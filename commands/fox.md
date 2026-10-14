---
description: 查看 WorkBuddy 订阅积分消耗（今日积分 / 本轮 credit / 上下文余量）与可选厂商余额，或启停 WorkBuddy狐娘小挂件（网页版 / 桌面浮层）
argument-hint: "[status|credits|turn|start|stop|url|window start|window stop|key <sk-...>|mode ledger|token]"
allowed-tools: Bash, mcp__plugin_fox-widget_whale__whale_credits, mcp__plugin_fox-widget_whale__whale_balance, mcp__plugin_fox-widget_whale__whale_widget, mcp__plugin_fox-widget_whale__whale_last_turn, mcp__plugin_fox-widget_whale__whale_config
---

用户请求操作 WorkBuddy狐娘小挂件（fox-widget）。参数：`$ARGUMENTS`

按参数分派：

- 空 / `status` / `credits`：调用 MCP 工具 `whale_credits`，用中文报告**今日积分、当前会话上下文余量、上一轮消耗的 credit**；再调用 `whale_widget`（`action=status`）报告挂件服务是否在运行、地址是什么。
- `start`：调用 `whale_widget`（`action=start`），把返回的地址告诉用户，并提示用浏览器打开即可看到大肥鱼。
- `stop`：调用 `whale_widget`（`action=stop`）。
- `url`：调用 `whale_widget`（`action=url`），只回地址。
- `turn`：调用 `whale_last_turn`，报告上一轮消耗的**积分**（宿主 credit 口径）、模型、处理 token 数与调用次数；如有等价金额一并说明「那是按公开价目折算的参考值，不是真实扣费」。
- `window start`：调用 `whale_widget`（`action=overlay_start`），把鲸鱼作为**桌面浮层**显示在 WorkBuddy 界面之上（透明置顶、默认鼠标穿透，不挡操作）。若返回「需要运行 Electron 运行时」，就让用户在终端执行 `node "${CODEBUDDY_PLUGIN_ROOT}/lib/cli.mjs" desktop install`（一次性，约 150MB）后重试。
- `window stop`：调用 `whale_widget`（`action=overlay_stop`）。
- `window status`：调用 `whale_widget`（`action=overlay_status`）。
- `balance`：调用 `whale_balance`——**注意这是可选的厂商卡**：WorkBuddy 是订阅积分制，模型由宿主托管，默认没有用户自带的厂商 key，因此通常返回「未配置凭据」。要向用户解释清楚这一点，并给出配置方式（环境变量 `DEEPSEEK_API_KEY` 或 `whale_config` 的 set）。
- `key <sk-...>`：调用 `whale_config`（`action=set`，`apiKey=<值>`）写入第三方厂商 API Key（可选功能）。
- `mode ledger|token`：调用 `whale_config`（`action=set`，`usageMode=...`）切换对账口径（大肥鱼记账 / 实时·令牌）。

若 MCP 工具不可用（例如插件刚装好还没重启会话），退回命令行：

```bash
node "${CODEBUDDY_PLUGIN_ROOT}/lib/cli.mjs" status          # 或 turn / start / stop / url / json
node "${CODEBUDDY_PLUGIN_ROOT}/lib/cli.mjs" window start    # 桌面浮层（浮在 WorkBuddy 上）
node "${CODEBUDDY_PLUGIN_ROOT}/lib/cli.mjs" desktop install # 首次使用浮层前安装 Electron 运行时
```

输出要求：中文，先给结论（今日积分多少、上下文余量多少、是否正常），再补充上一轮消耗与数据来源。**不要**把「余额」当成主口径——WorkBuddy 的主口径是订阅积分；余额只有在用户自己配了厂商 key 时才有数据，读不到时明确说明「这是可选项、未配置」，并给出可执行的配置动作，不要只贴原始错误。用户问「为什么界面上看不到」时，说明 WorkBuddy 客户端不提供界面注入点，所以用桌面浮层窗口实现，并给出 `window start` 或 `desktop install` 的确切命令。
