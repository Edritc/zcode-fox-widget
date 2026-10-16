// 桌面浮层窗口的管理：单例检查、启动、停止，以及 Electron 运行时的按需安装。
//
// 浮层用独立 Electron 进程承载（ZCode 客户端本身不提供界面注入点）。Electron
// 运行时体积较大，所以装在数据目录 ~/.zcode/whale/desktop-runtime 下，插件包
// 里只放几 KB 的窗口代码。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, DEFAULT_PORT, PLUGIN_ROOT } from './paths.mjs'
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
// 单例判定的「亲缘目录」：electron 可执行文件所在的 dist 目录。它在 RUNTIME_DIR
// 之下，所以同一条产品线的多个安装副本（仓库副本 / cache 快照）共享同一个目录 →
// 依然互相识别、依然去重；而 WorkBuddy 版（fox-widget）的运行时在
// ~/.workbuddy/plugins/data/<插件>-<市场>/desktop-runtime，绝不相交 → 跨产品线
// 互不干涉，各跟各的宿主。不直接用 RUNTIME_DIR：运行时安装器的 node 进程也在它
// 之下，用 dist 目录可顺手排除，避免安装期间被误当成浮层。
const OVERLAY_MARKER_DIR = path.join(RUNTIME_DIR, 'node_modules', 'electron', 'dist')
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
          name: 'zcode-whale-desktop-runtime',
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
// ---------- 单例判定的「亲缘」谓词（纯函数，可直接单测） ----------
//
// 【2026-10-14 真机事故】以前按插件名子串匹配命令行（`*zcode-fox-widget*`）。
// 这个子串会命中「从 WorkBuddy 的 worktree 启动的浮层」——那份 worktree 的路径是
// `...\WorkBuddy\Worktrees\zcode-fox-widget\main-<sha>\desktop`，**含 `zcode-fox-widget`**
// ——于是本插件的启停去重会把 WorkBuddy 版的浮层当重复实例杀掉（镜像问题在对面
// 同样存在：对方用 `fox-widget` 标记，而它是 `zcode-fox-widget` 的子串，反过来杀
// 我们的）。两边的完整证据链见仓库根的 BUGREPORT-CROSS-LINE-OVERLAY-KILL.md。
//
// 现在的判据 = 命令行是否包含**本插件数据目录的运行时**（OVERLAY_MARKER_DIR）：
//   - 同一条产品线的多个安装副本：electron.exe 都来自同一个运行时 → 依然互相
//     识别、依然去重（防「双角色同屏」的初衷不回归）；
//   - 跨产品线：运行时目录绝不相交 → 互不干涉，各跟各的宿主。
export function isOwnOverlayCommandLine(commandLine, markerDir) {
  const cl = String(commandLine || '')
  const dir = String(markerDir || OVERLAY_MARKER_DIR)
  if (!cl || !dir) return false
  if (process.platform === 'win32') {
    // Windows 路径大小写不敏感、/ 与 \ 等价
    const norm = (s) => s.toLowerCase().replace(/\//g, '\\')
    return norm(cl).indexOf(norm(dir)) !== -1
  }
  return cl.indexOf(dir) !== -1
}

// 为什么要枚举而不是只信 overlay.json：浮层可能被多条路径启动——会话自启走的是
// 客户端里的插件副本、命令行手动 start 走的是仓库副本，两边入口目录不同、却都是
// 「我们的浮层」。只按 overlay.json 里的单个 pid 启停，会让另一个实例变成孤儿：
// 桌面上出现两个角色，且 stop 只收掉一个。这里按命令行枚举，启停都覆盖全集。
export function listOverlayPids() {
  const pids = []
  try {
    if (process.platform === 'win32') {
      // 只取 (pid, 命令行)，**在 JS 侧**用 isOwnOverlayCommandLine 过滤——亲缘判据
      // 因此可以脱离 PowerShell 直接单测（见 tools/selftest.mjs 的跨线互杀回归）
      const r = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | " +
            "Where-Object { $_.CommandLine -and $_.CommandLine -notlike '*--type=*' } | " +
            'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 8000 }
      )
      let rows = []
      try {
        const parsed = JSON.parse(String((r && r.stdout) || '') || '{}')
        rows = Array.isArray(parsed) ? parsed : parsed && parsed.ProcessId ? [parsed] : []
      } catch (err) {
        rows = [] // PowerShell 失败/输出为空：宁可不识别，也不盲杀
      }
      for (const row of rows) {
        const n = Number(row && row.ProcessId)
        if (Number.isInteger(n) && n > 0 && isOwnOverlayCommandLine(row.CommandLine) && pids.indexOf(n) === -1) {
          pids.push(n)
        }
      }
    } else {
      // POSIX：与 Windows 同口径，按运行时的 electron dist 目录认亲
      //（旧写法用插件根目录，按副本区分、跨副本不去重，与 Windows 口径不一致）
      const r = spawnSync('pgrep', ['-f', OVERLAY_MARKER_DIR], { encoding: 'utf8', timeout: 8000 })
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

// ---------- 浮层子进程的环境与 profile ----------
//
// 1) **环境清理**（与 WorkBuddy 线同口径）：宿主如果把 Electron 二进制当 node 用，会给
//    派生的子进程注入 `ELECTRON_RUN_AS_NODE=1`。浮层是**真正的 Electron GUI**，继承该
//    变量后 electron.exe 会以 node 模式启动，`require('electron')` 拿不到 app /
//    BrowserWindow，主进程立刻抛错退出——症状是「服务正常、桌面上什么都没有」。
//    继承来的 `NODE_OPTIONS` 也一并清掉：宿主会塞 `--require=<它的 node shim>`，把宿主的
//    node 补丁注进浮层主进程没有收益、只有串味风险。只影响浮层这一个子进程。
// 2) **每个实例用自己的 Electron profile**：同线多实例共用 `%APPDATA%\<productName>` 时，
//    第二个实例会抢 GPUCache 文件锁 → 两边 GPU 进程连环崩、正在用的浮层渲染进程被打死，
//    留下「窗口在、进程活、但渲染已死」的僵尸态。按端口派生 profile 目录，天然互不干扰。
// 3) **数据目录显式传下去**：浮层侧也要读同一份 server.json（让路时停本机服务）与主题
//    观测文件；让两侧各自解析 ZCODE_HOME，会在「设了但没导出给子进程」时静默分叉。
export function overlayProfileDir(port) {
  return path.join(DATA_DIR, 'overlay-profile-' + String(port || overlayPort()))
}
export function overlaySpawnEnv(svc) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  return {
    ...env,
    WHALE_PORT: String(svc.port),
    WHALE_DATA_DIR: DATA_DIR,
    // 跟随哪个进程：默认 ZCode，可用环境变量覆盖（便于测试或适配改名的构建）
    WHALE_TARGET_PROCESS: process.env.WHALE_TARGET_PROCESS || 'ZCode',
    // 跟随探测间隔（毫秒）：配置文件里可改，挂件菜单里也能即时调整
    WHALE_FOLLOW_INTERVAL_MS: String(
      readPluginConfig().followIntervalMs || process.env.WHALE_FOLLOW_INTERVAL_MS || 40
    ),
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  }
}
// 等所有浮层实例真正退出（最多 ms 毫秒）。杀进程与 spawn 之间必须留这个窗口：旧实例还
// 没释放 profile / GPU 文件锁就起新实例，正是「连环崩 + 僵尸态」的成因。
export async function waitOverlayExit(ms) {
  const deadline = Date.now() + ms
  for (;;) {
    const live = listOverlayPids().filter((pid) => isProcessAlive(pid))
    if (!live.length) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 100))
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

  // 等旧实例真正退干净再起新的：杀完立刻 spawn 会撞上它还没释放的 profile/GPU 文件锁
  await waitOverlayExit(3000)
  const child = spawn(ELECTRON_EXE, ['--user-data-dir=' + overlayProfileDir(svc.port), OVERLAY_ENTRY_DIR], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: overlaySpawnEnv(svc),
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
  // 停完要**等进程真的退**：立刻返回会让紧随其后的 startOverlay 撞上一个还没释放
  // profile/GPU 文件锁的旧实例（真机上表现为两边 GPU 连环崩 → 渲染进程死掉），
  // 「重启挂件」这条路上尤其明显。
  await waitOverlayExit(3000)
  clearOverlayInfo()
  return ok ? { ok: true, killed: pids.length } : { ok: false, error: '未能结束浮层进程' }
}

// 让浮层用指定端口（默认跟挂件服务一致）
export function overlayPort() {
  return readPluginConfig().port || DEFAULT_PORT
}
