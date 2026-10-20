// 固定视图和自动跟随都由 provider 的有效 Base URL 选套餐，不用查询结果反推计费。
import { findProviderBaseUrl } from './discover.mjs'
import { resolveBillingSource } from './source.mjs'
import { readVolcPlanQuota } from './volc-plan.mjs'

export async function readVolcProviderView(providerId, force = false) {
  const id = String(providerId || '')
  const source = resolveBillingSource(id, '', findProviderBaseUrl(id))
  const meta = { providerId: id, source: source.source, volcMode: source.volcMode || 'unknown' }
  if (source.vendor !== 'volc') return { ...meta, ok: false, reason: 'no-volc-provider' }
  if (source.volcMode === 'api') return { ...meta, ok: true }
  if (source.volcMode !== 'coding' && source.volcMode !== 'agent') {
    return { ...meta, ok: false, reason: 'unknown-endpoint' }
  }
  return { ...await readVolcPlanQuota(force, source.volcMode), ...meta }
}
