# Phase 4 + 5 施工记录：产品口径、测试与收尾

> 作者：WorkBuddy 侧移植会话（2026-10-14）。时效声明：截至 2026-10-14，宿主版本
> WorkBuddy 5.8.2。上游依据：`MIGRATION-PLAN-WORKBUDDY.md` §Phase 4/5、§五、§六、§七。

## Phase 4 · 产品口径与差异化

| # | 事项 | 落地 |
|---|---|---|
| 1 | 主显示口径换成三层积分 | 前端新增 `credits` 计费源视图（`lib/widget.js` 的 `SOURCE_VIEW.credits`）：**主数字 = 今日积分**，小字 = **本轮 credit** + **上下文 xx%** + 当日调用次数。`resolveDisplaySource()` 在无会话信息时的兜底也从 `tokens` 改为 `credits`（WorkBuddy 的主口径就是积分，不该"不认识就什么都不显示"） |
| 2 | 上下文余量（新增能力） | `/whale/context.json`（`session_usage.used/size`）；前端 10 秒轮询，显示在 `credits` 视图小字与每轮消耗气泡小字里 |
| 3 | 每轮消耗气泡换积分 | `showCostBubble()` 新增 `turn.currency === 'CREDIT'` 分支：标签「上一轮消耗:」、数字 `<n> 积分`，小字补「N 次调用 · ≈ ¥x（等价金额）· 上下文 x% ·（结算中）」；`fmtMoney()` 对 `CREDIT` 不加货币符号 |
| 4 | 余额降级为可选卡 | MCP 工具新增 `whale_credits` 作为主查询；`whale_balance` 的描述与失败文案都明确写「这是可选功能，WorkBuddy 默认没有用户自带 key」；`/fox` 命令与 SKILL.md 同步 |
| 5 | 叙事去"峰谷"化 | 峰谷仅保留在等价金额与厂商卡层；`displayMode` 的可选值加了 `credits` |

### 有意保留的旧标识（不是漏改）

以下标识在 WorkBuddy 分支里**刻意保留**，理由都是「改它要动持久化状态或大范围测试，
收益为零、风险不小」，并已写进 `README` / `SKILL.md` / `widget.js` 头部注释：

- 类名前缀 `zcwv-`、localStorage 键 `zcw-pos` 等（纯内部标识，用户不可见）
- 路由前缀 `/whale/`（有历史排障习惯）
- 环境变量 `WHALE_*`（浮层相关：`WHALE_PORT` / `WHALE_TARGET_PROCESS` / `WHALE_FOLLOW_INTERVAL_MS` /
  `WHALE_DEBUG_PORT` / `WHALE_OVERLAY_LOG` / `WHALE_DISABLE_UPDATE_CHECK` / `WHALE_NPM_REGISTRY`）
- 注释里描述历史来源的「ZCode」字样

**注意**：`lib/` / `hooks/` / `commands/` / `skills/` / `desktop/` / `.codebuddy-plugin/` / `.mcp.json`
里**已无** `~/.zcode` 或 `${ZCODE_PLUGIN_ROOT}` 之类**路径/变量字面量**（有测试钉住）。

## Phase 5 · 收尾

### 测试

| 套件 | 命令 | 结果 |
|---|---|---|
| 主自检 | `node tools/selftest.mjs` | **全部通过 285/285**，0 失败 0 跳过 |
| 更新内核自检 | `node tools/selftest-update.mjs` | **50/50 通过**（含重启链路端到端） |
| 前端冒烟 | `node tools/smoke-ui.mjs` | **全部通过 103/103**（本机 msedge 真跑，无 SKIP） |

三套测试的**隔离手法**保留（承 HANDOFF §7.1）：临时目录 + 伪造数据源，不碰真实数据目录。
变化点是隔离变量名（`CODEBUDDY_HOME` / `FOX_WIDGET_DATA_DIR`）与 fixture 结构
（宿主 `session_usage` + `sessions` 两张表 + transcript jsonl，取代 ZCode 的
`turn_usage` / `model_usage`）。

移植期新增/改写的断言（要点）：
- **清单契约**：`.codebuddy-plugin/plugin.json` 的 `name: fox-widget` / `hooks` / `mcpServers`
  字段、`.mcp.json` 的 server 声明（`node` + `${CODEBUDDY_PLUGIN_ROOT}/lib/mcp-server.mjs`）、
  `.codebuddy-plugin/marketplace.json` 与 health 的版本号三处一致。
- **钩子接线**：3 个事件（SessionStart / UserPromptSubmit / Notification）、全部
  `type:"command"` + 字符串 command 含 `${CODEBUDDY_PLUGIN_ROOT}` + 数值 timeout（秒），
  并**显式断言 `PostToolUse` 不在 hooks 里**（见 phase-1 的取舍说明）。
- **数据源 fixture**：「金额虚高」回归（缓存命中按命中价、未命中只算 miss）、
  `breakdown.output` 把思考并入（= `completion_tokens`）、`usageFromRawUsage` 的字段映射、
  上下文百分比。
- **禁字面量**：`lib/` `hooks/` `commands/` `skills/` `desktop/` `.codebuddy-plugin/` `.mcp.json`
  中不得出现 `~/.zcode` 或 `${ZCODE_PLUGIN_ROOT}` 等路径/变量**字面量**（断言会先剥掉注释——
  注释里描述历史来源的「ZCode」字样是有意保留的，不在此列）。
- **单例归一**：浮层命令行特征同时匹配 `fox-widget` 与 `zcode-fox-widget`。
- ZCode 专属、无 WorkBuddy 等价物的断言（GLM Plan 日志尾随、`provider_config.json` 发现、
  `ZCODE_DATA_BASE_DIR`、ui-ready 门控、`type:"process"` 钩子）已删除或替换为对应的
  WorkBuddy 断言，未静默丢覆盖。

**移植期在测试里抓到的一个真实缺陷**（值得记下来）：等价金额断言最初只按「非思考输出」
（80_000）计，漏了思考（20_000）。而 `lib/pricing.mjs` 的既定口径是**输出与思考同价**
（`costOfUsage` 用 `t.output + t.reasoning`），`usageFromRawUsage` 也刻意把
`completion_tokens` 拆成 `output_tokens = completion − thinking` 与 `reasoning_tokens`
两栏。断言少算一格 → 期望 ¥0.340980 vs 实际 ¥0.420980（差 = 20_000/1e6 × out 价）。
修法：按 `completion_tokens` 全额计，并新增一条断言把「思考并入 output 桶」钉死。
这个对照值正好说明**没有**踩缓存命中的重复计价坑（重复计费会得到 ¥1.339980）。

### 文档

| 文档 | 状态 |
|---|---|
| `README.md` | 标题/产品名/移植关系/安装/更新/首次配置/数据与计价口径/架构/运行时数据/FAQ 全部按 WorkBuddy 重写；保留的血缘与历史条目按原文 |
| `skills/fox-widget/SKILL.md` | 重写（宿主接入点表、数据来源、故障排查表全部换新） |
| `skills/fox-pricing-review/SKILL.md` | 适配（清单路径、版本号单一来源、验证命令） |
| `commands/fox.md` | 适配（工具名前缀、路径变量、`credits` 子命令） |
| `CHANGELOG.md` | 改为两条产品线两节（`## WorkBuddy` / `## ZCode`），新增 `wb-v2.0.0` 条目 |
| `CONTRIBUTING.md` | 新增「双分支协作」一节（合并方向、分支规则、发版口径、宿主升级监控、责任划分） |
| `docs/porting/phase-0..5.md` | 新增（本文所在目录） |
| `HANDOFF-WORKBUDDY-PORT.md` | 新增（移植完成后的交接说明，按 `MIGRATION-PLAN` §6.3 结构模板） |
| `.gitignore` | 新增 `.workbuddy/`（宿主 AI 的工作记忆目录，不是项目资料） |

### 自更新默认值（决策记录）

**默认关闭**。原因（`MIGRATION-PLAN §3.6`）：ZCode 版的自更新会把新版本文件**原地覆盖**到
每个发现的安装目录，其中包括客户端 cache 快照；而 WorkBuddy 的版本账本由
`installed_plugins.json` 记录、**目录名里带版本号**——原地覆盖会让「cache 里的文件」
与「注册表记的版本」对不上，和宿主的插件管理打架。

落地方式：`lib/update.mjs` 的 `startAutoCheck()` 需显式 `FOX_WIDGET_ENABLE_UPDATE_CHECK=1`
才启用（`WHALE_DISABLE_UPDATE_CHECK=1` 仍是最高优先级的显式关闭）。推荐更新方式 =
`git pull` + 客户端重抓市场，已写进 README 与 SKILL.md。

同时把更新链路的「产品线口径」改对了：
- 探测分支 `main` → `workbuddy`；tag 前缀 `wb-v`（`TAG_PREFIX` / `UPDATE_BRANCH` 导出）。
- GitHub API 那条源改成列 releases 后**只挑 `wb-v*` 前缀里的最高版本**——不能用
  `releases/latest`（两条产品线共用一个仓库，它会返回整体最新，可能是 ZCode 线的 tag）。
- 安装根发现：`<CODEBUDDY_HOME>/plugins/installed_plugins.json` + `<CODEBUDDY_HOME>/plugins/cache/*/fox-widget/<版本>/`。
  插件 id 匹配**同时接受旧名**（用户可能两端同装）。

### 发版

- 版本号：`.codebuddy-plugin/plugin.json` = `.codebuddy-plugin/marketplace.json` = **2.0.0**（独立序列 `2.x.y`）。
- tag：`wb-v2.0.0`。
- 发布内容：`.codebuddy-plugin/` 那套清单 + GitHub Release；WorkBuddy 侧由客户端重抓市场。

## 遗留项

1. **真机验收未做**（清单见 `HANDOFF-WORKBUDDY-PORT.md` §7）——需要在实际的 WorkBuddy
   客户端里注册目录市场、安装、跑浮层。本次移植完成了能做的全部静态与隔离验证：
   三套测试全绿（285/50/103）、端到端服务冒烟（13 个路由）、MCP 协议冒烟（5 个工具）、
   钩子处理器冒烟（5 种载荷）、真实数据只读实测。
2. 用户在 `main` 分支上的历史 tag（v1.9.0 起累积未发版的提交）未处理——按规划
   `main` 侧发版是 ZCode 线自己的事，本分支不动 `main`。
3. `git push` 未执行：本次移植只在本地 `workbuddy/main-56fc9dd2` 工作树上完成（见下）。

## 关于本工作树

本次移植在 WorkBuddy 的 git worktree 里完成：

```
C:/Users/paper/WorkBuddy/Worktrees/zcode-fox-widget/main-56fc9dd2   # 本分支工作树（branch: workbuddy/main-56fc9dd2）
C:/Users/paper/.zcode/cli/plugins/marketplaces/zcode-fox-widget     # 主仓库（branch: main，ZCode 侧）
```

- 主仓库（`main`）**未被改动**，ZCode 侧的挂件服务仍在运行（端口 39321），未受影响。
- 本分支未 `git push`：远程分支 `workbuddy` 需由用户决定何时建立（规划 §1.2 要求先
  `git push origin main` 备份、再建 `workbuddy` 分支并推送）。
- 中间的 `.workbuddy/` 与临时探针脚本不入库（`.workbuddy/` 已加进 `.gitignore`）。
