// 挂件服务的发现、拉起与关闭。
// 被 MCP 工具和 SessionStart 自启 hook 共用：两者都只关心"服务是否已经在跑"，
// 不在跑就拉起来，跑着就复用，避免重复监听端口。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PORT, SERVER_INFO_FILE, DATA_DIR, CLOSE_PAUSE_FILE } from './paths.mjs'
import { HOST_NODE_BIN, HOST_APP_ID } from './host.mjs'
import { readPluginConfig } from './credentials.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ENTRY = path.join(HERE, 'server.mjs')

// 宿主自带 node，直接用 PATH 里的 node 拉起独立进程；允许环境变量覆盖。
// 【实测】WorkBuddy 钩子的 command 就是 `node ...`（内置插件 subscription-gate
// 也这么写），说明钩子/子进程 PATH 里有 node；WorkBuddy 自带的是 v22.22.2。
function nodeBin() {
  return process.env[HOST_NODE_BIN] || 'node'
}

export function readServerInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(SERVER_INFO_FILE, 'utf8'))
    if (info && typeof info.port === 'number' && typeof info.token === 'string') return info
  } catch (err) {}
  return null
}

// 只有健康检查通过才算"在跑"：server.json 可能是崩溃进程留下的。
export async function probeHealth(port, timeoutMs = 800) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/whale/health', {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const data = await res.json()
    // 认 app 标识，避免误认别的本地服务（与 server.mjs /whale/health 的 app 字段
    // 必须完全一致——两处不一致会让 findRunningServer 永远找不到在跑的服务）
    return data && data.app === HOST_APP_ID ? data : null
  } catch (err) {
    return null
  }
}

// 先看记录里的端口，再看默认端口，最后线性扫一段端口范围。
export async function findRunningServer() {
  const candidates = []
  const info = readServerInfo()
  if (info) candidates.push(info.port)
  const cfgPort = readPluginConfig().port
  if (cfgPort) candidates.push(cfgPort)
  candidates.push(DEFAULT_PORT)
  const seen = new Set()
  for (const port of candidates) {
    if (!port || seen.has(port)) continue
    seen.add(port)
    const health = await probeHealth(port)
    if (health) return { port, health, info: info && info.port === port ? info : null }
  }
  return null
}

export async function ensureServer({ waitReadyMs = 6000 } = {}) {
  const running = await findRunningServer()
  if (running) {
    return { running: true, started: false, port: running.port, health: running.health }
  }
  const port = readPluginConfig().port || DEFAULT_PORT
  const child = spawn(nodeBin(), [SERVER_ENTRY], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()

  const deadline = Date.now() + waitReadyMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
    const started = await findRunningServer()
    if (started) {
      return { running: true, started: true, port: started.port, health: started.health }
    }
  }
  return {
    running: false,
    started: false,
    port,
    error: '挂件服务未能在超时前就绪（可用 node lib/server.mjs 前台运行查看报错）',
  }
}

// 等端口真的不再应答。收到 /whale/shutdown 的 200 只说明「已受理」，进程还要过
// 几十到上百毫秒才退出（响应先回、再关连接、最后 process.exit）。不等这一下，
// 紧接着的 start 会探到尚未退出的旧进程并拿到 200，于是判定「复用已在运行的
// 服务」直接返回——旧进程随后退出，结果是重启完一个服务都不剩（实测确定性复现）。
export async function waitServerStopped(port, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const health = await probeHealth(port, 500)
    if (!health) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 100))
  }
}

export async function stopServer() {
  const running = await findRunningServer()
  if (!running) return { ok: false, error: '挂件服务未在运行' }
  const info = running.info || readServerInfo()
  if (!info || typeof info.token !== 'string') {
    return { ok: false, error: '缺少关闭令牌，请手动结束进程 pid=' + (info ? info.pid : '未知') }
  }
  try {
    const res = await fetch('http://127.0.0.1:' + running.port + '/whale/shutdown', {
      method: 'POST',
      headers: { 'x-whale-token': info.token },
      signal: AbortSignal.timeout(2000),
    })
    const data = await res.json()
    if (!data || !data.ok) return { ok: false, error: '关闭请求被拒绝' }
    // 受理 ≠ 停止：必须等端口真的停止应答，否则 restart 的「停→起」之间会撞上
    // 还没退干净的旧进程（见 waitServerStopped 注释）
    const stopped = await waitServerStopped(running.port)
    return stopped ? { ok: true } : { ok: false, error: '服务未在超时内停止（pid=' + (info.pid || '未知') + '）' }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

export function widgetUrl(port) {
  return 'http://127.0.0.1:' + (port || readPluginConfig().port || DEFAULT_PORT) + '/'
}

// ---------- 「本次关闭」标记（菜单「关闭插件」用） ----------
// 只活在「本次」：标记存在期间看门狗停手（它会每 15 秒补活，不拦就白关了）；一旦
// 宿主重启（看门狗走 noteHostUp）或挂件被别的路径拉回来（钩子 / 显式启动 / 看门狗
// 发现服务已活），标记即失效。刻意不放进 config.json——那是用户配置，这不是设置。
export function writeClosePause() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(CLOSE_PAUSE_FILE, JSON.stringify({ at: Date.now() }), 'utf8')
    return true
  } catch (err) {
    return false
  }
}

export function readClosePause() {
  try {
    const d = JSON.parse(fs.readFileSync(CLOSE_PAUSE_FILE, 'utf8'))
    return { at: Number(d && d.at) || 0 }
  } catch (err) {
    return null
  }
}

export function clearClosePause() {
  try {
    fs.unlinkSync(CLOSE_PAUSE_FILE)
  } catch (err) {}
}
