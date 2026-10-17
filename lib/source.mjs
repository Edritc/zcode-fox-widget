// 计费源解析：把「providerId / modelId / 有效 baseURL」映射到统一计费口径。
// 智能跟随（/whale/session.json）、气泡主显示、每轮消耗展示都走这一套判据，
// 保证「对话栏选了什么」与「气泡显示哪个源」永远一致。
//
// 判据优先级：
//   1. 订阅/套餐型 providerId（account:*plan* / *coding-plan*）→ Plan 配额口径
//   2. 有效 baseURL 域名（能区分 MiMo 的 api/plan 双端点）
//   3. providerId 关键词
//   4. model_id 前缀（网关转发时只有模型名指向真正厂商）
//   5. 全未知 → 'tokens'（只显示消耗量，**不冒充任何厂商的余额**）
//
// **WorkBuddy 分支的额外口径**：WorkBuddy 是订阅积分制，模型全部由宿主托管，
// 没有「用户自带 key 的按量厂商」这回事。所以主显示固定走 `credits`
// （见 resolveHostBillingSource 与 server.mjs 的 readSessionSource）；
// 下面的厂商判据在 WorkBuddy 侧只用于两件事：
//   a) 给每一轮标一个「厂商」标签（气泡里的小字、用量记录的模型排名分组）；
//   b) 用户**自己配了**某厂商 API Key 时，那张厂商卡才有意义。

const SOURCE_DEFS = {
  // WorkBuddy 主口径：宿主算好的订阅积分。currency 用 'CREDIT' 标记，
  // 展示层见到它就不加货币符号（见 turn-cost.mjs 的 CREDIT_CURRENCY）。
  credits: { source: 'credits', vendor: null, label: '订阅积分', currency: 'CREDIT', timeMode: 'none' },
  plan: { source: 'plan', vendor: 'zcode-plan', label: 'GLM Plan 配额', currency: 'CNY', timeMode: 'none' },
  // CommandCode 套餐（月度池 + 5小时/周窗口；反代或官方 API provider 接入）：
  // 主显示走三重额度卡片；行级计价仍按模型名走 pricing（per-call 真金白银口径另议）
  cmdgo: { source: 'cmdgo', vendor: 'commandcode', label: 'CommandCode', currency: 'USD', timeMode: 'none' },
  glm: { source: 'glm', vendor: 'glm', label: 'GLM 按量', currency: 'CNY', timeMode: 'none' },
  ds: { source: 'ds', vendor: 'deepseek', label: 'DeepSeek 余额', currency: 'CNY', timeMode: 'peak-valley' },
  'mimo-api': { source: 'mimo-api', vendor: 'mimo', label: 'MiMo API', currency: 'CNY', timeMode: 'none' },
  // Token Plan（token-plan-cn.xiaomimimo.com）：订阅额度，夜间 0.8x 消耗系数
  'mimo-plan': { source: 'mimo-plan', vendor: 'mimo', label: 'MiMo Plan', currency: 'CNY', timeMode: 'offpeak-x0.8' },
  openai: { source: 'openai', vendor: 'openai', label: 'OpenAI', currency: 'USD', timeMode: 'none' },
  claude: { source: 'claude', vendor: 'anthropic', label: 'Claude', currency: 'USD', timeMode: 'none' },
  gemini: { source: 'gemini', vendor: 'gemini', label: 'Gemini', currency: 'USD', timeMode: 'none' },
  qwen: { source: 'qwen', vendor: 'qwen', label: 'Qwen', currency: 'CNY', timeMode: 'none' },
  minimax: { source: 'minimax', vendor: 'minimax', label: 'MiniMax', currency: 'CNY', timeMode: 'none' },
  kimi: { source: 'kimi', vendor: 'kimi', label: 'Kimi', currency: 'CNY', timeMode: 'none' },
  // WorkBuddy 宿主上的几个新厂商族（2026-10-14 实测模型列表见 docs/porting/phase-0.md）：
  // hy4/hy3 = 腾讯混元，step-5 = 阶跃星辰。它们都**没有**内置角色立绘，
  // 因此只做标签识别，不参与 MODEL_ROLE_RULES（按模型换角色那里有意留空）。
  hunyuan: { source: 'hunyuan', vendor: 'hunyuan', label: '腾讯混元', currency: 'CNY', timeMode: 'none' },
  stepfun: { source: 'stepfun', vendor: 'stepfun', label: '阶跃星辰', currency: 'CNY', timeMode: 'none' },
  tokens: { source: 'tokens', vendor: null, label: '未知来源', currency: null, timeMode: 'none' },
}

export function sourceDef(source) {
  return SOURCE_DEFS[source] || SOURCE_DEFS.tokens
}

function hostnameOf(baseUrl) {
  try {
    return new URL(String(baseUrl || '')).hostname.toLowerCase()
  } catch (err) {
    return ''
  }
}

function modelBasename(modelId) {
  const m = String(modelId || '').trim().toLowerCase()
  const slash = m.lastIndexOf('/')
  return slash === -1 ? m : m.slice(slash + 1)
}

function sourceByHost(host) {
  if (!host) return null
  // MiMo 双端点：Token Plan 与按量 API 是两个不同域名，先精确后模糊
  if (host === 'token-plan-cn.xiaomimimo.com' || host.startsWith('token-plan')) return 'mimo-plan'
  if (host.endsWith('xiaomimimo.com') || host === 'mimo.mi.com' || host.endsWith('.mimo.mi.com')) return 'mimo-api'
  if (host === 'api.deepseek.com' || host.endsWith('.deepseek.com')) return 'ds'
  if (host === 'open.bigmodel.cn' || host.endsWith('.bigmodel.cn') || host === 'api.z.ai' || host.endsWith('.z.ai')) return 'glm'
  if (host === 'api.openai.com' || host.endsWith('.openai.com')) return 'openai'
  if (host === 'api.anthropic.com' || host.endsWith('.anthropic.com') || host === 'claude.ai' || host.endsWith('.claude.ai')) return 'claude'
  // Gemini API 与 Vertex AI 两个官方端点（OpenAI 兼容层也挂在 generativelanguage 下）
  if (host === 'generativelanguage.googleapis.com' || host.endsWith('.generativelanguage.googleapis.com')) return 'gemini'
  if (host === 'aiplatform.googleapis.com' || host.endsWith('.aiplatform.googleapis.com')) return 'gemini'
  if (host.indexOf('dashscope') !== -1) return 'qwen'
  if (host.endsWith('minimaxi.com') || host.endsWith('minimax.io')) return 'minimax'
  if (host === 'api.moonshot.cn' || host.endsWith('.moonshot.cn') || host.endsWith('.moonshot.ai') || host === 'kimi.com' || host.endsWith('.kimi.com')) return 'kimi'
  return null
}

function sourceByProviderId(pid) {
  if (!pid) return null
  if (pid.indexOf('start-plan') !== -1 || pid.indexOf('coding-plan') !== -1 || pid.indexOf('zcode-plan') !== -1) return 'plan'
  if (pid.indexOf('bigmodel') !== -1 || pid.indexOf('zhipu') !== -1 || pid.indexOf('glm') !== -1 || pid.indexOf('zai') !== -1) return 'glm'
  if (pid.indexOf('deepseek') !== -1) return 'ds'
  if (pid.indexOf('mimo') !== -1 || pid.indexOf('xiaomi') !== -1) return 'mimo-api'
  if (pid.indexOf('openai') !== -1 || pid.indexOf('gpt') !== -1) return 'openai'
  if (pid.indexOf('anthropic') !== -1 || pid.indexOf('claude') !== -1) return 'claude'
  if (pid.indexOf('qwen') !== -1 || pid.indexOf('dashscope') !== -1 || pid.indexOf('bailian') !== -1) return 'qwen'
  if (pid.indexOf('minimax') !== -1) return 'minimax'
  if (pid.indexOf('kimi') !== -1 || pid.indexOf('moonshot') !== -1) return 'kimi'
  if (pid.indexOf('gemini') !== -1 || pid.indexOf('google') !== -1) return 'gemini'
  return null
}

function sourceByModel(modelId) {
  const m = modelBasename(modelId)
  if (!m) return null
  if (m.indexOf('deepseek') !== -1) return 'ds'
  if (m.indexOf('glm') === 0) return 'glm'
  if (m.indexOf('mimo') !== -1) return 'mimo-api'
  if (m.indexOf('gpt') === 0 || m.indexOf('o1') === 0 || m.indexOf('o3') === 0 || m.indexOf('o4') === 0 || m.indexOf('codex') !== -1) return 'openai'
  if (m.indexOf('claude') !== -1 || m.indexOf('fable') === 0) return 'claude'
  if (m.indexOf('qwen') !== -1) return 'qwen'
  if (m.indexOf('minimax') !== -1 || m.indexOf('abab') === 0) return 'minimax'
  if (m.indexOf('kimi') === 0 || m.indexOf('moonshot') === 0 || m.indexOf('k2') === 0 || m.indexOf('k3') === 0) return 'kimi'
  if (m.indexOf('gemini') !== -1) return 'gemini'
  // WorkBuddy 宿主模型族（混元 hy*/hunyuan、阶跃 step-*/stepfun）
  if (m.indexOf('hunyuan') !== -1 || m.indexOf('hy') === 0) return 'hunyuan'
  if (m.indexOf('stepfun') !== -1 || m.indexOf('step-') === 0 || m.indexOf('step') === 0) return 'stepfun'
  return null
}

// 主入口。返回 { source, vendor, label, currency, timeMode }。
export function resolveBillingSource(providerId, modelId, baseUrl) {
  const pid = String(providerId || '').trim().toLowerCase()
  let source = null
  // 1) 订阅/套餐型 provider 优先：走配额口径，不看它挂什么域名
  if (pid && (pid.indexOf('start-plan') !== -1 || pid.indexOf('coding-plan') !== -1)) source = 'plan'
  // 1.5) CommandCode 套餐（反代或官方 API provider）：额度口径，但不改行级计价
  //      （仍按模型）。官方 API 的 providerId 形如 `commandcode-goat-1`，不含
  //      `cmdgo`，必须单独认，否则会按模型名被算成 OpenAI/DeepSeek 的真金白银。
  if (
    !source &&
    (pid.indexOf('cmdgo') !== -1 || pid.indexOf('commandcode') !== -1 || hostnameOf(baseUrl).indexOf('commandcode') !== -1)
  )
    source = 'cmdgo'
  // 2) 有效 baseURL 域名（MiMo api/plan 双端点靠这里区分）
  if (!source) source = sourceByHost(hostnameOf(baseUrl))
  // 3) providerId 关键词
  if (!source) source = sourceByProviderId(pid)
  // 4) model_id 兜底（网关转发：只有模型名指向真正厂商）
  if (!source) source = sourceByModel(modelId)
  // 5) 全未知：只报消耗量，不冒充任何厂商
  if (!source) source = 'tokens'
  return sourceDef(source)
}

// MiMo Token Plan 夜间系数时段：北京时间 00:00–08:00（官方 FAQ，消耗 0.8x）
export function isNightOffpeak(atMs) {
  const t = Number.isFinite(Number(atMs)) ? Number(atMs) : Date.now()
  const bj = new Date(t + 8 * 3600 * 1000)
  const hour = bj.getUTCHours()
  return hour >= 0 && hour < 8
}

// WorkBuddy 主计费源：**恒定是订阅积分**。
//
// 为什么不做成「按模型猜厂商」：WorkBuddy 的模型全部跑在宿主的订阅通道上，
// 用户的每一轮都只扣积分，不存在「这一轮走的是我的 DeepSeek key」这种情况。
// 把主显示绑到某个厂商的余额上会直接讲错故事（ZCode 版的「余额 + 峰谷」是
// 自带 key 的按量场景，WorkBuddy 不是）。
//
// 返回值里的 vendor/vendorLabel 是**模型归属**（给标签与分组用），不是计费源。
export function resolveHostBillingSource(modelId) {
  const vendorDef = resolveBillingSource('', modelId, '')
  return {
    ...SOURCE_DEFS.credits,
    modelVendor: vendorDef.vendor || null,
    modelVendorLabel: vendorDef.vendor === null ? '订阅模型' : vendorDef.label,
  }
}
