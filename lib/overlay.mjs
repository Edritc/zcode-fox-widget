// 桌面浮层窗口的管理：单例检查、启动、停止，以及 Electron 运行时的按需安装。
//
// 浮层用独立 Electron 进程承载（WorkBuddy 客户端同样不提供界面注入点【实测：
// 在 app.asar 里没搜到 panel/view 类注入契约】）。Electron 运行时体积较大，所以装在
// 插件数据目录 <${CODEBUDDY_PLUGIN_DATA}>/desktop-runtime 下，插件包里只放几 KB
// 的窗口代码。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, DEFAULT_PORT, PLUGIN_ROOT } from './paths.mjs'
import { HOST_PROCESS_NAME, OVERLAY_CMDLINE_MARKERS } from './host.mjs'
import { isBlockedHost, readPluginConfig } from './credentials.mjs'
import { ensureServer } from './service.mjs'

const RUNTIME_DIR = path.join(DATA_DIR, 'desktop-runtime')
const ELECTRON_EXE = path.join(
  RUNTIME_DIR,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
)
const OVERLAY_INFO_FILE = path.join(DATA_DIR, 'overlay.json')
const OVERLAY_ENTRY_DIR = path.join(PLUGIN_ROOT, 'desktop')
// 镜像地址先做形态校验再进命令行/下载：这些值来自环境变量，Windows 下起 npm
// 要走 shell（.cmd 不能裸 spawn），未经校验的元字符会被拼进命令行；下载地址
// 同理不该带出 shell/引号面。形态不干净一律回落内置默认。
const ELECTRON_MIRROR = safeMirrorUrl(process.env.ELECTRON_MIRROR, 'https://npmmirror.com/mirrors/electron/')
const NPM_REGISTRY = safeMirrorUrl(process.env.WHALE_NPM_REGISTRY, 'https://registry.npmmirror.com')

// 只放行「http(s)://主机[:端口][/路径]」形态：字符集里没有 shell 元字符
// （& | ; " ' ` $ ( ) < > 空格），拼进命令行也不会改写命令结构；主机再过
// isBlockedHost——镜像地址属于「拉工具时会去请求的 URL」，环回/私有/保留地址
// 与出站硬约束同口径拒绝（需要内网 npm 镜像的场景请用可解析的公网域名或代理）。
export function safeMirrorUrl(raw, fallback) {
  const v = String(raw || '').trim()
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~%/-]*)?$/.test(v)) return fallback
  try {
    const u = new URL(v)
    if (isBlockedHost(u.hostname)) return fallback
    return v
  } catch (err) {
    return fallback
  }
}

// 与依赖安装时的 electron 版本保持一致；升级这里即可换运行时。
const ELECTRON_RANGE = '^44.3.0'

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

// shell 只在必须起 .cmd（npm）时打开；裸 node 路径含空格时经 shell 会被拆词，
// 所以带路径的调用显式 shell:false（默认也是 false）。
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, shell: opts.shell === true })
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (out += c))
    child.on('error', (err) => resolve({ ok: false, out: out + String(err.message) }))
    child.on('close', (code) => resolve({ ok: code === 0, code, out }))
  })
}

export function isRuntimeInstalled() {
  try {
    return fs.statSync(ELECTRON_EXE).isFile()
  } catch (err) {
    return false
  }
}

export function runtimePaths() {
  return { runtimeDir: RUNTIME_DIR, electronExe: ELECTRON_EXE, overlayEntry: OVERLAY_ENTRY_DIR }
}

// 按需安装：npm 装 electron 包，再触发它自带的脚本下载二进制（走国内镜像）。
export async function installRuntime() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  const pkgFile = path.join(RUNTIME_DIR, 'package.json')
  if (!fs.existsSync(pkgFile)) {
    fs.writeFileSync(
      pkgFile,
      JSON.stringify(
        {
          name: 'fox-widget-desktop-runtime',
          version: '1.0.0',
          private: true,
          dependencies: { electron: ELECTRON_RANGE },
        },
        null,
        2
      ),
      'utf8'
    )
  }

  // npm.cmd 在 Windows 下必须经 shell 才能起（Node 不允许裸 spawn .cmd）；
  // 参数全是常量 + 形态校验过的 registry（见 safeMirrorUrl），无拼接注入面
  const install = await run(npmBin(), ['install', '--no-audit', '--no-fund', '--registry=' + NPM_REGISTRY], {
    cwd: RUNTIME_DIR,
    shell: process.platform === 'win32',
  })
  if (!install.ok) {
    return { ok: false, step: 'npm install', output: install.out.slice(-1200) }
  }

  if (!isRuntimeInstalled()) {
    // electron 包的 postinstall 在新版 npm 下不一定会跑，这里显式触发
    const installer = path.join(RUNTIME_DIR, 'node_modules', 'electron', 'install.js')
    if (!fs.existsSync(installer)) {
      return { ok: false, step: 'electron install.js 缺失', output: install.out.slice(-800) }
    }
    const fetched = await run(process.execPath, [installer], {
      cwd: RUNTIME_DIR,
      env: { ...process.env, ELECTRON_MIRROR },
    })
    if (!fetched.ok || !isRuntimeInstalled()) {
      return {
        ok: false,
        step: '下载 Electron 二进制',
        output: (fetched.out || '').slice(-1200) + '\n可手动重试：cd ' + RUNTIME_DIR + ' && npm install',
      }
    }
  }
  return { ok: true, electronExe: ELECTRON_EXE }
}

function isProcessAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

// 找出本插件的**所有**浮层主进程（不止 overlay.json 里记的那一个）。
//
// 为什么要这样找：浮层可能被多条路径启动——会话自启走的是客户端里的插件副本、
// 命令行手动 start 走的是仓库副本，两边的入口目录不同、却都是「我们的浮层」。
// 只按 overlay.json 里的单个 pid 启停，会让另一个实例变成孤儿：桌面上出现两个
// 嘎啦嘛，且 stop 只收掉一个。这里按命令行特征（入口目录 + 排除 --type= 子进程）
// 枚举，启停都覆盖全集。
export function listOverlayPids() {
  const pids = []
  try {
    if (process.platform === 'win32') {
      // 命令行特征匹配**同时接受新旧两个插件名**：本分支插件叫 fox-widget，而
      // ZCode 分支叫 zcode-fox-widget；用户两端同装时若不互认，桌面就会出现两个
      // 角色（ZCode 侧修过一次同类问题，见 MIGRATION-PLAN §1.5/§三.9）。
      const like = OVERLAY_CMDLINE_MARKERS.map((m) => "$_.CommandLine -like '*" + m + "*'").join(' -or ')
      const r = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | " +
            'Where-Object { (' + like + ') -and $_.CommandLine -notlike \'*--type=*\' } | ' +
            'Select-Object -ExpandProperty ProcessId',
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 8000 }
      )
      for (const line of String((r && r.stdout) || '').split(/\r?\n/)) {
        const n = Number(String(line).trim())
        if (Number.isInteger(n) && n > 0 && pids.indexOf(n) === -1) pids.push(n)
      }
    } else {
      const r = spawnSync('pgrep', ['-f', OVERLAY_ENTRY_DIR], { encoding: 'utf8', timeout: 8000 })
      for (const line of String((r && r.stdout) || '').split(/\r?\n/)) {
        const n = Number(String(line).trim())
        if (Number.isInteger(n) && n > 0 && n !== process.pid && pids.indexOf(n) === -1) pids.push(n)
      }
    }
  } catch (err) {}
  return pids
}

function killPidTree(pid) {
  try {
    if (process.platform === 'win32') {
      // Electron 会派生渲染/GPU 子进程，用 /T 一并收拾
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 })
    } else {
      process.kill(pid)
    }
    return true
  } catch (err) {
    return false
  }
}

export function readOverlayInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(OVERLAY_INFO_FILE, 'utf8'))
    if (info && typeof info.pid === 'number') return info
  } catch (err) {}
  return null
}

function writeOverlayInfo(info) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(OVERLAY_INFO_FILE, JSON.stringify(info, null, 2), 'utf8')
  } catch (err) {}
}

function clearOverlayInfo() {
  try {
    fs.unlinkSync(OVERLAY_INFO_FILE)
  } catch (err) {}
}

export async function overlayStatus() {
  const info = readOverlayInfo()
  if (!info) return { running: false, installed: isRuntimeInstalled() }
  const alive = isProcessAlive(info.pid)
  if (!alive) clearOverlayInfo()
  return {
    running: alive,
    installed: isRuntimeInstalled(),
    pid: alive ? info.pid : null,
    port: info.port || null,
    startedAt: info.startedAt || null,
  }
}

export async function startOverlay() {
  // 先归一去重：历史上可能由不同副本/不同路径起了不止一个浮层（桌面出现两个
  // 嘎啦嘛）。保留一个（overlay.json 记的优先，其次最后一个），其余收掉。
  const live = listOverlayPids().filter((pid) => isProcessAlive(pid))
  if (live.length) {
    const status = await overlayStatus()
    const keep = status.pid && live.indexOf(status.pid) !== -1 ? status.pid : live[live.length - 1]
    let killed = 0
    for (const pid of live) {
      if (pid === keep) continue
      if (killPidTree(pid)) killed++
    }
    writeOverlayInfo({
      pid: keep,
      port: status.port || overlayPort(),
      startedAt: status.startedAt || new Date().toISOString(),
    })
    return { running: true, started: false, pid: keep, port: status.port || overlayPort(), deduped: killed }
  }
  const status = await overlayStatus()
  if (status.running) {
    return { running: true, started: false, pid: status.pid, port: status.port }
  }
  if (!isRuntimeInstalled()) {
    return {
      running: false,
      started: false,
      installed: false,
      error: '尚未安装 Electron 运行时',
      hint: '运行：node lib/cli.mjs desktop install（约 150MB，一次性）',
    }
  }

  // 浮层要连挂件服务，先把服务确保在跑
  const svc = await ensureServer()
  if (!svc.running) {
    return { running: false, started: false, error: '挂件服务未就绪：' + (svc.error || '未知原因') }
  }

  const child = spawn(ELECTRON_EXE, [OVERLAY_ENTRY_DIR], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: {
      ...process.env,
      WHALE_PORT: String(svc.port),
      // 跟随哪个进程：默认 WorkBuddy，可用环境变量覆盖（便于测试或适配改名的构建）
      WHALE_TARGET_PROCESS: process.env.WHALE_TARGET_PROCESS || HOST_PROCESS_NAME,
      // 跟随探测间隔（毫秒）：配置文件里可改，挂件菜单里也能即时调整
      WHALE_FOLLOW_INTERVAL_MS: String(
        readPluginConfig().followIntervalMs || process.env.WHALE_FOLLOW_INTERVAL_MS || 40
      ),
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  })
  child.unref()

  writeOverlayInfo({
    pid: child.pid,
    port: svc.port,
    startedAt: new Date().toISOString(),
  })

  // 给窗口一点启动时间，再确认进程仍活着
  await new Promise((r) => setTimeout(r, 1800))
  const alive = isProcessAlive(child.pid)
  if (!alive) clearOverlayInfo()
  return {
    running: alive,
    started: alive,
    pid: alive ? child.pid : null,
    port: svc.port,
    error: alive ? null : '浮层进程启动后立即退出，可用 node lib/cli.mjs desktop install 检查运行时',
  }
}

export async function stopOverlay() {
  const info = readOverlayInfo()
  // 收全集：除了记录在案的实例，还按命令行特征扫出其它副本起的浮层（否则桌面
  // 上会留下一个收不掉的孤儿窗口）
  const pids = listOverlayPids().filter((pid) => isProcessAlive(pid))
  if (info && isProcessAlive(info.pid) && pids.indexOf(info.pid) === -1) pids.push(info.pid)
  if (!pids.length) {
    clearOverlayInfo()
    return { ok: false, error: '浮层未在运行' }
  }
  let ok = false
  for (const pid of pids) {
    if (killPidTree(pid)) ok = true
  }
  clearOverlayInfo()
  return ok ? { ok: true, killed: pids.length } : { ok: false, error: '未能结束浮层进程' }
}

// 让浮层用指定端口（默认跟挂件服务一致）
export function overlayPort() {
  return readPluginConfig().port || DEFAULT_PORT
}
