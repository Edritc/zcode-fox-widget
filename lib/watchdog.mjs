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
//      浮层会自己退（msg.gone），**服务保持常暖**（见下）。
//   3. 每 15s 自检：wbUp 期间服务/浮层死了就补（修复「会话切换杀服务」那类中途
//      死亡）；连续拉不起浮层 3 次 = 判定宿主其实不在，转怠速等下一次启动信号，
//      另有 5 分钟一次的进程探测兜底「崩溃没写 shutdown 日志」的漏网形态。
//
// 【服务常暖】服务从拉起到就绪要 3–8 秒，是「启动 WB 后挂件要等十来秒」的大头
//（实测分解：发现宿主 +4s、服务就绪 +6s、起浮层 +3s）。所以看门狗一旦在跑就把
// 服务拉起并**一直保温**：登录即暖、应用退出也不停——宿主起来的时点只剩「起浮层」
// 一步。代价是一个常驻 node 进程（仅监听 127.0.0.1，约 80MB）。保温的服务可能
// 跑着旧版本代码（插件升级后旧进程还活着），所以宿主要用它的时点校验一次
// health.version，不一致就换血（停旧拉新）。
//
// 排障开关：FOX_WIDGET_NO_WATCHDOG=1 时直接退出（VBS 会拉起一个立即退出的进程，
// 无副作用）。用户配置 autoStartWidget=false 时怠速（保持进程活着但什么都不做，
// 这样用户改回配置不需要重装）。
//
// 约束：与 lib/ 其它模块一致，只用 node: 内置模块；日志写
// <DATA_DIR>/watchdog.log 并截断保长，风格同 autostart.log。
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, HOST_HOME, pluginVersion } from './paths.mjs'
import { HOST_PROCESS_NAME, classifyHostLogAppend } from './host.mjs'
import { readPluginConfig } from './credentials.mjs'
import { clearClosePause, ensureServer, findRunningServer, readClosePause, stopServer } from './service.mjs'
import { startOverlay, overlayStatus, isRuntimeInstalled, runBoundedOutput } from './overlay.mjs'

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
let overlayFails = 0 // 连续拉不起浮层的次数
let lastProbeAt = 0 // 上次进程探测时刻（怠速期兜底）
let skippedOnce = false // autoStartWidget=false 时只记一次日志

// tasklist 只在「启动初始判定」与「怠速期 5 分钟兜底」用，不进 15s 常规轮询。
// 异步有界执行（runBoundedOutput）：**绝不**让同步子进程按住事件循环——
// 2026-10-14 真机：看门狗进程活着却全停（疑似卡死在同步调用上），错失多次补活。
async function probeHostRunning() {
  try {
    const out = await runBoundedOutput(
      'tasklist',
      ['/NH', '/FI', 'IMAGENAME eq ' + HOST_PROCESS_NAME + '.exe'],
      8000
    )
    return String(out || '').toLowerCase().indexOf(HOST_PROCESS_NAME.toLowerCase() + '.exe') !== -1
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
    // 用户点过菜单里的「关闭插件」：看门狗在「本次」停手，不能把关掉的挂件又拉回来。
    // 标记只活到下一次宿主启动（noteHostUp 清）或挂件被别的路径拉回来（下面这段清）。
    if (await honorClosePause()) return
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
    // 宿主不在时只把服务暖着：浮层跟随宿主窗口，宿主没有时起了也会自己退
    if (!wbUp) return
    // 保温的服务可能跑着旧版本代码（插件升级后旧进程还活着）：宿主要用它之前
    // 校验一次版本，不一致就换血——停旧拉新，避免「升级了还跑旧代码」。
    const want = pluginVersion()
    if (svc.health && svc.health.version && want && svc.health.version !== want) {
      log('server version mismatch (' + svc.health.version + ' != ' + want + '), restarting it')
      await stopServer()
      const fresh = await ensureServer({ waitReadyMs: 8000 })
      if (!fresh.running) {
        log('ensure[' + reason + '] server restart failed: ' + (fresh.error || 'unknown'))
        return
      }
      log('ensure[' + reason + '] server restarted on version ' + want)
    }
    if (!cfg.autoStartOverlay) return
    if (!isRuntimeInstalled()) {
      // 别静默跳过：运行时缺失/装残时，用户看到的是「挂件没了」却查不到原因
      //（2026-10-15 真机：运行时装了一半，桌面永远无挂件）
      log('ensure[' + reason + '] overlay skipped: runtime missing/incomplete — run: node lib/cli.mjs desktop install')
      return
    }
    const ov = await overlayStatus()
    if (ov.running) {
      overlayFails = 0
      return
    }
    const r = await startOverlay()
    if (r.running) {
      overlayFails = 0
      log(
        'ensure[' + reason + '] overlay ' + (r.started ? 'started pid ' + r.pid : 'reused pid ' + r.pid) +
          (r.dedupFailed ? ' ⚠ 去重未净（仍有自家浮层活着: ' + r.dedupFailed.join(',') + '）' : '')
      )
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
    // 新的一次宿主运行期 = 「本次关闭」结束：用户关掉挂件后重启宿主，自然要它回来
    if (readClosePause()) {
      clearClosePause()
      log('close-pause cleared: host restarted')
    }
    log('host-up: ' + reason)
  }
  scheduleEnsure(reason)
}

// 「本次关闭」期间看门狗停手（否则它每 15 秒就会把用户刚关掉的挂件拉回来）；但只要
// 挂件被别的路径拉回来了（钩子自启 / 显式启动），这个标记就作废——那等于用户又要它了。
async function honorClosePause() {
  if (!readClosePause()) return false
  if (await findRunningServer()) {
    clearClosePause()
    log('close-pause cleared: server is up again')
    return false
  }
  if (!skippedOnce) {
    log('skip: close-pause (idle until next host start)')
    skippedOnce = true
  }
  return true
}

function noteHostDown(reason) {
  if (wbUp) log('host-down: ' + reason)
  wbUp = false
  // 服务不在这里停：保持常暖（见文件头「服务常暖」），下次启动 WB 时省掉
  // 3–8 秒的服务冷启动。浮层会自己退（msg.gone）。
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
      // 读出**新增的字节**交给回调分流——只比大小不看内容会把「宿主退出」当成
      // 「宿主启动」（宿主把 [AppShutdown] 退出行也写进 AppStartup.log，见
      // host.mjs 的 classifyHostLogAppend；2026-10-14 审查 P0-1）
      let text = ''
      try {
        const fd = fs.openSync(file, 'r')
        try {
          const buf = Buffer.alloc(size - lastSize)
          fs.readSync(fd, buf, 0, buf.length, lastSize)
          text = buf.toString('utf8')
        } finally {
          fs.closeSync(fd)
        }
      } catch (err) {}
      lastSize = size
      if (text) onAppend(text)
    } else {
      lastSize = size // 变小 = 轮转/重写，只记新大小不触发
    }
  }
  let watcher = null
  try {
    watcher = fs.watch(LOGS_DIR, { persistent: true }, (event, filename) => {
      const base = path.basename(file)
      if (!filename || String(filename).toLowerCase() !== base.toLowerCase()) return
      // Windows 的目录事件可能早于写入可见：稍等一拍再量大小
      if (timer) clearTimeout(timer)
      timer = setTimeout(fire, 400)
      if (timer.unref) timer.unref()
    })
    // 挂载失败/目录被替换后要能自愈：关掉并定时重挂（2026-10-14 审查 P3-H）
    watcher.on('error', (err) => {
      log('watch error on ' + LOGS_DIR + ': ' + String((err && err.message) || err))
      try {
        watcher.close()
      } catch (e) {}
      scheduleWatchRetry()
    })
  } catch (err) {
    log('watch failed on ' + LOGS_DIR + ': ' + String((err && err.message) || err))
    scheduleWatchRetry()
  }
  return watcher
}

// 重挂调度：startWatchers 会先关掉旧句柄再注册，不会叠加
let watchRetryTimer = null
function scheduleWatchRetry() {
  if (watchRetryTimer) return
  watchRetryTimer = setTimeout(() => {
    watchRetryTimer = null
    try {
      startWatchers()
    } catch (err) {
      log('watch retry failed: ' + String((err && err.message) || err))
    }
  }, 60 * 1000)
  if (watchRetryTimer.unref) watchRetryTimer.unref()
}

function startWatchers() {
  // 宿主把退出行也写进 AppStartup.log → 追加块按内容分流（classifyHostLogAppend）
  watchHostLog(APP_STARTUP_LOG, (text) => {
    if (classifyHostLogAppend(text) === 'down') noteHostDown('AppStartup.log 退出行')
    else noteHostUp('AppStartup.log append')
  })
  // 兜底保留：宿主实测不写该文件（全机不存在此文件），未来版本若开始写就直接命中
  watchHostLog(APP_SHUTDOWN_LOG, () => noteHostDown('AppShutdown.log append'))
}

// ---------- 主循环 ----------

async function tick() {
  const cfg = readPluginConfig()
  if (await honorClosePause()) return
  if (!cfg.autoStartWidget) return
  try {
    if (wbUp) {
      const running = await findRunningServer()
      if (!running) {
        await ensureWidget('tick-server-dead')
        return
      }
      // 版本哨兵：常暖服务可能跑着升级前的旧代码，换血（走 ensureWidget 里的同款守卫）
      const want = pluginVersion()
      if (running.health && running.health.version && want && running.health.version !== want) {
        await ensureWidget('tick-server-stale')
        return
      }
      if (!cfg.autoStartOverlay || !isRuntimeInstalled()) return
      const ov = await overlayStatus()
      if (ov.running) {
        overlayFails = 0
        return
      }
      // 【不要在这里"连败 3 次就放弃"】（2026-10-15 真机教训）：走到这里时 wbUp
      // 必为真（宿主退出已被日志分流正确检测、走下面的怠速分支），所以每 15s
      // 重试是安全的；而一旦加了放弃闸门，浮层自身故障（如运行时装残）会把
      // tick 打成永久沉默 —— 实测卡在 5/3 后 9 分钟无动作，用户面对的正是
      // 「挂件再也不出现」。宿主真不在的情况由下面的探测兜底转怠速。
      await ensureWidget('tick-overlay-dead')
      if (overlayFails >= OVERLAY_FAIL_LIMIT) {
        // 【区分】连续拉不起浮层 ≠ 宿主一定不在：也可能浮层自身有问题
        //（2026-10-14 实测：ELECTRON_RUN_AS_NODE 污染时宿主明明在跑，却被这条
        // 启发式判成宿主退出）。先探一次宿主再定——在跑就如实上报并继续重试。
        if (await probeHostRunning()) {
          log(
            'overlay failed x' + overlayFails + ' but host is running: overlay-side issue, keep retrying'
          )
        } else {
          noteHostDown('overlay-fails-' + overlayFails)
        }
      }
    } else {
      // 怠速期：服务保持常暖（见文件头「服务常暖」），这里只做慢探测兜底——
      // 覆盖「崩溃没写 shutdown 日志」与「启动时 host 探测误判」的漏网形态。
      if (Date.now() - lastProbeAt >= PROBE_INTERVAL_MS) {
        lastProbeAt = Date.now()
        if (await probeHostRunning()) {
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
  const ov = probeHostRunning()
    .then((up) => {
      wbUp = up
      return overlayStatus()
    })
    .then((s) => {
    if (s.running) {
      wbUp = true
      log('init: overlay alive (pid ' + s.pid + '), assume host up')
    }
    log('init: wbUp=' + wbUp + ' pid=' + process.pid)
    // 无论宿主在不在都把服务暖起来（宿主不在时只暖服务、不起浮层，见 ensureWidget
    // 里的 wbUp 门）——这是「启动 WB 后要等十来秒才见挂件」的解药
    scheduleEnsure('init')
  })
  ov.catch(() => {})

  startWatchers()
  setInterval(() => {
    tick()
  }, TICK_MS)
  log('watchdog started (tick=' + TICK_MS + 'ms)')
}

main()
