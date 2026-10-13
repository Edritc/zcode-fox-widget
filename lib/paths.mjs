// 插件内的所有路径解析。集中在这里，方便迁移与调试。
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// lib/paths.mjs -> 插件根目录
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const ASSETS_DIR = path.join(PLUGIN_ROOT, 'assets')

// 版本号单一来源：插件清单 .zcode-plugin/plugin.json。/whale/health、MCP 握手、
// 插件页展示的是同一个版本；marketplace.json 的副本由 selftest 的三处一致性
// 断言兜底（审查 P2-2：server.mjs 曾硬编码 VERSION，与清单存在漂移风险）。
export function pluginVersion() {
  try {
    const raw = fs.readFileSync(path.join(PLUGIN_ROOT, '.zcode-plugin', 'plugin.json'), 'utf8')
    const v = JSON.parse(raw).version
    if (typeof v === 'string' && v.trim()) return v.trim()
  } catch (err) {}
  return '0.0.0'
}

// ZCode 用户目录。环境变量可覆盖，便于测试与多profile隔离。
export const ZCODE_HOME = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode')

// 插件自己的数据目录：配置、账本、挂件状态、运行信息都写这里
export const DATA_DIR = path.join(ZCODE_HOME, 'whale')

// 用户配置（apiKey / platformToken / port / usageMode 等）
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
// 挂件外观与开关（等价于上游的 .dshw-size.json）
export const WIDGET_STATE_FILE = path.join(DATA_DIR, 'widget-state.json')
// 记账模式账本（等价于上游的 .dshw-usage.json）
export const LEDGER_FILE = path.join(DATA_DIR, 'usage-ledger.json')
// 挂件服务运行信息（pid / port / url），供命令与 MCP 复用同一个服务
export const SERVER_INFO_FILE = path.join(DATA_DIR, 'server.json')
// 服务日志（启动失败时排查用）
export const SERVER_LOG_FILE = path.join(DATA_DIR, 'server.log')
// 每轮消耗气泡的 seq 计数（服务重启后续号，前端靠它区分"新的一轮"）
export const TURN_SEQ_FILE = path.join(DATA_DIR, 'turn-seq.json')
// 自定义角色：图片目录 + 索引（角色上传/选择，见 server.mjs 的 roles 路由）
export const ROLES_DIR = path.join(DATA_DIR, 'roles')
export const ROLES_INDEX_FILE = path.join(DATA_DIR, 'roles.json')
// 导入的音效集：音频文件目录 + 索引（内置集在 SOUND_SETS，导入集在这里）
export const SOUNDS_DIR = path.join(DATA_DIR, 'sounds')
export const SOUNDS_INDEX_FILE = path.join(DATA_DIR, 'sounds.json')
// 按压泡泡队列（对应上游的 .dshw-bubble.json；v1.3.0 为文字队列，v1.5.0 起 v2 点击队列）
export const BUBBLE_CONTENT_FILE = path.join(DATA_DIR, 'bubble-content.json')
// 泡泡模板：每轮消耗 / 预警的可编辑内容（null = 内置默认文案）
export const BUBBLE_TEMPLATES_FILE = path.join(DATA_DIR, 'bubble-templates.json')
// 泡泡图库：图片/随机图片模块的素材目录 + 索引（内置 rua 用包内素材）
export const BUBBLE_IMGS_DIR = path.join(DATA_DIR, 'bubble-imgs')
export const BUBBLE_IMGS_INDEX_FILE = path.join(DATA_DIR, 'bubble-imgs.json')

// ZCode 的会话数据库：turn_usage / model_usage 表提供每轮真实 token 用量
export const DB_FILE = path.join(ZCODE_HOME, 'cli', 'db', 'db.sqlite')
// 模型 I/O 日志目录：读不到数据库时的兜底数据源
export const ROLLOUT_DIR = path.join(ZCODE_HOME, 'cli', 'rollout')
// ZCode 客户端配置：用于发现用户已经配好的 DeepSeek provider 凭据
export const ZCODE_CLIENT_CONFIG = path.join(ZCODE_HOME, 'v2', 'config.json')

// v2 数据目录候选（Plan 日志尾随与凭据发现共用）。数据目录迁移后，ZCode 进程内
// 拉起的服务靠 ZCODE_DATA_BASE_DIR 定位新目录；普通终端没有该变量，只能退回
// ~/.zcode——迁移场景下旧目录可能只剩历史残留，调用方应把实际探测结果如实
// 报出来（见 plan-balance.mjs 的 probedDirs），别让"没数据"和"找错目录"混在一起。
export function v2DataDirCandidates() {
  const dirs = []
  const base = String(process.env.ZCODE_DATA_BASE_DIR || '').trim()
  if (base) dirs.push(path.join(base, '.zcode', 'v2'))
  dirs.push(path.join(ZCODE_HOME, 'v2'))
  return dirs
}

// 内置角色：嘎啦嘛为默认形象（安装即选中，替代旧「默认」语义），
// 大肥鱼即原「默认」的鲸鱼形象；GPT 娘 / kimi 娘 / 小克为项目自有素材
//（2026-10-06/07 收录）。五套内置角色各有专属台词包（大肥鱼那套是默认套，
// 用户导入的角色也用它）。roles.json 只存用户上传的角色。
// 嘎啦嘛 id 曾用 xiaohuniang（v1.7.3 及之前）：持久化里出现的旧值按
// BUILTIN_ROLE_RENAMES 在读取侧归一，不要求用户手改配置。
export const BUILTIN_ROLES = [
  { id: 'fox', name: '嘎啦嘛', image: path.join(ASSETS_DIR, 'GLM.png') },
  { id: 'whale', name: '大肥鱼', image: path.join(ASSETS_DIR, 'DSniang1.png') },
  { id: 'gpt', name: 'GPT娘', image: path.join(ASSETS_DIR, 'gpt.png') },
  { id: 'kimi', name: 'kimi娘', image: path.join(ASSETS_DIR, 'kimi.png') },
  { id: 'xiaoke', name: '小克', image: path.join(ASSETS_DIR, 'xiaoke.png') },
]
export const DEFAULT_ROLE_ID = 'fox'
export const BUILTIN_ROLE_RENAMES = { xiaohuniang: 'fox' }

// 模型名 → 内置角色（「按模型自动换角色」用，2026-10-13 借鉴 CrossPet 的思路）。
// 匹配方式是**小写子串**：ZCode 的模型标识是 `<providerId>/<modelId>` 拼串
//（如 `deepseek/deepseek-flash`、`cmdgo-bridge/claude-sonnet-5-5`、
// `account:zai-start-plan/GLM-5.3-Flash`），既有网关前缀也有套餐前缀，只有子串
// 匹配能同时罩住。认不出的模型一律**不动**当前角色（宁可保持现状，也不乱换人）。
// 映射依据：fox 的立绘就是 GLM.png（GLM 族）、whale 是原版鲸鱼（DeepSeek 族）、
// gpt / kimi 各自同名，xiaoke 按「小克 ≈ Claude 谐音」归给 Claude 族。
export const MODEL_ROLE_RULES = [
  { roleId: 'fox', keywords: ['glm', 'zhipu', 'chatglm', 'z.ai', 'zai-', 'bigmodel'] },
  { roleId: 'whale', keywords: ['deepseek'] },
  { roleId: 'gpt', keywords: ['gpt', 'openai', 'chatgpt', 'o1-', 'o3-', 'o4-', 'codex'] },
  { roleId: 'kimi', keywords: ['kimi', 'moonshot'] },
  { roleId: 'xiaoke', keywords: ['claude', 'anthropic'] },
]

// 只做纯字符串判定，不碰文件系统（可用性由调用方按角色列表再判一次）
export function roleIdForModel(model) {
  const m = String(model || '').toLowerCase()
  if (!m) return null
  for (const rule of MODEL_ROLE_RULES) {
    for (const kw of rule.keywords) {
      if (m.indexOf(kw) !== -1) return rule.roleId
    }
  }
  return null
}

// 最终兜底：首选 DSniang1.png，回退 DSniang02.png（与上游一致）
export const IMAGE_CANDIDATES = [
  path.join(ASSETS_DIR, 'DSniang1.png'),
  path.join(ASSETS_DIR, 'DSniang02.png'),
]
export const GIF_CANDIDATES = [path.join(ASSETS_DIR, 'rua.gif')]

// 按压/松手音效，两套可选（duck=小黄鸭，fx1=音效1）
export const SOUND_SETS = {
  duck: {
    press: [path.join(ASSETS_DIR, 'Ya1.mp3')],
    release: [path.join(ASSETS_DIR, 'Ya2.mp3')],
  },
  fx1: {
    press: [path.join(ASSETS_DIR, 'D1.mp3')],
    release: [path.join(ASSETS_DIR, 'D2.mp3')],
  },
}

// 内置音效集在界面上的名字（导入集的名字存在索引里）
export const BUILTIN_SOUND_NAMES = { duck: '小黄鸭', fx1: '音效1' }

export const DEFAULT_PORT = 39321
