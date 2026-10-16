# Phase 0 探路验证：WorkBuddy 宿主契约

> 写给接手移植/维护的 AI。作者：WorkBuddy 侧移植会话（2026-10-14）。
> **时效声明：截至 2026-10-14 实测于 WorkBuddy 5.8.2（本机 Windows）**。宿主升级后
> 需重跑本文的验证项；结论过时以更新者为准，改写而非叠加。
> 本文只记「探路」这一阶段；施工记录见 `phase-1.md` / `phase-2.md` / `phase-3.md` / `phase-5.md`。
> 来源分级：【实测】= 本机翻过文件/跑过命令确认；【源码】= 直接读 `app.asar` 里的宿主实现；
> 【文档】= 取自宿主自带 `plugin-dev` 技能文档；【未验证】= 推断或待实测。

## 0. 结论速览

| # | 验证项 | 结论 | 依据 |
|---|---|---|---|
| 0.1 | 插件能装上 | **可以**；市场清单放 `<市场根>/.codebuddy-plugin/marketplace.json` | 【实测】内置/官方市场全部如此 |
| 0.2 | `source: "./"`（仓库根即插件）是否合法 | **合法**（不必做子目录重构） | 【源码】宿主的 `isPathInside` 允许相等 |
| 0.3 | 出站是否被沙箱拦 | **不拦**（shell 与 node 子进程都能出网） | 【实测】`curl`/`fetch` 均返回 401/200 |
| 0.4 | 变量展开 + node 可用 | 两个变量都会展开并注入环境；node v22.22.2（`node:sqlite` 可用） | 【源码】+【实测】 |
| 0.5 | 钩子写法 | 只有 `command`/`prompt`；`timeout` 单位是秒；`node` 可直接用 | 【源码】+【文档】+【实测】内置插件 |
| 0.6 | 数据源（更重要的发现） | `workbuddy.db` 的 `session_usage` + transcript 的 `rawUsage`，**积分由宿主算好** | 【实测】 |

**没有一项不通，Phase 1 及之后可以照常施工。**

## 1. 插件装得上吗（0.1）

【实测】本机 `~/.workbuddy/plugins/known_marketplaces.json` 支持 `type: "directory"` +
`source.path` 指向本地目录，与 ZCode 的 directory 市场同构。参考三个已装市场：

- `workbuddy-builtin`（宿主自带）
- `workbuddy-connector-plugins-official`
- `codebuddy-plugins-official`

三者的市场清单都在 `<市场根>/.codebuddy-plugin/marketplace.json`，结构：

```json
{
  "name": "<市场名>",
  "description": "...",
  "owner": { "name": "..." },
  "metadata": { "version": "1.0.0" },
  "plugins": [
    { "name": "<插件>", "version": "x.y.z", "source": "./<子目录>", "category": "..." }
  ]
}
```

安装注册表 `~/.workbuddy/plugins/installed_plugins.json` →
`plugins["<插件名>@<市场名>"] = [{scope, installPath, version, installedAt}]`；
`installPath` 指向 `~/.workbuddy/plugins/cache/<市场>/<插件>/<版本>/`。
启用开关在 `~/.workbuddy/settings.json` 的 `enabledPlugins["<插件名>@<市场名>"] = true`。

## 2. `source: "./"` 合法性（0.2）——**本次移植最省事的一条结论**

【源码】宿主 `app.asar` 里的本地插件安装器：

```js
resolvePluginPath(e, n, r) {
  let i = resolveContainedPathAllowingRoot(r, n)                 // r = 市场根, n = source
  return await pathExists(i) || ((i = resolveContainedPathAllowingRoot(r, join(n, e))), await pathExists(i))
    ? i : resolveContainedPathAllowingRoot(r, n)
}
function resolveContainedPathAllowingRoot(e, ...n) { return resolvePathUnderRoot(e, n, true) }
```

以及判定函数（注意第一个分支）：

```js
isPathInside(e, t) {
  let n = u.relative(u.resolve(t), u.resolve(e))
  return n === '' || (!n.startsWith('..' + u.sep) && n !== '..' && !u.isAbsolute(n))
}
```

`n === ''` 即「两个路径相等」，返回 **true**；函数名里的 `AllowingRoot` 也直说了
「允许落在根上」。所以 `"source": "./"` 解析到市场根本身是合法的。

**决策**：保持「仓库根即插件」布局（`marketplace.json` 的 `source: "./"`），
**不做** `plugins/fox-widget/` 子目录重构——省掉一次全仓 `git mv`，也让
`git merge main` 的冲突面小得多。

【未验证】没有在客户端 UI 上真机点过「安装」；本结论只到「路径解析不会因为
`./` 而被拒」这一层。若真机安装报错，回落方案是单 commit 的 `git mv` 子目录重构。

## 3. 出站会不会被沙箱拦（0.3）

【实测】`~/.workbuddy/settings.json` 里确实有：

```json
"sandbox": { "networkDenyAllMigrated": true, "orderedRules": { "network": { "rules": [] } } }
```

**但实测出站是通的**：

```bash
curl -s -o /dev/null -w '%{http_code}' https://api.deepseek.com/user/balance   # → 401（可达，只是没带 key）
curl -s -o /dev/null -w '%{http_code}' https://api.github.com                  # → 200
# 用挂件同款运行时再测一次（模拟 MCP/钩子子进程）
node -e "fetch('https://api.deepseek.com/user/balance').then(r=>console.log(r.status))"  # → 401
```

**结论**：`networkDenyAllMigrated: true` 没有拦住 agent shell 与 node 子进程的出站。
余额 / 厂商卡 / 更新链路在**本机**可用；但仍按「可能被拦」设计降级路径——
读不到出站数据时如实标注「来源缺失」，绝不静默造假数据。

## 4. 变量展开与 node（0.4）

【源码】宿主 MCP 配置解析：

```js
function resolvePluginConfig(e, n, r) {
  let i = { CODEBUDDY_PLUGIN_ROOT: n, CODEBUDDY_PLUGIN_DATA: r }
  const command = substituteVariables(e.command, i)
  const args = (e.args ?? []).map(x => substituteVariables(x, i))
  const cwdRaw = e.cwd ? substituteVariables(e.cwd, i) : n   // ← 默认 cwd = 插件根
  const cwd = F.resolve(cwdRaw)
  if (!isPathInside$4(n, cwd)) return                        // ← 指定 cwd 时必须落在插件目录内
  return { ...e, command, args, cwd, env: { ...userEnv, CODEBUDDY_PLUGIN_ROOT: n, CODEBUDDY_PLUGIN_DATA: r } }
}
function substituteVariables(s, vars) {
  // 同时支持 ${VAR} 与 $VAR 两种写法
}
```

要点：
- `${CODEBUDDY_PLUGIN_ROOT}` / `${CODEBUDDY_PLUGIN_DATA}` 都会展开，并作为环境变量注入子进程。
- **不写 `cwd` 时默认就是插件根**——本插件因此不写 `cwd`，少一个出错面。
- `${CODEBUDDY_PROJECT_DIR}` 也可用（见宿主 `projectStdio`）。

【实测】宿主自带 node：`~/.workbuddy/binaries/node/versions/22.22.2-6/node.exe` = **v22.22.2**
（`node:sqlite` 需要 ≥ 22.5，满足）。钩子里的 `node` 可直接用——内置插件
`subscription-gate` 的 hook 就是 `node "${CODEBUDDY_PLUGIN_ROOT}/dist/gate.mjs"`。

## 5. 钩子写法（0.5）

【实测】内置插件 `subscription-gate` 的 `hooks/hooks.json`（权威样板）：

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Skill",
        "hooks": [{ "type": "command", "command": "node \"${CODEBUDDY_PLUGIN_ROOT}/dist/gate.mjs\" skill ...", "timeout": 30 }] }
    ],
    "UserPromptExpansion": [ { "hooks": [ { "type": "command", "command": "..." } ] } ],
    "UserPromptSubmit":    [ { "hooks": [ { "type": "command", "command": "..." } ] } ]
  }
}
```

差异清单（相对 ZCode）：
1. **只有 `command` / `prompt` 两种钩子类型**；ZCode 的 `{"type":"process","command":"node","args":[...]}` 不认。
2. `command` 是 **bash 字符串**；`timeout` 单位是**秒**（不是 `timeoutMs`）。
3. 事件表有 10 个：PreToolUse / PostToolUse / Stop / SubagentStop / SessionStart /
   SessionEnd / UserPromptSubmit / UserPromptExpansion / PreCompact / Notification。
   **没有 `PermissionRequest`** → 「等确认提醒」改挂 `Notification`（已知过度触发）。
4. stdin 契约公共字段：`session_id` / `transcript_path` / `cwd` / `permission_mode` /
   `hook_event_name`（与 ZCode 同名，**兼容**，`hook-event.mjs` 不必改字段名）。
5. `matcher` 可省略（内置插件对 `UserPromptSubmit` 就没写）。

`hooks/hooks.json` 采用 `{description, hooks:{...}}` 外层包装（插件格式），
与宿主文档一致。

## 6. 数据源（0.6）——比 ZCode 更好

【实测】`~/.workbuddy/workbuddy.db`（**带 WAL：测试一律先 copy 再读**）里有两张关键表：

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, cwd TEXT NOT NULL, user_id TEXT NOT NULL,
  title TEXT, custom_title TEXT, status TEXT NOT NULL DEFAULT 'Pending',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_activity_at INTEGER,
  deleted_at INTEGER, is_playground INTEGER NOT NULL DEFAULT 0, source_mode TEXT,
  is_background_automation INTEGER, mode TEXT, model TEXT, ... , context_window INTEGER, ...
);
CREATE TABLE session_usage (
  session_id TEXT PRIMARY KEY, used INTEGER NOT NULL, size INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, credit_json TEXT
);
```

样例（本机真实值）：

```
session_id = 12968ef3-…  used = 83282   size = 1000000  updated_at = 1791948173814
credit_json = {"01a1386e9212723d9280270ba883bfa9": 2.6999999999999997}
sessions.model 实测值：deepseek-v4.1-flash / glm-5.3 / step-5-preview / hy4-preview
```

- **`credit_json` 是宿主算好的积分**（key = conversationRequestId）——移植要求「优先直接用
  宿主算好的 credit」，这里正好有。
- **注意它是「按请求覆盖」的**：一个会话只留最后一笔。做「今日合计」不能靠它，
  必须扫 transcript（`lib/usage-records.mjs` 就是这么做的）。
- `used` / `size` 直接给出上下文占用 → 顺手做出 ZCode 侧没有的「上下文 xx%」。

transcript 在 `~/.workbuddy/projects/<cwd 的 slug>/<sessionId>.jsonl`，
每次模型调用一条，`providerData.rawUsage` 实测结构：

```json
{"prompt_tokens":33184,"completion_tokens":50,"total_tokens":33234,
 "completion_tokens_details":{"reasoning_tokens":9,"cached_tokens":0},
 "prompt_tokens_details":{"cached_tokens":13952},
 "prompt_cache_hit_tokens":13952,"prompt_cache_miss_tokens":19232,
 "cache_read_input_tokens":0,"cache_creation_input_tokens":0,"prompt_cache_write_tokens":0,
 "completion_thinking_tokens":9,"credit":3.66,"cached_tokens":0}
```

**口径要点（金额虚高陷阱的 WorkBuddy 版）**：
- `prompt_tokens` **含**缓存命中（`33184 = 13952 + 19232` ✔），所以 `input_tokens` 传总量、
  `cache_read_input_tokens` 传 `prompt_cache_hit_tokens`，交给 `splitInputTokens()` 去减——别自己减也别不减。
- `completion_tokens` **含**思考（`10056` 里 `completion_thinking_tokens = 9704`），
  映射时 `output_tokens = completion − thinking`，思考单列，否则重复计价。
- `conversationRequestId` 同时出现在用户消息与模型调用上，是**天然的「轮」主键**。
- `requestModelId` / `requestModelName` 给当前模型与展示名。

其他数据源：
- **主题**：【实测】`~/.workbuddy/storage/user-<uid>-personal/global/preferences.json` →
  `{"theme":"light","appearance.themeSelection":{...}}`。uid 因账号而异，按目录扫而不是写死。
- **凭据**：【实测】**找不到**用户自带厂商 key 的存储——`settings.json` 的 `pluginConfigs`
  为空对象、`models.json` 为 `[]`。这是**预期**（模型由宿主托管）。所以厂商卡默认
  「无凭据」，主口径走积分。
- **模型列表**（`cache/acc-product-config-v3.json` 实测）：`fast-model` / `balanced-model` /
  `deep-model` / `hy4-preview` / `hy3` / `hy3-x` / `step-5-preview` / `space-bunny` /
  `deepseek-v4.1-flash` / `glm-5.3`(+flash/flashx) / `glm-5.2` / `glm-5.1` / `glm-5v-turbo` /
  `minimax-m3-pay` / `kimi-k3-2` / `kimi-k2.8-preview` / `kimi-k2.7` / `kimi-k2.6` /
  `deepseek-v4-pro` / `builtin-lite`。其中 `glm*` / `deepseek*` / `kimi*` 有内置角色，
  `hy*`（混元）与 `step*`（阶跃）**没有立绘 → 按模型换角色时有意不动**。

## 7. 没能验证 / 留待后续

| 项 | 状态 | 说明 |
|---|---|---|
| 真机安装（客户端 UI 点安装） | 【未验证】 | 只验证到「路径解析合法」；需要在客户端里实际注册目录市场并安装 |
| 钩子真的被触发 | 【未验证·待真机】 | 已把证据链做进代码：`autostart.log`（SessionStart 一跑就写）+ `hook-state.json` 的 `ts` + `FOX_WIDGET_HOOK_DEBUG=1` 时的 `hook.log`。**真机首次运行务必看这三处** |
| `Notification` 是否只在「等确认」时发 | 【未验证】 | 已把原始文本记进 `hook-state.json` 的 `notification` 字段便于核实；提醒默认关闭 |
| 浮层跟随 WorkBuddy 主窗口 | 【未验证·待真机】 | 跟随脚本改指向 `WorkBuddy` 进程；`follow-window.ps1` 的判定是「取面积最大的可见窗口」，与宿主无关，理论可直接用 |
| 宿主的窗口标题 / 主窗口识别 | 【未验证】 | 已知安装目录 `E:\WorkBuddy\WorkBuddyAI`、可执行名 `WorkBuddy.exe`；主窗口标题未实测（跟随脚本不依赖标题，只按进程 + 面积） |
| macOS / Linux | 不适用 | 浮层依赖 Win32；非 Windows 只有浏览器形态（继承 ZCode 版） |

## 8. 可复现命令（本文结论的最小验证）

```bash
# 0.2 source:"./" 合法性：读宿主实现
grep -a -o -m1 "function resolveContainedPathAllowingRoot.\{0,300\}" \
  "E:/WorkBuddy/WorkBuddyAI/resources/app.asar"

# 0.3 出站
curl -s -o /dev/null -w '%{http_code}\n' https://api.deepseek.com/user/balance   # 401 = 可达
"~/.workbuddy/binaries/node/versions/22.22.2-6/node.exe" -e \
  "fetch('https://api.deepseek.com/user/balance').then(r=>console.log(r.status))"

# 0.4 node 版本
"~/.workbuddy/binaries/node/versions/22.22.2-6/node.exe" -v          # v22.22.2

# 0.6 数据源（**先 copy 再读**，别直接开用户的 WAL 库）
cp ~/.workbuddy/workbuddy.db* /tmp/wbprobe/ && node -e "…"                        # 见表结构
```

## 9. 对后续阶段的直接影响

1. **Phase 1 无需子目录重构**（0.2）→ 直接把清单换成 `.codebuddy-plugin/` 那两件套。
2. **主口径改为积分**（0.6）→ 余额从「头号卖点」降为可选厂商卡；新增「上下文余量」。
3. **`PermissionRequest` 缺席**（0.5）→ 等确认提醒换 `Notification`，默认关闭 + 记原始文本待核实。
4. **ui-ready 门控整体移除**（宿主启动标记未实测，且失效方向是「永不出现」）。
5. **自更新默认关闭**（与宿主插件管理打架，见 `phase-5.md`）。
