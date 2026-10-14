// 看门狗守护进程：让挂件「随 WorkBuddy 应用启动而出现」，不再依赖会话动作。
//
// 【为什么需要它】WorkBuddy **应用启动本身不触发任何插件钩子**（实测：冷启动后
// 一动不动，SessionStart 一次都不跑；宿主钩子事件枚举里也没有「应用启动」类事件，
// 见 docs/porting/phase-0.md），插件 MCP 进程也只随**会话**（新对话/回退对话）spawn。
// 而钩子拉起的挂件服务与浮层都长在宿主进程树上：应用退出时被一并收走，
// CLI 宿主被 CliPrewarmPool 回收 / 会话切换时也可能被连带杀掉（2026-10-14 实测：
// 16:43 由钩子拉起的服务在应用存活期间死亡）。于是「启动 WorkBuddy → 桌面上没有
// 挂件，直到用户做出回退/新对话这类会话动作」。
//
// 本进程就是补这个缺口的：**独立于 WorkBuddy 进程树**常驻（登录时由启动文件夹的
// VBS 拉起，见 cli.mjs 的 watchdog install），自己的子进程（服务/浮层）因此不会随
// 应用退出被杀。它做三件事：
//   1. 监听 <HOST_HOME>/logs/AppStartup.log 的追加——宿主每次启动/持续活动都会写
//      这份日志（[AppStartup]/[Perf]/[DocumentSelectionHook] 行），一旦有动静就把
//      wbUp 置真并确保「服务 + 浮层」在跑。这覆盖「应用冷启动」这个原先的死角。
//   2. 监听 AppShutdown.log 的追加——应用退出（before_quit 都写）→ wbUp 置假；
//      宽限期后优雅停掉服务（保持「服务随应用存在」的既有语义；浮层会自己退）。
//   3. 每 15s 自检：wbUp 期间服务/浮层死了就补（修复「会话切换杀服务」那类中途
//      死亡）；连续拉不起浮层 3 次 = 判定宿主其实不在，转怠速等下一次启动信号，
//      另有 5 分钟一次的进程探测兜底「崩溃没写 shutdown 日志」的漏网形态。
//
// 排障开关：FOX_WIDGET_NO_WATCHDOG=1 时直接退出（VBS 会拉起一个立即退出的进程，
// 无副作用）。用户配置 autoStartWidget=false 时怠速（保持进程活着但什么都不做，
// 这样用户改回配置不需要重装）。
//
// 约束：与 lib/ 其它模块一致，只用 node: 内置模块；日志写
// <DATA_DIR>/watchdog.log 并截断保长，风格同 autostart.log。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DATA_DIR, HOST_HOME } from './paths.mjs'
import { HOST_PROCESS_NAME } from './host.mjs'
import { readPluginConfig } from './credentials.mjs'
import { ensureServer, findRunningServer, stopServer } from './service.mjs'
import { startOverlay, overlayStatus, isRuntimeInstalled } from './overlay.mjs'

// 服务用哪个 node 拉起：service.mjs 的 nodeBin() 读 FOX_WIDGET_NODE 或 PATH 的 node。
// 看门狗自己被哪个 node 跑，就把这个绝对路径传下去——不依赖登录会话的 PATH。
process.env.FOX_WIDGET_NODE = process.env.FOX_WIDGET_NODE || process.execPath

const LOG_FILE = path.join(DATA_DIR, 'watchdog.log')
const LOCK_FILE = path.join(DATA_DIR, 'watchdog.json')
const LOG_KEEP_LINES = 200

const LOGS_DIR = path.join(HOST_HOME, 'logs')
const APP_STARTUP_LOG = path.join(LOGS_DIR, 'AppStartup.log')
const APP_SHUTDOWN_LOG = path.join(LOGS_DIR, 'AppShutdown.log')

const TICK_MS = 15000 // 常规自检间隔
const ENSURE_DEBOUNCE_MS = 2500 // 日志追加后的动作去抖（宿主冷启动本身要 ~3s）
const OVERLAY_FAIL_LIMIT = 3 // 连续拉不起浮层的次数上限 → 判定宿主不在
// 宿主退出后多久停服务（覆盖更新重启空档与多实例误判）。环境变量可覆盖：
// 测试要缩短等待时用 FOX_WIDGET_WATCHDOG_GRACE_MS。
const STOP_SERVER_GRACE_MS = Number(process.env.FOX_WIDGET_WATCHDOG_GRACE_MS) || 5 * 60 * 1000
const PROBE_INTERVAL_MS = 5 * 60 * 1000 // 怠速期的进程探测间隔

function log(text) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + text + '\n', 'utf8')
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean)
    if (lines.length > LOG_KEEP_LINES) {
      fs.writeFileSync(LOG_FILE, lines.slice(-LOG_KEEP_LINES).join('\n') + '\n', 'utf8')
    }
  } catch (err) {}
}

function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

// ---------- 单实例 ----------
// 启动文件夹的 VBS、手动 `watchdog run`、旧实例未退——都可能造成第二个看门狗。
// 锁文件记 pid：活着且不是自己就退出。
function acquireLock() {
  try {
    const prev = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))
    if (prev && Number.isInteger(prev.pid) && prev.pid !== process.pid && pidAlive(prev.pid)) {
      log('another watchdog running (pid ' + prev.pid + '), exit')
      return false
    }
  } catch (err) {}
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2))
  } catch (err) {
    // 锁都写不进（数据目录不可用）：干脆退出，别在无日志的状态下盲跑
    return false
  }
  return true
}
process.on('exit', () => {
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))
    if (cur && cur.pid === process.pid) fs.unlinkSync(LOCK_FILE)
  } catch (err) {}
})

// ---------- 宿主存活判定 ----------

let wbUp = false // 当前认为 WorkBuddy 应用在跑
let hostGoneAt = 0 // 最后一次观察到 AppShutdown 的时刻（0 = 未观察/已处理）
let overlayFails = 0 // 连续拉不起浮层的次数
let lastProbeAt = 0 // 上次进程探测时刻（怠速期兜底）
let skippedOnce = false // autoStartWidget=false 时只记一次日志

// tasklist 只在「启动初始判定」与「怠速期 5 分钟兜底」用，不进 15s 常规轮询。
function probeHostRunning() {
  try {
    const r = spawnSync(
      'tasklist',
      ['/NH', '/FI', 'IMAGENAME eq ' + HOST_PROCESS_NAME + '.exe'],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 }
    )
    return String((r && r.stdout) || '').toLowerCase().indexOf(HOST_PROCESS_NAME.toLowerCase() + '.exe') !== -1
  } catch (err) {
    return false
  }
}

// ---------- 拉起/保活 ----------

let ensuring = false
let ensureTimer = null

async function ensureWidget(reason) {
  if (ensuring) return
  ensuring = true
  try {
    const cfg = readPluginConfig()
    if (!cfg.autoStartWidget) {
      if (!skippedOnce) {
        log('skip: autoStartWidget=false (idle)')
        skippedOnce = true
      }
      return
    }
    const svc = await ensureServer({ waitReadyMs: 8000 })
    if (!svc.running) {
      log('ensure[' + reason + '] server failed: ' + (svc.error || 'unknown'))
      return
    }
    if (svc.started) log('ensure[' + reason + '] server started on port ' + svc.port)
    if (!cfg.autoStartOverlay || !isRuntimeInstalled()) return
    const ov = await overlayStatus()
    if (ov.running) {
      overlayFails = 0
      return
    }
    const r = await startOverlay()
    if (r.running) {
      overlayFails = 0
      log('ensure[' + reason + '] overlay ' + (r.started ? 'started pid ' + r.pid : 'reused pid ' + r.pid))
    } else {
      overlayFails++
      log('ensure[' + reason + '] overlay failed (' + overlayFails + '/' + OVERLAY_FAIL_LIMIT + '): ' + (r.error || 'unknown'))
    }
  } catch (err) {
    log('ensure[' + reason + '] error: ' + String((err && err.message) || err))
  } finally {
    ensuring = false
  }
}

// 去抖调度：宿主冷启动那几秒日志会成串追加，动作只需要一次
function scheduleEnsure(reason) {
  if (ensureTimer) clearTimeout(ensureTimer)
  ensureTimer = setTimeout(() => {
    ensureTimer = null
    ensureWidget(reason)
  }, ENSURE_DEBOUNCE_MS)
  if (ensureTimer.unref) ensureTimer.unref()
}

function noteHostUp(reason) {
  if (!wbUp) {
    wbUp = true
    log('host-up: ' + reason)
  }
  hostGoneAt = 0
  scheduleEnsure(reason)
}

function noteHostDown(reason) {
  if (wbUp) log('host-down: ' + reason)
  wbUp = false
  // 每次 shutdown 证据都刷新（多实例场景：一个退了另一个还活着，
  // 后续它的活动追加会把状态拉回来，这里的刷新只影响宽限期计时）
  hostGoneAt = Date.now()
}

// ---------- 宿主日志监听 ----------
//
// AppStartup.log 在宿主**整个运行期**都有追加（不只是启动那一行：[Perf]、
// [DocumentSelectionHook] 都写这里），所以「任何追加」都是宿主活着的证据；
// AppShutdown.log 只在 before_quit 时写。fs.watch 目录（非递归）拿文件名过滤，
// 按文件大小增长确认是「追加」而非轮转重写。

function watchHostLog(file, onAppend) {
  let lastSize = -1
  try {
    lastSize = fs.statSync(file).size
  } catch (err) {
    lastSize = 0 // 宿主可能还没跑过，文件不存在；出现后目录事件会带我们补上
  }
  let timer = null
  const fire = () => {
    let size = 0
    try {
      size = fs.statSync(file).size
    } catch (err) {
      return
    }
    if (size > lastSize || lastSize < 0) {
      lastSize = size
      onAppend()
    } else {
      lastSize = size // 变小 = 轮转/重写，只记新大小不触发
    }
  }
  try {
    fs.watch(LOGS_DIR, { persistent: true }, (event, filename) => {
      const base = path.basename(file)
      if (!filename || String(filename).toLowerCase() !== base.toLowerCase()) return
      // Windows 的目录事件可能早于写入可见：稍等一拍再量大小
      if (timer) clearTimeout(timer)
      timer = setTimeout(fire, 400)
      if (timer.unref) timer.unref()
    })
  } catch (err) {
    log('watch failed on ' + LOGS_DIR + ': ' + String((err && err.message) || err))
  }
}

function startWatchers() {
  watchHostLog(APP_STARTUP_LOG, () => noteHostUp('AppStartup.log append'))
  watchHostLog(APP_SHUTDOWN_LOG, () => noteHostDown('AppShutdown.log append'))
}

// ---------- 主循环 ----------

async function tick() {
  const cfg = readPluginConfig()
  if (!cfg.autoStartWidget) return
  try {
    if (wbUp) {
      const running = await findRunningServer()
      if (!running) {
        await ensureWidget('tick-server-dead')
        return
      }
      if (!cfg.autoStartOverlay || !isRuntimeInstalled()) return
      const ov = await overlayStatus()
      if (ov.running) {
        overlayFails = 0
        return
      }
      if (overlayFails >= OVERLAY_FAIL_LIMIT) return // 已判定宿主不在，等信号
      await ensureWidget('tick-overlay-dead')
      // 连续失败到上限：宿主多半已经退了（崩溃没写 AppShutdown 的漏网形态）。
      // 转入怠速；真在跑的话，下一次日志追加 / 5 分钟探测会把状态纠正回来。
      if (overlayFails >= OVERLAY_FAIL_LIMIT) {
        noteHostDown('overlay-fails-' + overlayFails)
      }
    } else {
      // 怠速期：宽限期过后停服务（对齐「服务随应用存在」的语义；浮层自己会退）。
      // 动手前再探一次进程：宽限期存在的意义就是覆盖「旧实例退出、新实例还没起」
      // 的空档（更新重启），以及多实例一个退了另一个还活着的形态。
      if (hostGoneAt && Date.now() - hostGoneAt >= STOP_SERVER_GRACE_MS) {
        hostGoneAt = 0
        if (probeHostRunning()) {
          noteHostUp('probe-before-stop')
          return
        }
        const running = await findRunningServer()
        if (running) {
          const r = await stopServer()
          log('server stopped after grace: ' + (r.ok ? 'ok' : 'failed: ' + r.error))
        } else {
          log('grace elapsed, server already gone')
        }
      }
      // 慢探测兜底：覆盖「崩溃没写 shutdown 日志」与「启动时 host 探测误判」
      if (Date.now() - lastProbeAt >= PROBE_INTERVAL_MS) {
        lastProbeAt = Date.now()
        if (probeHostRunning()) {
          noteHostUp('probe')
        }
      }
    }
  } catch (err) {
    log('tick error: ' + String((err && err.message) || err))
  }
}

function main() {
  if (process.env.FOX_WIDGET_NO_WATCHDOG === '1') process.exit(0)
  if (!acquireLock()) process.exit(0)

  // 初始判定：进程探测一次 + 浮层活着也算宿主在（浮层跟随宿主窗口而活）
  lastProbeAt = Date.now()
  wbUp = probeHostRunning()
  const ov = overlayStatus().then((s) => {
    if (s.running) {
      wbUp = true
      log('init: overlay alive (pid ' + s.pid + '), assume host up')
    }
    log('init: wbUp=' + wbUp + ' pid=' + process.pid)
    if (wbUp) scheduleEnsure('init')
  })
  ov.catch(() => {})

  startWatchers()
  setInterval(() => {
    tick()
  }, TICK_MS)
  log('watchdog started (tick=' + TICK_MS + 'ms)')
}

main()
