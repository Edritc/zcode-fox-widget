// 版本更新内核单测（独立进程 + 隔离 ZCODE_HOME）。
//
// 为什么单独一个文件：lib/update.mjs 与 lib/balance.mjs 的路径常量在 import 时
// 就从 ZCODE_HOME 求值，直接在主 selftest 进程里 import 会写到真实数据目录。
// 这里先把 ZCODE_HOME 指到临时目录再 import（与 selftest 的账本子进程同法）。
//
// 覆盖：版本比较 / 出站白名单守卫 / tar.gz 解包（含中文名与路径穿越）/ 落盘计划与
// 清理（有 manifest、无 manifest 非 git、无 manifest 的 git 工作区三种）/ 跳过标记
// 读写 / 注入式远端检查（成功、回退、全失败）/ 注入式整包更新（成功、版本不符、
// 重复触发）。
//
//   node tools/selftest-update.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-update-test-'))
process.env.ZCODE_HOME = TMP

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail !== undefined ? '  — ' + detail : ''))
}

const U = await import('../lib/update.mjs')
const B = await import('../lib/balance.mjs')

function fakeRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    arrayBuffer: async () => {
      const b = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
    },
  }
}

// ---------- 1. 版本比较 ----------
{
  check(
    'compareVersions：数值段比较（含 v 前缀 / 段数不等 / 非法段按 0）',
    U.compareVersions('1.10.0', '1.9.9') === 1 &&
      U.compareVersions('v1.9.1', '1.10.0') === -1 &&
      U.compareVersions('1.10.0', 'v1.10.0') === 0 &&
      U.compareVersions('1.9', '1.9.0') === 0 &&
      U.compareVersions('2.0.0', '1.99.99') === 1,
    [U.compareVersions('1.10.0', '1.9.9'), U.compareVersions('1.9', '1.9.0')].join(',')
  )
  check(
    'isValidVersion：只收 x.y[.z]',
    U.isValidVersion('1.10.0') && U.isValidVersion('1.2') && !U.isValidVersion('main') && !U.isValidVersion('') && !U.isValidVersion('1.2.3.4')
  )
}

// ---------- 2. 出站守卫 ----------
{
  const bad = (u) => {
    try {
      U.assertUpdateUrl(u)
      return false
    } catch (err) {
      return true
    }
  }
  check(
    '出站守卫：拒绝非白名单主机 / http / 环回 / 私有 / 保留地址',
    bad('https://evil.com/x') && bad('http://ghproxy.net/x') && bad('https://127.0.0.1/x') &&
      bad('https://localhost/x') && bad('https://192.168.1.9/x') && bad('https://10.0.0.1/x') &&
      bad('https://[::1]/x') && bad('https://169.254.1.1/x') && bad('file:///etc/passwd')
  )
  const urls = [...U.buildVersionEndpoints().map((e) => e.url), ...U.buildTarballUrls('1.10.0').map((e) => e.url).filter(Boolean)]
  const allOk = urls.every((u) => {
    try {
      U.assertUpdateUrl(u)
      return true
    } catch (err) {
      return false
    }
  })
  check('出站守卫：全部候选地址都过白名单（' + urls.length + ' 条）', allOk, urls.length + ' urls')
  check(
    '候选链含国内镜像与 jsdelivr 兜底',
    U.buildVersionEndpoints().some((e) => e.name === 'jsdelivr') &&
      U.buildTarballUrls('1.10.0').some((e) => e.name === 'ghproxy') &&
      U.buildTarballUrls('1.10.0').some((e) => e.name === 'jsdelivr' && e.url === null) &&
      U.buildVersionEndpoints().some((e) => e.url.includes('ghproxy.net'))
  )
}

// ---------- 3. tar.gz 解包 ----------
function makeTar(entries) {
  // 最小 tar 写入器（本测试自用）：ustar 头 + 内容补齐 512
  const blocks = []
  const pad = (b) => {
    const rest = (512 - (b.length % 512)) % 512
    return rest ? Buffer.concat([b, Buffer.alloc(rest)]) : b
  }
  for (const e of entries) {
    const body = Buffer.isBuffer(e.body) ? e.body : Buffer.from(e.body || '', 'utf8')
    const header = Buffer.alloc(512)
    const name = Buffer.from(e.name, 'utf8')
    name.copy(header, 0, 0, Math.min(name.length, 100))
    header.write('0000644\0', 100, 'utf8')
    header.write('0000000\0', 108, 'utf8')
    header.write('0000000\0', 116, 'utf8')
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'utf8')
    header.write('00000000000\0', 136, 'utf8')
    header.write(e.type || '0', 156, 'utf8')
    header.write('ustar\0', 257, 'utf8')
    header.write('00', 263, 'utf8')
    let sum = 0
    for (let i = 0; i < 512; i++) sum += header[i]
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8')
    blocks.push(header, pad(body))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}
const gz = (tarBuf) => zlib.gzipSync(tarBuf)

{
  const tar = makeTar([
    { name: 'repo-abc/', type: '5', body: '' },
    { name: 'repo-abc/.zcode-plugin/plugin.json', body: '{"version":"1.11.0"}' },
    { name: 'repo-abc/lib/widget.js', body: 'x'.repeat(1000) },
    { name: 'repo-abc/assets/说明.txt', body: '中文内容' },
    { name: '../evil.js', body: 'nope' },
  ])
  const files = U.extractTarGz(gz(tar))
  check(
    'tar 解包：剥掉顶层目录 + 目录项跳过 + 中文名保留 + 路径穿越丢弃',
    files.size === 3 &&
      files.get('.zcode-plugin/plugin.json').toString('utf8') === '{"version":"1.11.0"}' &&
      files.get('lib/widget.js').length === 1000 &&
      files.get('assets/说明.txt').toString('utf8') === '中文内容' &&
      !files.has('../evil.js'),
    [...files.keys()].join(',')
  )
  check('U.parsePluginJsonVersion 从包内清单取版本', U.parsePluginJsonVersion(files.get('.zcode-plugin/plugin.json').toString('utf8')) === '1.11.0')
  // 没有顶层目录的包（git archive 形态）也要能装
  const flat = U.extractTarGz(gz(makeTar([{ name: '.zcode-plugin/plugin.json', body: '{"version":"2.0.0"}' }])))
  check('tar 解包：无顶层目录的包同样可用', flat.has('.zcode-plugin/plugin.json'), [...flat.keys()].join(','))
  let threw = false
  try {
    U.extractTarGz(Buffer.from('not gzip'))
  } catch (err) {
    threw = true
  }
  check('tar 解包：非 gzip 输入抛错（不静默）', threw)
}

// ---------- 4. 落盘计划 / 清理 ----------
function mkRoot(name, entries) {
  const root = path.join(TMP, name)
  fs.mkdirSync(path.join(root, '.zcode-plugin'), { recursive: true })
  fs.writeFileSync(path.join(root, '.zcode-plugin', 'plugin.json'), JSON.stringify({ version: '1.10.0' }), 'utf8')
  for (const [rel, body] of Object.entries(entries)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body, 'utf8')
  }
  return root
}

{
  const root = mkRoot('plan-root', { 'lib/keep.js': 'same', 'lib/gone.js': 'old', 'lib/change.js': 'v1' })
  const files = new Map([
    ['lib/keep.js', Buffer.from('same')],
    ['lib/change.js', Buffer.from('v2')],
    ['lib/new.js', Buffer.from('new')],
    ['.zcode-plugin/plugin.json', Buffer.from('{"version":"1.11.0"}')],
  ])
  const plan = U.planApply(root, files, ['lib/keep.js', 'lib/gone.js', 'lib/change.js', 'README.md'])
  check(
    'planApply：内容相同跳过、变化重写、缺失新增、旧清单独有项进删除集、不存在的旧项忽略',
    plan.skip.includes('lib/keep.js') &&
      plan.write.includes('lib/change.js') &&
      plan.write.includes('lib/new.js') &&
      plan.write.includes('.zcode-plugin/plugin.json') &&
      plan.remove.includes('lib/gone.js') &&
      !plan.remove.includes('README.md'),
    JSON.stringify(plan)
  )
  // 无 manifest 的 git 工作区：不猜、不删（readOldFileList 返回 null → remove 空）
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  const gitPlan = U.planApply(root, files, U.readOldFileList(root, { manifest: null }))
  check('readOldFileList：无 manifest 的 git 工作区返回 null（只覆盖不删除）', gitPlan.remove.length === 0, JSON.stringify(gitPlan.remove))

  // 无 manifest 的非 git 目录：整目录扫描 → 旧文件被清理
  const plain = mkRoot('plan-plain', { 'lib/old.js': 'old', 'lib/keep.js': 'same' })
  const plainPlan = U.planApply(plain, files, U.readOldFileList(plain, { manifest: null }))
  check('readOldFileList：非 git 目录整目录扫描，旧文件进入删除集', plainPlan.remove.includes('lib/old.js') && plainPlan.skip.includes('lib/keep.js'), JSON.stringify(plainPlan))
}

// ---------- 5. 应用到目录 + manifest ----------
{
  const root = mkRoot('apply-root', { 'lib/old.js': 'old', 'lib/keep.js': 'same' })
  const files = new Map([
    ['.zcode-plugin/plugin.json', Buffer.from('{"version":"1.12.0"}')],
    ['lib/keep.js', Buffer.from('same')],
    ['lib/new.js', Buffer.from('brand new')],
  ])
  const oldList = ['lib/old.js', 'lib/keep.js', '.zcode-plugin/plugin.json']
  const results = U.applyUpdateFiles(files, '1.12.0', [root], { stamp: 'test-1' })
  const after = (rel) => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8')
    } catch (err) {
      return null
    }
  }
  check(
    'applyUpdateFiles：写入新文件 / 保留未变文件 / 删除旧文件',
    after('lib/new.js') === 'brand new' && after('lib/keep.js') === 'same' && after('lib/old.js') === null,
    JSON.stringify(results[0])
  )
  check('applyUpdateFiles：包内版本号写进 manifest（供下次清理）', (() => {
    const m = JSON.parse(fs.readFileSync(path.join(TMP, 'whale', 'update-files.json'), 'utf8'))
    return m.version === '1.12.0' && m.files.includes('lib/new.js') && !m.files.includes('lib/old.js')
  })())
  check('applyUpdateFiles：旧文件备份到 update/backup/', fs.existsSync(path.join(TMP, 'whale', 'update', 'backup', 'test-1', 'lib', 'old.js')))
  // 再跑一次：所有文件相同 → 不写不删
  const second = U.applyUpdateFiles(files, '1.12.0', [root], { stamp: 'test-2' })
  check('applyUpdateFiles：重复应用幂等（写入 0 / 删除 0）', second[0].written === 0 && second[0].removed === 0, JSON.stringify(second[0]))
}

// ---------- 6. 跳过标记（widget-state） ----------
{
  check('updateSkip 写入合法版本号', (() => {
    const r = B.writeWidgetState({ updateSkip: '1.11.0' })
    return r.updateSkip === '1.11.0' && B.readWidgetState().updateSkip === '1.11.0'
  })())
  check('updateSkip 非法值被忽略', B.writeWidgetState({ updateSkip: 'latest' }).updateSkip === '1.11.0')
  check('updateSkip 置 null 取消跳过', B.writeWidgetState({ updateSkip: null }).updateSkip === null)
}

// ---------- 7. 远端检查（注入 fetch，不出网） ----------
{
  const eps = [
    { name: 'bad', url: 'https://ghproxy.net/x', pick: U.parsePluginJsonVersion },
    { name: 'good', url: 'https://cdn.jsdelivr.net/gh/a/b@main/.zcode-plugin/plugin.json', pick: U.parsePluginJsonVersion },
  ]
  let calls = 0
  const fetchImpl = async (url) => {
    calls++
    if (String(url).includes('ghproxy.net')) throw new Error('connect timeout')
    return fakeRes('{"version":"1.11.0"}')
  }
  const st = await U.checkForUpdate({ current: '1.10.0', endpoints: eps, fetchImpl })
  check(
    'checkForUpdate：首个源失败自动回退，命中后写状态（available + source）',
    calls === 2 && st.available === true && st.latest === '1.11.0' && st.source === 'good' && !st.error,
    JSON.stringify({ calls, source: st.source, latest: st.latest })
  )
  // 上次成功的源会被优先（成功后 source=good，再查时 good 排前）
  let first = null
  const st2 = await U.checkForUpdate({
    current: '1.10.0',
    endpoints: eps,
    fetchImpl: async (url) => {
      if (first === null) first = String(url)
      if (String(url).includes('ghproxy.net')) throw new Error('should not be first')
      return fakeRes('{"version":"1.11.0"}')
    },
  })
  check('checkForUpdate：记住上次可用源并优先使用', String(first).includes('jsdelivr') && st2.source === 'good', String(first))
  // 已是最新：available false
  const st3 = await U.checkForUpdate({ current: '1.11.0', endpoints: eps, fetchImpl: async () => fakeRes('{"version":"1.11.0"}') })
  check('checkForUpdate：版本相同 → available=false', st3.available === false && st3.latest === '1.11.0')
  // 全部失败：写 error，不抛
  const st4 = await U.checkForUpdate({
    current: '1.10.0',
    endpoints: eps,
    fetchImpl: async () => {
      throw new Error('all down')
    },
  })
  check('checkForUpdate：全部源失败写 error（不抛异常）', !!st4.error && st4.error.includes('检查失败'), String(st4.error).slice(0, 60))

  // 镜像缓存陈旧（实测：刚发版后 ghproxy 代理的 raw 仍返回上一版）——不能只看
  // 第一个成功的响应，要取所有候选里的最高版本；旧值不得把新版本盖掉
  const staleEps = [
    { name: 'stale-mirror', url: 'https://ghproxy.net/x', pick: U.parsePluginJsonVersion },
    { name: 'fresh-api', url: 'https://api.github.com/x', pick: U.parsePluginJsonVersion },
  ]
  const staleFirst = await U.checkForUpdate({
    current: '1.10.0',
    endpoints: staleEps,
    fetchImpl: async (url) => fakeRes(String(url).includes('ghproxy.net') ? '{"version":"1.10.0"}' : '{"version":"1.11.0"}'),
  })
  check(
    'checkForUpdate：镜像返回缓存旧版本时不会被当成「已是最新」（取最高版本）',
    staleFirst.latest === '1.11.0' && staleFirst.available === true && staleFirst.source === 'fresh-api',
    JSON.stringify({ latest: staleFirst.latest, source: staleFirst.source })
  )
  const allStale = await U.checkForUpdate({
    current: '1.11.0',
    endpoints: staleEps,
    fetchImpl: async (url) => fakeRes(String(url).includes('ghproxy.net') ? '{"version":"1.10.0"}' : '{"version":"1.11.0"}'),
  })
  check(
    'checkForUpdate：陈旧值 + 权威值并存时以高者为准（available=false，latest 不回退）',
    allStale.latest === '1.11.0' && allStale.available === false,
    JSON.stringify({ latest: allStale.latest, available: allStale.available })
  )
  check(
    '探测地址带时间戳防缓存参数（镜像 CDN 缓存键不命中）',
    U.buildVersionEndpoints().every((e) => e.url.includes('?t=')),
    U.buildVersionEndpoints().map((e) => e.name).join(',')
  )
}

// ---------- 8. 整包更新编排（注入 files，不出网） ----------
{
  const root = mkRoot('run-root', { 'lib/old.js': 'old' })
  const pkg = new Map([
    ['.zcode-plugin/plugin.json', Buffer.from('{"version":"1.13.0"}')],
    ['lib/server.mjs', Buffer.from('new server')],
  ])
  U.writeUpdateState({ latest: '1.13.0', available: true, busy: false, phase: null, error: null, source: null })
  const r1 = await U.runUpdate({ files: pkg, roots: [root], source: 'test' })
  const state1 = U.readUpdateState()
  check(
    'runUpdate：注入整包 → 写入并落状态 done（appliedVersion / busy=false）',
    r1.ok === true && state1.phase === 'done' && state1.appliedVersion === '1.13.0' && state1.busy === false && state1.available === false,
    JSON.stringify({ ok: r1.ok, phase: state1.phase, applied: state1.appliedVersion })
  )
  check('runUpdate：旧文件被清理', !fs.existsSync(path.join(root, 'lib', 'old.js')))
  // 版本不符必须拒装
  const badPkg = new Map([['.zcode-plugin/plugin.json', Buffer.from('{"version":"1.12.0"}')]])
  U.writeUpdateState({ latest: '1.13.0', available: true, busy: false })
  const r2 = await U.runUpdate({ files: badPkg, roots: [root] })
  check('runUpdate：包内版本与目标不符 → 拒绝安装并报错', r2.ok === false && r2.error.includes('版本不符'), String(r2.error))
  // busy 防重入
  U.writeUpdateState({ busy: true })
  const r3 = await U.runUpdate({ files: pkg, roots: [root] })
  check('runUpdate：已有任务进行中 → 直接拒绝（防重入）', r3.ok === false && r3.error.includes('在进行'), String(r3.error))
  U.writeUpdateState({ busy: false, latest: null, available: false, phase: null, error: null })
}

// ---------- 9. 安装目录发现 ----------
{
  // DATA_BASE 在 import 时求值（= 本测试的临时 ZCODE_HOME），所以假 home 就建在 TMP 下
  const cacheRoot = path.join(TMP, 'cli', 'plugins', 'cache', 'zcode-fox-local', 'zcode-fox-widget', '1.0.0')
  fs.mkdirSync(path.join(cacheRoot, '.zcode-plugin'), { recursive: true })
  fs.writeFileSync(path.join(cacheRoot, '.zcode-plugin', 'plugin.json'), '{"name":"zcode-fox-widget","version":"1.0.0"}', 'utf8')
  fs.writeFileSync(
    path.join(TMP, 'cli', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ plugins: { a: { id: 'zcode-fox-widget@zcode-fox-local', installPath: cacheRoot } } }),
    'utf8'
  )
  const roots = U.discoverInstallRoots()
  const hasCache = roots.some((r) => path.resolve(r) === path.resolve(cacheRoot))
  const hasRepo = roots.some((r) => path.resolve(r) === path.resolve(U.REPO_ROOT_FOR_TEST || ''))
  void hasRepo
  check('discoverInstallRoots：按注册表 + 缓存扫描找到安装副本', hasCache, JSON.stringify(roots))
}

fs.rmSync(TMP, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log('\n更新内核自检：' + (results.length - failed.length) + '/' + results.length + ' 通过')
process.exit(failed.length ? 1 : 0)
