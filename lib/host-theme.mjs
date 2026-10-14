// 宿主自己用的主题：三层判定，取值归一到挂件三态 'light' | 'dark' | 'system'。
//
// 背景：挂件主题里的「跟随 WorkBuddy」必须跟随 **WorkBuddy 当前主题**，
// 而不是操作系统深浅色——用户把系统设浅色、WorkBuddy 设暗色时，只看系统必错。
//
// 三层来源（优先级从高到低）：
//   1. **观测**（<数据目录>/host-theme-observed.json，浮层跟随脚本写）：
//      直接读 WorkBuddy 主窗口的 DWM 沉浸式暗色标志（DWMWA_USE_IMMERSIVE_DARK_MODE）。
//      WorkBuddy 桌面端就是 Electron，壳层把自己的主题设到 nativeTheme，
//      该标志即「实际在用的主题」，且跟随设置实时变化【实测：ZCode 侧同源结论】。
//      浮层没跑（浏览器模式）就没有观测，自动降级。
//   2. **配置**：<HOST_HOME>/storage/user-<uid>-personal/global/preferences.json 的
//      `theme` 字段（取值 light|dark|system）【实测 2026-10-14：本机值 "light"】。
//      uid 因账号而异，所以扫描 storage/user-*/global/ 下所有 preferences.json。
//   3. **系统**：都拿不到时返回 'system'，页面再退回操作系统深浅色。
//
// 观测按时间戳保鲜（TTL 24h；浮层活着时每 60s 刷一次时间戳、干净退出会删文件），
// 防止「浮层早已退出、宿主后来改了主题」时用旧观测以新充旧。
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths.mjs'
import { HOST_HOME, hostPreferenceFiles } from './host.mjs'

const CACHE_TTL_MS = 5000
const OBSERVED_TTL_MS = 24 * 3600 * 1000

export const OBSERVED_FILE = path.join(DATA_DIR, 'host-theme-observed.json')
export const PREFERENCES_DIR = path.join(HOST_HOME, 'storage')

// 纯函数：配置里的原始值 → 挂件三态（可测）
export function mapHostTheme(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase()
  if (v === 'dark' || v === 'zai-dark') return 'dark'
  if (v === 'light' || v === 'zai-light') return 'light'
  return 'system'
}

// 从一份解析好的 WorkBuddy preferences 对象里取主题原始值。
// 宿主同时写了 `theme` 与 `appearance.themeSelection.resourceKey`（实测两者一致），
// 优先前者，后者作兜底。
export function themeOfPreferences(prefs) {
  if (!prefs || typeof prefs !== 'object') return null
  const direct = prefs.theme
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const sel = prefs['appearance.themeSelection']
  const key = sel && typeof sel.resourceKey === 'string' ? sel.resourceKey.trim() : ''
  return key || null
}

// 三层合并（纯函数，供测试）：新鲜观测 > 配置 > 系统。
//   observed = { dark: 0|1, at }（at 缺失视为新鲜；过期则忽略）
//   rawConfig = preferences 里的 theme 原始值
export function resolveHostTheme(observed, rawConfig, now = Date.now()) {
  if (observed && (observed.dark === 0 || observed.dark === 1)) {
    const at = Number(observed.at) || 0
    if (!at || now - at <= OBSERVED_TTL_MS) return observed.dark === 1 ? 'dark' : 'light'
  }
  return mapHostTheme(rawConfig)
}

function readObserved() {
  try {
    const o = JSON.parse(fs.readFileSync(OBSERVED_FILE, 'utf8'))
    if (!o || (o.dark !== 0 && o.dark !== 1)) return null
    const at = Number(o.at) || 0
    if (at && Date.now() - at > OBSERVED_TTL_MS) return null // 过期观测不算数
    return o
  } catch (err) {
    return null
  }
}

function readPreferences() {
  for (const file of hostPreferenceFiles()) {
    try {
      const raw = themeOfPreferences(JSON.parse(fs.readFileSync(file, 'utf8')))
      if (raw) return { raw, file }
    } catch (err) {
      // ENOENT（该账号目录没有这份 preferences）继续找下一个；坏 JSON 也跳过
    }
  }
  return { raw: null, file: '' }
}

// 读主题并归一。返回 { theme, raw, source, file, observed }
//   theme  ∈ light | dark | system
//   raw    实际生效那一层的原始值（观测层为 'dark'/'light'）
//   source 'host-window'（观测）/ 'preferences'（配置）/ 'missing'
export function readHostTheme() {
  const cached = readHostTheme.cache
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.payload
  const observed = readObserved()
  const { raw, file } = readPreferences()
  const payload = observed
    ? {
        theme: observed.dark === 1 ? 'dark' : 'light',
        raw: observed.dark === 1 ? 'dark' : 'light',
        source: 'host-window',
        file: OBSERVED_FILE,
        observed: { dark: observed.dark, at: Number(observed.at) || null },
      }
    : {
        theme: mapHostTheme(raw),
        raw,
        source: raw ? 'preferences' : 'missing',
        file: file || PREFERENCES_DIR,
        observed: null,
      }
  readHostTheme.cache = { at: Date.now(), payload }
  return payload
}

export function invalidateHostThemeCache() {
  readHostTheme.cache = null
}
