# 火山方舟 URL 路由与显示

基线：`c4ca8ffa9018d0bf41f61b80298b16a318ca5219`。本次是其后的增量修改，不改写原有提交。

## 判定

`providerId → findProviderBaseUrl → resolveBillingSource`。providerId 仅作查找键，不要求厂商关键词。
火山域名家族只提供平台身份；只有已核实的 `https://ark.cn-beijing.volces.com` 加精确路径确认调用类型：

- `/api/v3`：`source=volc-api`、`volcMode=api`。
- `/api/coding`、`/api/coding/v3`：`source=volc`、`volcMode=planType=coding`。
- `/api/plan`、`/api/plan/v3`：`source=volc`、`volcMode=planType=agent`。
- 未知火山路径：`source=volc-api`、`volcMode=unknown`，保留估算，不自动清零。

兼容末尾斜杠与域名大小写；不接受查询参数、片段、userinfo、非默认端口、HTTP、相似路径或未知子域作为套餐证据。模型名、IAM 存在与否、配额返回结果、菜单选择均不参与计费判定。旧声明键不再读取。未知代理没有自动订阅识别。

## 查询与显示

`volc-view.mjs` 根据 provider 的当前配置返回视图。API 模式不请求 IAM 接口；Coding 用 `GetCodingPlanUsage`，个人版 Agent 用 `GetAFPUsage`，含有效的 AFPDaily 窗口。成功空窗口返回 `no-data`，不据此推断未订阅。每个套餐有独立缓存和在途请求，凭据变更使对应缓存失效；强制刷新也合并在途请求。

菜单只有「火山方舟」（沿用 `displayMode=volc`）。自动模式跟随当前接入；固定模式使用当前火山接入，切换到其他厂商时使用最近火山 providerId。只在浏览器本地保存这个 ID，不保存 key、Base URL 或配额数据；重开后重新查当前配置。没有记录、配置已删除或路径未知时显示对应提示，不静默猜套餐。

API 卡显示平台今日按量估算合计。订阅卡一次显示当前接入的一个套餐，不把两个套餐的百分比或重置时间混合。Agent 四窗口使用紧凑样式。异步响应通过请求序号隔离，同 ID 改路径和跨 provider 切换时旧请求均不能覆盖新卡。预警键包含 provider、套餐和窗口。

`vendors.json` 的火山模板保留一个条目，返回 `plans.coding` 与 `plans.agent` 两份独立状态；不再用一个 `windows` 字段代表两个产品。

## 边界

- 当前按 provider 配置重新解释历史用量，未实现按调用时配置快照记账。
- IAM 配额账号与模型 API key 的账号绑定仍由配置者确认，无法从 URL 证明二者相同。
- 配额查询仅覆盖个人版；企业版席位数据需要后续独立支持。
- API 缺少模型价格时只显示 tokens，不把估算称为真实账单。

## 官方依据

- [Coding Plan 接入地址](https://docs.volcengine.com/docs/ark/coding-plan-personal-plan-overview?lang=zh)
- [Agent Plan 接入 ZCode](https://docs.volcengine.com/docs/ark/agent-plan-personal-zcode?lang=zh)
- [个人版 Agent AFP 配额接口](https://docs.volcengine.com/docs/ark/get-afp-usage-api?lang=zh)

## 验证

- 隔离 selftest：清空继承凭据、临时 ZCODE_HOME / ZCODE_DATA_BASE_DIR、preload 拒绝非 loopback 连接；462/462。
- `node tools/test-volc-display.mjs`：执行实际前端函数，覆盖自动/固定选择、API 分流、失败保留套餐、跨 provider 与同 ID 改模式的响应竞态；通过。
- `node tools/smoke-ui.mjs`：当前 Linux 环境无脚本支持的 Edge/Chrome，SKIP；新增单菜单、三模式、四窗口和固定模式浏览器断言尚待 Windows 实跑。
- 不使用真实凭据查询；不把 mock 或 SKIP 记为实机通过。
