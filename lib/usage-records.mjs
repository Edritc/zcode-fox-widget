// 用量记录聚合：扫 WorkBuddy 的 transcript，做按日 / 按模型统计。
//
// 与 ZCode 版的差异：ZCode 侧直接查 model_usage 表；WorkBuddy 的 db 只存
// 「每个会话最后一笔积分」（session_usage.credit_json 是按请求覆盖的），拿不出
// 按日明细。好在 transcript（<HOST_HOME>/projects/<slug>/<sid>.jsonl）里每次模型
// 调用都带完整 rawUsage + 宿主算好的 credit，按日聚合正合适。
//
// 口径（**积分是主口径**）：
//   - 「今日积分」= 当天所有轮次的宿主 credit 之和（真金白银口径就是它）；
//   - 每轮同时带一个「等价市值」（按公开价目折算，pricing.mjs 的 costOfUsage），
//     仅供对账/排行参考，**不参与今日合计**，面板里以 ≈ 标注；
//   - 逐模型明细按 conversationRequestId 归并成「轮」（一轮 agent 循环会对
//     同一个 requestId 落几十次模型调用，逐行展示就是一堆碎片账）。
//
// 性能：服务每秒轮询一轮消耗，页面 25–60s 轮询一次面板。这里对「文件指纹
// （数量 + 最大 mtime）+ TTL 30s」做记忆化，指纹没变直接回缓存；每个 transcript
// 只读尾部（默认 2MB），并按 mtime 只取最近若干个会话。
import fs from 'node:fs'
import path from 'node:path'
import { HOST_PROJECTS_DIR } from './host.mjs'
import { CREDIT_CURRENCY, readTranscriptTurns } from './turn-cost.mjs'
import { hostModelInfo } from './host-models.mjs'

const REC_CACHE_TTL_MS = 30_000
const MAX_TRANSCRIPTS = 60
// 单文件只读尾部的窗口。2MB 时实测「今日积分」系统性低估 16%（375/2377 积分、
// 调用次数低估 64%）：单轮 agent 循环有 50+ 次模型调用，一轮就能吃掉大半个窗口
//（2026-10-14 审查 P0-2，本机最大会话 17MB）。提到 32MB 后常规会话可完整覆盖；
// 仍超限的文件会在 scan 信息里**如实标记截断**（truncatedTranscripts），面板据此
// 提示「可能偏低」。环境变量可覆盖（测试用它构造小窗口的截断场景）。
const TAIL_BYTES = Number(process.env.FOX_WIDGET_TAIL_BYTES) || 32 * 1024 * 1024

function dayKey(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function startOfToday() {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

// 最近若干个 transcript 文件（按 mtime 倒序）。返回 [{file, mtime, size}]。
function listTranscripts() {
  const out = []
  let dirs = []
  try {
    dirs = fs.readdirSync(HOST_PROJECTS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch (err) {
    return out
  }
  for (const d of dirs) {
    const dir = path.join(HOST_PROJECTS_DIR, d.name)
    let files = []
    try {
      files = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      continue
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue
      const full = path.join(dir, f.name)
      try {
        const st = fs.statSync(full)
        out.push({ file: full, mtime: st.mtimeMs, size: st.size })
      } catch (err) {}
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out.slice(0, MAX_TRANSCRIPTS)
}

function fingerprint(files) {
  let n = 0
  let m = 0
  let bytes = 0
  for (const f of files) {
    n += 1
    if (f.mtime > m) m = f.mtime
    bytes += f.size
  }
  return n + ':' + Math.round(m) + ':' + bytes
}

function blankDay() {
  // total 为积分合计（单一口径）；totals 按「币种键」分列，积分是 CREDIT，
  // 等价市值单列 marketAmount，避免两条口径混进同一个数。
  return { total: 0, tokens: 0, calls: 0, marketAmount: 0, totals: {}, models: new Map() }
}

function addRow(day, row) {
  day.total += row.credit
  day.tokens += row.tokens
  day.calls += row.calls
  day.marketAmount += row.market
  day.totals[CREDIT_CURRENCY] = (day.totals[CREDIT_CURRENCY] || 0) + row.credit
  const key = row.model + '|' + row.vendorLabel
  let m = day.models.get(key)
  if (!m) {
    m = {
      model: row.model,
      modelName: row.modelName,
      providerId: '',
      vendorLabel: row.vendorLabel,
      currency: CREDIT_CURRENCY,
      tokens: 0,
      amount: 0,
      credit: 0,
      market: 0,
      calls: 0,
      // 免费标注（宿主促销，见 host-models.mjs）：今天同一模型可能命中过免费窗口
      free: false,
      freeLabel: null,
    }
    day.models.set(key, m)
  }
  m.tokens += row.tokens
  m.amount += row.credit
  m.credit += row.credit
  m.market += row.market
  m.calls += row.calls
  // 只要有过免费轮就标出来（文案取第一次命中的那条促销）
  if (row.free && !m.free) {
    m.free = true
    m.freeLabel = row.freeLabel || null
  }
}

const rankByCredit = (m) => Number(m.credit) || 0

function modelsList(modelsMap, limit, rankKey) {
  const rank = rankKey || rankByCredit
  const list = [...modelsMap.values()].sort((a, b) => rank(b) - rank(a) || b.tokens - a.tokens)
  return limit ? list.slice(0, limit) : list
}

// 按 token 消耗排序的同款列表（页面「按 Token 排名」用）。
export function modelsByTokens(modelsMap, limit) {
  const list = [...modelsMap.values()].sort((a, b) => b.tokens - a.tokens || b.credit - a.credit)
  return limit ? list.slice(0, limit) : list
}

// 厂商级汇总（积分口径）：主显示「今日积分」与面板「对账」都用它。
function vendorSums(modelsMap) {
  const out = {}
  for (const m of modelsMap.values()) {
    const k = m.vendorLabel || '未知'
    if (!out[k]) out[k] = { amount: 0, credit: 0, tokens: 0, currency: CREDIT_CURRENCY }
    out[k].amount += Number(m.credit) || 0
    out[k].credit += Number(m.credit) || 0
    out[k].tokens += Number(m.tokens) || 0
  }
  for (const k of Object.keys(out)) out[k].amount = Math.round(out[k].amount * 1e6) / 1e6
  return out
}

// 本机口径的「今日某厂商用量」。hasRows=false 表示今天没有该厂商的调用记录。
export function todayVendorUsage(vendorLabel) {
  const want = String(vendorLabel || '')
  const blank = { ok: false, hasRows: false, amount: 0, credit: 0, tokens: 0, currency: CREDIT_CURRENCY }
  if (!want) return blank
  const rec = usageRecords()
  if (!rec || !rec.ok) return blank
  const hit = rec.today.byVendor[want]
  if (!hit) return { ok: true, hasRows: false, amount: 0, credit: 0, tokens: 0, currency: CREDIT_CURRENCY }
  return { ok: true, hasRows: true, amount: hit.amount, credit: hit.credit, tokens: hit.tokens, currency: CREDIT_CURRENCY }
}

let recCache = null

export function invalidateUsageRecordsCache() {
  recCache = null
}

export function usageRecords() {
  const files = listTranscripts()
  const fp = fingerprint(files)
  const now = Date.now()
  if (recCache && recCache.fp === fp && now - recCache.at < REC_CACHE_TTL_MS) return recCache.payload
  const payload = computeUsageRecords(files, now)
  recCache = { at: now, fp, payload }
  return payload
}

function computeUsageRecords(files, now) {
  const todayStart = startOfToday()
  const weekStart = todayStart - 6 * 86400_000
  const today = blankDay()
  const byDay = new Map()
  const turnMap = []
  let scanned = 0
  // 【截断如实暴露】（2026-10-14 审查 P0-2）：以前只报文件数（14/14），掩盖了
  // 「单文件按尾部窗口截断、整轮整轮丢失」的事实。这里把字节口径与截断数一并返回。
  let truncated = 0
  let totalBytes = 0
  let scannedBytes = 0

  for (const f of files) {
    // 明显不可能落在 7 天窗口里的文件直接跳过（mtime 比窗口起点还早）
    if (f.mtime < weekStart) continue
    scanned += 1
    let size = 0
    try {
      size = fs.statSync(f.file).size
    } catch (err) {}
    totalBytes += size
    if (size > TAIL_BYTES) truncated += 1
    scannedBytes += Math.min(size, TAIL_BYTES)
    let turns = []
    try {
      turns = readTranscriptTurns(f.file, TAIL_BYTES)
    } catch (err) {
      continue
    }
    for (const t of turns) {
      const ts = t.ts || f.mtime
      if (ts < weekStart) continue
      // 免费/促销标注：按**这一轮的时间戳**判定宿主的模型促销（不是「现在」），
      // 否则历史轮次的标注会随当前时段漂移（hy4 白天挂「夜间免费」广告、
      // 夜间才真免费，只能按轮发生时刻判）。
      const hm = hostModelInfo(t.model, ts)
      const row = {
        ts,
        model: t.model || '未知模型',
        modelName: t.modelName || '',
        vendorLabel: (t.models && t.models[0] && t.models[0].vendorLabel) || '订阅模型',
        credit: t.credit || 0,
        tokens: t.tokens || 0,
        calls: t.calls || 0,
        market: t.marketAmount || 0,
        free: hm.free,
        freeLabel: hm.freeLabel,
      }
      if (row.credit === 0 && row.tokens === 0) continue
      const day = dayKey(ts)
      if (!byDay.has(day)) byDay.set(day, blankDay())
      addRow(byDay.get(day), row)
      if (ts >= todayStart) addRow(today, row)
      turnMap.push({
        ts,
        sessionId: '',
        requestId: t.requestId,
        calls: row.calls,
        credit: row.credit,
        market: row.market,
        tokens: row.tokens,
        currency: CREDIT_CURRENCY,
        totals: { [CREDIT_CURRENCY]: row.credit },
        billable: row.credit > 0,
        free: hm.free,
        freeLabel: hm.freeLabel,
        models: (t.models || []).slice(0, 8).map((m) => {
          const mi = hostModelInfo(m.model, ts)
          return {
            model: m.model,
            modelName: m.modelName,
            providerId: '',
            vendorLabel: m.vendorLabel,
            currency: m.currency || 'CNY',
            calls: m.calls,
            credit: m.credit,
            amount: m.amount,
            tokens: m.tokens,
            free: mi.free,
            freeLabel: mi.freeLabel,
          }
        }),
      })
    }
  }

  const days = [...byDay.keys()].sort()
  const daysList = days.map((d) => {
    const b = byDay.get(d)
    return { date: d, total: b.total, tokens: b.tokens, calls: b.calls, marketAmount: b.marketAmount, totals: b.totals }
  })

  const week = blankDay()
  for (const b of byDay.values()) {
    week.total += b.total
    week.tokens += b.tokens
    week.calls += b.calls
    week.marketAmount += b.marketAmount
    week.totals[CREDIT_CURRENCY] = (week.totals[CREDIT_CURRENCY] || 0) + Number(b.totals[CREDIT_CURRENCY] || 0)
    for (const [key, m] of b.models) {
      let m2 = week.models.get(key)
      if (!m2) {
        m2 = {
          model: m.model,
          modelName: m.modelName,
          providerId: '',
          vendorLabel: m.vendorLabel,
          currency: CREDIT_CURRENCY,
          tokens: 0,
          amount: 0,
          credit: 0,
          market: 0,
          calls: 0,
        }
        week.models.set(key, m2)
      }
      m2.tokens += m.tokens
      m2.amount += m.amount
      m2.credit += m.credit
      m2.market += m.market
      m2.calls += m.calls
    }
  }

  const turns = turnMap
    .sort((a, b) => a.ts - b.ts)
    .map((t, i) => ({ ...t, requests: i }))
    .slice(-100)
    .reverse()

  return {
    ok: true,
    generatedAt: now,
    // 口径声明：面板顶部展示，避免用户把积分与等价市值混起来看
    unit: 'credit',
    scannedTranscripts: scanned,
    totalTranscripts: files.length,
    // 【截断如实暴露】（2026-10-14 审查 P0-2）：truncatedTranscripts > 0 表示有
    // 会话超过单文件窗口、只统计了尾部，「今日积分」可能偏低；面板据此提示。
    truncatedTranscripts: truncated,
    scanBytes: { total: totalBytes, scanned: scannedBytes },
    today: {
      date: dayKey(todayStart),
      total: today.total,
      credit: today.total,
      tokens: today.tokens,
      calls: today.calls,
      marketAmount: today.marketAmount,
      marketCurrency: 'CNY',
      totals: today.totals,
      rankTotal: [...today.models.values()].reduce((s, m) => s + (Number(m.credit) || 0), 0),
      models: modelsList(today.models, 12),
      modelsByTokens: modelsByTokens(today.models, 12),
      byVendor: vendorSums(today.models),
    },
    days7: {
      total: week.total,
      credit: week.total,
      tokens: week.tokens,
      calls: week.calls,
      marketAmount: week.marketAmount,
      totals: week.totals,
      byDay: daysList,
      models: modelsList(week.models, 12),
    },
    turns,
  }
}
