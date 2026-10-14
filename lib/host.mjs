// 宿主适配层：本插件与 WorkBuddy 之间**所有**宿主差异的唯一落点。
//
// 为什么单独一个文件：这个仓库是「同仓双分支」——`main` 分支跑 ZCode、`workbuddy`
// 分支跑 WorkBuddy，共享内核（widget.js / server.mjs / pricing.mjs / vendors.mjs /
// balance.mjs / desktop/）占七成以上。把宿主差异集中在这里，`git merge main` 时
// 冲突面从「十几个文件散落的硬编码」缩到本文件 + 少数 import 行。
//
// 本文件里的结论都来自 2026-10-14 对本机 WorkBuddy 5.8.2 的实测（见
// docs/porting/phase-0.md）。宿主升级后需要重跑验证。
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

export const HOST_NAME = 'workbuddy'
export const HOST_LABEL = 'WorkBuddy'
// 日志前缀：服务/MCP 的 stderr 诊断行用它，便于与宿主自身日志区分
export const LOG_PREFIX = '[fox-widget]'

// ---------- 宿主用户目录 ----------
//
// 【实测】WorkBuddy 的用户数据根是 ~/.workbuddy（`configDir`），环境变量可覆盖，
// 便于测试与多 profile 隔离。注意这只在 WorkBuddy 分支上存在——ZCode 分支对应的是
// 它自己的用户目录（名字不同、语义相同）。
export const HOST_HOME = process.env.CODEBUDDY_HOME || path.join(os.homedir(), '.workbuddy')

// ---------- 插件数据目录 ----------
//
// 【实测 / 来自宿主代码】宿主这样算插件数据目录：
//   getPluginDataDirectory(pluginId, join(configDir, 'plugins'))
//     = <configDir>/plugins/data/<pluginId 里非 [A-Za-z0-9-_] 的字符换成 '-'>
//   其中 pluginId = `<插件名>@<市场名>`。
// 宿主的 MCP 进程会把结果作为 `CODEBUDDY_PLUGIN_DATA` 注入环境变量；但**钩子与
// 命令行**未必有该变量，所以这里必须能自己算出来（否则钩子会写到一个宿主不认识
// 的目录里去）。
export const PLUGIN_NAME = 'fox-widget'
export const MARKETPLACE_NAME = 'fox-local'
export const PLUGIN_ID = PLUGIN_NAME + '@' + MARKETPLACE_NAME

function sanitizePluginDataId(id) {
  return String(id).replace(/[^a-zA-Z0-9\-_]/g, '-')
}

function defaultPluginDataDir() {
  return path.join(HOST_HOME, 'plugins', 'data', sanitizePluginDataId(PLUGIN_ID))
}

// FOX_WIDGET_DATA_DIR 供测试/排查强制指定（优先级最高）。
export const PLUGIN_DATA_DIR =
  process.env.FOX_WIDGET_DATA_DIR || process.env.CODEBUDDY_PLUGIN_DATA || defaultPluginDataDir()

// ---------- 宿主会话数据 ----------
//
// 【实测】宿主把「每个会话的上下文占用 + 每次请求消耗的积分」落在一张 sqlite 表里：
//   <HOST_HOME>/workbuddy.db  →  session_usage(session_id, used, size, updated_at, credit_json)
//                              sessions(id, cwd, model, is_background_automation, title, ...)
//   credit_json = {"<conversationRequestId>": <credit>}，积分由宿主算好，直接用即可。
// 库带 WAL：**只读打开**，且测试一律先 copy 再读（见 HANDOFF 的红线）。
export const HOST_DB_FILE = path.join(HOST_HOME, 'workbuddy.db')

// 【实测】会话 transcript 落在 <HOST_HOME>/projects/<cwd 的 slug>/<sessionId>.jsonl，
// 每行一条事件；模型调用事件带 providerData.rawUsage（含宿主算好的 credit）与
// requestModelId / conversationRequestId。这是宿主给的最好的数据源。
export const HOST_PROJECTS_DIR = path.join(HOST_HOME, 'projects')

// ---------- 宿主配置 / 凭据候选位 ----------
//
// 【实测】本机 WorkBuddy 上**找不到**用户自带的厂商凭据存储：
//   - settings.json 的 pluginConfigs 为空对象、models.json 为 []
//   - 模型全部由宿主托管（订阅积分制），不需要用户填 key
// 所以厂商卡（34 家模板）在 WorkBuddy 上默认是「无凭据 → 不可用」，这是**预期行为**
// 而不是 bug。下面这些路径仍然枚举出来，是因为用户有可能自己往里填（例如用
// ${CODEBUDDY_PLUGIN_DATA}/config.json 的 vendorKeys，或往 settings.json 的 env 里
// 放 DEEPSEEK_API_KEY）。探测不到时错误文案会如实列出「探过哪些地方」。
export const HOST_SETTINGS_FILE = path.join(HOST_HOME, 'settings.json')
export const HOST_MODELS_FILE = path.join(HOST_HOME, 'models.json')
// 各插件自己的数据目录（连接器插件可能把 apiKey 写在自己的 config.json 里）
export const HOST_PLUGIN_DATA_DIR = path.join(HOST_HOME, 'plugins', 'data')

// ---------- 宿主主题 ----------//
// 【实测】主题存在 <HOST_HOME>/storage/user-<uid>-personal/global/preferences.json，
// 形如 {"theme":"light"|"dark"|"system", "appearance.themeSelection":{...}}。
// uid 因账号而异，所以按 glob 扫描目录而不是写死（可能有多个 user-* 目录）。
export function hostPreferenceFiles() {
  const out = []
  const storage = path.join(HOST_HOME, 'storage')
  let entries = []
  try {
    entries = fs.readdirSync(storage, { withFileTypes: true })
  } catch (err) {
    return out
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name !== 'user' && !e.name.startsWith('user-')) continue
    out.push(path.join(storage, e.name, 'global', 'preferences.json'))
  }
  return out
}

// ---------- 宿主进程识别（桌面浮层跟随用） ----------
//
// 【实测/未验证】WorkBuddy 桌面端主进程可执行名是 `WorkBuddy.exe`（安装目录
// E:\WorkBuddy\WorkBuddyAI）。UI 就是 Electron，浮层的跟随/穿透手法可原样沿用。
export const HOST_PROCESS_NAME = 'WorkBuddy'
// 浮层窗口标题：只用于人工辨识与 owner 关系，不参与跟随判定
export const OVERLAY_WINDOW_TITLE = 'WorkBuddy狐娘小挂件'

// 宿主日志追加块的分流（纯函数，供看门狗单测）。
//
// 【关键事实】宿主把 `[AppShutdown]` 退出行**也写进 AppStartup.log** —— 本机实测
// 全盘不存在 AppShutdown.log，[AppShutdown] 行 30 条全在 AppStartup.log 里
//（2026-10-14 审查 P0-1：看门狗只比文件大小，把宿主退出当成了宿主启动，退出语义
// 整体反转）。规则：以新增块里**最后一条**可判别行为准（成串追加时最后一行最能
// 代表当前状态——「退出后又启动」的最后一行是活动行）；判别不了按活动处理（宽进，
// 与旧行为一致）。
export function classifyHostLogAppend(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/\[AppShutdown\]/.test(lines[i])) return 'down'
    if (/\[(AppStartup|Perf|DocumentSelectionHook)\]/.test(lines[i])) return 'up'
  }
  return 'up'
}

// 【不要在这里加"按插件名匹配命令行"的单例判据】2026-10-14 真机事故：曾用
// 「两个插件名的子串标记表」做浮层去重，但 'fox-widget' 是 'zcode-fox-widget' 的
// **子串**，结果 WB 版把 ZCode 版的浮层当重复实例杀掉（跨产品线互杀）。浮层单例
// 现在按「本插件数据目录的运行时」认亲（lib/overlay.mjs 的
// OVERLAY_MARKER_DIR / isOwnOverlayCommandLine），跨产品线天然隔离、同线多副本
// 依然去重。这里特意不保留那个常量，防止再被捡起来用。

// ---------- 环境变量名 ----------
// 插件自己的环境变量统一用 FOX_WIDGET_ / WHALE_ 前缀（whale 是本挂件的内部代号），
// 不带宿主名，跨分支合并时不需要改。
export const ENV = {
  port: 'FOX_WIDGET_PORT',
  dataDir: 'FOX_WIDGET_DATA_DIR',
  overlayPort: 'WHALE_PORT',
  targetProcess: 'WHALE_TARGET_PROCESS',
  followInterval: 'WHALE_FOLLOW_INTERVAL_MS',
  disableUpdateCheck: 'WHALE_DISABLE_UPDATE_CHECK',
  npmRegistry: 'WHALE_NPM_REGISTRY',
}

// 宿主注入的插件目录变量名（MCP 进程里一定有；钩子里由宿主展开 ${...} 字面量）
export const ENV_PLUGIN_ROOT = 'CODEBUDDY_PLUGIN_ROOT'
export const ENV_PLUGIN_DATA = 'CODEBUDDY_PLUGIN_DATA'

// 拉起挂件服务时用的 node（PATH 里取；可用环境变量指向绝对路径兜底）
export const HOST_NODE_BIN = 'FOX_WIDGET_NODE'
// /whale/health 的 app 标识。**只在 host.mjs 定义一次**：server.mjs 写它、
// service.mjs 校验它，两处不一致会让 findRunningServer 永远找不到在跑的服务。
export const HOST_APP_ID = 'fox-widget'
