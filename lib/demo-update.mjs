// 演示模式：把「检测到新版本 → 下载 → 完成」这条流程用**模拟数据**跑一遍，给录宣传片用。
// 三条硬约束（写在最前面，改动时别破坏）：
//   1) 不出网：全程 setTimeout，不调用 checkForUpdate / downloadTarball / runUpdate
//   2) 不落真实状态：真正的 update-state.json 一个字节都不动，这里只写 update-demo.json
//   3) 随时可回滚：`cli demo off`（或 POST action=demo-off）立刻恢复正常；代码自成一模块，
//      删掉本文件 + server.mjs 里三处 gated 分支 + 面板那个按钮，就回到线上行为
//
// 文案与字段**照抄真实流程**（lib/update.mjs 的 runUpdate 与 readUpdateState 的载荷形状），
// 面板不改一行也能渲染出与真实更新完全一致的界面（"不要加字少字"）。
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths.mjs'

const DEMO_FILE = path.join(DATA_DIR, 'update-demo.json')
// 「当前版本」按演示需要往前写；「检测到」的目标版本固定为 1.3.0
export const DEMO_CURRENT = '1.2.0'
export const DEMO_LATEST = '1.3.0'
const DOWNLOAD_MS = 5000 // 模拟下载时长（真实下载 60–240s，这里固定 5s 好录）

// 直读配置文件，**不走 readPluginConfig**：那个函数带短 TTL 缓存，刚写下的开关要立刻生效，
// 否则第一枪 GET/update 会落到真实更新分支上（真去下载、真写状态）。
export function demoEnabled() {
  if (String(process.env.WHALE_DEMO_UPDATE || '') === '1') return true
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'))
    return !!(cfg && cfg.demoUpdate === true)
  } catch (err) {
    return false
  }
}

export function readDemo() {
  try {
    const s = JSON.parse(fs.readFileSync(DEMO_FILE, 'utf8'))
    return s && s.demo ? s : null
  } catch (err) {
    return null
  }
}

function writeDemo(state) {
  try {
    if (state) fs.writeFileSync(DEMO_FILE, JSON.stringify(state, null, 2), 'utf8')
    else fs.unlinkSync(DEMO_FILE)
  } catch (err) {}
  return state
}

let timer = null
function clearTimer() {
  if (timer) clearInterval(timer)
  timer = null
}

// 开始演示：进入「检测到 v1.3.0」那一屏（面板状态与真实 checkForUpdate 命中时同形）
export function startDemo() {
  clearTimer()
  return writeDemo({
    demo: true,
    active: true,
    version: DEMO_CURRENT, // 面板「当前版本」那一栏读的是 version
    current: DEMO_CURRENT,
    latest: DEMO_LATEST,
    available: true,
    busy: false,
    phase: null,
    progress: 0,
    message: '',
    error: null,
    appliedVersion: null,
    appliedAt: null,
    skipped: null,
    skipActive: false,
    // 与真实流程一致：notified 为 null → 前端按「这个版本还没提醒过」弹一次提醒气泡
    notified: null,
    checkedAt: Date.now(),
    source: 'demo',
    startedAt: Date.now(),
  })
}

// 模拟下载 + 完成：进度 0→80 走 5 秒，然后「替换文件」→「已更新到 v1.3.0（重启挂件后生效）」
export function demoUpdate() {
  const s = readDemo()
  if (!s) return { ok: false, error: '演示未开始' }
  clearTimer()
  const startedAt = Date.now()
  writeDemo({
    ...s,
    busy: true,
    phase: 'downloading',
    progress: 0,
    message: '正在下载 v' + DEMO_LATEST, // 与 update.mjs 的真实文案一致
    error: null,
  })
  timer = setInterval(() => {
    const elapsed = Date.now() - startedAt
    const ratio = Math.min(1, elapsed / DOWNLOAD_MS)
    const cur = readDemo()
    if (!cur) {
      clearTimer()
      return
    }
    if (ratio < 1) {
      writeDemo({ ...cur, progress: Math.round(ratio * 80), message: '正在下载 v' + DEMO_LATEST })
      return
    }
    clearTimer()
    // 第一阶段完成 → 「替换文件」→ 完成态（0.6s 后落定，和真实落盘耗时观感一致）
    writeDemo({ ...cur, progress: 80, message: '正在替换文件（完整性校验已通过）', phase: 'applying' })
    timer = setTimeout(() => {
      const last = readDemo()
      timer = null
      if (!last) return
      writeDemo({
        ...last,
        busy: false,
        phase: 'done',
        progress: 100,
        message: '已更新到 v' + DEMO_LATEST + '（重启挂件后生效）',
        appliedVersion: DEMO_LATEST,
        appliedAt: Date.now(),
        available: false,
        skipped: null,
        skipActive: false,
        notified: null,
      })
    }, 600)
    if (timer && timer.unref) timer.unref()
  }, 250)
  if (timer && timer.unref) timer.unref()
  return { ok: true, state: readDemo() }
}

// 「跳过此版本」：只改演示状态里的 skipActive，不碰真实的 widget-state（真实跳过会持久化）
export function demoSkip() {
  const s = readDemo()
  if (!s) return { ok: false, error: '演示未开始' }
  const next = { ...s, skipActive: !s.skipActive, skipped: s.skipActive ? null : DEMO_LATEST }
  writeDemo(next)
  return { ok: true, state: next }
}

// 结束演示：删掉演示状态文件；真实 update-state.json 从未被碰过
export function stopDemo() {
  clearTimer()
  writeDemo(null)
  return { ok: true }
}
