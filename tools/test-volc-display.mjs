// 执行 widget.js 的实际函数，验证选择与异步竞态；不模拟配额查询或计费实现。
import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const source = fs.readFileSync(new URL('../lib/widget.js', import.meta.url), 'utf8')
const names = ['volcProviderId', 'resolveDisplaySource', 'volcCard', 'pollVolc', 'cmdgoKey']
const functions = names.map(name => {
  const match = source.match(new RegExp('  function ' + name + '\\([^]*?\\n  }'))
  assert.ok(match, name + ' missing')
  return match[0]
}).join('\n')
const requests = []
let renders = 0
const ctx = vm.createContext({
  displayMode: 'auto', sessionState: null, lastVolcProviderId: '', volcState: null,
  volcPendingKey: '', volcViewKey: '', volcRequestSeq: 0, costBubbleActive: false,
  VOLC_URL: '/whale/volc.json', encodeURIComponent, JSON,
  render() { renders++ }, checkAlerts() {},
  fetch(url) { return new Promise(resolve => requests.push({ url, finish: data => resolve({ json: async () => data }) })) },
})
vm.runInContext(functions, ctx)
const tick = () => new Promise(resolve => setImmediate(resolve))
const coding = { providerId: 'uuid-1', source: 'volc', volcMode: 'coding' }
const agent = { providerId: 'uuid-2', source: 'volc', volcMode: 'agent' }
ctx.sessionState = coding
ctx.pollVolc()
assert.equal(requests.length, 1)
assert.ok(requests[0].url.endsWith('providerId=uuid-1'))
ctx.pollVolc()
assert.equal(requests.length, 1, 'same pending request is shared')
ctx.sessionState = agent
ctx.pollVolc()
requests[1].finish({ ...agent, ok: true, planType: 'agent', windows: [
  { label: '近一天', usedPct: 25, resetAt: null },
] })
await tick()
requests[0].finish({ ...coding, ok: true, planType: 'coding', windows: [] })
await tick()
assert.equal(ctx.volcState.providerId, 'uuid-2', 'late Coding response must not overwrite Agent')
assert.equal(ctx.volcCard().title, '火山 Agent Plan')
assert.equal(ctx.volcCard().rows[0].percentUsed, 25)

ctx.displayMode = 'volc'
ctx.lastVolcProviderId = 'uuid-2'
ctx.sessionState = { providerId: 'other', source: 'ds' }
assert.equal(ctx.volcProviderId(), 'uuid-2', 'fixed platform retains last Ark provider')
assert.equal(ctx.resolveDisplaySource(), 'volc')
ctx.volcState = { ...agent, ok: false, reason: 'invalid-credentials' }
assert.equal(ctx.volcCard().title, '火山 Agent Plan', 'query failure preserves product identity')
assert.match(ctx.volcCard().error, /IAM/)

ctx.lastVolcProviderId = 'uuid-api'
ctx.volcState = { providerId: 'uuid-api', source: 'volc-api', volcMode: 'api', ok: true }
assert.equal(ctx.resolveDisplaySource(), 'volc-api', 'fixed platform selects API money view')
ctx.lastVolcProviderId = ''
assert.match(ctx.volcCard().error, /请先/)
ctx.displayMode = 'auto'
assert.equal(ctx.resolveDisplaySource(), 'ds', 'auto follows other vendors')
const before = requests.length
ctx.pollVolc()
assert.equal(requests.length, before, 'non-Ark selection makes no quota request')
assert.equal(ctx.volcState, null)

// 同一个 provider 改了路径，也不能接受旧模式的在途响应。
ctx.sessionState = coding
ctx.pollVolc()
const old = requests.at(-1)
ctx.sessionState = { ...coding, volcMode: 'agent' }
ctx.pollVolc()
requests.at(-1).finish({ ...ctx.sessionState, ok: false, reason: 'no-data' })
await tick()
old.finish({ ...coding, ok: true, windows: [] })
await tick()
assert.equal(ctx.volcState.volcMode, 'agent')
assert.equal(ctx.volcState.reason, 'no-data')
assert.ok(renders > 0)
console.log('火山显示逻辑：选择、固定模式、失败状态及请求竞态通过')
