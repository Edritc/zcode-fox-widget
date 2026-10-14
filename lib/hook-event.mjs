// WorkBuddy 钩子事件 → 挂件状态文件（借鉴 CrossPet 的接入方式，做了两点取舍）。
//
// 为什么只挂低频事件：WorkBuddy 的钩子**始终内联执行**，每挂一个事件就是每次触发
// 都要起一个 node 进程（冷启动 ~40–80ms）。PreToolUse / PostToolUse 每次工具调用
// 各来一发，会给用户每次工具调用都加延迟——不可接受。所以当前只挂三个：
//   SessionStart     —— 幂等拉起服务（在 autostart.mjs，不在这里）
//   UserPromptSubmit —— 用户新一轮提问（=「开始干活」），**同时刷新会话身份**
//   Notification     —— 宿主发通知（=「在等你确认」的候选事件源）
//
// `hook_event_name` 的处理**额外兼容** PreToolUse / PostToolUse / Stop / SessionEnd：
// 它们当前没挂，但将来做「姿势状态机」时 PostToolUse 是主要数据面（见
// MIGRATION-PLAN §4.1.3）。届时记得那里的前置依赖是**噪音过滤**
//（用 sessions.is_background_automation 跳过后台轮次），否则角色会被后台任务带得乱动。
//
// **会话身份是本文件最重要的产出**：每轮消耗、上下文余量、当前模型全都要知道
// 「现在这个会话是哪个」。宿主在钩子 stdin 里给了 session_id 与 transcript_path，
// 把它们落进 hook-state.json，挂件服务就能用 lib/turn-cost.mjs 直接定位数据。
//
// 事件表差异（承 HANDOFF §5.3）：WorkBuddy **没有 PermissionRequest 事件**，
// 所以「等确认提醒」改挂 Notification——它是唯一语义接近的候选，但它也会在
// 别的通知上触发，属于**已知的过度触发**（前端默认关闭该提醒，开启时另做去重）。
//
// 只写一个小文件：<数据目录>/hook-state.json。失败一律静默退出 0——
// 钩子出错绝不能影响 WorkBuddy 本身的行为（非零退出码会被当成钩子失败）。
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, HOOK_STATE_FILE } from './paths.mjs'

// 等确认的触发事件（WorkBuddy 没有 PermissionRequest，用 Notification 顶）
const ASKING_EVENTS = ['Notification', 'PermissionRequest']
// 提问类工具名兜底（PreToolUse 挂着的时候才有用，当前未挂，留作将来）
const ASKING_TOOLS = ['askuserquestion', 'ask_user_question', 'request_user_input', 'clarify']
// 明确表示「上一轮已经过去」的事件
const CLEARING_EVENTS = ['UserPromptSubmit', 'Stop', 'SessionEnd']

function nowSec() {
  return Math.floor(Date.now() / 1000)
}

function readState() {
  try {
    const v = JSON.parse(fs.readFileSync(HOOK_STATE_FILE, 'utf8'))
    return v && typeof v === 'object' ? v : {}
  } catch (err) {
    return {}
  }
}

function writeState(next) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    // 临时名带进程号 + rename：多个事件同时到达时不互相截断
    const tmp = HOOK_STATE_FILE + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next), 'utf8')
    fs.renameSync(tmp, HOOK_STATE_FILE)
  } catch (err) {}
}

// 排查用（默认关）：FOX_WIDGET_HOOK_DEBUG=1 时把每次事件追加到 hook.log。
// 这是「钩子到底有没有被触发」的第一手证据——项目历史上最大的时间浪费之一
// 就是「以为钩子生效了」（HANDOFF §9.2）。
function debugLog(line) {
  if (process.env.FOX_WIDGET_HOOK_DEBUG !== '1') return
  try {
    const file = path.join(DATA_DIR, 'hook.log')
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.appendFileSync(file, new Date().toISOString() + ' ' + line + '\n', 'utf8')
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    if (lines.length > 300) fs.writeFileSync(file, lines.slice(-300).join('\n') + '\n', 'utf8')
  } catch (err) {}
}

function readStdin() {
  try {
    const buf = fs.readFileSync(0) // fd 0 = stdin；没有输入时返回空
    const text = buf.toString('utf8')
    if (!text.trim()) return null
    return JSON.parse(text)
  } catch (err) {
    return null
  }
}

try {
  const event = readStdin() || {}
  const name = String(event.hook_event_name || '')
  // 没解析出事件名 = 空输入或坏 JSON（或宿主改了字段名）：直接退出，**不写文件**——
  // 否则会把上一次的真实状态覆盖成空，连带清掉「等确认」标记与会话身份。
  debugLog('event=' + (name || '(none)') + ' parsed=' + (event && event.session_id ? 'yes' : 'no'))
  if (!name) process.exit(0)

  const tool = String(event.tool_name || '')
  const state = readState()
  const counts = state.counts && typeof state.counts === 'object' ? state.counts : {}
  counts[name] = (Number(counts[name]) || 0) + 1

  // 会话身份：有就给，没有就保留上一次的（Stop/Notification 等事件都带）
  const sid = String(event.session_id || '') || String(state.sessionId || '')
  const transcript = String(event.transcript_path || '') || String(state.transcriptPath || '')
  const cwd = String(event.cwd || '') || String(state.cwd || '')
  const permissionMode = String(event.permission_mode || '') || String(state.permissionMode || '')

  let waiting = false
  if (ASKING_EVENTS.indexOf(name) !== -1) waiting = true
  if (name === 'PreToolUse' && ASKING_TOOLS.indexOf(tool.toLowerCase()) !== -1) waiting = true
  if (CLEARING_EVENTS.indexOf(name) !== -1) waiting = false
  // waiting 的清除靠「用户提交了新一轮」（说明上一轮已经过去了）与前端的超时兜底

  // Notification 的原始载荷留一份（掩掉可能含密钥的长文本），方便核实
  // 「Notification 到底是不是只在等确认时才发」——这是 §三.3 的待验证项。
  let noteKind = ''
  if (name === 'Notification') {
    const raw = event.message || event.notification || event.notification_type || ''
    noteKind = String(raw).slice(0, 200)
  }

  writeState({
    event: name,
    tool: tool,
    sessionId: sid,
    transcriptPath: transcript,
    cwd,
    permissionMode,
    ts: nowSec(),
    waiting,
    notification: noteKind || undefined,
    counts,
  })
} catch (err) {}

process.exit(0)
