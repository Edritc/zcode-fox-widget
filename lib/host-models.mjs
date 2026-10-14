// 宿主模型目录（读 WorkBuddy 自己的商品配置）。
//
// **为什么需要它**：用量面板里「这一轮为什么没扣积分」原本只有一个笼统说法
// 「套餐/网关」，把两类完全不同的东西混在一起：
//   1. 订阅/网关口径（走配额，不按积分计）
//   2. **免费模型**（宿主自己标了倍率 0 / 限时促销）——例如 `step-5-preview`
//      （宿主徽章「独家限免」）、`hy3` 系列（「限时免费」）。
// 宿主的商品配置里有**权威答案**，不必我们猜：
//
//   <HOST_HOME>/storage/user-*/scoped/*/wb-product-config.json
//     { "product-config-snapshot": { "savedAt": <ms>, "data": {
//         "models":         [ { "id": "step-5-preview", "credits": "x0.00", ... } ],
//         "modelPromotions":[ { "id","kind","enabled","modelIds":[],"priority",
//                              "badge": { "label": "独家限免" },
//                              "discount": { "factor": 0 },
//                              "hover": { "textZh": "…" },
//                              "schedule": { "timezone","validFrom","validUntil","daily":[{start,end}] } } ]
//     } } }
//
// 实测（2026-10-14，本机）：`step-5-preview` → credits `x0.00` + 促销「独家限免」；
// `hy3/hy3-b/hy3-c` → `x0.00` + 「限时免费」；`hy4-preview` → `x0.29`，
// 但夜间另有 factor 0 的「夜间免费」窗口。
//
// 口径说明：**倍率是「免费」的判据，徽章只是文案**。所以
//   free   = credits 倍率 0，或该时刻命中的促销 discount.factor 为 0
//   label  = 该时刻命中的最高优先级促销的 badge.label（没有就退回「免费」）
// 促销按**轮次时间戳**判定（不是「现在」）——历史轮次的红字标注才不会随当前时段漂移。
//
// 只读、零依赖，带 TTL 缓存（宿主在后台刷新这个快照）。
import fs from 'node:fs'
import path from 'node:path'
import { HOST_HOME } from './paths.mjs'

const CACHE_TTL_MS = 60000
let cache = { at: 0, value: null }

function scopedRoots() {
  const roots = []
  const storage = path.join(HOST_HOME, 'storage')
  let users = []
  try {
    users = fs.readdirSync(storage, { withFileTypes: true }).filter((d) => d.isDirectory() && /^user-/.test(d.name))
  } catch (err) {
    return roots
  }
  for (const u of users) {
    const scoped = path.join(storage, u.name, 'scoped')
    let scopes = []
    try {
      scopes = fs.readdirSync(scoped, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch (err) {
      continue
    }
    for (const s of scopes) roots.push(path.join(scoped, s.name, 'wb-product-config.json'))
  }
  return roots
}

// 多个 scope 各有一份快照：取 savedAt 最新的那份（宿主按 scope 隔离，内容通常一致）
function readSnapshot() {
  let best = null
  for (const file of scopedRoots()) {
    let json
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
      continue
    }
    const snap = json && json['product-config-snapshot']
    const data = snap && snap.data
    if (!data || typeof data !== 'object') continue
    const savedAt = Number(snap.savedAt) || 0
    if (!best || savedAt > best.savedAt) best = { savedAt, data }
  }
  return best ? best.data : null
}

// 'x0.21' / 'x0.00' / '' → 0.21 / 0 / null
function parseMultiplier(v) {
  const m = /^x\s*([0-9]+(?:\.[0-9]+)?)$/i.exec(String(v == null ? '' : v).trim())
  return m ? Number(m[1]) : null
}

// schedule → 该时刻是否命中。支持日期区间 + 可选的每日窗口（可跨零点）。
function scheduleHits(schedule, atMs) {
  if (!schedule || typeof schedule !== 'object') return true
  const at = Number.isFinite(atMs) ? atMs : Date.now()
  const t = Date.parse(String(schedule.validFrom || ''))
  if (!Number.isNaN(t) && at < t) return false
  const u = Date.parse(String(schedule.validUntil || ''))
  if (!Number.isNaN(u) && at >= u) return false
  const daily = Array.isArray(schedule.daily) ? schedule.daily : null
  if (!daily || !daily.length) return true
  const d = new Date(at)
  const mins = d.getHours() * 60 + d.getMinutes()
  const toMin = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim())
    return m ? Number(m[1]) * 60 + Number(m[2]) : null
  }
  for (const w of daily) {
    const a = toMin(w && w.start)
    const b = toMin(w && w.end)
    if (a === null || b === null) continue
    if (a <= b ? mins >= a && mins < b : mins >= a || mins < b) return true
  }
  return false
}

function pickPromotion(promotions, modelId, atMs) {
  let best = null
  for (const p of promotions) {
    if (!p || p.enabled === false) continue
    const ids = Array.isArray(p.modelIds) ? p.modelIds : []
    if (ids.indexOf(modelId) === -1) continue
    if (!scheduleHits(p.schedule, atMs)) continue
    const prio = Number(p.priority) || 0
    const zero = !!(p.discount && Number(p.discount.factor) === 0)
    const score = prio * 10 + (zero ? 1 : 0)
    if (!best || score > best.score) best = { score, promo: p }
  }
  return best ? best.promo : null
}

// 懒加载 + TTL（宿主换配置不需要重启服务）
function catalog() {
  const now = Date.now()
  if (cache.value && now - cache.at < CACHE_TTL_MS) return cache.value
  const data = readSnapshot()
  const models = new Map()
  const promotions = []
  if (data) {
    for (const m of Array.isArray(data.models) ? data.models : []) {
      if (m && typeof m.id === 'string') models.set(m.id, { multiplier: parseMultiplier(m.credits) })
    }
    for (const p of Array.isArray(data.modelPromotions) ? data.modelPromotions : []) promotions.push(p)
  }
  cache = { at: now, value: { models, promotions, ok: !!data } }
  return cache.value
}

// 测试用：强制下次重新读盘
export function invalidateHostModelsCache() {
  cache = { at: 0, value: null }
}

// 一个模型在 `atMs` 时刻的「免费与否 + 该用哪个徽章」。
// 返回 { known, multiplier, free, badge, freeLabel, promoId, promoText }
//   known=false 表示宿主快照里没有这个模型（自定义模型 / 配置缺失）——
//   此时不要去猜，交给调用方自己决定口径。
//
// **badge 与 freeLabel 必须分开**：宿主的促销徽章有时是「广而告之」而非「现在就免费」。
// 实例：`hy4-preview` 的 `hy4-night-discount-badge` 每日窗口是 8:00–23:00（白天挂着
// 「夜间免费」告诉你晚上免费），此刻倍率仍是 0.29、并未免费。所以：
//   badge      = 当前命中的促销徽章（可能只是广告，别直接当免费文案）
//   freeLabel  = **只在真的免费时**才非空（免费模型的展示文案，没有徽章时退回「免费」）
export function hostModelInfo(modelId, atMs) {
  const id = String(modelId || '').trim()
  const empty = {
    known: false,
    multiplier: null,
    free: false,
    badge: null,
    freeLabel: null,
    promoId: null,
    promoText: null,
  }
  if (!id) return empty
  const cat = catalog()
  const entry = cat.models.get(id)
  const promo = pickPromotion(cat.promotions, id, atMs)
  if (!entry && !promo) return empty

  const promoZero = !!(promo && promo.discount && Number(promo.discount.factor) === 0)
  const free = (!!entry && entry.multiplier === 0) || promoZero
  const badge = promo && promo.badge && typeof promo.badge.label === 'string' ? promo.badge.label : null
  return {
    known: true,
    multiplier: entry ? entry.multiplier : null,
    free,
    badge,
    freeLabel: free ? badge || '免费' : null,
    promoId: promo ? String(promo.id || '') : null,
    promoText: promo && promo.hover && typeof promo.hover.textZh === 'string' ? promo.hover.textZh : null,
  }
}
