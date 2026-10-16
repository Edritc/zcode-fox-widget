# 交接文档：把 zcode-fox-widget 移植到 WorkBuddy

> 写给接手移植的 AI。作者是 ZCode 侧负责这个插件开发的会话，2026-10-14 交接。
> **本文所有 WorkBuddy 相关结论都标了来源**：`【实测】`= 我在本机翻过代码/文件确认；`【文档】`= 取自 WorkBuddy 自带的插件开发文档；`【未验证】`= 推断或待你实测。
> 本文件是给你看的交接说明，**不是产品文档**；仓库里给用户看的文档是 `README.md` 与 `skills/zcode-fox-widget/SKILL.md`。

---

## 0. 先做这三件事

1. **读本机 WorkBuddy 自带的插件开发文档**（比任何二手描述都权威，就在磁盘上）：
   `~/.workbuddy/plugins/marketplaces/codebuddy-plugins-official/plugins/plugin-dev/skills/`
   —— 子目录 `plugin-structure` / `hook-development` / `mcp-integration` / `plugin-settings` / `command-development` / `agent-development`，每份都是 `SKILL.md`。你要的插件契约、钩子事件表、输出格式、MCP 写法全在里面。
2. **读另一份本机记忆**：`<本仓库>/.workbuddy/memory/MEMORY.md` 与 `2026-10-13.md` / `2026-10-14.md`。那是上一个 WorkBuddy 会话在排查浮层冻结时留下的，里面有它的排查手法与踩坑（尤其是「agent shell 里 Electron 的 GPU 子进程必崩」）。
3. **先定产品口径**：这个插件今天的头号卖点是「DeepSeek 余额 + 峰谷计价」，而 WorkBuddy 是**订阅/积分制**（本机实测：`high-credit-tools.json` + `subscription-gate` 插件 + 会话里按 request 记 credit）。**别默认照搬 ZCode 的叙事**，见 §6。

---

## 1. 项目概览

**它是什么**：一个"桌宠 + 账本"挂件。核心是一个本地 HTTP 服务 + 一个浏览器页面（Electron 透明置顶浮层承载同一个页面），另有 MCP 工具、斜杠命令、技能与钩子把它接进宿主 agent。

**宿主提供的接入点 vs 我们自建的部分**（这条是理解整个仓库的钥匙）：

| 部分 | 谁提供 | 说明 |
|---|---|---|
| 挂件窗口 | **我们自建** | 独立 Electron 进程，透明置顶无边框，铺满工作区但默认鼠标穿透，指针压到角色才接管。宿主的 agent 界面完全不参与 |
| 挂件页面 | **我们自建** | `lib/widget.js`，单文件 IIFE，无构建步骤，零依赖 |
| 本地服务 | **我们自建** | `lib/server.mjs`，只监听 `127.0.0.1` |
| 数据获取 | **宿主耦合** | 余额走 DeepSeek 官方 API（通用）；但「今日已用 / 每轮消耗 / 当前模型 / 主题跟随」读的是宿主的私有文件（ZCode 的 sqlite + 日志）。**这是移植的主要工作量** |
| 事件 | **宿主提供** | 钩子（SessionStart 自启、UserPromptSubmit / PermissionRequest 写状态） |
| 会话内工具 | **宿主提供** | MCP 工具、斜杠命令、技能 |

**技术栈约定**（移植时请保持，这是这个项目能长期维护的原因）：
- **零第三方依赖**：`lib/*.mjs` 只用 `node:` 内置模块；前端 `lib/widget.js` 是单个 IIFE，无打包、无框架、无 npm install。tar.gz 解包是自己写的（`lib/update.mjs`）。**不要为了省事引入依赖**，除非你同时说明为什么必须。
- **零构建**：`lib/widget.js` 是服务端按请求现读现发的（改前端 = 刷新页面即生效）；`lib/server.mjs` / `lib/paths.mjs` 是进程启动时定版（改它们必须重启服务）。
- **Windows 优先**：桌面浮层的跟随、穿透、键盘焦点全依赖 Win32 窗口 API + PowerShell；macOS/Linux 只有浏览器页面形态。
- 当前版本 `1.11.1`，共 4 个本地提交未发版（`git log --oneline` 看 `761e905` / `a500d59` / `2257e80` / `65698f3`）。

**仓库位置**：`C:\Users\<用户>\.zcode\cli\plugins\marketplaces\zcode-fox-widget`（就是 ZCode 的本地 marketplace 目录）。
**运行副本**：ZCode 实际加载的是 `~/.zcode/cli/plugins/cache/zcode-fox-local/zcode-fox-widget/1.0.0/`——**改完源码必须同步副本**，否则你测的是旧代码（上一个 AI 就在这上面误判过一次，见 `.workbuddy/memory/2026-10-13.md`）。

---

## 2. 文件树与各文件作用

```
zcode-fox-widget/
├── .zcode-plugin/plugin.json     ← 插件清单（ZCode 格式）  【移植时必须改写】
├── marketplace.json              ← 本地市场清单（ZCode 格式）【移植时必须改写】
├── hooks/hooks.json              ← 钩子接线（3 个事件）      【移植时必须改写】
├── commands/fox.md               ← 斜杠命令 /fox
├── skills/
│   ├── zcode-fox-widget/SKILL.md ← 排障与操作手册（给宿主 AI 读；内容最全）
│   └── fox-pricing-review/SKILL.md ← 人工复核价目的流程
├── lib/                          ← 全部服务端逻辑（零依赖 ESM，22 文件 ~16k 行）
├── desktop/                      ← Electron 浮层（5 文件 ~1.5k 行）
├── tools/                        ← 测试与演示（5 文件 ~7k 行）
├── assets/                       ← 角色立绘 / 音效 / 图片素材
├── README.md / CHANGELOG.md / CONTRIBUTING.md / LICENSE / NOTICE
└── 调查报告（不发版时按惯例留在工作区）：OVERLAY-PAUSE-FINDINGS.md、
    FIX-REPORT-ISSUE2-HOST-FREEZE.md、HANDOFF.md、CODE-*.md、UI-REVIEW-REPORT.md
```

### lib/ —— 后端（按重要性）

| 文件 | 行数 | 作用 | 移植影响 |
|---|---|---|---|
| `widget.js` | 8003 | **前端全量 UI**：拖拽/吸附/翻转/菜单/气泡/音效/数字滚动/浮层穿透切换/角色与配色/更新面板 | 基本可直接复用（不含宿主耦合） |
| `server.mjs` | 1591 | 本地 HTTP 服务：页面与全部 JSON 路由、写接口的 Host+Origin+JSON 三重校验、CSP、shutdown 令牌 | 复用；新增/改路由要同步 `tools/selftest.mjs` |
| `update.mjs` | 905 | **自更新内核**：探测（镜像链）→ 下载（纯 JS 解 tar.gz）→ 替换 → 清理，含出站白名单 | **风险项**，见 §9.6 |
| `vendors.mjs` | 686 | 26 家厂商模板（余额/额度/订阅窗口），并发取数 + in-flight 合并 | 复用（与宿主无关） |
| `balance.mjs` | 644 | DeepSeek 余额、记账账本（观测余额差值累计）、对账口径 | 复用；账本的换 key 归档依赖读 config 的实时性 |
| `pricing.mjs` | 609 | **价目单一来源** + 峰谷时段判定 + token→金额换算 | 复用（改价目只改这里） |
| `turn-cost.mjs` | 372 | **每轮消耗**：读 `~/.zcode/cli/db/db.sqlite` 的 `turn_usage` 表，回退解析 `~/.zcode/cli/rollout/model-io-*.jsonl` | **必须整段重写**（WorkBuddy 有更好的数据源，见 §6） |
| `cli.mjs` | 355 | 命令行：`status/turn/start/stop/restart-all/key/mode/json/vendors/window/desktop` | 部分重写（`window`/`desktop` 复用） |
| `mcp-server.mjs` | 350 | MCP 工具：`whale_balance` / `whale_widget` / `whale_last_turn` / `whale_config` | 复用（改 `plugin.json` 里的声明方式） |
| `plan-balance.mjs` | 339 | GLM Plan 套餐配额（零密钥尾随日志） | 重写（读 ZCode 数据目录的日志） |
| `cmdgo.mjs` | 337 | CommandCode 三重额度（月度池 + 5 小时/周窗口） | 复用（走 HTTP） |
| `usage-records.mjs` | 332 | 「用量记录」面板的数据聚合（本机库） | 重写（数据源换成 WorkBuddy 的库，见 §6） |
| `overlay.mjs` | 322 | 浮层单例检查/启停、Electron 运行时按需下载安装 | 复用（改运行时存放路径） |
| `discover.mjs` | 321 | 凭据自动发现（宿主 provider 配置 + 环境变量） | 重写（WorkBuddy 的凭据位置不同） |
| `credentials.mjs` | 190 | 找 API Key、出站主机白名单校验（**安全边界**） | 复用逻辑，接口要适配 |
| `paths.mjs` | 142 | **所有路径的单一来源** + 模型→角色映射规则表 | **移植的落点之一**（见 §6.7） |
| `service.mjs` | 128 | 服务发现/拉起/关闭（含 `waitServerStopped` 那个易错点） | 复用 |
| `source.mjs` | 116 | 「当前计费源」判定（决定气泡主显示跟随谁） | 重写（读宿主会话状态） |
| `zcode-theme.mjs` | 110 | 跟随 ZCode 主题（读客户端配置 + 浮层观测） | 重写（改成 WorkBuddy 主题） |
| `hook-event.mjs` | 84 | 钩子事件 → `hook-state.json`（等确认提醒的数据面） | 复用（事件名/字段要适配） |
| `blocked-host.mjs` | 58 | 环回/私有/保留地址判定（安全） | 复用 |
| `autostart.mjs` | 56 | SessionStart 钩子：幂等拉起服务（+ 已装运行时则拉浮层） | 复用 |

### desktop/ —— Electron 浮层

| 文件 | 说明 | 移植影响 |
|---|---|---|
| `main.cjs` | 主进程：透明置顶窗口、鼠标穿透/接管 IPC、隐身/重现、主题观测、外链防护（`setWindowOpenHandler`）、**`type:'toolbar'`（别删，见 §10）** | 窗口能力复用；**认宿主的部分全要重写**（`noteZCodeIdentity`、`ui-ready` 门控、跟随目标） |
| `follow-window.ps1` | 常驻 PowerShell：每 40ms 读宿主主窗口矩形/前台状态、DPI、跨进程补 `WS_EX_TOOLWINDOW`。**必须保持纯 ASCII**（PS 5.1 按 ANSI 读） | 重写目标进程名/标题判定 |
| `ui-ready.cjs` | 「宿主主界面是否加载完成」门控（解析 ZCode 客户端日志的启动标记，用 pid 归属到本次启动） | **重写**（WorkBuddy 的启动标记不同） |
| `preload.cjs` | 暴露给页面的桥：`setInteractive` / `setViewport` / `quit` / 跟随间隔 | 复用 |
| `package.json` | Electron 运行时元信息 | 复用 |

### tools/ —— 测试与演示

| 文件 | 说明 |
|---|---|
| `selftest.mjs` | **主自检 299 项**：起临时服务 + 隔离 `ZCODE_HOME`，跑后端路由/纯函数/一致性断言 |
| `selftest-update.mjs` | **更新内核自检 50 项**：独立进程跑版本比较/白名单/tar 解包/落盘计划/多 root 清单/**重启链路端到端** |
| `smoke-ui.mjs` | **前端冒烟 103 项**：headless Edge + CDP，真开菜单/气泡/面板、算对比度、模拟媒体特性 |
| `demo.mjs` | 演示服务（假数据，用来人工观察气泡） |
| `debug-overlay.mjs` | 浮层调试 |

---

## 3. 已实现的功能（现状清单）

**显示与交互**：气泡主显示随计费源切换（自动/Plan/CommandCode/GLM/DeepSeek）；每轮消耗气泡（金额或"消耗余额 x%"）；峰谷时段与倒计时（流光渐变，已纳入 `prefers-reduced-motion`）；按压泡泡（点击队列、可视化三级编辑器、模板导入导出、按权重随机）；拖拽/吸附/翻转/右键唤菜单/桌宠模式（全屏漫游、失焦不隐身）；音效（内置两套 + 导入）；数字滚动与按压形变。

**角色**：5 套内置形象（大肥鱼/GPT娘/kimi娘/小克/嘎啦嘛）+ 导入自定义（改名、删除、内置可隐藏找回）；每个角色专属台词池；**角色配色覆盖**（内嵌 HSV 调色板 + HEX/RGB 输入，浅色档整套界面跟随角色色，正文按 4.5:1 派生达标变体）；**按模型自动换角色**（读会话模型 → 映射到角色，认不出就不动，手动选过即自动关闭，两拍迟滞防抖动）。

**账本与额度**：DeepSeek 余额 + 记账账本（观测余额差值累计，跨天归档，换 key 整本归档）；今日已用双口径（本机库为主 + 账号口径对账）；GLM Plan 套餐配额；CommandCode 三重额度；26 家厂商模板（余额/额度/订阅窗口/无接口）；记账二级页（额度预警 / 余额预警 / 余额校正）；用量记录面板（今日/7 天/逐条明细）。

**工程**：三套测试共 452 项断言；自更新（镜像链 + 纯 JS 解包 + 备份/清理 + 多安装目录）；浮层单例归一；写接口三重校验 + CSP + 出站白名单。

---

## 4. 可规划的功能

下面是**明确想做但还没做**的，按价值排序（第 1、2 条来自对 CrossPet 项目的调研，当时已和你确认方向）：

| # | 功能 | 现状 | 备注 |
|---|---|---|---|
| 1 | **姿势/状态机 + 每姿势台词池** | 只有「每轮消耗气泡」一个事件反应 | 参考 CrossPet：事件→姿势（thinking/running/writing/reading/asking/proud/…）、按工具名分类、一轮工具数 ≥8 结束就"得意"、多会话并发"手忙脚乱"。**WorkBuddy 的钩子与 transcript 正好够用**（见 §6.5），是移植后最容易做出差异化的方向 |
| 2 | 「用户手动退出过就别再自动拉起」 | 现在是每次会话启动幂等拉起 | 参考 CrossPet：比较退出标记 mtime 与宿主顶层进程启动时间（Windows 要 toolhelp + QueryFullProcessImageName，跳过 cmd/powershell 外壳） |
| 3 | 「等确认提醒」的事件源 | ZCode 靠 `PermissionRequest` 钩子 | **WorkBuddy 没有这个事件**（见 §5.3），要换数据源 |
| 4 | 噪音过滤（跳过 agent 自己的后台轮次） | 没做 | 现在只挂低频事件用不上；**要做姿势就必须先做**，否则角色会被后台轮次带得乱动。WorkBuddy 的 `sessions.is_background_automation` 字段可直接用(【实测】) |
| 5 | 心跳/自检面 | 数据面有（`hook-state.json` + `/whale/hook.json`），界面诊断行刚被用户要求删掉 | 若要恢复，别做成 `钩子 UserPromptSubmit 20:18` 那种裸事件名——做成开关旁边的状态点或 tooltip |

---

## 5. 移植规范：WorkBuddy 的插件契约

**本节的权威来源是你本机的 `plugin-dev` 文档（§0 第 1 条），下面是直接可用的对照与我实测到的细节。**

### 5.1 目录与清单

| 项 | ZCode（现在） | WorkBuddy |
|---|---|---|
| 清单目录 | `.zcode-plugin/plugin.json` | **`.codebuddy-plugin/plugin.json`**【实测】 |
| 清单必填 | `name` | `name`（kebab-case，全局唯一）【文档】 |
| 组件目录 | `commands/` `skills/` `hooks/` + 清单里 `mcpServers` | 同名，**必须在插件根**（不能塞进 `.codebuddy-plugin/`）【文档】；另支持 `agents/`（子代理定义）【实测：内置插件有】 |
| MCP | 清单内联 `mcpServers` | **`.mcp.json`**（推荐，清单里写 `"mcpServers": "./.mcp.json"`）【实测+文档】 |
| 钩子 | `hooks/hooks.json`，清单写 `"hooks": "hooks/hooks.json"` | 同左，**格式兼容**（`{hooks:{<Event>:[{matcher,hooks:[…]}]}}`）【实测：内置插件就这么写】 |
| 路径变量 | `${ZCODE_PLUGIN_ROOT}` / `${ZCODE_PLUGIN_DATA}` | **`${CODEBUDDY_PLUGIN_ROOT}` / `${CODEBUDDY_PLUGIN_DATA}`**，且支持 `$VAR` 无花括号形式【实测+文档】 |
| 其它变量 | — | `${CODEBUDDY_PROJECT_DIR}`、`${CODEBUDDY_ENV_FILE}`(仅 SessionStart)、`${CODEBUDDY_CODE_REMOTE}`【文档】 |

**最小可用的 WorkBuddy 清单**（本机内置插件 `subscription-gate` 的实例【实测】）：

```json
{
  "name": "fox-widget",
  "version": "1.0.0",
  "description": "…",
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json",
  "defaultEnabled": true
}
```

### 5.2 市场与安装（本机实测）

- 市场注册表：`~/.workbuddy/plugins/known_marketplaces.json`，**支持 `type: "directory"` + `source.path`**（指向本地目录）——和 ZCode 的 directory 市场同构，**这是推荐的移植路径**。
- 市场清单：`<市场目录>/.codebuddy-plugin/marketplace.json`，形如
  `{ "name": "<市场名>", "plugins": [ { "name": "<插件>", "version": "x.y.z", "source": "./plugins/<插件>", "description": "…", "category": "…" } ] }`【实测】
- 安装注册表：`~/.workbuddy/plugins/installed_plugins.json`，`plugins["<插件>@<市场>"] = [{scope, installPath, version, installedAt}]`；`installPath` 指向 `~/.workbuddy/plugins/cache/<市场>/<插件>/<版本>/`【实测】
- 启用开关：`~/.workbuddy/settings.json` 的 `enabledPlugins["<插件>@<市场>"] = true`【实测】
- **插件数据目录**：`~/.workbuddy/plugins/data/<插件>-<市场>/`，即 `${CODEBUDDY_PLUGIN_DATA}`【实测】

> 移植时把「本仓库即市场」的形态照搬过去：仓库根放 `.codebuddy-plugin/marketplace.json`（`source: "./plugins/fox-widget"` 之类），插件目录放 `.codebuddy-plugin/plugin.json`。**注意 WorkBuddy 的市场清单要求 `plugins[].source` 指向插件子目录**，而 ZCode 的 `marketplace.json` 用的是 `"source": "."`（仓库根即插件）——两者不同，别直接抄。

### 5.3 钩子：事件表与写法差异（**最容易踩的地方**）

WorkBuddy 的事件（【文档】`hook-development`，另在【实测】内置插件里见到 `UserPromptExpansion`）：
`PreToolUse`、`PostToolUse`、`Stop`、`SubagentStop`、`SessionStart`、`SessionEnd`、`UserPromptSubmit`、`UserPromptExpansion`、`PreCompact`、`Notification`。

**差异清单**：

1. **没有 `PermissionRequest` 事件** → 我们「等确认提醒」的触发源没有了。候选替代（**都需你实测**）：`Notification`（文档：宿主发通知时触发）/ `PreToolUse` 返回 `permissionDecision: "ask"` 的自身时机 / 宿主 ACP 审批通道（WorkBuddy 的审批是 ACP 请求，字面量 `codebuddy.ai/approval` 在 asar 里出现过）。
2. **钩子类型不兼容**：ZCode 用 `{"type":"process","command":"node","args":[...]}`；WorkBuddy 文档只有 **`type:"command"`（shell 字符串）** 与 **`type:"prompt"`（自然语言判定，仅 Stop/SubagentStop/UserPromptSubmit/PreToolUse 支持）**。→ 我们 3 个钩子都要改写成 `command` 形式，注意 shell 是 bash 语法（文档示例用 `bash ${CODEBUDDY_PLUGIN_ROOT}/…`）。
3. **stdin 契约**（【文档】）：公共字段 `session_id` / `transcript_path` / `cwd` / `permission_mode` / `hook_event_name`；事件专属：PreToolUse/PostToolUse → `tool_name`/`tool_input`/`tool_result`；UserPromptSubmit → `user_prompt`；Stop → `reason`。
   → 我们的 `lib/hook-event.mjs` 读的是 ZCode 的 `hook_event_name`（同名字段，**这点是兼容的**），但它只认 `UserPromptSubmit`/`PermissionRequest`，要扩。
4. **输出格式**：公共 `{"continue":bool,"suppressOutput":bool,"systemMessage":"…"}`；PreToolUse 用 `hookSpecificOutput.permissionDecision`；exit 0 正常 / 2 阻断 / 其它非阻塞错误。（【文档】；ZCode 的语义类似但细节不同，我们现有钩子只写文件不输出，**这条不受影响**。）
5. **`SessionStart` 有个特别能力**：`$CODEBUDDY_ENV_FILE` 可以持久化环境变量【文档】。我们的自启（`autostart.mjs`）不需要它，但如果要让挂件知道"本次会话的模型"，这是条路。

### 5.4 MCP

- stdio 写法与 ZCode 几乎一样，只是变量名换成 `${CODEBUDDY_PLUGIN_ROOT}`；**`cwd` 必须落在插件目录内**（asar 里有 `isPathInside` 校验）【实测】。
- WorkBuddy 支持 `defer_loading`（默认 `true`）；计费类工具若走 defer 会绕开钩子，内置插件显式写 `false`【实测：`high-credit-gate.cjs` 的注释】。我们的工具不涉及计费，可不管。
- **工具全名前缀不同**：WorkBuddy 是 `mcp__plugin_<插件名>_<server名>__<工具名>`【文档】，ZCode 是 `mcp__whale__whale_balance`。→ **`commands/fox.md` 的 `allowed-tools` 必须改**。

### 5.5 命令 / 技能 / 子代理

- `commands/*.md` 自动发现（YAML frontmatter，`allowed-tools` 预授权）；`skills/<name>/SKILL.md` 自动发现；WorkBuddy 还多一层 `agents/*.md`（子代理）。
- 我们要搬的：`commands/fox.md`（改 `allowed-tools` 前缀）、两个 SKILL.md（**内容基本可复用，但里面所有 `node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs"`、`~/.zcode/whale/...`、`~/.zcode/cli/...` 路径都要换成 WorkBuddy 的**）。

### 5.6 运行时与沙箱（**本机实测的两个坑**）

- WorkBuddy 自带 node：`~/.workbuddy/binaries/node/versions/…`（还有 PortableGit / python）。钩子里的 `node` 解析到哪个 node 要实测确认；**不要假设系统 PATH 里的 node 可用**。
- `~/.workbuddy/settings.json` 里有沙箱规则，且本机 `sandbox.networkDenyAllMigrated: true`【实测】。我们的插件是**大量出站**的（DeepSeek API、26 家厂商、更新镜像链），**如果沙箱默认拒绝出站，多数功能会静默失败**——移植时第一件事就是确认出站策略，必要时在 `sandbox.extraAllowWrite` / 网络规则里放行。

---

## 6. 数据源替换表（**移植的核心工作量**）

ZCode 侧我们把宿主的私有数据读得很深。WorkBuddy 的数据**更结构化、更好读**（本机实测），但字段完全不同。

| 功能 | ZCode 现在读什么 | WorkBuddy 可用的替代 | 难度 |
|---|---|---|---|
| **每轮消耗** | `~/.zcode/cli/db/db.sqlite` 的 `turn_usage` 表（`computed_total_tokens`/`input`/`output`…），回退 `~/.zcode/cli/rollout/model-io-*.jsonl` | **`~/.workbuddy/workbuddy.db` 的 `session_usage` 表**：`credit_json` 是 `{conversationRequestId: credit}`（每次请求消耗多少积分），join `~/.workbuddy/projects/<项目 slug>/<sessionId>.jsonl` 里 `providerData.conversationRequestId` / `rawUsage`（含 `prompt_tokens`/`completion_tokens`/`prompt_cache_hit_tokens`/`credit`）与 `requestModelId`/`requestModelName` | 中（**比 ZCode 的数据更好**：原生给积分和模型名） |
| **今日已用** | 本机库聚合 + 记账账本 | `session_usage.credit_json` 按日汇总；`session_usage.updated_at` 有毫秒时间戳 | 低 |
| **当前模型**（→ 换角色） | `/whale/session.json`（从 ZCode 会话状态/最近调用推） | **`sessions` 表的 `model` 字段**（本机实测值：`glm-5.3` / `hy4-preview` / `step-5-preview`）；或 transcript 的 `providerData.requestModelId` | 低，但**映射表要扩**（见下） |
| **上下文余量** | 无（ZCode 侧我们没做） | **`session_usage.used` / `size`**（本机实测：`214505 / 600000`）——可直接做一个「上下文 xx%」显示 | 低（**新增能力**） |
| **余额** | DeepSeek `/user/balance`（通用，可直接复用） | 同左；但 WorkBuddy 是订阅制，"余额"故事要重讲 | — |
| **凭据发现** | ZCode provider 配置 + 环境变量（`lib/discover.mjs`，读 `provider_config.json`） | 需重新发现 WorkBuddy 的 provider/凭据存哪（**未验证**）；`pluginConfigs`（`settings.json`）与 `${CODEBUDDY_PLUGIN_DATA}` 是候选 | 中 |
| **主题跟随** | `lib/zcode-theme.mjs` + `~/.zcode/...` 配置 + 浮层 DWM 观测 | **未验证**：WorkBuddy 主题存在哪（`app-config.json` 里只有 locale；可能在 `~/.workbuddy/local_storage` 或 `settings.json`）。**建议先做浮层 DWM 观测那一半（与宿主无关），配置读取后补** | 中 |
| **Plan / CommandCode 额度** | 读 ZCode 数据目录的日志 | WorkBuddy 没有对应物；**建议直接砍掉或改成"订阅额度"**（它的 `subscription-gate` 说明有订阅概念，具体接口**未验证**） | 高/可选 |
| **配置与数据落盘** | `~/.zcode/whale/`（`ZCODE_HOME`） | **`${CODEBUDDY_PLUGIN_DATA}`**（`~/.workbuddy/plugins/data/<插件>-<市场>/`）【实测】 | 低，但**全仓库的路径常量都集中在 `lib/paths.mjs`，改一处即可** |

**模型→角色映射要扩**：现在是 5 族关键词（glm/zhipu→嘎啦嘛，deepseek→大肥鱼，gpt/openai→GPT娘，kimi/moonshot→kimi娘，claude/anthropic→小克），规则表在 `lib/paths.mjs` 的 `MODEL_ROLE_RULES`（前端 `lib/widget.js` 的 `roleForModel` 有一份副本，`tools/selftest.mjs` 有两条断言钉住两侧一致）。WorkBuddy 本机见过的模型有 `glm-5.3`、`hy4-preview`、`step-5-preview`——后两个当前**认不出→保持不动**，如果你要覆盖它们，**两边同步改**，否则自检会红。

---

## 7. 测试与验收

### 7.1 现有三套（移植后仍应能跑）

```bash
node tools/selftest.mjs         # 期望：全部通过（299/299）
node tools/selftest-update.mjs  # 期望：更新内核自检 50/50 通过
node tools/smoke-ui.mjs         # 期望：前端冒烟全部通过（103/103）；找不到 Edge/Chrome 会 SKIP
```

三套都会自建临时 `ZCODE_HOME`（`selftest.mjs` 与 `smoke-ui.mjs` 用 `mkdtempSync`），**不碰真实数据目录**——移植时这套隔离手法要保留，只把 env 名换成 WorkBuddy 的。

**已知的测试脆弱点**（别被误判带偏）：
- `smoke-ui.mjs` 依赖 headless Edge/Chrome 与 CDP；**时间敏感的用例用轮询而不是固定 sleep**（我们已经踩过两次假失败：主题切换、音效触发器）。
- `smoke-ui.mjs` 里**注入到页面执行的那些表达式**把中文写成 `\uXXXX` 转义（避免注入串的转义/编码问题）；Node 侧的字面量中文是正常的。改这些注入串时别把 `\u` 还原成中文。
- `selftest.mjs` 顶层 `import` 了 `node:sqlite`（Node ≥ 22.5）。WorkBuddy 自带的 node 版本要先确认。

### 7.2 移植后必须新增的测试

1. **清单契约**：`.codebuddy-plugin/plugin.json` / `.mcp.json` / `hooks/hooks.json` 的字段与路径变量（照抄 `selftest.mjs` 里现成的「钩子接线契约」那几条改写）。
2. **数据源解析**：给 `workbuddy.db` 造一个 fixture（`session_usage.credit_json` + `sessions.model`），断言「每轮消耗 / 当前模型 / 上下文余量」的解析结果。**推荐直接把 `~/.workbuddy/workbuddy.db` 复制成 fixture 再改**（本机那份有真实结构）。
3. **重启链路**：`selftest-update.mjs` 里那条端到端用例（start → restart-all → 断言服务仍在线）值得原样保留——它抓过一个确定性的真 bug。

### 7.3 人工验收清单（移植后逐条过）

- [ ] 会话启动自动出现挂件（`SessionStart` 钩子生效）；关掉 `autoStartWidget` 后不再自启
- [ ] 菜单能打开、能点、**不打断宿主前台**；点角色后宿主画面不冻结（见 §10.1）
- [ ] 余额/今日已用/每轮消耗三个数字都出得来（数据源替换成功的硬指标）
- [ ] 按模型换角色：切模型 → 两拍内换形象；手动选过之后不再自动跟随
- [ ] 角色配色弹层：拖动实时预览、松手落盘；「恢复默认」可回退
- [ ] 浮层穿透：指针在角色外时宿主可正常操作；压到角色才接管
- [ ] 「等确认提醒」：宿主弹权限确认时能提醒（**先在 §5.3 里选定事件源**）

### 7.4 截图/预览的取法（让验收有据可查）

隔离服务 + headless 浏览器 + CDP 截图。模板见我这次用的脚本（**未入库**，可直接照抄思路）：临时 `ZCODE_HOME` + `config.json` 指定端口 → 起服务 → `--headless=new --remote-debugging-port=0` → 从 stderr 抓 `DevTools listening on ws://…` → 连 CDP → 点开菜单 → `Page.captureScreenshot`。气泡类内容要等 ~900ms 再截。菜单宽度这类布局结论**要量 DOM 而不是肉眼估**（我就是靠 `getBoundingClientRect` 才确认新加的行不是菜单变宽的原因）。

---

## 8. 两个 agent 的差别与交接注意事项

| 维度 | ZCode | WorkBuddy |
|---|---|---|
| 插件清单 | `.zcode-plugin/plugin.json` | `.codebuddy-plugin/plugin.json`（CodeBuddy 血统） |
| 插件能力 | skills / commands / hooks / mcpServers | **skills / commands / agents / hooks / mcpServers**（多一层子代理） |
| 钩子事件 | 7 个（SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure / Stop） | 10 个（少了 `PermissionRequest`，多了 SubagentStop / SessionEnd / UserPromptExpansion / PreCompact / Notification） |
| 钩子写法 | 支持 `type:"process"`（args 数组） | 只有 `type:"command"` / `type:"prompt"` |
| 界面注入 | **完全没有**（所以挂件自己开窗口） | 也**没有找到**注入点【未验证：我没在 asar 里搜到 panel/view 类注入契约】→ **同样走自建浮层** |
| 会话协议 | ZCode 私有会话库 + 日志 | **ACP**（`session/new`/`load`/`prompt`/`cancel`）【实测 asar 字符串】 |
| 计费模型 | 用户自带各家 API Key，按 token 计价 | **订阅 + 积分**（`credit_json`、高积分工具审批） |
| 记忆约定 | `~/.zcode/cli/memories/projects/<项目>/` | **`<项目>/.workbuddy/memory/`**（本仓库里已有一份） |
| 数据目录 | `~/.zcode/`（`ZCODE_HOME`） | `~/.workbuddy/`（+ 插件数据在 `plugins/data/<插件>-<市场>/`） |

**交接注意事项**：

1. **别把"移植"理解成"复制粘贴"**。能直接搬的是：浮层（`desktop/`）、页面（`lib/widget.js`）、本地服务（`server.mjs`）、定价（`pricing.mjs`）、厂商模板（`vendors.mjs`）、记账（`balance.mjs`）、MCP 服务本体、三套测试框架。必须重写的是：**宿主数据源**（`turn-cost` / `usage-records` / `source` / `discover` / `zcode-theme` / `plan-balance`）与**宿主的接入声明**（清单 / 钩子 / 市场 / 命令工具名）。
2. **改运行副本**：WorkBuddy 从 `plugins/cache/<市场>/<插件>/<版本>/` 加载（本机实测 `installed_plugins.json`）。改完源目录要么重新走客户端安装，要么同步 cache 副本并重启——**别只改一处就下结论**（上一个 AI 因此误判过一次）。
3. **本机已经装了 WorkBuddy**，`~/.workbuddy/` 里有你自己的会话数据，**测试时一律用隔离目录**，不要读写用户真实的 `workbuddy.db`（它带 WAL，随意打开可能干扰宿主进程；要读就先 copy 一份再读，我就是这么做的）。
4. **`.workbuddy/memory/MEMORY.md` 是给宿主 AI 的长期记忆**，不是给我的——你写的东西要按它的约定写（daily 文件 + MEMORY.md 索引）。
5. 我这边（ZCode）留了几份调查报告在仓库根（`OVERLAY-PAUSE-FINDINGS.md` 等）。它们是**排查记录**，不是规格；`FIX-REPORT-ISSUE2-HOST-FREEZE.md` 里的结论（浮层冻结的根因）对你有用——WorkBuddy 的界面也是 Electron，同源问题可能出现。

---

## 9. 可能产生的问题（风险清单）

按"会不会让你白干一天"排序：

1. **沙箱拦出站**。`sandbox.networkDenyAllMigrated: true`（本机实测）意味着默认可能拒网。挂件 90% 的功能要出站（DeepSeek 余额、26 家厂商、更新镜像）。→ **第一步就验证**：随便调一次 `/whale/balance.json`，看出站是否被拦。
2. **钩子类型不兼容**导致的"钩子完全不跑"。我们现有 `hooks/hooks.json` 用的是 ZCode 的 `process` 类型，WorkBuddy 只认 `command`/`prompt`。→ 改完**必须验证钩子真的被触发**（`hook-state.json` 有没有新事件时间戳），别假设。
3. **`PermissionRequest` 缺席**导致"等确认提醒"永久静默。→ §5.3 里选替代事件源并实测。
4. **数据源解析错误但"看起来正常"**。积分/金额算错的典型症状是数字虚高十几倍（ZCode 侧踩过：token 的 `input` 含缓存、被按未命中价重复计价）。WorkBuddy 的 `rawUsage` 同样给了 `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`，**别把 `prompt_tokens` 整个按未命中价算**。→ 写单测钉住口径；优先直接用宿主给的 `credit`（它已经算好了）。
5. **Electron 在 agent shell 里起不来**：本机实测 GPU 子进程必崩（`0xC0000005` → "GPU process isn't usable"），要加 `--no-sandbox --disable-gpu`；且 `ELECTRON_RUN_AS_NODE` 会污染子进程（需 `env -u ELECTRON_RUN_AS_NODE`）。**真机浮层重启要在 WorkBuddy 客户端环境里做，别在 agent shell 里 `window start`**（会把窗口弄没）。
6. **自更新与客户端插件管理冲突**。`lib/update.mjs` 会把新版本文件**原地覆盖**到每个安装目录（包括 cache 快照），而 WorkBuddy 的版本号由 `installed_plugins.json` 记录、目录名带版本号。→ 建议移植时**默认关闭自动更新**（`WHALE_DISABLE_UPDATE_CHECK=1` 已有开关），或改成"只更新源码仓库副本、不动 cache"。至少要知道这个风险。
7. **路径常量散落**。路径解析集中在 `lib/paths.mjs`（`ZCODE_HOME` / `DATA_DIR` / `CONFIG_FILE` / …），但别处仍有直接拼 `~/.zcode` 或读宿主文件的地方。我按字面量数过：`lib/paths.mjs` 18 处、`lib/update.mjs` 17、`lib/discover.mjs` 14、`desktop/main.cjs` 12、`desktop/ui-ready.cjs` 6、`lib/turn-cost.mjs` 6、`lib/plan-balance.mjs` 6、`lib/zcode-theme.mjs` 7、`lib/credentials.mjs` 5、`hooks/hooks.json` 4。→ 建议先只改 `paths.mjs` 把 `ZCODE_HOME` 指向 WorkBuddy 数据目录，再逐个收拾硬编码。
8. **`follow-window.ps1` 必须保持纯 ASCII**（PS 5.1 按 ANSI 代码页读）。改它的时候别顺手写中文注释。
9. **主机识别与 UI 就绪门控整个要重写**：现在靠窗口标题 `ZCode狐娘小挂件` 与 ZCode 日志里的启动标记（`ui-ready.cjs`）。WorkBuddy 的主窗口标题/进程名/启动标记都不同。→ 跟随目标换成 `WorkBuddy.exe` 的主窗口；`ui-ready` 那套门控可以先整个去掉（宁可在加载动画期间早出现，也别永不出现）。
10. **浮层单例归一**：`lib/overlay.mjs` 的 `listOverlayPids()` 按命令行里含 `zcode-fox-widget` 来枚举实例。移植后改名的话要同步，否则可能出现"桌面上两个角色"（我们修过一次）。

---

## 10. 已知坑与"不要改"的清单

### 10.1 不要删：`desktop/main.cjs` 的 `type: 'toolbar'`
Windows 上它让浮层常驻 `WS_EX_TOOLWINDOW`，从而使浮层**不进入宿主 Chromium 的遮挡判定**。删掉会复发「点角色后宿主画面停帧」（issue #2 症状一，真机 A/B 实锤：无此位时点击后 113 帧仅 8 个不同；有此位时 113/113 全变）。详见 `FIX-REPORT-ISSUE2-HOST-FREEZE.md`。
排查同类问题时记住两条方法学：**触发场景是宿主正在流式输出时**；**冻结检测必须完全被动**（摆动鼠标的悬停重绘会掩盖冻结，导致假阴性）。

### 10.2 不要"顺手优化"的几处（都有实测理由，代码里有注释）
- `lib/credentials.mjs` 的 `readPluginConfig()` **刻意不加缓存**：账本靠"读到的 apiKey 与上次不同"判定换 key 并归档整本账，加 TTL 缓存会让外部写入在窗口期内不可见（实测：加 1s 缓存后账本状态机用例立刻失败）。
- `lib/service.mjs` 的 `stopServer` 必须**等端口真的停止应答**才返回（`waitServerStopped`）：shutdown 的 200 只是"已受理"，不等就会在 restart 时误判"复用已在运行的服务"→ 停完起不来（确定性复现 3/3）。
- `lib/turn-cost.mjs` 的 `splitInputTokens()` **必须**减掉缓存命中部分（否则缓存那 99% 被按未命中价重复计费，单轮从 ¥3.05 虚高到 ¥76.95）。
- `lib/update.mjs` 的探测**取所有候选里的最高版本**：镜像 CDN 会返回上一版（刚发版后实测），只看第一个成功响应会漏报新版本。
- `lib/widget.js` 的 `--zcw-ink` 取的是 **4.5:1 派生色**（`--zcw-role-ink-text`），装饰件才用角色原色——这是为了让 kimi娘（原值对白底仅 2.85:1）也有可读正文。别把两者合并回去。
- 前端**不引 ESM**：`lib/widget.js` 与 `lib/paths.mjs` 各有一份模型→角色映射表，靠 `tools/selftest.mjs` 的两条断言钉住一致。

### 10.3 交互约定（改窗口/菜单前先读）
- 浮层全程铺满工作区、**不 `setBounds`**（改尺寸会让透明窗合成层错位）；隐身靠 `setOpacity(0)` 而非 `hide()`；`focusable:false` 不抢前台，键盘需求走临时 `setFocusable(true)`。
- 菜单/面板里的控件只准用 `background-color` 做 hover（用 `background` 简写会把手绘箭头的 `background-image/position` 清掉，箭头会"飞"）。
- `GetLayeredWindowAttributes` 对这个浮层返回 `flags=0`（Electron 44 透明窗走 DirectComposition），**不能用 alpha 判断可见性**，要用像素多样性。

---

## 11. 建议的施工顺序

1. **探路（半天）**：在 WorkBuddy 里装一个最小的本地目录市场 + 一个只有 `SessionStart` 钩子的空插件，验证「插件能被装上 / 钩子真的触发 / 出站是否被沙箱拦 / `${CODEBUDDY_PLUGIN_ROOT}` 能展开」。这四件事任意一件不通，后面全白干。
2. **骨架（1 天）**：把仓库复制过去，改成 `.codebuddy-plugin/plugin.json` + `.codebuddy-plugin/marketplace.json` + `.mcp.json` + 3 个 `command` 类型钩子；`lib/paths.mjs` 把数据目录指向 `${CODEBUDDY_PLUGIN_DATA}`。此时验收：MCP 四个工具能调、`node lib/cli.mjs status` 能跑。
3. **数据源（2–3 天，核心）**：先做「每轮消耗 + 当前模型 + 上下文余量」（`workbuddy.db`，最容易也最有价值），再做「主题跟随」，`plan-balance`/`cmdgo` 直接决定砍或留。每做一块补一条单测。
4. **浮层适配（1 天）**：换跟随目标进程与窗口标题，去掉 `ui-ready` 门控；在 WorkBuddy 客户端里重启浮层验收（别在 agent shell 里起）。
5. **收尾**：把三套测试跑绿；更新 `README.md` / `SKILL.md` 里的路径与命令；决定自更新开关的默认值。

**每一步的验收标准都在 §7**。有拿不准的宿主行为，**先用最小实验证伪再动手**——这个项目历史上最大的时间浪费都来自"看起来应该生效"的假设（副本没同步、钩子没触发、ID 用了旧口径），而不是写代码本身。