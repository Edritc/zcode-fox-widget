// GLM Plan（ZCode 套餐）剩余配额 —— **WorkBuddy 分支已冻结（砍掉）**。
//
// 决策记录（MIGRATION-PLAN-WORKBUDDY §4.2 / Phase 2.7）：
//   ZCode 侧这个功能的唯一数据源是 **ZCode 客户端自己的日志**（主进程 usage-stats
//   每次刷新套餐余额会把完整 payload 明文写进 ZCode 客户端数据目录的
//   `v2/logs/<date>.log`，
//   挂件尾随解析，做到「零密钥」）。WorkBuddy 没有对应物：
//     - 它的计费模型是订阅积分（宿主按 request 记 credit，见 lib/turn-cost.mjs），
//       没有「GLM Plan 套餐剩余配额」这种账号级接口；
//     - 也没有可尾随的同类客户端日志（本机实测：~/.workbuddy/logs 下无 billing
//       balance payload，见 docs/porting/phase-0.md）。
//   所以 ZCode 分支的「Plan 配额」主显示在 WorkBuddy 侧不存在替代品，
//   按规划「先冻结后决策」处理：保留导出接口（server/cli/mcp 不必改），
//   恒返回「宿主不支持」，界面不再出现该模块。
//
// 若将来 WorkBuddy 开放订阅额度接口，「订阅额度」可以以本文件的形态重生：
// 换掉数据源，保留 readPlanBalance() / turnPlanUsage() 两个出口即可。

// 恒为「宿主无此项」：调用方（server.mjs 的 /whale/plan.json、cli、mcp）按 ok=false 处理。
export function readPlanBalance() {
  return {
    ok: false,
    reason: 'not-supported-on-workbuddy',
    hint: 'WorkBuddy 是订阅积分制，由宿主按 request 记账（见 /whale/last-turn.json 的 credit）；无 GLM Plan 套餐配额日志可读。',
  }
}

// 轮级套餐口径：WorkBuddy 不存在「套餐扣费轮」，恒返回 null——
// 调用方（server.mjs 的 pollTurnCost、cli 的 cmdTurn）见到 null 就走普通积分口径。
export function turnPlanUsage() {
  return null
}
