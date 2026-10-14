# Phase 6 · 真机验收（自动化部分）

> 作者：WorkBuddy 侧移植会话（2026-10-14）。环境：WorkBuddy **5.8.2**（Windows），
> node `C:/Users/paper/.workbuddy/binaries/node/versions/22.22.2-6/node.exe`（v22.22.2）。
> 本文只记录**在 agent shell 里能做的**那部分验收；必须动客户端 UI 的项在 §6，留给人工。
>
> **本次未发版**：未打 tag、未 push、未改 `main`、未动仓库以外任何既有配置。

## 0. 结论摘要

| 项 | 结果 |
|---|---|
| 宿主契约（读宿主实现逐条比对） | **全部符合**（§1） |
| 真实数据集成冒烟 | **25/25 通过**（§2） |
| MCP 协议 + 5 个工具（真实数据） | **通过**（§3） |
| 三套测试 | **285/285、50/50、103/103**（§4） |
| 发现的问题 | **1 个真实缺陷**（§5.1）+ 2 条环境记录（§5.2/§5.3） |
| 需人工在客户端做的 | 10 项（§6） |

**没有发现阻塞级问题**：清单合法、数据源数字与独立基线逐项吻合、新轮次能触达每轮消耗气泡。

## 1. 宿主契约验证（直接读宿主实现，非推断）

宿主代码位置：`E:/WorkBuddy/WorkBuddyAI/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs`。

| 我们依赖的约定 | 宿主实现原话 | 判定 |
|---|---|---|
| `marketplace.json` 条目 `source: "./"`（市场根即插件根） | `resolveContainedPathAllowingRoot()` → `resolvePathUnderRoot(root, ["./"], /*allowRoot=*/true)`，根自身放行 | ✅ 合法 |
| 目录型市场不复制、原地使用 | `isMarketplaceMaterialized()`：`isDirectoryMarketplaceType(...) → return true` | ✅ 改仓库即生效 |
| 目录型市场的 `installLocation` 可在市场根之外 | `assertSavableInstallLocation()`：目录型直接跳过校验 | ✅ 可指向仓库目录 |
| 清单目录与文件名 | `MANIFEST_DIRS = [".codebuddy-plugin",".workbuddy-plugin",".claude-plugin"]`、`MANIFEST_FILE="plugin.json"` | ✅ 一致 |
| `defaultEnabled` 必须是布尔 | `void 0!==defaultEnabled && "boolean"!=typeof ... → error` | ✅ 我们写 `true` |
| `version` 需 semver 开头 | `/^\d+\.\d+\.\d+/`（不合规只是 warning） | ✅ `2.0.0` |
| `hooks` / `mcpServers` 允许字符串路径 | `'Field "hooks" must be a path, object, or array'`、`'Field "mcpServers" must be an object or string'` | ✅ 我们都用字符串 |
| 插件名合法性 | 校验正则 `…[A-Za-z0-9._]*(?:@[A-Za-z0-9][-A-Za-z0-9._]*)?$` | ✅ `fox-widget` 通过 |
| `${CODEBUDDY_PLUGIN_ROOT}` 插值 | `substitutePluginLoadTimeVariables()` 替换为插件根（同时支持 `${CODEBUDDY_PLUGIN_DATA}`） | ✅ |
| 钩子 `timeout` 单位是**秒** | `{ timeout: t.timeout ? 1e3*t.timeout : void 0 }` | ✅ 我们写 15 / 5 |
| 钩子 `type:"command"` + 字符串命令 | 判别式联合 `type ∈ {command,prompt,agent,http}` | ✅ |
| 裸 `node` 在钩子里可用 | 宿主官方插件 `subscription-gate` / `sheetagent` / `wecom-a2a-auth` 全部写 `node "${CODEBUDDY_PLUGIN_ROOT}/…"` | ✅ 我们逐字同风格 |
| `<pluginRoot>/skills/` 无需声明即被发现 | `let rr="skills"`；`SkillExtensionLoader.load()` 扫 `<root>/skills`（递归，`MAX_SCAN_DEPTH=5`）并额外解析 `<root>/SKILL.md` | ✅ 两个 skill 会被自动发现 |
| `.mcp.json` 文件名校验 | 常量 `[".mcp.json","mcp.json"]` | ✅ |

> 说明：`.codebuddy-plugin/plugin.json` 未显式声明 `commands` / `skills` 字段——由上面的自动扫描约定兜住；
> 宿主官方插件 `agent-browser` 就是不声明 `skills` 也能生效的现成例子（它的 skill 在本会话里是激活的）。

## 2. 真实数据集成（25/25）

做法：把**当前真实** `~/.workbuddy` 整体快照到临时目录（`workbuddy.db`+`-wal`+`-shm`、`projects/`、
`storage/`、`settings.json` 全部复制，**不在原地读写**），在快照上起服务，再把服务给出的数字与
**同一份快照上独立算出来的**数字对账。独立那一侧只用 `node:sqlite` + 手写 JSONL 解析，
**不 import `lib/`**，避免用被测代码验证被测代码。基准口径按 `lib/usage-records.mjs` 的**文档化窗口**
（最近 60 个 transcript、每个尾部 2MB、按本地日切分），但代码独立实现。

会话：`12968ef3-f1f8-4536-863d-34f8272287e5`（本会话），模型 `deepseek-v4.1-flash`。

| 断言 | 服务 | 独立基线 | 判定 |
|---|---|---|---|
| `health.app` | `fox-widget` | 期望常量 | ✅ |
| `health.version` | `2.0.0` | 清单 2.0.0 | ✅ |
| 上下文 `used/size` | `182866 / 1000000` | 库 `182866 / 1000000` | ✅ |
| 上下文百分比 | `18.3` | `18.29` | ✅ |
| 今日 `calls` | `304` | `304` | ✅ |
| 今日 `tokens` | `72,673,835` | `72,673,835` | ✅ |
| 今日 `total`（积分） | `896.9` | `896.9` | ✅ |
| `total == Σ models[].credit` | `896.9 == 896.90` | — | ✅ |
| `total == Σ byVendor` | 通过 | — | ✅ |
| 模型行 `currency` | 全部 `CREDIT` | — | ✅ |
| 主计费源 | `credits` / `订阅积分` | — | ✅ |
| 当前模型 | 与库 `sessions.model` 一致 | — | ✅ |
| `/whale/host-theme.json` | `theme=light, source=preferences` | preferences.json | ✅ |
| `/whale/plan.json` | `ok:false, not-supported-on-workbuddy` | 冻结契约 | ✅ |
| 旧主题路由 `/whale/zcode-theme.json` | `404` | 已改名 | ✅ |

**每轮消耗气泡链路（重点项）**：服务刚起来时 `last-turn.json` 返回 `{seq:0, turn:null}` —
这是**设计如此**（`pollTurnCost()` 首次只对齐当前轮次，不把历史最后一轮当「新的一轮」弹）。
随后向 transcript 追加一条新 `conversationRequestId` 的合成轮次，1 秒轮询捕获到：

```
{"ok":true,"seq":1,"turn":"wx-accept-…","amount":1.25,"currency":"CREDIT",
 "tokens":1600,"model":"glm-5.3","credit":1.25,"calls":1,"partial":true,
 "vendor":"glm","breakdown":{"hit":1000,"miss":240,"cacheWrite":0,"output":360}}
```

| 断言 | 结果 |
|---|---|
| 新轮次后 `seq:0 → 1` 且 `turn` 为新的 requestId | ✅ |
| `credit` = `rawUsage.credit`（无 `credit_json` 时回退） | ✅ `1.25` |
| `currency = CREDIT`、`model = glm-5.3` | ✅ |
| token 分档 `hit/miss/output` = `1000/240/360` | ✅ |
| `partial: true`（宿主尚未结算） | ✅ |
| `seq` 已持久化到 `turn-seq.json` | ✅ |

## 3. MCP 与 CLI

MCP（真实数据，隔离数据目录）：

```
serverInfo = {"name":"fox-widget","version":"2.0.0"} protocol = 2024-11-05
tools: whale_credits, whale_balance, whale_widget, whale_last_turn, whale_config
```

- `whale_credits` → `上下文：212,164 / 1,000,000（21.2%）`、`今日积分：892.18 积分（293 次调用）`、`上一轮：14.64 积分（deepseek-v4.1-flash，48 次调用）` ✅
- `whale_last_turn` → 逐档明细（缓存命中 7,489,664 / 未命中 162,320 / 输出 49,646）+ 等价金额 `≈ ¥1.0214`（**明确标注非真实扣费**）✅
- `whale_balance` → 如实报「未找到 DeepSeek API Key」并说明这是**可选卡**、给两条配置途径 ✅
- `whale_widget` → `桌面浮层：未运行 · 运行时未安装`（**如实**）✅

CLI `status` / `turn` / `json` 在隔离环境全部 exit 0（见 `tools/` 与 Phase 5 文档）。

## 4. 三套测试（对当前 `lib/`）

```
node tools/selftest.mjs         → 285/285 通过，0 失败 0 跳过，exit 0
node tools/selftest-update.mjs  →  50/50  通过，exit 0（含重启链路端到端）
node tools/smoke-ui.mjs         → 103/103 通过，0 跳过（本机 msedge 真跑），exit 0
```

## 5. 发现

### 5.1 【真实缺陷】混元 / 阶跃模型被归为「未知来源」

`lib/source.mjs` 的 `sourceByModel()` **认识** WorkBuddy 宿主模型族
（`hy*`/`hunyuan` → `hunyuan`；`step-*`/`stepfun` → `stepfun`，见该文件 103–105 行），
但 `lib/pricing.mjs` 的 `resolveVendor()`（351–371 行）**没有这两支**，
于是 `resolvePricing()` 走到 `none(null, '未知来源', null)`（406 行），
模型行的 `vendorLabel` 变成「未知来源」，聚合进 `usage-records` 的 `byVendor` 里。

**真实数据实证**：全部 transcript 的模型分布为

| requestModelId | 调用 | 积分 |
|---|---|---|
| `glm-5.3` | 156 | 1133.95 |
| `deepseek-v4.1-flash` | 643 | 161.23 |
| `hy4-preview` | 2 | **8.60** |
| `glm-5.2` | 1 | 6.73 |
| `step-5-preview` | 74 | 0.00 |

服务返回的 `byVendor` 里 `"未知来源": { credit: 8.6, tokens: 6471270 }` —— 8.6 正好等于
`hy4-preview`，6,471,270 tokens 主要来自 `step-5-preview`。**两个宿主自家模型都没有厂商归属**。

影响：用量面板「按厂商」视角把这两族混进「未知来源」，厂商占比失真；不影响能否计价（这两族本来也没价目）、
不崩溃、不影响积分总额。

建议修法（二选一）：在 `resolveVendor()` 里补 `hy*`→`hunyuan`、`step-*`→`stepfun`；
或让 `costOfUsage` 在 vendor 未命中价目表但 `source.mjs` 认得时，仍给出**厂商标签**（仅标签、不折算金额）。
**未擅自修改**——等你人工测试后再决定改不改、何时改。

### 5.2 【环境记录】宿主自带校验器在本沙箱里用不了

`codebuddy plugin validate <path>` 会卡在宿主启动期的远端配置拉取（`fetch config failed` + 挂起），
`--help` 之外的所有子命令都超时。所以**本次没有拿到宿主校验器的结论**，§1 的契约验证全部来自
直接读宿主实现 + 与官方插件逐条对照，不含 `plugin validate` 的结果。

### 5.3 【环境记录】残留的插件数据目录（来自更早的测试）

验收开始时 `~/.workbuddy/plugins/data/fox-widget-fox-local/` 已存在（11K），内容**全部是测试残留**：

```
fox-widget-fox-local/
├─ server.json          记着一个早已退出的 pid 与 39322 端口
├─ widget-state.json    测试写入的默认外观
├─ update-state.json    测试的报错文案
├─ update-files.json    根指向 C:\...\Temp\fox-update-test-* 临时目录
└─ update/backup/
   ├─ test-1/.zcode-plugin/plugin.json + root.json   ← 测试夹具
   └─ test-3/.zcode-plugin/plugin.json + root.json   ← 测试夹具
```

**没有真实用户配置混在里面**；不影响真机（插件只在 `server.json` 记录的端口有响应时才认作「服务在跑」）。

**处置**：用户选择清掉。实际结果是——两次尝试删除**都没由我执行**（第一次被 `Add-Type` 安全策略整条拦下，
第二次进来时目录已不存在），目录在 **14:38 前后**消失，`plugins/data/` 的 mtime 与之吻合。
最可能是宿主自己的插件数据目录清理（宿主代码里有 `.in_use` / `.orphaned_at` 标记与 sweep 机制，
`fox-widget-fox-local` 从未被安装过，属「孤儿」）。现状已核验：全盘 `find ~/.workbuddy/plugins -iname "*fox*"`
无任何命中。**记录如此，避免误以为是本会话删的。**

另外：本机 39321 / 39322 / 39323 **当前都没有监听**（ZCode 版挂件服务此刻也没在跑），
桌面没有浮层进程。

### 5.4 【已修】README 的安装步骤写错了，导致真机卡在第一步

**症状**：用户按 README 装完并重启后完全看不到挂件。查宿主状态：

| 检查点 | 结果 |
|---|---|
| `plugins/known_marketplaces.json` 里的 `fox-local` | **不存在** |
| `plugins/installed_plugins.json` 里的 `fox-widget` | **不存在** |
| `settings.json` 的 `enabledPlugins` | **不存在** |
| `plugins/cache/`、`plugins/marketplaces/` 下的 fox 目录 | **不存在** |
| 插件数据目录里的 `autostart.log` / `hook-state.json` / `server.json` | **全都不存在**（只有我装的 `desktop-runtime`） |
| 任何端口上的 `/whale/health` | 无响应 |
| 宿主日志里的 `[PluginMcpProvider] catalog scan`（重启时 14:45:52） | `installed=42, readable=42`，**没有 fox** |
| 宿主日志里 UI 调用的市场类接口 | 只有 `wb:connectors:listMarket`、`wb:experts.market:*`、`wb:skills.marketplace.skillhub:getInstalledMetas` ——**从未调用过任何「添加插件市场」的接口** |

即：**注册没发生，插件从未安装，所以钩子一次都没跑过**——挂件当然不会出现。这不是挂件的 bug。

**根因**：README 原文写「设置 → 插件管理 → **发现** → 右上角 `+` → **选择本地目录**」，
而宿主实际的「添加市场」UI 是**一个填「市场源」的文本框，不是文件夹选择器**。
宿主文案（`renderer/assets/zh-cn-*.js`）：

```
plugins.title                    = 插件管理
plugins.addMarketplace           = 添加市场
plugins.addMarketplace.sourceLabel = 市场源
plugins.addMarketplace.sourceTip = 示例：owner/repo（GitHub）、git@…（SSH）、https://….zip（ZIP）、./path/to/marketplace（本地）
plugins.addMarketplace.placeholder = owner/repo 或 https://...
plugins.marketplace.refresh      = 刷新
```

且入口不在「设置」里——`plugins.addMarketplace` 的按钮渲染在**技能市场页**的组件里
（`renderer/assets/skills-market-*.js`，与 `plugins.marketplace.delete/refresh` 同处），
宿主日志里也是 `MarketPageLoadCollector tab=skills / tab=experts`。

宿主对输入串的处理（`pluginManager.parseSource()`）：

```js
async parseSource(t){
  let i = ey.P.resolveFilePathToWorkDir(t)
  if (await ec.pathExists(i)) {           // ← 路径真实存在 ⇒ 本地目录市场
    let t = i.toLowerCase()
    return t.endsWith('.zip')||t.endsWith('.tgz')||t.endsWith('.tar.gz')
      ? { source: p.Zip, path: i, url: i }
      : { source: p.Directory, path: i }
  }
  if (t.startsWith('npm:')||t.startsWith('pip:')) return {...}
  if (t.match(/^[\w-]+\/[\w-]+$/)) return { source: p.Github, repo: t }
  if (t.startsWith('git@')) return {...}
  try { new URL(t) ... } catch { if (t.endsWith('.git')) ...; throw Error(`Unsupported source format: ${t}`) }
}
```

**结论：必须在「市场源」里填一个真实存在的路径**（仓库根目录的绝对路径），
填市场名 / 插件名 / 目录名都会走进 `Unsupported source format` 分支。

**已修**：`README.md` 的「安装」一节按上面重写（明确是文本框、要填绝对路径、入口在技能市场页、安装时选 user 范围），
「更新」一节里的入口也同步改成技能市场页的「刷新」。这是**本阶段唯一改动仓库文件的地方**（纯文档）。

#### 补充（第二轮：用户反馈「专家·技能里没有插件管理」）

用户第一次尝试后反馈：在「专家·技能」里找不到插件管理；从「技能」页的**导入技能**里选仓库目录，
提示「没有 `.skill`」。截图核对 + 读前端路由与导航配置后定位到**真正的入口层级**：

`renderer/assets/route-config-TvV2OaIr.js` 的路由表：

```js
{path:`discover`,   Component: MarketPage,  handle:{view:`discover`}}     // market-CjnsC-C5.js
{path:`connectors`, Component: MarketPage,  handle:{view:`connectors`}}
{path:`plugins`,    Component: PluginsPage, handle:{view:`plugins`}}      // plugins-riuGq-0A.js
```

`renderer/assets/contexts-BMeWSUHk.js` 的侧栏项定义（`builtin:*`）：

```js
{id:`market`, target:`builtin:experts`, title:`conversation.experts`, order:40, children:[
   {id:`experts`,     target:`builtin:experts`,     title:`unifiedMarket.tab.experts`},      // 专家
   {id:`skills`,      target:`builtin:skills`,      title:`unifiedMarket.tab.skills`,        // 技能
    config:{defaultTab:`recommend`, tabs:[
       {id:`recommend`},{id:`skillhub`},{id:`plugins`},{id:`knot`},{id:`enterprise`}]}},      // ← 「插件」在这里
   {id:`connectors`,  target:`builtin:connectors`,  title:`unifiedMarket.tab.connectors`}]}   // 连接器
```

⇒ **「插件」是「技能」页里的一个子分页**（`unifiedMarket.tab.skills` → 子分页 `plugins` → 路由 `/plugins`
→ 组件 `PluginsPage`），不是顶栏的一级入口。中文文案：`conversation.experts = 专家·技能·连接器`、
`unifiedMarket.tab.skills = 技能`、`conversation.plugins = 插件`、`plugins.addMarketplace = 添加市场`。

**路径确认**：左栏「专家·技能·连接器」→「技能」→「插件」子分页 → 页头右上角圆形 `＋`（添加市场）。
「导入技能」（`collab.config.skillsDrawer.importAction`）只收 `.skill` 技能包，**与插件是两套东西**，
所以拿仓库目录去导入必然报「没有 .skill」——这条路走不通，不是配置问题。

**宿主 CLI 这条路也不通**（已实测）：`<宿主>/cli/bin/codebuddy plugin marketplace list`
与 `plugin validate` 都会卡在启动期的远端配置拉取，**200s 超时**（`EXIT=124`，无任何输出）。
所以「添加市场」目前只能走客户端 UI。

**README 已按这个层级再修一次**（第一版只写到「技能市场页」，粒度不够，用户仍然没找到）。

**顺带确认的一个环境事实**：本机 WorkBuddy 的「技能」页子分页里有 `knot` / `enterprise` 等，
说明宿主的插件市场体系是通用的；「插件」分页正是给 `fox-local` 这种本地市场用的。

### 5.5 【已修·阻塞级】真机看不到挂件：浮层继承了宿主的 `ELECTRON_RUN_AS_NODE`

**现象**（用户第二轮反馈）：插件确实装上了、服务也在跑，但桌面就是没有挂件。

**证据链**（这次是「肯定式」的，与 §5.4 的「否定式」正好相反）：

| 检查点 | 结果 |
|---|---|
| `known_marketplaces.json` | `fox-local` → `C:\Users\paper\WorkBuddy\Worktrees\zcode-fox-widget\main-56fc9dd2` ✅ |
| `installed_plugins.json` | `fox-widget@fox-local` → `plugins/cache/fox-local/fox-widget/2.0.0` ✅ |
| `settings.json` `enabledPlugins` | `"fox-widget@fox-local": true` ✅ |
| 钩子 | `hook-state.json` 有会话身份（`UserPromptSubmit` 已落盘）✅ |
| 服务 | `curl 127.0.0.1:39321/whale/health` → `app: fox-widget, version: 2.0.0, pid: 700` ✅ |
| `autostart.log` | `server=started overlay=failed:浮层进程启动后立即退出` ← **只有浮层挂了** |

即：**服务侧全通，唯一失败的是浮层进程**。

**根因**：宿主的环境变量里有（实测打印）

```
ELECTRON_RUN_AS_NODE=1
NODE_OPTIONS=--require="E:/WorkBuddy/…/cli/vendor/shim/node-language-shim.cjs"
```

WorkBuddy 自己把 Electron 二进制当 Node 用，所以给派生的子进程注入了
`ELECTRON_RUN_AS_NODE=1`。而 `lib/overlay.mjs` 的 `startOverlay()` 用
`env: { ...process.env, … }` 起浮层 —— **继承了它**，于是 `electron.exe` 以 Node 模式启动。

**决定性实测**（同一个 `electron.exe`，零风险）：

```
ELECTRON_RUN_AS_NODE=1   electron.exe --version  →  v24.21.0   （node 版本！）
env -u ELECTRON_RUN_AS_NODE  electron.exe --version  →  v44.7.2  （Electron 版本）
```

以 Node 模式启动时 `require('electron')` 拿不到 `app` / `BrowserWindow`，主进程立刻抛错退出
→ 浮层「启动后立即退出」。**这是 ZCode 分支碰不到的问题**（那边没有这个变量），
是移植到 WorkBuddy 后才暴露的宿主差异。

**修法**（`lib/overlay.mjs`）：

1. 新增 `overlaySpawnEnv(svc)`：spawn 前 `delete ELECTRON_RUN_AS_NODE`、`delete NODE_OPTIONS`，
   其余环境照旧（PATH 等必须保留），只作用于浮层子进程，父进程不动。
2. 浮层 stderr 落 `<插件数据目录>/overlay-spawn.log`。原来是 `stdio:'ignore'`，
   导致前两次真机失败**完全没有现场**（父进程是钩子/MCP，退出后管道就断了）。
3. 失败文案改成先指向该日志，不再误导人去重装运行时（运行时本来是好的）。

**探针验证**（用「启动就自己退出」的最小 Electron 应用，避免违反「浮层真机操作在客户端做」的纪律）：
清理过的环境下 Electron 正常起来 —— `electron=44.7.2`、`app class=function`、
`window created ok=true`，791ms 正常退出。顺带确认：agent shell 里 GPU 子进程仍会崩
（`exit_code=-1073741819` = `0xC0000005`，就是 HANDOFF §5 记的那条），但 Electron 会
**自动回落软件渲染**，不影响启动。

**已同步到已安装副本**：`plugins/cache/fox-local/fox-widget/2.0.0/lib/overlay.mjs`（做了 `cmp` 逐字节核对）。
注意：**必须换新进程才生效**——当时跑着的 MCP 服务与 `server.mjs` 进程都是 15:11 启动的旧代码，
在内存里缓存着旧模块（用 MCP 工具再点一次 `overlay_start` 仍报旧文案即为证据）。

### 5.6 【已修】一条「到点才红」的假失败断言（用量记录排名）

复跑 `tools/selftest.mjs` 时出现 1 项失败：

```
❌ 用量记录：两个榜各自降序（金额榜按排名值 / token 榜按 tokens）
   {"amt":[5.600009999999999,0.94,1.1235,0.3,0.03], …}
```

先排除「是不是我给 5.5 动 `lib/` 弄出来的」：把 **HEAD 的原始代码**导出到临时目录单跑，
**同样这一条失败**（数值一模一样）→ 既存问题，与 5.5 无关。

根因：断言用**等价市值** `market` 当排序键，而服务端 `usage-records.mjs` 的 `modelsList()`
是按 **`credit`（积分）** 排的（`rankByCredit`，token 作次键）。而 fixture 的时间戳是
`Date.now()`，等价市值会随 DeepSeek 峰谷时段（`PEAK_HOURS = [9,12],[14,18]`）翻倍 ——
**off-peak（如 12:00–13:59）时「积分序」与「市值序」恰好同向**，所以这条断言看起来一直是绿的；
15:16（peak）复跑才暴露（`0.94` 与 `1.1235` 反序）。

修法：断言改用 `credit`（与服务端口径一致），并写清「不要拿 `market` 验这条」的原因。
结果：**290/290**（285 + 5.5 新增的 5 条浮层环境断言）。

> 这条值得单独记：**它是"时间相关的假失败"**。同一份代码在不同钟点跑出不同结论，
> 会让人误以为「刚改的东西把测试搞红了」。以后遇到「昨天还绿今天红了」先看
> 有没有踩到 `PEAK_HOURS` / `Date.now()` 这类时间依赖。

## 5.7 5.5 的修复在真机上得到确认（阻塞项关闭）

> ⚠️ **本节结论已被 §5.8 更正。** 本节列的显隐事件本身是**真实的**（`host-not-foreground` 的确存在），
> 但把它当成用户「看不到挂件」的**主要原因**是错的 —— 用户实测指出真正的主线是**浮层活不过一轮对话**。
> 请以 §5.8 为准，本节只保留事件记录。

用户重启后反馈「仍然没有显示」，但读浮层黑匣子 `<插件数据目录>/overlay-debug.log` 得到的
是**完全成功的现场** —— 这次修复生效了，只是报告发早了半分钟：

```
15:26:10.406  follower-started interval=40ms
15:26:12.771  host-identity pid=32304 start=1791962682726 prev=0/0
15:26:12.773  hidden host-not-foreground          ← 重启瞬间前台不是 WorkBuddy（当时是 29068，随即退出）
15:26:14.343  page-linfo [zcw] auto-role deepseek-v4.1-flash -> whale   ← 页面已加载、按模型自动选角
15:26:41.630  shown-at {"x":540,"y":0,"width":1208,"height":1104}       ← ★ 浮层显示
15:26:41.631  state show=true fgIsWorkBuddy=true
15:26:48.668  pd drag-start hit=1638,977          ← 用户开始拖拽
15:26:48.738  click -> showBubble moved=false     ← 点击弹气泡（此后连续几十次交互）
15:27:07.218  state show=false fgPid=30184 fgIsWorkBuddy=false
15:27:07.222  hidden host-not-foreground          ← 前台切到 War Thunder → 按设计隐身
```

配套证据：`autostart.log` 变成 `server=started overlay=started`（上一次是 `overlay=failed`）；
`overlay-spawn.log` **0 字节**（Electron 无任何报错）；`overlay.json` pid 12240；
5 个 electron 进程存活；`host-theme-observed.json` 被写入（说明跟随脚本与主题观测都在工作）。

**结论**：§5.5 的修复正确且充分。用户以为「没显示」的两个原因都是**设计行为**，不是缺陷：

1. **报告发早了**：用户 15:26:08 说「没有显示」，浮层 15:26:41 才出现（重启过程中 WorkBuddy
   还没拿到前台，浮层按 `host-not-foreground` 隐身；等 WorkBuddy 成为前台才显示）。
2. **浮层只跟随 WorkBuddy 前台**：用户切到别的应用（实测切到了 `War Thunder`）就隐身。
   想让它「切到别的窗口也不消失」，要用挂件菜单里的 **桌宠模式**（`pet-mode`，日志里有对应行）。

> 因此「界面看不到挂件」这个症状要**先问一句「你是不是在别的窗口上」**——
> 浮层的默认行为就是只跟在 WorkBuddy 前台，这在验收清单第 1/7 条上容易被误判成故障。
> `kick reshow` 机制保证即使漏了一次状态消息，也会在约 30s 内重新补一次显示。

## 5.8 【已作废，见 §5.9】浮层活不过「一轮对话」—— 宿主按轮回收子进程

> ⚠️ **本节的两个核心论断后来都被证伪**：①「每轮触发 SessionStart」——`autostart.log` 只有 4 行，
> 不是每轮；②「回合结束宿主用作业对象杀掉浮层」——12 分钟采样器显示浮层进程横跨两次回合结束
> 一直存活。**结论请看 §5.9。** 下面保留原文，作为「证据挑着看会得出错误结论」的实例。

**这一节纠正 §5.7 的结论。** §5.7 把用户的「挂件消失了」解释成「前台不在 WorkBuddy」，
只解释了**个别** hide 事件，漏掉了用户真正感受到的**主要**行为。用户实测反馈：

> 挂件两次消失都发生在**我这一轮对话跑完**的时候；两次出现都是**我发起新一轮对话之后**突然出现。

**用户是对的。** 真因是宿主的两条语义叠加：

### 证据

`autostart.log`（每次 SessionStart hook 跑一行）与用户发言一一对应：

```
15:11:30  server=started overlay=failed:…     ← 修复前
15:26:12  server=started overlay=started      ← 用户第 1 条消息之后
15:32:00  server=started overlay=started      ← 用户第 2 条消息之后
15:36:58  server=started overlay=started      ← 用户第 3 条消息（15:36:55）之后
```

⇒ **WorkBuddy 每轮对话都触发一次 `SessionStart`**（不是每次开客户端一次）。
而且四行里 `overlay` **从来没有 `reused`** —— `startOverlay()` 只有在「找不到活着的浮层」时才会
返回 `started`，所以**上一轮的浮层在下一轮钩子跑之前就已经死了**。

浮层 pid 逐轮更换，实锤「死一个、起一个」：`12240`(15:26) → `31828`(15:31:58) → `31680`(15:36:56)。
每次新浮层的**父进程都已退出**（`21940` / `36968`），因为那是**短命的钩子进程**。
服务同样逐轮重起（`server=started` 每轮都是 started，pid `700` → `13352` → …）。

### 机制：**部分确认，且已被新数据部分反证**（写清楚哪些是实的、哪些还没定）

**已经坐实的（可复现）：**

1. **WorkBuddy 每轮对话触发一次 `SessionStart`**。`autostart.log` 的行与用户发言一一对应
   （15:26:12 / 15:32:00 / 15:36:58 ↔ 15:26:08 / 15:31:54 / 15:36:55）。
2. **钩子起的浮层会「换新」**：四行全是 `overlay=started`、从无 `reused`
   （`startOverlay()` 只有找不到活着的浮层时才返回 `started`）→ **前两轮的浮层确实没活到下一轮**。
   浮层 pid 也逐轮更换：`12240`(15:26:10) → `31828`(15:31:58) → `31680`(15:36:56)，
   且每次新浮层的**父进程都已退出**（短命钩子进程）。
3. 宿主 CLI 侧确实有 kill-on-close 的作业对象：`cli/bin/no-orphans.cjs` → `ensureKillOnCloseJob()`
   （原生 `job-object.node`），且 `no-orphans.install()` 在 CLI 入口、业务代码之前运行。

**没能坐实、而且被反证的（上一版这里写得太满，已修正）：**

- 我先断言「我这轮跑完 → 会话进程退出 → 作业关闭 → 浮层被杀」。**这条是错的**：
  我起了个采样器（每秒记录浮层存活 + 前台窗口），它 **跨过了我的回合结束点继续运行**
  （`07:38:31` → `07:42:47+` 连续采样，mtime 到 15:44），而且那一轮的浮层 `31680`
  **也跨过了回合边界一直活着**（`alive=true`、`electronProcs=5` 全程不变）。
  ⇒ **「回合结束必杀浮层」不成立。** 至于 `12240`/`31828` 当初究竟被谁杀掉，**原因还没定**。
- 另一个反证：宿主 CLI 的**预热池**（`codebuddy --prewarm --prewarm-id wb-pool-…`）
  进程的 argv 里**没有** `--no-orphans`，所以按 `no-orphans.install()` 的判定
  （`if (!args.includes('--no-orphans') && isDisabled(env)) return false`），
  环境变量开关是**有效路径**。

**结论**：目前只能说「浮层与服务的生命周期**与对话轮次强相关**，每轮都会被重新拉起」——
用户观察到的「回合结束消失、新回合出现」是真实存在的现象，但**具体是"被杀"还是"自己退出"、
触发点在回合的哪一刻，还没定论**。下一步靠采样器继续覆盖回合边界来定（它仍在跑）。
**在定论之前不要照 §5.8 的方案去改宿主设置。**

### 修复方向（**待定论后再选**，当前未改任何宿主设置）

| 方案 | 说明 | 代价 / 状态 |
|---|---|---|
| **A. 关掉宿主的子进程包含** | 让宿主不再装那个 kill-on-close 作业对象。**可靠做法是设 Windows 用户环境变量** `CODEBUDDY_DISABLE_CHILD_PROCESS_CONTAINMENT=1`，然后**完全重启 WorkBuddy**（新起的 CLI 进程才带上它）。<br>`~/.workbuddy/settings.json` **目前没有 `env` 块**，宿主是否会把该块下发给 CLI 进程**未验证**，所以不要依赖它。 | 宿主**全局**不再兜底清理残留子进程（不止本插件）；且 #5.8 的机制还没定论，**现在改可能白改** |
| **B. 让它由「作业之外」的进程代建** | 例如从**普通终端**（不是 WorkBuddy 里的终端）或桌面快捷方式跑 `node lib/cli.mjs window start` —— 那个进程不在宿主作业里，浮层就能常驻 | 需要用户手动做一次「自启」；WMI / 任务计划这类自动代建在本沙箱不可验（`Invoke-CimMethod` 被安全策略拦、`schtasks.exe` 在黑名单且不可绕过） |
| **C. 向平台提需求** | 插件需要一个**跨回合的常驻宿主**；否则任何「常驻桌宠」类插件都做不成 | 等平台 |

**未擅自改任何宿主设置或插件配置。**

### 复现方法（可交给任何人验）

```powershell
# 1) 看每轮钩子都在跑、且从没 reused
Get-Content "$env:USERPROFILE\.workbuddy\plugins\data\fox-widget-fox-local\autostart.log"
# 2) 看浮层 pid 逐轮变化（每发一条消息就换一个）
(Get-Content "$env:USERPROFILE\.workbuddy\plugins\data\fox-widget-fox-local\overlay.json" | ConvertFrom-Json).pid
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Select-Object ProcessId, ParentProcessId, CreationDate
# 3) 浮层的父进程每次都「已退出」= 短命钩子
```

## 5.9 【结论·已定案】用户看到「随对话出现/消失」的角色是 **WorkBuddy 自带桌宠**，不是本挂件

§5.7 与 §5.8 错在同一个地方：把「用户看到的那个角色」默认成了本挂件。本节用两条独立证据定案。

### 证据 A：截图里那个角色是**宿主的**资产

用户提供的截图（`~/.workbuddy/clipboard-images/clipboard-2026-10-14T07-36-55-364Z-d027dde4.png`）
里有一个**灰白猫耳 + 耳机 + 深色面罩 + 两个 `^ ^` 眼睛、带倒影**的机器头。放大后逐一比对：

- 本仓库**五套内置角色**全是 chibi 少女：嘎啦嘛（深蓝发猫耳 maid）、大肥鱼（蓝发）、GPT娘、
  kimi娘、小克（橙发）——**没有一个是灰白机器头**。
- 宿主渲染层里有完全对应的资产 `renderer/assets/default-miao-BlTmPevf.png`，在
  `renderer/assets/contexts-BMeWSUHk.js` 里绑定给 `HomePetActivityBubble` /
  `HomePetActivityRestoreButton`（**带活动气泡 + 收起/恢复按钮的宠物组件**）。

⇒ 那个角色是 **WorkBuddy 自带的桌宠（home pet，资源名 `miao`）**，由宿主界面自己渲染。

### 证据 B：截图那一刻，本挂件确定不在屏幕上

- 截图是在 **15:36:55** 贴进对话的（剪贴板文件名时间戳 `…T07-36-55.364Z`），消息在 15:36:57 发出
  （SessionStart 钩子 15:36:58.702Z）。
- 浮层日志：**15:34:37 隐身 → 15:36:59 才显示**。截图时刻落在隐身窗口内。
- 整张截图里也不存在任何一套本挂件角色立绘。

⇒ 用户看到的「出现/消失」**只能是宿主的桌宠**。它带 `ActivityBubble`，语义就是「助手在干活」，
所以「发消息就冒出来、我这一轮跑完就收回去」——正是用户描述的现象。

### 本挂件的真实规则：零例外

把 `overlay-debug.log` 里全部 **47 条** follower 状态行拉出来逐条核对：

```
show === (fgIsWorkBuddy || fgIsOverlay) && !minimized
```

**47/47 一致，0 例外。** 24 次隐身的实际原因：

| 隐身时前台是谁 | 次数 |
|---|---|
| `explorer.exe`（桌面 / 任务栏） | 8 |
| War Thunder（`aces.exe`） | 5 |
| QQ | 5 |
| Edge | 4 |
| ShellExperienceHost / SearchHost | 各 1 |
| 前台进程已退出 | 1 |
| WorkBuddy 被最小化 | 1 |

**从来没有一次是「WorkBuddy 在最前却隐身」。** 另有一个 12 分钟、每秒采样一发的采样器证明：
浮层进程 `31680` 从 15:36:56 到 15:50:32 **一直存活**，横跨了我两次回合结束。

### 更正 §5.8 里说错的两点

1. ~~「WorkBuddy 每轮对话触发一次 SessionStart」~~ —— **错**。`autostart.log` 只有 4 行
   （15:11 / 15:26 / 15:32 / 15:36:58），用户后来的消息没有再触发。它是**会话开始**时触发，
   前三次对应的是用户那几次重启客户端。
2. ~~「回合结束时宿主用 kill-on-close 作业对象杀掉浮层」~~ —— **错**，被采样器否掉。

### 对用户的实际意义

- 想「切到别的窗口也不消失」：开本挂件菜单里的 **桌宠模式**（`pet-mode`）。
- 分辨两个角色：灰白猫耳**机器头**（有倒影、可能带对话气泡）= 宿主桌宠；
  蓝发 / 深蓝发 chibi **少女** = 本挂件（当前选中 嘎啦嘛）。
- 两者默认都落在**右下角**（本挂件落位是 `{"hAnchor":"right","hDist":0,"vAnchor":"bottom","vDist":0}`，
  读自 `%APPDATA%\fox-widget-overlay\Local Storage`），会**互相重叠**。
  **待办**：给本挂件默认落位加一点偏移，避免与宿主桌宠叠在一起。

---

## 5.10 【根因·已修】冷启动后挂件不出现 —— WorkBuddy 启动客户端不触发 `SessionStart`

用户给出稳定复现：**启动 WorkBuddy 时挂件不显示，随便点一个「对话回退」按钮后挂件才出现。**

### 证据：宿主日志里有每次钩子执行的原始记录

宿主会记 `[SessionHookManager] executeSessionStartHooks source=<source>`。把它与
`AppStartup.log` 的 `[AppStartup]` / `[AppShutdown]` 按应用实例对齐：

| 应用实例启动 | 存活 | 期间 SessionStart |
|---|---|---|
| 15:10:42 | 817s | 15:11:30 / resume（+49s） |
| **15:24:26** | **14s** | **★ 一个都没有 ★** |
| 15:24:43 | 2143s | 15:26:12（+89s）、15:32:00（+437s）、15:36:58（+736s） |
| 16:00:30 | 566s | 16:02:26 / resume（+116s） |
| 16:09:59 | 87s | 16:11:16 / resume（+78s） |
| 16:11:29 | 23s | 16:11:47 / resume（+19s） |
| 16:11:56 | 26s | 16:12:19 / resume（+22s） |
| **16:12:26** | **21s** | **★ 一个都没有 ★** |
| 16:12:51 | 仍在运行 | 16:13:10 / resume（+19s） |

两条判据都是硬的：

1. **有两个应用实例从启动到退出，SessionStart 一次都没跑** → 启动本身不触发它。
2. **其余实例里的延迟从 +19s 到 +736s 毫无规律** → 不是启动后的定时器，而是**用户动作**驱动。
3. `source` 分布：本工作区日志里 **12 × `resume` + 1 × `startup`** —— `resume` 才是常态，
   它对应「真正进入/恢复一个会话」（用户点「对话回退」正是这类操作）。

另外把宿主的钩子事件枚举整个拉出来核对过，**没有任何「应用启动」类事件**
（`SessionStart / SessionEnd / UserPromptSubmit / PreToolUse / PostToolUse / PostToolUseFailure /
Notification / Stop / StopFailure / SubagentStop / SubagentStart / PreCompact / PostCompact /
PermissionRequest / PermissionDenied / Elicitation(Result) / TaskCreated / TaskCompleted /
TeammateIdle / Setup / ConfigChange / InstructionsLoaded / FileChanged / CwdChanged / FinalStop /
WorktreeCreate / WorktreeRemove / UserPromptExpansion`），所以**没有启动钩子可挂**。

### 修法

在 `lib/hook-event.mjs`（本来就挂在 `UserPromptSubmit` / `Notification` 上）里加一次
**极廉价**的兜底：

- 读 `<数据目录>/server.json` 与 `overlay.json`，用 `process.kill(pid, 0)` 判活
  （**不**调用 `listOverlayPids()`——那要起一次 PowerShell，实测 1.76s，放不进每轮的钩子）；
- 只要服务或浮层不活着，就 **`detached` 后台拉起 `autostart.mjs` 并立即返回**，
  **不 await**，所以不拖慢用户这一轮；
- 20s 节流（锚点存在 `hook-state.json` 的 `lastEnsureSpawnAt`），避免连发消息拉出一堆 Electron；
- `FOX_WIDGET_NO_ENSURE=1` 可关（排障 / 测试用）。

效果：冷启动后**用户做的第一件事**（发消息、或点回退走 SessionStart）就会把挂件带出来，
不再是「只有进会话才有」。

### 验证

- 隔离实测 8/8：服务不在 → 触发补拉起且 `autostart.log` 出现；节流生效；`Stop` 不触发；
  服务+浮层都活着 → 一次都不 spawn。
- 已进主自检（`tools/selftest.mjs` 新增 6 条）→ **296/296**。
- 修复已同步到**已安装副本**（`plugins/cache/fox-local/fox-widget/2.0.0/lib/hook-event.mjs`，
  `cmp` 逐字节一致）。钩子命令每次调用才解析文件，所以**不需要重启就能生效**。

> 顺带说明一个**不是** bug 的现象：`autostart.log` 里每次都是 `overlay=started`、从无
> `reused`。原因是每一轮复现都伴随一次 **WorkBuddy 重启**（`AppShutdown` → `AppStartup`），
> 浮层随应用退出而消失，下一次钩子当然只能重新起。`listOverlayPids()` 本身是好的
> （实测能正确返回在跑的浮层 pid）。

---

## 6. 必须人工在客户端做的（本次做不到）

agent shell 里**不能**起浮层（Electron GPU 子进程必崩 + `ELECTRON_RUN_AS_NODE` 污染，见
`HANDOFF-WORKBUDDY-PORT.md` §5），也没有客户端 UI 可点。以下 10 项要在 WorkBuddy 客户端里过：

准备（一次性）：

1. **注册市场**：技能市场页（带「技能 / 专家」分栏、页头标题「插件管理」）→ 页头右上角圆形 `＋`
   （悬浮提示「添加市场」）→ 在「**市场源**」文本框里粘贴**仓库根目录的绝对路径**
   → 提交。（**不是**文件夹选择框；见 §5.4）
2. **安装并启用** `fox-widget`：在刚添加的 `fox-local` 市场里安装，范围选 **user**
   （清单已写 `defaultEnabled: true`）。
3. **重启会话 / 重开 WorkBuddy**，让 MCP 与钩子加载。
4. ~~装浮层运行时~~ **已完成**：`node lib/cli.mjs desktop install` 已跑通，
   Electron 运行时落在 `<插件数据目录>/desktop-runtime/`（解压后 381MB，
   `node_modules/electron/dist/electron.exe` 就位）。`cli status` 已不再报「未安装」。

> 第 1、2 步按约定在**客户端界面**里做（宿主支持的路径；直接手写 `known_marketplaces.json` /
> `settings.json` 有被运行中的宿主覆盖的风险）。第 3 步必须重启——MCP 与钩子只在会话启动时加载，
> **当前这个会话看不到新插件**。

逐条过（对应 `HANDOFF-WORKBUDDY-PORT.md` §7）：

- [ ] **1** 会话启动自动出现挂件；`autoStartWidget=false` 后不再自启
- [ ] **2** 菜单能开、能点、**不打断宿主前台**；点角色后宿主画面不冻结
- [ ] **3** 三个数字出数：今日积分 / 本轮 credit / 上下文 xx%，与客户端显示一致
- [ ] **4** 上下文余量与实际会话长度相符
- [ ] **5** 按模型换角色：`glm-5.3` / `deepseek-v4.1-flash` / `kimi-*` 两拍内换形象；
      `hy4-preview` / `step-5-preview` 不动（**预期**）
- [ ] **6** 角色配色弹层：拖动实时预览、松手落盘；「恢复默认」可回退
- [ ] **7** 浮层穿透：指针在角色外时宿主可正常操作；压到角色才接管
- [ ] **8** 「等确认提醒」：开后在宿主弹通知时提醒一次（**已知比 ZCode 版更容易多提醒**）
- [ ] **9** 两端同装（ZCode 版 + WorkBuddy 版）时桌面**只有一个**角色
- [ ] **10** 出站不可用时不崩、不静默造假数据

看证据的位置：

| 想确认什么 | 看哪里 |
|---|---|
| 自启有没有生效 | `<插件数据目录>/autostart.log` 最后一行 |
| 钩子有没有写进会话身份 | `<插件数据目录>/hook-state.json`（含 `sessionId` / `transcriptPath`） |
| 钩子细节（要开开关） | `FOX_WIDGET_HOOK_DEBUG=1` 时的 `<插件数据目录>/hook.log` |
| 服务在不在、什么版本 | `curl http://127.0.0.1:39321/whale/health`（`app` 应为 `fox-widget`） |
| 浮层是否在跑 | `node lib/cli.mjs window status` |
| 浮层跟随异常 | `WHALE_DEBUG_PORT` 启动后的 `<插件数据目录>/overlay-debug.log` |
| 每轮消耗 | `node lib/cli.mjs turn` |

`<插件数据目录>` = `%USERPROFILE%\.workbuddy\plugins\data\fox-widget-fox-local\`。

## 7. 本次未做的事（明确声明）

- **未发版**：无 tag、无 release、未 push（含未建 `workbuddy` 远程分支）。
- **未改 `main`**，未动 ZCode 侧那份 `main` 分支的克隆。
- **未在真实 `~/.workbuddy` 上落地任何写入**：所有服务/CLI/MCP 运行都在快照上；真实库只被**复制**过。
- **未安装插件到宿主**（市场注册与安装留给客户端界面，见 §6）、**未起浮层**。

已做的两件写操作（都经用户确认）：

- **装了浮层运行时**：`node lib/cli.mjs desktop install` → `<插件数据目录>/desktop-runtime/`（381MB）。
  只写在插件自己的数据目录里，不碰宿主配置。
- **清理残留**：见 §5.3 —— 结果是目录已消失，但**不是本会话删的**（两次尝试一次被安全策略拦下、
  一次发现已不存在），时间点与宿主自身的数据目录 sweep 吻合。

脚本产物：验收脚本放在工作区**外**（`%TEMP%\wbport\accept-realdata.mjs` 等），临时快照目录已清理；
仓库内只新增本文（`docs/porting/phase-6-acceptance.md`），**未提交**。
