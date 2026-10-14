# Phase 3 施工记录：浮层适配

> 作者：WorkBuddy 侧移植会话（2026-10-14）。时效声明：截至 2026-10-14，宿主版本
> WorkBuddy 5.8.2。上游依据：`MIGRATION-PLAN-WORKBUDDY.md` §Phase 3、`HANDOFF-WORKBUDDY.md` §9.9/§10、`FIX-REPORT-ISSUE2-HOST-FREEZE.md`。

## 出口标准逐条勾选

| # | 标准 | 状态 | 说明 |
|---|---|---|---|
| 1 | 跟随目标换成宿主主窗口 | ✅ 代码，⏳ 真机未验 | `HOST_PROCESS_NAME = 'WorkBuddy'`；`follow-window.ps1` 默认目标 `WorkBuddy`（可用 `WHALE_TARGET_PROCESS` 覆盖） |
| 2 | `ui-ready` 门控整个移除 | ✅ | `desktop/ui-ready.cjs` 已删除，`main.cjs` 里所有 `uiReady` 分支与轮询移除 |
| 3 | `type: 'toolbar'` 一个字符都没动 | ✅ | 见下「不要动的清单」核对 |
| 4 | `follow-window.ps1` 保持纯 ASCII | ✅ | 替换 31 处字样后脚本自带校验：**non-ASCII chars = 0** |
| 5 | 浮层跟随/最小化/点击不打断/穿透/无双角色 | ⏳ 待真机 | 需在 WorkBuddy 客户端里 `window start` 验收（**不能**在 agent shell 里起，见下） |

## 改动明细

### `desktop/main.cjs`

| 改动 | 说明 |
|---|---|
| 数据目录解析 | 新增一个最小 CJS 实现（复制 `lib/host.mjs` 的算法）：`FOX_WIDGET_DATA_DIR` || `CODEBUDDY_PLUGIN_DATA` || `~/.workbuddy/plugins/data/fox-widget-fox-local`。浮层是独立 Electron 进程、不引 ESM 的 `lib/`，所以只能复制一份 |
| 调试日志位置 | `~/.zcode/whale/overlay-debug.log` → `<插件数据目录>/overlay-debug.log`（并补 `mkdirSync`） |
| 主题观测文件 | → `<插件数据目录>/host-theme-observed.json`；`/whale/host-theme.json` 读它 |
| 窗口标题 | `ZCode狐娘小挂件` → `WorkBuddy狐娘小挂件` |
| 宿主标识符 | `zcodePid`/`zcodePidStart` → `hostPid`/`hostPidStart`；`noteZCodeIdentity` → `noteHostIdentity`；`applyZCodeBounds` → `applyHostBounds`；日志标签 `zcode-*` → `host-*` |
| **ui-ready 门控移除** | 删除 `refreshUiReady()`、`ensureUiReadyPoll()`、`uiReady`/`uiReadyPoll` 状态、`require('./ui-ready.cjs')`，以及 `applyHostBounds` 里那段「宿主还在加载就隐身」的分支 |

**为什么移除 ui-ready 门控**（`MIGRATION-PLAN §Phase 3.1` 的决策，此处落实）：
ZCode 版靠解析客户端日志里的启动标记（`[startup] 创建主窗口` / `database-startup ready`）
配 pid 归属来做「主界面就绪」判定。WorkBuddy 的启动标记与日志格式不同、**未实测到可用锚点**，
而这个门控的失效方向很差——标记改名或日志缺失会变成「鲸鱼**永远不出现**」，
比「加载动画期间早出现一会儿」严重得多。加载期的浮层只是跟着窗口矩形，默认鼠标穿透、
不吃点击，代价很小。所以宁可在加载期早出现，也不冒永不出现的风险。

**保留的东西**：进程身份跟踪（`noteHostIdentity`）——换宿主进程时立刻交还鼠标并隐身。
这条与门控无关，解决的是「更新程序无法关闭宿主」那个形态（ZCode 侧 issue #2 真机 A/B 实锤）。

### `desktop/follow-window.ps1`

- 默认目标进程 `'ZCode'` → `'WorkBuddy'`（第 61 行；仍支持 `$env:WHALE_TARGET_PROCESS` 覆盖）。
- 文件内 31 处 `ZCode` 字样（全在注释里）一并替换为 `WorkBuddy`；替换后校验：
  **non-ASCII chars = 0**，仍旧纯 ASCII。
- **判定逻辑完全没动**：`Process.GetProcessesByName($targetProcess)` 之后取「面积最大的可见窗口」，
  与宿主品牌无关——这正是它能直接复用到 WorkBuddy 的原因。

### `desktop/ui-ready.cjs`

**删除**。原文件是 ZCode 专属的日志解析器（启动标记正则与 ZCode 3.14.4 日志逐字对齐），
在 WorkBuddy 上无意义。

### `desktop/package.json`

`name` / `description` / `version` 更新（不影响行为，只是元信息）。

## 不要动的清单（逐条核对）

来自 `HANDOFF-WORKBUDDY.md` §10，本阶段全部遵守：

| 项 | 状态 |
|---|---|
| `desktop/main.cjs` 的 `type: 'toolbar'` | ✅ 未动。它让浮层常驻 `WS_EX_TOOLWINDOW`、不进宿主 Chromium 的遮挡判定；删掉会复发「点角色后宿主停帧」。WorkBuddy 同为 Electron，同源风险存在 |
| 浮层全程铺满工作区、**不 `setBounds`** | ✅ 未动 |
| 隐身靠 `setOpacity(0)` 而非 `hide()` | ✅ 未动 |
| `focusable: false` 不抢前台 | ✅ 未动 |
| `follow-window.ps1` 纯 ASCII | ✅ 已复验 |
| 菜单/面板控件 hover 只用 `background-color` | ✅ 未动 |
| `GetLayeredWindowAttributes` 返回 `flags=0`，不能用 alpha 判可见性 | ✅ 未动 |

## 真机验收的注意事项（**重要，别踩**）

1. **浮层真机重启必须在 WorkBuddy 客户端环境里做**。在 agent shell 里 `window start` 会失败或
   留下坏窗口：实测 Electron 的 GPU 子进程在 agent shell 里必崩（`0xC0000005`），
   且 `ELECTRON_RUN_AS_NODE` 会污染子进程。必要时的实验姿态：`--no-sandbox --disable-gpu` +
   `env -u ELECTRON_RUN_AS_NODE`。
2. **本次移植没有在 agent shell 里尝试启动浮层**（遵守上述纪律），也**没有**触碰本机正在运行的
   ZCode 版挂件服务（31321 端口上的进程原样保留）。
3. 验收清单（Phase 5 的人工验收表）：跟随移动/最小化、点击不打断前台、穿透正常、
   桌面无双角色（同时装 ZCode 版与 WorkBuddy 版时）。

## 遗留项

1. 宿主主窗口的实际识别：本机安装目录 `E:\WorkBuddy\WorkBuddyAI`，可执行名 `WorkBuddy.exe`；
   `follow-window.ps1` 只按进程名 + 窗口面积，不依赖标题，理论上可直接用——**待真机确认**。
2. 浮层跟随间隔、DPI、多显示器等行为继承 ZCode 版结论，未在 WorkBuddy 上重测。
3. 若宿主主窗口的进程名带后缀（如 `WorkBuddy Helper`），`GetProcessesByName('WorkBuddy')`
   仍能命中主进程；若不符，用 `WHALE_TARGET_PROCESS` 覆盖即可（已留开关）。
