// ZCode 钩子事件 → 挂件状态文件（借鉴 CrossPet 的接入方式，做了两点取舍）。
//
// 为什么只挂两个事件：ZCode 的钩子**始终内联执行**（官方文档：async 无实效），
// 每挂一个事件就是每次触发都要起一个 node 进程（冷启动 ~40–80ms）。PreToolUse /
// PostToolUse 每次工具调用各来一发，会给用户每次工具调用都加延迟——不可接受。
// 只留低频且信息量大的两个：
//   UserPromptSubmit  —— 用户新一轮提问（=「开始干活」，也能顺手刷新会话身份）
//   PermissionRequest —— 弹出授权确认（=「在等你点确认」，唯一需要主动提醒的场景）
// 「一轮结束」我们本来就能从 ZCode 的用量库轮询到（无需钩子）。
//
// 只写一个小文件：<数据目录>/hook-state.json。失败一律静默退出 0——
// 钩子出错绝不能影响 ZCode 本身的行为（官方文档：非零退出码会被当成钩子失败）。
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths.mjs'

const STATE_FILE = path.join(DATA_DIR, 'hook-state.json')
// 等确认的工具名/事件：PermissionRequest 一定是等授权；提问类工具名兜底
const ASKING_TOOLS = ['askuserquestion', 'ask_user_question', 'request_user_input', 'clarify']

function nowSec() {
  return Math.floor(Date.now() / 1000)
}

function readState() {
  try {
    const v = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    return v && typeof v === 'object' ? v : {}
  } catch (err) {
    return {}
  }
}

function writeState(next) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    // 临时名带进程号 + rename：多个事件同时到达时不互相截断
    const tmp = STATE_FILE + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next), 'utf8')
    fs.renameSync(tmp, STATE_FILE)
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
  // 没解析出事件名 = 空输入或坏 JSON（或上游改了字段名）：直接退出，**不写文件**——
  // 否则会把上一次的真实状态覆盖成空，连带清掉「等确认」标记（自检抓到的缺陷）
  if (!name) process.exit(0)
  const tool = String(event.tool_name || '')
  const sid = String(event.session_id || '')
  const state = readState()
  const counts = state.counts && typeof state.counts === 'object' ? state.counts : {}
  counts[name] = (Number(counts[name]) || 0) + 1

  let waiting = false
  if (name === 'PermissionRequest') waiting = true
  if (name === 'PreToolUse' && ASKING_TOOLS.indexOf(tool.toLowerCase()) !== -1) waiting = true
  if (name === 'PostToolUse' || name === 'Stop' || name === 'UserPromptSubmit') waiting = false
  // 只有 UserPromptSubmit / PermissionRequest 会被挂上，waiting 的清除靠
  // 「用户提交了新一轮」（说明上一轮已经过去了）与前端的超时兜底

  writeState({
    event: name,
    tool: tool,
    sessionId: sid,
    ts: nowSec(),
    waiting: waiting,
    counts: counts,
  })
} catch (err) {}

process.exit(0)
