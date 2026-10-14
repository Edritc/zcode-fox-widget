// 厂商凭据发现：从 WorkBuddy 侧**能找的地方**找出「哪家厂商的 key 在哪个文件」，
// 供厂商模板（vendors.mjs）与 DeepSeek 余额（credentials.mjs）在请求时即时读取。
// 密钥**不复制**进挂件配置——注册表只存「来源 + 位置」，key 每次现读，
// 配置变更即时生效，也不会把密钥写进挂件。
//
// ⚠️ 与 ZCode 侧的重要差异（2026-10-14 实测，见 docs/porting/phase-0.md）：
//   ZCode 有 `provider_config.json`（用户的接入点规则 + apiKey），所以 ZCode 版能
//   做到「零配置复用你在客户端里配好的 DeepSeek 凭据」。
//   **WorkBuddy 没有这个东西**：模型全部由宿主托管（订阅积分制），
//   settings.json 的 pluginConfigs 是空的、models.json 是 `[]`，用户不需要填 key。
//   因此本文件枚举的候选位大概率全部落空 —— 这是**预期行为**，不是缺陷；
//   WorkBuddy 上的厂商卡默认「无凭据 → 不可用」，主口径走积分（turn-cost.mjs）。
//
// 数据源（按顺序，全部现读）：
//   1. 环境变量（DEEPSEEK_API_KEY 等，见 ENV_KEY_TABLE）—— 用户最常见的手工方式
//   2. <HOST_HOME>/settings.json 的 `env` 块（宿主会把这里的环境变量注入会话）
//   3. <HOST_HOME>/settings.json 的 `pluginConfigs.<插件>.options`（连接器/插件
//      可能把 apiKey/baseUrl 存在这里；本机为空，但结构是宿主 readPluginConfig
//      的既定契约，留着以防用户自己填）
//   4. <HOST_HOME>/plugins/data/<插件>/config.json 的 apiKey/baseUrl/vendorKeys
//      （宿主的插件数据目录，用户手改这里最直接）
//
// 明确跳过本地网关：baseURL 指向环回/私有地址的条目，它的 apiKey 是网关鉴权用，
// 不是厂商 key，拿去查余额必然 401。enc:v1: 加密凭据无法解密，标记 keyEncrypted
// 跳过，不猜、不当明文用。
import fs from 'node:fs'
import path from 'node:path'
import { HOST_SETTINGS_FILE, HOST_PLUGIN_DATA_DIR } from './host.mjs'
import { isBlockedHost } from './blocked-host.mjs'

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (err) {
    return null
  }
}

// 本地/私有网关判定：这些地址背后的 key 不是厂商 key。与出站黑名单共用同一份口径。
const isLocalHost = (hostname) => isBlockedHost(hostname)

export function matchTemplateId(parts) {
  const hay = parts.filter(Boolean).join(' ').toLowerCase()
  if (!hay) return null
  if (hay.indexOf('deepseek') !== -1) return 'deepseek'
  if (hay.indexOf('openrouter') !== -1) return 'openrouter'
  // Kimi Coding 订阅用的是另一套凭据（KIMI_CODING_KEY ≠ 平台 key），凡带 coding
  // 的 kimi 先归它，剩下才是平台的 moonshot-cn/intl
  if (hay.indexOf('kimi') !== -1 && hay.indexOf('coding') !== -1) return 'kimi-coding'
  if (hay.indexOf('moonshot') !== -1 || hay.indexOf('kimi') !== -1) {
    return hay.indexOf('intl') !== -1 || hay.indexOf('international') !== -1 ? 'moonshot-intl' : 'moonshot-cn'
  }
  if (
    hay.indexOf('bigmodel') !== -1 ||
    hay.indexOf('zhipu') !== -1 ||
    hay.indexOf('zai') !== -1 ||
    hay.indexOf('z.ai') !== -1 ||
    hay.indexOf('glm') !== -1
  ) {
    // 国际站（z.ai）另有账号体系与凭据名；其余（含智谱 Coding Plan 大陆站）仍归
    // 按量的 bigmodel-glm——保持 v1.3 起的既有判定，避免凭据绑错模板
    if (hay.indexOf('intl') !== -1 || hay.indexOf('z.ai') !== -1) return 'zhipu-coding-intl'
    return 'bigmodel-glm'
  }
  // —— 与上游 DSH 版对齐补齐的厂商（vendors.mjs 同名模板）——
  if (hay.indexOf('minimax') !== -1) {
    return hay.indexOf('intl') !== -1 || hay.indexOf('international') !== -1 ? 'minimax-coding-intl' : 'minimax-coding'
  }
  if (hay.indexOf('opencode') !== -1) return 'opencode-go'
  if (hay.indexOf('stepfun') !== -1 || hay.indexOf('step-') !== -1) return 'stepfun'
  if (hay.indexOf('novita') !== -1) return 'novita'
  if (hay.indexOf('siliconflow') !== -1) {
    return hay.indexOf('intl') !== -1 || hay.indexOf('international') !== -1 ? 'siliconflow-en' : 'siliconflow-cn'
  }
  // 火山方舟只认明确关键词：`ark` 太短，'dark' 一类字符串会误命中
  if (hay.indexOf('volcengine') !== -1 || hay.indexOf('doubao') !== -1 || hay.indexOf('ark.cn-beijing') !== -1) return 'volcengine-ark'
  if (hay.indexOf('dashscope') !== -1 || hay.indexOf('qwen') !== -1 || hay.indexOf('tongyi') !== -1) return 'dashscope'
  if (hay.indexOf('qianfan') !== -1 || hay.indexOf('ernie') !== -1) return 'qianfan'
  if (hay.indexOf('hunyuan') !== -1) return 'hunyuan'
  if (hay.indexOf('spark') !== -1 || hay.indexOf('xfyun') !== -1) return 'spark'
  if (hay.indexOf('modelscope') !== -1) return 'modelscope'
  if (hay.indexOf('anthropic') !== -1 || hay.indexOf('claude') !== -1) return 'anthropic'
  if (hay.indexOf('gemini') !== -1 || hay.indexOf('google') !== -1) return 'gemini'
  if (hay.indexOf('grok') !== -1 || hay.indexOf('xai') !== -1) return 'xai'
  if (hay.indexOf('groq') !== -1) return 'groq'
  if (hay.indexOf('mistral') !== -1 || hay.indexOf('codestral') !== -1) return 'mistral'
  if (hay.indexOf('together') !== -1) return 'together'
  if (hay.indexOf('fireworks') !== -1) return 'fireworks'
  if (hay.indexOf('deepinfra') !== -1) return 'deepinfra'
  if (hay.indexOf('cerebras') !== -1) return 'cerebras'
  if (hay.indexOf('ollama') !== -1 || hay.indexOf('lmstudio') !== -1 || hay.indexOf('lm-studio') !== -1) return 'ollama'
  if (hay.indexOf('openai') !== -1) return 'openai'
  return null
}

// 环境变量 → 模板 id。用户不必改任何配置文件，export 一下就能让厂商卡活起来。
export const ENV_KEY_TABLE = [
  { env: 'DEEPSEEK_API_KEY', templateId: 'deepseek', baseUrl: 'https://api.deepseek.com' },
  { env: 'MOONSHOT_API_KEY', templateId: 'moonshot-cn', baseUrl: 'https://api.moonshot.cn' },
  { env: 'KIMI_CODING_KEY', templateId: 'kimi-coding', baseUrl: '' },
  { env: 'ZHIPU_API_KEY', templateId: 'bigmodel-glm', baseUrl: 'https://open.bigmodel.cn' },
  { env: 'GLM_API_KEY', templateId: 'bigmodel-glm', baseUrl: 'https://open.bigmodel.cn' },
  { env: 'OPENAI_API_KEY', templateId: 'openai', baseUrl: 'https://api.openai.com' },
  { env: 'ANTHROPIC_API_KEY', templateId: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  { env: 'DASHSCOPE_API_KEY', templateId: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com' },
  { env: 'MINIMAX_API_KEY', templateId: 'minimax-coding', baseUrl: '' },
  { env: 'OPENROUTER_API_KEY', templateId: 'openrouter', baseUrl: 'https://openrouter.ai' },
  { env: 'SILICONFLOW_API_KEY', templateId: 'siliconflow-cn', baseUrl: 'https://api.siliconflow.cn' },
]

function hostOf(baseUrl) {
  try {
    return new URL(String(baseUrl || '')).hostname.toLowerCase()
  } catch (err) {
    return ''
  }
}

function normalizeKey(raw) {
  const k = typeof raw === 'string' ? raw.trim() : ''
  if (!k) return { apiKey: '', keyEncrypted: false }
  // enc:v1: 密文无法解密，不能当明文用，也不能当"没配"
  if (k.startsWith('enc:')) return { apiKey: '', keyEncrypted: true }
  return { apiKey: k, keyEncrypted: false }
}

function pushProvider(out, o) {
  const { apiKey, keyEncrypted } = normalizeKey(o.rawKey)
  out.push({
    providerId: String(o.providerId || ''),
    templateId: typeof o.templateId === 'string' ? o.templateId : '',
    providerName: typeof o.providerName === 'string' ? o.providerName : '',
    baseUrl: o.baseUrl || '',
    host: hostOf(o.baseUrl),
    apiKey,
    keyEncrypted,
    isLocal: isLocalHost(hostOf(o.baseUrl)),
    matchParts: (o.matchParts || []).filter(Boolean).map(String),
    source: o.source,
  })
}

// 枚举全部宿主侧 provider 条目（key 现读；调用方负责掩码与用途过滤）。
// 参数可注入路径（测试用），默认扫描本机全部候选位。
//
// 默认路径带短 TTL 缓存：前端每 3 秒轮询 /whale/session.json，每次都要判计费源，
// 而一次全量扫描要读 settings.json + 遍历插件数据目录。这些文件只在用户改配置时变，
// 5 秒缓存足够新鲜。注入了路径的调用（测试/诊断）永远现读。
const CACHE_TTL_MS = 5000
let cacheEntries = null
let cacheAt = 0

export function invalidateDiscoverCache() {
  cacheEntries = null
  cacheAt = 0
}

export function buildProviderEntries(opts = {}) {
  const injected = !!(opts.settingsFile || opts.pluginDataDir || opts.envOverride)
  if (!injected) {
    const now = Date.now()
    if (cacheEntries && now - cacheAt < CACHE_TTL_MS) return cacheEntries.slice()
  }
  const out = collectProviderEntries(opts)
  if (!injected) {
    cacheEntries = out
    cacheAt = Date.now()
    return out.slice() // 恒返回副本：调用方（含测试）改不动缓存
  }
  return out
}

// 扫描一个插件数据目录下的 config.json（宿主的插件数据落在
// <HOST_HOME>/plugins/data/<插件>-<市场>/config.json）。
// 只认我们认得的字段（apiKey/baseUrl/vendorKeys），不做全量字段猜测。
function collectPluginDataConfigs(out, root, env) {
  let dirs = []
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch (err) {
    return
  }
  for (const d of dirs) {
    const file = path.join(root, d.name, 'config.json')
    const cfg = readJson(file)
    if (!cfg) continue
    const own = typeof cfg.apiKey === 'string' ? cfg.apiKey : ''
    if (own) {
      pushProvider(out, {
        providerId: d.name,
        baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : '',
        rawKey: own,
        matchParts: [d.name, cfg.baseUrl, cfg.provider],
        source: 'plugin-data:' + file,
      })
    }
    // vendorKeys: { <templateId>: <key> } —— 我们自己的 config.json 也走这条路
    const vendorKeys = cfg.vendorKeys && typeof cfg.vendorKeys === 'object' ? cfg.vendorKeys : null
    if (vendorKeys) {
      for (const [tid, key] of Object.entries(vendorKeys)) {
        pushProvider(out, {
          providerId: d.name + '/' + tid,
          templateId: tid,
          rawKey: key,
          matchParts: [tid],
          source: 'plugin-vendor-keys:' + file,
        })
      }
    }
  }
  void env
}

function collectProviderEntries(opts = {}) {
  const out = []
  const env = opts.envOverride || process.env

  // 1) 环境变量（最简单的路径，也是本机唯一实际可用的路径）
  for (const row of ENV_KEY_TABLE) {
    const v = String(env[row.env] || '').trim()
    if (!v) continue
    pushProvider(out, {
      providerId: 'env:' + row.env,
      templateId: row.templateId,
      baseUrl: row.baseUrl,
      rawKey: v,
      matchParts: [row.templateId, row.env],
      source: 'env:' + row.env,
    })
  }

  // 2/3) 宿主 settings.json：env 块 + pluginConfigs.<插件>.options
  const settingsFile = typeof opts.settingsFile === 'string' ? opts.settingsFile : HOST_SETTINGS_FILE
  const settings = readJson(settingsFile)
  if (settings) {
    if (settings.env && typeof settings.env === 'object') {
      for (const row of ENV_KEY_TABLE) {
        const v = String(settings.env[row.env] || '').trim()
        if (!v) continue
        pushProvider(out, {
          providerId: 'settings-env:' + row.env,
          templateId: row.templateId,
          baseUrl: row.baseUrl,
          rawKey: v,
          matchParts: [row.templateId, row.env],
          source: 'settings-env:' + settingsFile,
        })
      }
    }
    const pc = settings.pluginConfigs && typeof settings.pluginConfigs === 'object' ? settings.pluginConfigs : {}
    for (const [pluginId, conf] of Object.entries(pc)) {
      const options = (conf && conf.options) || {}
      const key = typeof options.apiKey === 'string' ? options.apiKey : ''
      const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl : typeof options.baseURL === 'string' ? options.baseURL : ''
      if (!key) continue
      pushProvider(out, {
        providerId: pluginId,
        baseUrl,
        rawKey: key,
        matchParts: [pluginId, baseUrl, options.providerId],
        source: 'plugin-config:' + settingsFile,
      })
    }
  }

  // 4) 插件数据目录（含本插件自己的 config.json）
  const pluginDataDir = typeof opts.pluginDataDir === 'string' ? opts.pluginDataDir : HOST_PLUGIN_DATA_DIR
  collectPluginDataConfigs(out, pluginDataDir, env)

  return out
}

// 供 credentials.mjs / vendors.mjs 调用。
export function listHostProviders() {
  return buildProviderEntries()
}

// 兼容旧名（ZCode 分支叫 listZcodeProviders）：避免上游 merge 时多一处改名冲突。
export const listZcodeProviders = listHostProviders

// 按 providerId 找有效 baseURL（计费源判据用）。优先非本地条目。
export function findProviderBaseUrl(providerId) {
  const pid = String(providerId || '')
  if (!pid) return ''
  let fallback = ''
  for (const e of buildProviderEntries()) {
    if (e.providerId !== pid) continue
    if (!e.isLocal && e.baseUrl) return e.baseUrl
    if (!fallback && e.baseUrl) fallback = e.baseUrl
  }
  return fallback
}

// 供 vendors.mjs 调用：返回 { key, source } 或 null。key 每次现读，掩码由调用方负责。
// 跳过本地网关与加密凭据——它们都不是可直接使用的厂商 key。
export function findDiscoveredKey(templateId) {
  for (const e of buildProviderEntries()) {
    if (e.isLocal || e.keyEncrypted || !e.apiKey) continue
    if (matchTemplateId(e.matchParts) === templateId || e.templateId === templateId) {
      return { key: e.apiKey, source: e.source + ':' + e.providerId }
    }
  }
  return null
}

// 排查用：列出发现结果（不含任何密钥内容）
export function listDiscoveries() {
  return buildProviderEntries().map((e) => ({
    templateId: e.templateId || matchTemplateId(e.matchParts),
    providerId: e.providerId,
    providerName: e.providerName,
    host: e.host,
    kind: e.source.split(':')[0],
    file: e.source.slice(e.source.indexOf(':') + 1),
    hasKey: !!e.apiKey,
    keyEncrypted: e.keyEncrypted,
    isLocal: e.isLocal,
  }))
}
