# Phase 2 施工记录：数据源替换（核心工作量）

> 作者：WorkBuddy 侧移植会话（2026-10-14）。时效声明：截至 2026-10-14，宿主版本
> WorkBuddy 5.8.2。上游依据：`MIGRATION-PLAN-WORKBUDDY.md` §Phase 2、§四、`phase-0.md` §6。

## 出口标准逐条勾选

| # | 模块 | 出口标准 | 状态 | 证据 |
|---|---|---|---|---|
| 2.1 | `turn-cost.mjs` 整段重写 | `/fox turn` 给出上轮消耗（积分为主、附等价金额） | ✅ 代码 + 隔离实测 | 见「真实数据实测」 |
| 2.2 | 当前模型 → 换角色 | 切模型两拍内换角色；认不出的不动 | ✅ | `sessions.model` 为主、transcript `requestModelId` 兜底；`hy*`/`step*` 有意不映射 |
| 2.3 | `usage-records.mjs` 重写 | 用量记录面板今日/7 天/明细出数 | ✅ 代码，⏳ 面板真机未验 | 见下 |
| 2.4 | **新增**上下文余量 | 气泡或菜单显示「上下文 xx%」 | ✅ | `/whale/context.json` + 气泡小字 + 每轮消耗小字 |
| 2.5 | `discover.mjs` 重写 | 凭据三级发现链；找不到时带探测摘要 | ✅ | 如实报告「WorkBuddy 侧无 provider 凭据存储」 |
| 2.6 | 主题跟随 | 客户端切深浅色 10 秒内跟变（观测层） | ✅ 代码，⏳ 真机未验 | 观测层与宿主无关；配置层读 `preferences.json` |
| 2.7 | `plan-balance` / `cmdgo` 决策 | 决策写进交接文档 | ✅ | `plan-balance` 冻结；`cmdgo` 保留 |

## 真实数据实测（关键证据）

用**本机真实数据的副本**（`workbuddy.db` + `-wal`/`-shm` + `projects/` 全部 copy 到临时
目录，`CODEBUDDY_HOME` 指向它，**只读**）跑新 `lib/turn-cost.mjs`：

```
resolveSession = { ok:true, sessionId:"12968ef3-…", model:"deepseek-v4.1-flash",
                   transcriptPath:"…\\projects\\c-Users-<用户>-WorkBuddy-Worktrees-…\\12968ef3-….jsonl",
                   from:"latest-session" }
context        = { ok:true, used:224003, size:1000000, pct:22.4, remaining:775997 }
latestTurn     = { ok:true, source:"transcript", turnId:"01a1386e9212723d9280270ba883bfa9",
                   model:"deepseek-v4.1-flash", modelName:"Deepseek-V4.1-Flash",
                   amount:14.88, credit:14.88, currency:"CREDIT",
                   marketAmount:1.02970712, marketCurrency:"CNY",
                   tokens:7185529, calls:50, partial:false,
                   breakdown:{ hit:6966528, miss:166827, cacheWrite:0, output:52174 },
                   models:[{ model:"deepseek-v4.1-flash", calls:50, credit:14.71, … }] }
turnIdentity   = "12968ef3-…/01a1386e9212723d9280270ba883bfa9"
todayCreditFromUsage = { ok:true, credit:178.47, sessions:3 }
```

**口径自检**：`prompt_tokens = hit + miss`（19组数据全部成立，这里 hit 6,966,528 与
miss 166,827 之和 = 7,133,355 = 50 次调用的输入总量），`breakdown.output` 与
`completion_tokens − completion_thinking_tokens` 一致——**没有把缓存命中按未命中价重复计费**。
`credit 14.88` 与宿主 `credit_json` 记的值同源（`partial:false` 表示命中宿主权威值）。

## 逐模块说明

### 2.1 `lib/turn-cost.mjs`（整段重写）

- **积分主口径**：`session_usage.credit_json[conversationRequestId]` 优先；缺失时按
  transcript 里 `rawUsage.credit` 求和兜底，并把结果标 `partial:true`（表示宿主还没结算）。
- **轮=一个 `conversationRequestId`**：一轮 agent 循环会对同一 requestId 落几十次模型调用，
  必须归并（实测这一轮 50 次调用），否则气泡会连弹几十次。
- **字段映射集中在 `usageFromRawUsage()`**：`prompt_tokens`→`input_tokens`、
  `prompt_cache_hit_tokens`→`cache_read_input_tokens`、`prompt_cache_write_tokens`→
  `cache_creation_input_tokens`、`output_tokens = completion − thinking`、思考单列。
  这样 `pricing.splitInputTokens()` 的「input 含缓存」判据能自动生效。
- **等价金额**：对每次调用跑 `costOfUsage()`（与 vendors/pricing 同源），按轮求和成
  `marketAmount`/`marketCurrency`。**只是参考值**，不参与主显示，UI 上标 `≈`。
- **会话定位**：`hook-state.json` 的 `sessionId`/`transcriptPath` 优先；没有则取
  `sessions` 表里最近活跃的**前台**会话（`is_background_automation = 0`——
  这正是规划里那条「噪音过滤」字段，顺便就用上了）。
- **transcript 查找不复刻 slug 规则**：宿主按 cwd 生成目录 slug（`C:` → `c-`、`/` → `-`），
  规则细节（驱动器大小写、`.` 是否保留）不稳定，改为按 `sessionId` 在 `projects/*/` 里
  找同名 jsonl（sessionId 是 UUID，天然唯一）。
- 保留 `getSharedDb()`（`usage-records.mjs` 复用连接）与 `turnIdentity()` 的对外语义。

### 2.2 当前模型 → 角色

- 来源：`sessions.model`（宿主当前选择）→ `readActiveSelection()`；transcript 的
  `requestModelId` 作 `readLatestUsageModel()` 兜底。
- `MODEL_ROLE_RULES` **未扩**：WorkBuddy 的 `hy4-preview`/`hy3`/`step-5-preview`/
  `space-bunny`/`minimax-m3-pay`/`fast-model` 等**没有对应立绘**，硬映射反而突兀；
  「认不出就不动」是设计意图，已在 `SKILL.md` 与 `paths.mjs` 注释里写明。
- `lib/source.mjs` 新增 `hunyuan`/`stepfun` 源定义，只用于**标签**（气泡小字、用量记录分组），
  不参与换角色。

### 2.3 `lib/usage-records.mjs`（重写）

- 扫 `~/.workbuddy/projects/*/*.jsonl`（按 mtime 取最近 **60** 个，每个只读 **2MB 尾部**），
  按 `conversationRequestId` 归轮、按日聚合**宿主 credit**。
- **不能说 `days7` 是「完整 7 天」**：文件数与读入字节都有上限，长会话的早期轮次可能没算进去
  （`scannedTranscripts`/`totalTranscripts` 如实暴露）。这是刻意的性能取舍
  （服务每秒轮询轮消耗、页面 25–60s 轮询面板，逐行全量读 60 个 jsonl 太贵）。
- 缓存指纹 = 文件数 + 最大 mtime + 总字节，TTL 30s。
- 输出兼容原面板形状，但主数字换成积分：`today.credit` / `today.calls` /
  `models[].credit` 与 `models[].market`（等价金额，面板里以 `≈` 标注）。

### 2.4 上下文余量（新增能力）

- `/whale/context.json` → `{ok, used, size, pct, remaining, updatedAt}`，来自
  `session_usage.used/size`。实测 224003/1000000 = **22.4%**。
- 前端：`CREDITS` 视图的小字与每轮消耗气泡都带 `上下文 xx%`；10 秒轮询一次。

### 2.5 `lib/discover.mjs`（重写）+ `lib/credentials.mjs`

- 三级链：环境变量（`ENV_KEY_TABLE`，11 个常见厂商）→ `<插件数据目录>/config.json` 的
  `apiKey` → 宿主 `settings.json` 的 `env` / `pluginConfigs.<插件>.options` →
  `~/.workbuddy/plugins/data/*/config.json`（含我们自己的 `vendorKeys`）。
- `matchTemplateId()`（纯函数，34 家模板的关键词判定）**原样保留**——与宿主无关且是资产。
- **如实报告**：`describeKeyProbe()` 现在带 `hostSettingsFile` 与一句 `note`，说明
  「WorkBuddy 默认没有用户自带 key，这是预期」。找不到时错误文案带探测摘要。
- `enc:v1:` 加密凭据、环回/私有地址网关仍然跳过（安全边界不变）。

### 2.6 主题跟随

- `lib/zcode-theme.mjs` → `lib/host-theme.mjs`：三层合并逻辑与观测 TTL **原样保留**（与宿主无关），
  只换第二层的数据源：`~/.workbuddy/storage/user-<uid>-personal/global/preferences.json` 的
  `theme` 字段（`appearance.themeSelection.resourceKey` 兜底）。uid 因账号而异 → 扫目录。
- 观测文件跟数据目录走：`<插件数据目录>/host-theme-observed.json`；浮层跟随脚本写它。
- 路由 `/whale/zcode-theme.json` → `/whale/host-theme.json`；返回的 `source` 值改为
  `host-window` / `preferences` / `missing`。

### 2.7 `plan-balance` / `cmdgo` 决策

| 模块 | 处置 | 理由 |
|---|---|---|
| `lib/plan-balance.mjs`（GLM Plan 配额） | **砍（冻结）** | 唯一数据源是 ZCode 客户端日志（`<ZCODE_HOME>/v2/logs/*.log` 的 `billing/balance 请求完成` 标记），WorkBuddy 无对应物也无同类日志。保留导出接口（`readPlanBalance()` 恒返回 `not-supported-on-workbuddy`，`turnPlanUsage()` 恒 `null`），server/cli/mcp 不必改；`lib/vendors.mjs` 的 `zcode-plan` 模板删除。若日后开放订阅额度接口，以本文件的形态重生。 |
| `lib/cmdgo.mjs`（CommandCode 三重额度） | **保留（降级为附加卡）** | 它走 HTTP 网关（`api.commandcode.ai`）+ 读反代本地配置，与宿主零耦合，技术上可留。但 WorkBuddy 用户用 CommandCode 反代的比例未知，故**移出主显示**，留在厂商模板层按需显示。 |
| 「峰谷计价」叙事 | **降级** | DeepSeek 峰谷仍在（用于等价金额），但不再是头号卖点；主叙事换积分。 |
| 34 厂商模板 / 余额预警 / 记账账本 | **保留不动** | 与宿主零耦合，纯搬运收益。 |

## 遗留项

1. 用量记录面板、每轮消耗气泡、上下文小字的**真机观感未验证**（需要浮层跑起来）。
2. `usage-records.mjs` 的 60 文件 / 2MB 上限是估值；若用户会话数远超此数，「今日合计」会偏低——
   已通过 `scannedTranscripts`/`totalTranscripts` 暴露，后续可按需提上限。
3. 宿主 db schema 变更风险：`session_usage` 只有 5 列，`credit_json` 的语义（按请求覆盖）是从
   数据形态推断的，未见官方文档。已按「只当兜底、今日合计走 transcript」的方式规避。
