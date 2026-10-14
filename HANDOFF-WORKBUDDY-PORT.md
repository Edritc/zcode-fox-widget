# 交接文档：WorkBuddy 分支（`fox-widget`）的维护与后续移植

> 写给接手维护 `workbuddy` 分支的 AI / 人。作者：WorkBuddy 侧移植会话（2026-10-14）。
> **时效声明：截至 2026-10-14 实测于 WorkBuddy 5.8.2（Windows）**。宿主升级后结论可能失效，
> 请按「宿主升级监控」一节重跑验证；改写本文而非叠加。
> 与其他文档的关系：`MIGRATION-PLAN-WORKBUDDY.md`（施工规划，写于移植前）→ `HANDOFF-WORKBUDDY.md`
> （ZCode 侧的交接，移植的输入）→ **本文（移植完成后的交付说明）**；分阶段实测记录在 `docs/porting/`。

## 0. 先做这几件事

1. **读 `docs/porting/phase-0.md`**：那是宿主契约的实测基线（四项探路验证 + 数据源结构），
   本文的结论大量引用它，别只看本文。
2. **读 `lib/host.mjs`**：宿主差异的唯一定义处。改任何与 WorkBuddy 相关的行为，先看这里。
3. **本机同时装了 ZCode 版与 WorkBuddy 版时**：两端的挂件服务是两个独立进程（默认端口都是 39321，
   后者会自动顺延）。调试时先确认你连的是哪一个：`curl 127.0.0.1:39321/whale/health` 的 `app` 字段
   会告诉你（`fox-widget` = 本分支，`zcode-fox-widget` = ZCode 版）。
4. **别在 agent shell 里启浮层**（GPU 子进程必崩 + `ELECTRON_RUN_AS_NODE` 污染），见 §5。

## 1. 概览：「宿主提供 vs 自建」的责任表

| 部分 | 谁提供 | 本分支的做法 |
|---|---|---|
| 挂件窗口 | **自建** | 独立 Electron 进程；透明置顶无边框、铺满工作区、默认鼠标穿透 |
| 挂件页面 | **自建** | `lib/widget.js`，单文件 IIFE，零依赖、零构建 |
| 本地服务 | **自建** | `lib/server.mjs`，只监听 `127.0.0.1` |
| **积分 / 上下文 / 模型** | **宿主提供** | 读 `~/.workbuddy/workbuddy.db` 的 `session_usage` + `~/.workbuddy/projects/*/*.jsonl` 的 `rawUsage` |
| **会话身份** | **宿主提供** | 钩子 stdin 的 `session_id` / `transcript_path` → `<插件数据目录>/hook-state.json` |
| **主题** | **宿主提供** | `~/.workbuddy/storage/user-*/global/preferences.json` 的 `theme`（+ 浮层 DWM 观测） |
| **凭据（可选）** | **宿主几乎没有** | 实测宿主侧无 provider 凭据存储；厂商卡靠环境变量或用户手填 |
| 余额 / 厂商额度 | 自建 + 出站 | 只向白名单主机发请求（可选功能） |
| 事件 | **宿主提供** | 3 个**低频**钩子：SessionStart / UserPromptSubmit / Notification（不挂 PostToolUse——它每次工具调用都触发，内联执行会拖慢每次工具调用） |
| 会话内工具 | **宿主提供** | MCP 工具（`mcp__plugin_fox-widget_whale__*`）、`/fox` 命令、两个 skill |

## 2. 文件/模块清单（作用 + 移植影响）

| 文件 | 作用 | 移植影响 |
|---|---|---|
| `lib/host.mjs` | 宿主适配层：数据目录、db、主题、进程名、单例特征、环境变量名 | **重写（新文件）**，本分支独有的核心 |
| `lib/paths.mjs` | 插件内路径常量 | 适配（宿主路径转发给 `host.mjs`） |
| `lib/turn-cost.mjs` | 每轮消耗 + 上下文余量 | **重写**（数据源整段换掉） |
| `lib/usage-records.mjs` | 用量记录聚合 | **重写**（改扫 transcript） |
| `lib/host-theme.mjs` | 主题三层判定 | 适配（原 `zcode-theme.mjs`） |
| `lib/discover.mjs` | 厂商凭据发现 | **重写**（宿主侧候选位完全不同） |
| `lib/credentials.mjs` | 出站白名单 + 找 key | 小幅适配 |
| `lib/plan-balance.mjs` | GLM Plan 配额 | **冻结**（恒返回不支持） |
| `lib/cmdgo.mjs` | CommandCode 三重额度 | 直接复用（HTTP，与宿主无关） |
| `lib/pricing.mjs` | 价目 + 峰谷 + token→金额 | 直接复用（只服务「等价金额」参考值） |
| `lib/vendors.mjs` | 34 家厂商模板框架 | 复用（删掉 `zcode-plan` 模板） |
| `lib/balance.mjs` | 余额 / 记账账本 | 复用（降级为可选功能） |
| `lib/source.mjs` | 计费源判定 | 适配（恒为 `credits`；新增混元/阶跃标签） |
| `lib/server.mjs` | 本地 HTTP 服务 | 适配（新增 `/whale/context.json`；主题路由改名；`app` 标识改名） |
| `lib/widget.js` | 前端挂件 | 适配（新增 `credits` 视图与上下文小字；文案换宿主名） |
| `lib/mcp-server.mjs` | MCP 工具 | 适配（新增 `whale_credits`） |
| `lib/cli.mjs` | 命令行 | 适配（`status` 换成积分口径） |
| `lib/service.mjs` | 服务发现/拉起/关闭 | 适配（`app` 标识改从 `host.mjs` 取——**一致性关键点**） |
| `lib/overlay.mjs` | 浮层启停 + 运行时安装 | 适配（路径、单例特征、默认跟随目标） |
| `lib/autostart.mjs` | SessionStart 自启 | 复用（仅注释与日志路径） |
| `lib/hook-event.mjs` | 钩子事件 → 状态文件 | 适配（事件表扩到 WorkBuddy，新增会话身份落盘） |
| `lib/update.mjs` | 自更新内核 | 适配（分支/tag/安装根发现；**默认关闭**） |
| `desktop/main.cjs` | 浮层主进程 | 适配（数据目录、主题观测、宿主标识符；**移除 ui-ready 门控**） |
| `desktop/follow-window.ps1` | 常驻窗口探测 | 适配（默认目标进程改名，**保持纯 ASCII**） |
| `desktop/ui-ready.cjs` | 宿主启动就绪门控 | **删除** |
| `.codebuddy-plugin/plugin.json` | 插件清单 | **新增** |
| `.codebuddy-plugin/marketplace.json` | 市场清单 | **新增** |
| `.mcp.json` | MCP server 声明 | **新增** |
| `hooks/hooks.json` | 钩子接线 | **改写**（`command` 型） |
| `commands/fox.md` | `/fox` 命令 | 适配（工具名前缀、路径变量） |
| `skills/fox-widget/SKILL.md` | 使用与排查手册 | **重写**（宿主相关全部换新） |
| `skills/fox-pricing-review/SKILL.md` | 价目复核流程 | 小幅适配 |
| `tools/*.mjs` | 三套测试 + 演示 | 适配（隔离环境与数据源 fixture 换成 WorkBuddy 的） |

## 3. 三处最容易出错的地方（都有实测理由）

1. **`/whale/health` 的 `app` 标识必须两处一致**。`server.mjs` 写它（`HOST_APP_ID`）、
   `service.mjs` 校验它。两处不一致 → `findRunningServer()` 永远找不到在跑的服务 →
   每次都会尝试新起一个 → 端口顺延、`status` 显示「未运行」但实际有服务在跑。
   本分支已把常量收敛到 `lib/host.mjs` 的 `HOST_APP_ID`。
2. **浮层单例特征必须同时匹配新旧插件名**（`lib/overlay.mjs` 的 `OVERLAY_CMDLINE_MARKERS`）。
   本分支插件叫 `fox-widget`，ZCode 分支叫 `zcode-fox-widget`；用户两端同装时若不互认，
   `startOverlay` 的去重逻辑会保留两个 → 桌面出现两个角色。
3. **宿主的 db 带 WAL，测试一律先 copy 再读**。直接打开用户的 `~/.workbuddy/workbuddy.db`
   可能干扰宿主进程。`lib/turn-cost.mjs` 只读打开（`readOnly: true`），测试则整体复制到临时目录。

## 4. 分阶段记录索引

| 阶段 | 文档 | 一句话 |
|---|---|---|
| Phase 0 探路 | `docs/porting/phase-0.md` | 四项验证全通；**`source: "./"` 合法**（省掉子目录重构）；数据源比 ZCode 更好 |
| Phase 1 骨架 | `docs/porting/phase-1.md` | 清单/钩子/路径/命令/skill 全部 WorkBuddy 化；新增宿主适配层 |
| Phase 2 数据源 | `docs/porting/phase-2.md` | 积分主口径 + 上下文余量；真实数据实测样例在文内 |
| Phase 3 浮层 | `docs/porting/phase-3.md` | 跟随目标改名；**移除 ui-ready 门控**；`type:'toolbar'` 未动 |
| Phase 5 收尾 | `docs/porting/phase-5.md` | 测试、产品口径、发版与验收清单 |

## 5. 浮层真机的纪律（**别踩**）

- **浮层的一切真机操作都在 WorkBuddy 客户端环境里做**。在 agent shell 里 `window start` 会失败
  或留下坏窗口：实测 Electron 的 GPU 子进程在 agent shell 里必崩（`0xC0000005`），
  且 `ELECTRON_RUN_AS_NODE` 会污染子进程。
  必要的实验姿态：`--no-sandbox --disable-gpu` + `env -u ELECTRON_RUN_AS_NODE`。
- **本次移植没有在 agent shell 里启过浮层**，也没有触碰本机正在运行的 ZCode 版挂件服务。
- 冻结检测必须**完全被动**（摆动鼠标的悬停重绘会掩盖冻结，导致假阴性）。

## 6. 不要改的清单（全部继承，含实测理由）

| 项 | 为什么 |
|---|---|
| `desktop/main.cjs` 的 `type: 'toolbar'` | 让浮层常驻 `WS_EX_TOOLWINDOW`、不进宿主 Chromium 的遮挡判定；删掉会复发「点角色后宿主停帧」。WorkBuddy 同为 Electron，同源风险存在 |
| `lib/credentials.mjs` 的 `readPluginConfig()` **不加缓存** | 账本靠「读到的 apiKey 与上次不同」判定换 key 并归档整本账；加 TTL 缓存会破坏该语义 |
| `lib/service.mjs` 的 `waitServerStopped` | shutdown 的 200 只是「已受理」；不等端口真的停止应答就 restart 会误判「复用已在运行的服务」 |
| `lib/pricing.mjs` 的 `splitInputTokens()` | 不减缓存命中会让等价金额虚高十几倍（WorkBuddy 的 `prompt_tokens` 同样含缓存） |
| `lib/update.mjs` 的探测取最高版本 | 镜像 CDN 会返回上一版；只看第一个成功响应会漏报新版本 |
| `lib/widget.js` 的 `--zcw-ink` 4.5:1 派生色 | 让浅色角色（如 kimi娘原值 2.85:1）也有可读正文；别把派生色与角色原色合并 |
| 前端不引 ESM | `widget.js` 与 `lib/paths.mjs` 各有一份模型→角色映射表，靠测试钉住一致 |
| 浮层不 `setBounds`、隐身用 `setOpacity(0)`、`focusable: false` | 改尺寸会让透明窗合成层错位；hide/show 会卡死原生输入管线 |
| `desktop/follow-window.ps1` 纯 ASCII | PS 5.1 按 ANSI 代码页读无 BOM 的 .ps1，中文注释会破坏语法、脚本秒退 |

## 7. 验收标准

### 自动化（三套测试）

```bash
node tools/selftest.mjs          # 主自检（隔离 CODEBUDDY_HOME + 伪造 workbuddy.db 与 transcript）
node tools/selftest-update.mjs   # 更新内核自检（含重启链路端到端）
node tools/smoke-ui.mjs          # 前端冒烟（headless 浏览器；找不到浏览器时 SKIP 是预期）
```

结果与新增断言见 `docs/porting/phase-5.md`。

### 人工验收（真机门槛，逐条过）

- [ ] 会话启动自动出现挂件（SessionStart 钩子生效）；`autoStartWidget=false` 后不再自启
- [ ] 菜单能打开、能点、**不打断宿主前台**；点角色后宿主画面不冻结
- [ ] **积分三数字出数**：今日积分 / 本轮 credit / 上下文 xx%，且与客户端显示一致
- [ ] 上下文余量与实际会话长度相符
- [ ] 按模型换角色：切到 `glm-5.3` / `deepseek-v4.1-flash` / `kimi-*` 时两拍内换形象；`hy4-preview` / `step-5-preview` 不动（预期）
- [ ] 角色配色弹层：拖动实时预览、松手落盘；「恢复默认」可回退
- [ ] 浮层穿透：指针在角色外时宿主可正常操作；压到角色才接管
- [ ] 「等确认提醒」：开启后能在宿主弹通知时提醒一次（**已知会比 ZCode 版更容易多提醒**）
- [ ] 两端同装（ZCode 版 + WorkBuddy 版）时桌面**只有一个**角色
- [ ] 出站不可用时不崩、不静默造假数据（读不到就明确标注来源缺失）

## 8. 已知限制

1. **真机未验证项**：客户端里实际注册目录市场并安装、钩子真的被触发、浮层跟随宿主窗口、
   `Notification` 是否只在「等确认」时发。证据链已备好（`autostart.log` / `hook-state.json` /
   `FOX_WIDGET_HOOK_DEBUG=1` 的 `hook.log` / `/whale/health`），首次真机运行请逐项确认。
2. **今日积分有上限**：只扫最近 60 个会话、每个 2MB 尾部。会话极多的用户会偏低
   （`scannedTranscripts`/`totalTranscripts` 可诊断）。
3. **`session_usage.credit_json` 是按请求覆盖的**，所以它只能当「最后一轮」的权威值，
   不能当今日合计。今日合计走 transcript 聚合。
4. **`hy*` / `step*` 模型没有内置立绘**，按模型换角色时有意不动。
5. **自更新默认关闭**；开着时与宿主插件管理的混用风险仍在（见 `docs/porting/phase-5.md`）。
6. macOS / Linux 只有浏览器页面形态（浮层依赖 Win32），继承 ZCode 版结论、未在 WorkBuddy 上重测。
7. 注释里仍有多处「ZCode」字样（描述历史来源的措辞），属有意保留；**代码路径中已无
   `~/.zcode` 或 `${ZCODE_PLUGIN_ROOT}` 字面量**（有测试钉住）。
