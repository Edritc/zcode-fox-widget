# Phase 1 施工记录：骨架 WorkBuddy 化

> 作者：WorkBuddy 侧移植会话（2026-10-14）。时效声明：截至 2026-10-14，宿主版本
> WorkBuddy 5.8.2。上游依据：`MIGRATION-PLAN-WORKBUDDY.md` §Phase 1、`HANDOFF-WORKBUDDY.md` §5、`phase-0.md`。

## 出口标准逐条勾选

| # | 标准 | 状态 | 证据 |
|---|---|---|---|
| 1 | 清单换成 `.codebuddy-plugin/plugin.json` + `.codebuddy-plugin/marketplace.json` | ✅ | 见下「交付物」 |
| 2 | `.mcp.json`（stdio 写法，仅换变量名） | ✅ | `.mcp.json` |
| 3 | 3 个钩子改成 `command` 类型（bash 字符串） | ✅ | `hooks/hooks.json`（4 个事件） |
| 4 | `lib/paths.mjs` 数据目录指向宿主插件数据目录 | ✅ | `lib/paths.mjs` + 新增 `lib/host.mjs` |
| 5 | `commands/fox.md` 的 `allowed-tools` 前缀换成 `mcp__plugin_fox-widget_whale__*` | ✅ | `commands/fox.md` |
| 6 | 两个 SKILL.md 的路径与命令全量替换 | ✅ | `skills/fox-widget/SKILL.md`（新）、`skills/fox-pricing-review/SKILL.md` |
| 7 | 浮层运行时路径 + 单例判定 | ✅ | `lib/overlay.mjs` + `desktop/main.cjs` |
| 8 | MCP 四工具可调 / `cli.mjs status` 跑通 | ⏳ 待真机 | 静态语法与导入已全绿；**真机未验**（见「遗留项」） |

## 交付物（文件级）

### 新增

| 文件 | 作用 |
|---|---|
| `.codebuddy-plugin/plugin.json` | WorkBuddy 插件清单：`name: fox-widget`、`hooks: "./hooks/hooks.json"`、`mcpServers: "./.mcp.json"`、`defaultEnabled: true` |
| `.codebuddy-plugin/marketplace.json` | 本地市场清单：市场名 `fox-local`，插件 `fox-widget`，`source: "./"` |
| `.mcp.json` | MCP server `whale` → `node ${CODEBUDDY_PLUGIN_ROOT}/lib/mcp-server.mjs`（**不写 `cwd`**：宿主默认为插件根，见 phase-0 §4） |
| `lib/host.mjs` | **宿主适配层**：数据目录、db、主题、进程名、单例特征、环境变量名、事件表差异的唯一定义处（`MIGRATION-PLAN §4.3.1` 的落地） |
| `lib/host-theme.mjs` | 由 `lib/zcode-theme.mjs` 改写：主题来源换成宿主 `preferences.json` |

### 删除

| 文件 | 原因 |
|---|---|
| `.zcode-plugin/plugin.json` | ZCode 清单，本分支不再使用（`main` 分支保留） |
| `marketplace.json`（仓库根） | ZCode 格式；WorkBuddy 的市场清单在 `.codebuddy-plugin/marketplace.json`。**注意两份清单的 `source` 语义不同**：ZCode 用 `"."`，WorkBuddy 子目录惯例是 `"./plugins/<name>"`——本仓因根布局合法（phase-0 §2）用 `"./"` |
| `skills/zcode-fox-widget/SKILL.md` | 由 `skills/fox-widget/SKILL.md` 取代 |

### 改写要点

| 文件 | 改动 |
|---|---|
| `hooks/hooks.json` | `type:"process"` + `args` + `timeoutMs` → `type:"command"` + bash 字符串 + `timeout`（秒）。事件从 `SessionStart/UserPromptSubmit/PermissionRequest` → `SessionStart/UserPromptSubmit/Notification`（`PermissionRequest` 不存在，见 phase-0 §5）。**刻意只挂这三个低频事件**：WorkBuddy 的钩子是内联执行的，每挂一个事件就是每次触发起一个 node 进程（冷启动 40–80ms）；`PostToolUse` 每次工具调用都来一发，会给每次工具调用加延迟，所以**不挂**（`hook-event.mjs` 仍保留对它的处理，将来做姿势状态机时再挂，那时要先做后台轮次过滤） |
| `lib/paths.mjs` | `ZCODE_HOME` → `HOST_HOME`（`~/.workbuddy`）；`DATA_DIR` → `${CODEBUDDY_PLUGIN_DATA}`（默认 `~/.workbuddy/plugins/data/fox-widget-fox-local`）；`pluginVersion()` 读 `.codebuddy-plugin/plugin.json`；`DB_FILE` → `~/.workbuddy/workbuddy.db`；`ROLLOUT_DIR`/`ZCODE_CLIENT_CONFIG`/`v2DataDirCandidates()` 删除；`DEFAULT_PORT` 环境变量名 → `FOX_WIDGET_PORT` |
| `lib/service.mjs` | **关键一致性**：`probeHealth` 校验的 `app` 标识改为从 `host.mjs` 的 `HOST_APP_ID` 取（原先硬编码 `'zcode-fox-widget'`，与 `server.mjs` 的 `/whale/health` 必须逐字一致，否则 `findRunningServer` 永远找不到在跑的服务） |
| `lib/overlay.mjs` | 运行时目录跟数据目录走；单例命令行特征同时接受 `fox-widget` 与 `zcode-fox-widget`（两端同装不互盲）；默认跟随目标 → `WorkBuddy` |
| `commands/fox.md` | `allowed-tools` 前缀 `mcp__whale__*` → `mcp__plugin_fox-widget_whale__*`；CLI 路径 `${ZCODE_PLUGIN_ROOT}` → `${CODEBUDDY_PLUGIN_ROOT}`；新增 `credits` 子命令说明 |
| `lib/widget.js` | 仅骨架层面：`__zcodeWhaleWidget` → `__foxWidget`、主题路由常量 → `/whale/host-theme.json`（+ 新增 `/whale/context.json`）、`ZCODE_THEME_URL` → `HOST_THEME_URL`、"跟随 ZCode" → "跟随 WorkBuddy" |
| `desktop/main.cjs` | 日志与主题观测落到插件数据目录；窗口标题 → `WorkBuddy狐娘小挂件`；宿主标识符 `zcodePid` → `hostPid` 等 |
| `desktop/follow-window.ps1` | 默认目标进程 `ZCode` → `WorkBuddy`（31 处字样替换后**仍为纯 ASCII**，脚本自带校验） |

### 有意保留的旧标识

改它们要动持久化状态与 2500 行冒烟测试，收益为零、风险不小，故**保留并记录**：

- 类名前缀 `zcwv-`、localStorage 键 `zcw-pos` / `zcw-*`
- 路由前缀 `/whale/`
- 环境变量 `WHALE_*`（浮层用）、`WHALE_PORT` 等
- 注释里描述历史来源的「ZCode」字样

（`lib/` 与 `desktop/` 之外只有在文档里出现；代码路径中已无 `~/.zcode` 或
`${ZCODE_PLUGIN_ROOT}` 字面量。）

## 证据

```bash
# 全部 lib/desktop 模块语法检查（无依赖 electron，未被 require 的路径可静态解析）
node --check lib/*.mjs desktop/*.cjs tools/*.mjs     # 全部通过

# 导入图检查（排除有副作用的脚本模块）
# server/autostart/hook-event 等模块在 import 时会执行顶层代码，不逐个 import；
# 改为在隔离 HOME 下真起一次服务验证（见 phase-2 的证据段）
```

## 遗留项

1. **真机安装与 MCP 工具调用未验证**（需在 WorkBuddy 客户端里注册目录市场 → 安装 → 重启会话）。
   代码侧证据链已备好：`autostart.log` / `hook-state.json` / `/whale/health`。
2. 宿主市场清单里 `plugins[].source: "./"` 只验证到「路径解析不报错」这一层（phase-0 §2）。
3. `settings.json` 的 `enabledPlugins` 需要在客户端里勾选启用（或依赖 `defaultEnabled: true`）——
   未真机确认 `defaultEnabled` 的实际效果。
