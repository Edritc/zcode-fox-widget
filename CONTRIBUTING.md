# 提交与 PR 规范

本仓库自 `435efb5`（2026-09-29，QA 审查修复）起采用 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/zh-hans/)；其前的 14 个提交为过渡格式（无类型前缀），按「不改写已推送历史」的原则保留原样，不追溯重写。

## Commit 格式

```
<type>(<scope>): <subject>

<body>
```

### type（限定集合）

只用这 11 个：`feat` `fix` `docs` `style` `refactor` `perf` `test` `build` `ci` `chore` `revert`。

- 不使用自定义类型（此前的 `debug` 属临时诊断入库，后续不再出现）。
- 临时诊断代码不入库：调试探针放 `%TEMP%`，需要长期保留的诊断设施走 `feat`/`chore` 并在 body 说明用途与开关。

### scope

- 取改动的**主体模块名**，小写：`pricing` `widget` `server` `overlay` `desktop` `balance` `usage-records` `plan-balance` `source` `vendors` `discover` `theme` `bubble` `watcher` `release`…
- 一个提交跨多个模块时：选主体模块，其余在 body 列出；或拆成多个提交。**不用** `+` 连接的复合 scope（如 `billing+security`），**不用版本号当 scope**（如 `fix(v1.4.2)`）。
- release 提交固定用 `chore(release)`。

### subject

- 祈使句、结尾不加句号。
- **显示宽度 ≤72 列**（CJK 全角字符按 2 列计）。超长的根因解释、证据链移入 body——subject 塞不下解释，正说明该有 body。提交前自检：
  ```bash
  git log --format='%s' 435efb5.. | awk '{ w=0; for(i=1;i<=length($0);i++){ c=substr($0,i,1); w += (c ~ /[\x80-\xFF]/) ? 2 : 1 } if (w > 72) print w, $0 }'
  ```
  （按 UTF-8 字节近似 CJK×2；输出非空即超宽。）
- 结论进 subject，**为什么进 body**：动机、根因、实测证据、验证方式。

### body

- 多问题批量修复至少写一句总述并列出各项；空 body 只允许极小改动（单行、自解释）。
- `revert` 必须在 body 注明被回退的 commit 与原因。

### 版本号（release 纪律）

- 版本变更必须独立成 `chore(release): vX.Y.Z`，body 列变更清单。**禁止把版本号变更悄悄夹带进 feat/fix**（v1.6.0–v1.7.2 曾四次这样夹带，本条即为教训成文）。
- 版本号单一来源：`.zcode-plugin/plugin.json`（`lib/paths.mjs` 的 `pluginVersion()` 供 server 的 health 与 MCP 动态读取——审查 P2-2 之前 server.mjs 硬编码第三份，已移除）。release commit 仍需同步改 `marketplace.json` 的版本；selftest 有「health = 清单 = marketplace」一致性断言兜底。`desktop/package.json` 是浮层入口包，版本独立，不在此列。

### 两条产品线的发布纪律（同仓双分支）

本仓库有两个分支承载两条产品线：`main` = ZCode狐娘小挂件（`zcode-fox-widget`），`workbuddy` = WorkBuddy狐娘小挂件（`fox-widget`）。上面那套纪律两边都适用，另加这几条：

- **版本号各自独立递增，不刻意对齐**。共享内核的修复 = 同一个修复、两个版本号，各自在 CHANGELOG 里记一条，release 正文互相点名配对关系（人看 tag 列表看不出配对）。只发一条线时**另一条线什么都不做**——不要为「对齐」补一个空 tag。
- **tag 前缀即产品线**：`main` 用 `vX.Y.Z`，`workbuddy` 用 `wb-vX.Y.Z`。两条线的更新内核都按各自前缀做探测与下载，改动任一侧的前缀口径等于改发版契约。
- **版本号提交必须先于 tag**：两线的更新内核都有「包内清单的版本号 == 目标版本」这道落盘前校验，tag 若打在版本号未改的提交上，之后所有下载包都会被判「版本不符」拒装。
- **每个 tag 一份自己线的树**：客户端自动附的源码包天然是该 tag 对应提交的树，两线的更新内核下载的正是它。**不要做双端合并包**——更新内核的清理步骤是「删掉上一版清单里有、这一版没有的文件」，包里混入另一条线的文件，会让它在下一次更新时被当旧文件删掉。若另附人工安装包，按线各附一个、命名带线名与版本（如 `fox-widget-1.0.0.zip`），包内是插件根（含各自的清单目录）。
- **`Latest` 徽章留给 `v*` 那条线**：WorkBuddy 线的 release 用 `gh release create … --latest=false`。它的探测本来就是「枚举 releases 再挑 `wb-v*`」，不依赖徽章；而 ZCode 线的探测走 `/releases/latest`，徽章被 `wb-v*` 抢走会让这条探测源失效。
- **pre-release 的可见性两线不同**：ZCode 线的 `/releases/latest` 会被 GitHub 跳过（prerelease 与 draft 都不返回），所以 pre-release 不会自动送达 ZCode 用户；WorkBuddy 线是枚举 releases + 前缀过滤，**会**送达已装用户。发 pre-release 前先确认这是不是想要的。

## 提交纪律

- **不改写已推送历史**：不 force-push 已推送分支、不 rebase 已进入 PR 的提交；修错用新提交。
- **已发布 tag / Release 的删除与重指向是破坏性元数据变更**，必须有 commit 记录删除范围与原因（先例：9cd7b81 重指向、959b14e 按合并策略删 16 个 tag），且 commit 历史本身一律保留。
- 提交前自检：`node tools/selftest.mjs` 全绿；改了前端交互再跑 `node tools/smoke-ui.mjs`。
- **`desktop/*.ps1` 必须纯 ASCII**（`follow-window.ps1`）：提交前跑 `grep -nP '[^\x00-\x7F]' desktop/*.ps1`，必须零输出。Windows PowerShell 5.1 按 ANSI 代码页读取无 BOM 的 `.ps1`，非 ASCII 注释会解码成破坏语法的字节，脚本直接退出、跟随失效。
- 源码、示例与测试中不得出现可用凭据字面量；日志与 CLI 只输出掩码（如 `sk-8a…8c5`）。
- SQL 一律参数绑定；出站请求走 `assertSafeUpstream` 白名单（扩展目标改 `lib/credentials.mjs`，厂商模板须显式声明 `host`）。

## 文档风格

README / SKILL / commands 的标点与空格漂移是反复出现的问题，这里成文，评审按此核对。

- **引号**：中文用「」『』，不用直引号 `"…"`。代码、路径、标识符例外（写在反引号里）。
- **中英/数字间距**：中文与拉丁字母、数字之间加半角空格（「5 小时」「GLM Plan 配额」「204/204」）；中文标点前后不加。
- **计量词**：一律「5 小时」「7 天」「60 秒」，不写「5小时」（界面上的紧凑标签如额度卡的「5小时」行名除外，那是版式需要）。
- **版本小节标题**：`## vX.Y.Z <动词>：<一句话>`，动词只用三种——新能力用「新增」、缺陷用「修复」、行为或口径调整用「变更」；标题动词要与该版本的主提交类型一致（`feat` → 新增）。小节内用平铺列表，不写 `###` 子节。
- **代码块语言标注**：命令与输出用 ```bash / ```text；ASCII 架构图可不标。
- **术语表**（同一概念只用一种说法）：

  | 用法 | 不写 |
  | --- | --- |
  | ZCode狐娘小挂件（产品名；标题/描述/窗口名统一用它；曾用名 Widget of ZCode） | ZCode 版 DeepSeek 余额大肥鱼挂件 / 大肥鱼挂件（指代产品名时） |
  | GLM Plan（v1.7.8 起；template id 仍是 `zcode-plan`） | ZCode Plan |
  | 对账口径（v1.7.0 起；值仍是 `ledger` / `token`） | 用量模式 / 用量统计模式 |
  | CommandCode 三重额度 | CommandCode 限额 / 周限额套餐 |
  | 本机库口径 · 账号口径 | 本机数据 / 云端口径 |
  | 记账二级页（=角色名记账=） | 记账面板（那是用量记录面板） |

## PR 规范

- 一个 PR 一个主题；描述包含：摘要、背景动机、改动分组（按模块）、兼容性与迁移、测试结果（真实运行的数字）、安全影响、已知限制。
- 正文措辞与事实一致：测试数字用最近一次真实运行的输出；对历史的描述不夸大（如提交格式、版本轨迹）。
- 不引入 lint 配置（项目约定）；风格靠本文件与代码评审维持。
