# 提交与 PR 规范

本仓库自 `435efb5`（2026-09-29，QA 审查修复）起采用 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/zh-hans/)；其前的 14 个提交为过渡格式（无类型前缀），按「不改写已推送历史」的原则保留原样，不追溯重写。

## Commit 格式

```
<type>(<scope>): <subject>

<body>
```

### type（限定集合）

只用这 11 个：`feat` `fix` `docs` `style` `refactor` `perf` `test` `build` `ci` `chore` `revert`。

- 不使用自定义类型（此前的 `debug` 属临时诊断入库，后续不再出现）。**这条覆盖技能文档里的提交模板**：`skills/*/SKILL.md` 若给了提交范例，也必须落在本集合内（先例：`skills/fox-pricing-review/SKILL.md` 曾给 `pricing(vX.Y.Z): …`，既非标准类型、又用版本号当 scope）。
- 临时诊断代码不入库：调试探针放 `%TEMP%`，需要长期保留的诊断设施走 `feat`/`chore` 并在 body 说明用途与开关。

### scope

- 取改动的**主体模块名**，小写：`pricing` `widget` `server` `overlay` `desktop` `balance` `usage-records` `plan-balance` `source` `vendors` `discover` `theme` `bubble` `watcher` `release`…
- 一个提交跨多个模块时：选主体模块，其余在 body 列出；或拆成多个提交。**不用** `+` 连接的复合 scope（如 `billing+security`），**不用版本号当 scope**（如 `fix(v1.4.2)`）。
- release 提交固定用 `chore(release)`。

### subject

- 祈使句、结尾不加句号。
- **显示宽度 ≤72 列**（CJK 全角字符按 2 列计）。超长的根因解释、证据链移入 body——subject 塞不下解释，正说明该有 body。提交前自检：
  ```bash
  git log --format='%s' 435efb5.. | node -e "let n=0,o=require('readline').createInterface({input:process.stdin});o.on('line',s=>{const w=[...s].reduce((a,c)=>a+(c.codePointAt(0)>0x7f?2:1),0);if(w>72){n++;console.log(w+' '+s)}});o.on('close',()=>{console.log('结果：'+(n?n+' 条超宽（>72 列）':'全部 ≤72 列'));process.exit(n?1:0)})"
  ```
  （按 Unicode 码点近似 CJK×2。**判定只看最后一行「结果：…」与退出码**——0 = 全部合规、1 = 有超宽；**不要**按「输出非空即超宽」判读：脚本自身报错时输出同样为空，那样会把工具故障读成「全部合格」。）
- 结论进 subject，**为什么进 body**：动机、根因、实测证据、验证方式。

### body

- 多问题批量修复至少写一句总述并列出各项；空 body 只允许极小改动（单行、自解释）。
- `revert` 必须在 body 注明被回退的 commit 与原因。

### 版本号（release 纪律）

- 版本变更必须独立成 `chore(release): vX.Y.Z`，body 列变更清单。**禁止把版本号变更悄悄夹带进 feat/fix**（v1.6.0–v1.7.2 曾四次这样夹带，本条即为教训成文）。
- `chore(release)` 的 body 省略**仅当**该版本的 CHANGELOG 小节已列全变更（先例：v1.10.0 / v1.11.0 的 CHANGELOG 小节已列全，其 release 提交 body 为空；v1.12.0 另有清单，两可）。
- 版本号单一来源：`.zcode-plugin/plugin.json`（`lib/paths.mjs` 的 `pluginVersion()` 供 server 的 health 与 MCP 动态读取——审查 P2-2 之前 server.mjs 硬编码第三份，已移除）。release commit 仍需同步改 `marketplace.json` 的版本；selftest 有「health = 清单 = marketplace」一致性断言兜底。`desktop/package.json` 是浮层入口包，版本独立，不在此列。

### 两条产品线的发布纪律（同仓双分支）

本仓库有两个分支承载两条产品线：`main` = ZCode狐娘小挂件（`zcode-fox-widget`），`workbuddy` = WorkBuddy狐娘小挂件（`fox-widget`）。上面那套纪律两边都适用，另加这几条：

- **版本号各自独立递增，不刻意对齐**。共享内核的修复 = 同一个修复、两个版本号，各自在 CHANGELOG 里记一条，release 正文互相点名配对关系（人看 tag 列表看不出配对）。只发一条线时**另一条线什么都不做**——不要为「对齐」补一个空 tag。
- **tag 前缀即产品线**：`main` 用 `vX.Y.Z`，`workbuddy` 用 `wb-vX.Y.Z`。两条线的更新内核都按各自前缀做探测与下载，改动任一侧的前缀口径等于改发版契约。
- **版本号提交必须先于 tag**：两线的更新内核都有「包内清单的版本号 == 目标版本」这道落盘前校验，tag 若打在版本号未改的提交上，之后所有下载包都会被判「版本不符」拒装。
- **每个 tag 一份自己线的树**：客户端自动附的源码包天然是该 tag 对应提交的树，两线的更新内核下载的正是它。**不要做双端合并包**——更新内核的清理步骤是「删掉上一版清单里有、这一版没有的文件」，包里混入另一条线的文件，会让它在下一次更新时被当旧文件删掉。若另附人工安装包，按线各附一个、命名带线名与版本（如 `fox-widget-1.0.0.zip`），包内是插件根（含各自的清单目录）。
- **`Latest` 徽章留给 `v*` 那条线**：WorkBuddy 线的 release 用 `gh release create … --latest=false`，否则仓库首页与 `/releases/latest` 会指向 wb 版本（2026-10-18 发生过，徽章落到 `wb-v1.3.1`）。两条线的探测都**不依赖**徽章（各自枚举 releases 再按前缀取最高），错位只影响观感与外部工具，但会让人以为 WB 的版本是「最新」。
- **pre-release 的可见性两线不同**：ZCode 线的 github-api 源显式跳过 prerelease 与 draft，所以 pre-release 不会自动送达；WorkBuddy 线只按前缀过滤，**会**送达已装用户。发 pre-release 前先确认这是不是想要的。

### 版本说明的写法（2026-10-18 统一）

- **版本标题**：`## vX.Y.Z <动词>：<一句话>`，动词只用 **新增 / 修复 / 变更**；并入多个小版本的写「（并入 …）」。
- **条目**：平铺列表，每条**一句话、≤150 字**，只写「现象 → 影响」；实现细节、调查过程、字段名不进 CHANGELOG。
- **数量**：每版聚焦重点（一般 ≤10 条）；批次大或并入多个小版本时可放宽，但不再逐条罗列实现。
- **层级**：正文不出现 `###`；跨版本的回撤/补全说明用 `>` 引用块。
- **Release 正文**：首行一句总述并指回 CHANGELOG 小节；分节标题用 `##`；**不逐字复制 CHANGELOG**，只挑 3–6 条用户最关心的；末尾固定「升级」（ZCode 线）/「安装 / 升级」（WorkBuddy 线）。
- **两条线同批修复**用同一段文字，只替换宿主名词（ZCode↔WorkBuddy、余额↔积分）。
- **历史 Release**：全部版本已于 2026-10-18 按上述格式重建（同一骨架、每条 ≤5 条提要）；已发布正文不再逐条回改，只有格式错乱时才修。

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
- **release 正文的标题层级**：分组标题用 `##`（不用 `###`：GitHub 会渲染成小一号，同一页上就与相邻版本的正文大小不一致）；首行一句总述并指向 CHANGELOG 小节，末尾给升级方式小节（WorkBuddy 线是「安装 / 升级」）。
- **更新日志只写用户能感知的变化**：写「改了什么、用户会看到什么」。不写开发侧独白——死路与回滚（「试过 X 无效，别再加回来」）、测试计数与断言名（「selftest 259→263」「留了一条反向断言」）、给下一位维护者的嘱咐（「正解是上面的…」「相关代码与钉桩一并移除」）。这些属于源码注释、`*-FINDINGS.md` / `*-REPORT.md` 或提交正文。（v1.12.0 曾整条写「试过但无效的方向…别再加回来」，是给下一个改代码的人看的，已删。）
- **「维护者视角」措辞**：README / SKILL / commands / **源码注释** / **提交正文**只写事实与取舍，不写决策来源的归属（「按用户要求…」「用户裁决…」「用户实测…」这类）。要交代来历就落到证据上：写成「该方向实测无效，已在 `<sha>` 回滚」而不是「按用户要求回滚」。**例外**：`*-REPORT.md` / `*-FINDINGS.md` / `HANDOFF-*.md` 这类过程与调查报告引述的是当时会话语境，不做改写；但它们里的**事实性错误**仍要修（例如某份报告写着「本报告不入库」，在它随版本入库之后就该更正）。
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

### 发布物完整性（发布前必须做）

更新内核会从镜像下载整包并**直接覆盖 `lib/*.mjs`**，所以只校验「包内版本号 == 目标版本」不够
（版本号与包体来自同一批镜像）。现在下载后还会校验一份**发布签名**：

- 信任锚：仓库根 `.release-pubkey.pem`（随包分发，安装副本自带；镜像伪造不了签名）。
- 每次发布前跑一次签名工具，把生成的两份文件**一起提交**，然后才打 tag：

  ```bash
  # 一次性：生成密钥对（私钥留在仓库外，别提交）
  node tools/sign-release.mjs --gen-key ../fox-release-key.pem
  # 每次发版：生成清单 + 签名，然后 git add 两个文件并提交
  node tools/sign-release.mjs --key ../fox-release-key.pem
  # 提交前自检：清单与当前树是否一致、签名是否有效
  node tools/sign-release.mjs --check
  ```

清单按 `git archive` 的**打包字节**计算 sha256（仓库有 `.gitattributes` 的 eol 规则，工作区与
打包字节未必相同），逐个文件覆盖；签名覆盖清单本身。

**换钥**：私钥丢了或要轮换时，先用**旧私钥**签一个把新公钥提交进去的版本（`--gen-key` 会写新的
`.release-pubkey.pem`，再用旧私钥 `--key` 签），之后用新私钥签后续版本——否则已装副本会拒收新版本。

**顺序很重要**：清单按 `git archive` 的**打包字节**算，所以必须
「先把要发的改动全部提交 → 再签名 → 提交清单与签名 → 打 tag 之前再跑一次 `--check`」。
签名之后又改了任何被跟踪的文件，都会让清单与包体对不上，更新器会拒装（这正是它该做的事）。

**没有清单的旧版本会被拒装**（fail-closed），提示用户改用市场「重新抓取」或手动安装。
