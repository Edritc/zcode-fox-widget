// 拉起挂件服务 + 浮层的共用逻辑。
//
// 调用方有两个：
//   · autostart.mjs —— ZCode SessionStart 钩子（会话启动/恢复时）
//   · zcode-watch.mjs —— 登录后常驻的看门进程（ZCode 进程一出现就拉起）
//
// 这里只做「幂等启动 + 预算控制」，不写日志、不输出 stdout；调用方自己记录。

import { readPluginConfig } from './credentials.mjs'
import { ensureServer } from './service.mjs'
import { isRuntimeInstalled, startOverlay } from './overlay.mjs'
import { dockOnline, ensureDock } from './dock-shim.mjs'

// 与 hooks/hooks.json 的 20s 超时对齐：服务 5s + 浮层 3s 等旧实例 + 观察窗口。
export const HOOK_BUDGET_MS = 15000

export async function ensureWidgetStarted(opts = {}) {
  const startedAt = Number(opts.startedAt) || Date.now()
  const cfg = opts.cfg || readPluginConfig()
  if (!cfg.autoStartWidget) {
    return { skipped: 'autoStartWidget=false', server: 'skipped', overlay: 'skipped', dock: 'skipped', elapsed: 0 }
  }

  // dock 在线时旧挂件让出浮层（避免两只角色），但服务仍可拉起给 MCP/老页面用。
  const dock = await dockOnline({ timeoutMs: Number(opts.dockTimeoutMs) || 80 })
  let dockNote = dock ? 'online' : ''
  let dockHandled = !!dock
  if (!dock && opts.ensureDock !== false) {
    const r = ensureDock()
    dockNote = r.ok ? 'ensuring' : 'skip:' + r.reason
    dockHandled = r.ok
  }

  const svc = await ensureServer({ waitReadyMs: Number(opts.waitReadyMs) || 5000 })
  let overlayNote = 'skipped'
  if (svc.running && cfg.autoStartOverlay) {
    if (dockHandled) {
      overlayNote = 'skipped:dock-online'
    } else if (!isRuntimeInstalled()) {
      overlayNote = 'skipped:no-runtime'
    } else if (Date.now() - startedAt > HOOK_BUDGET_MS) {
      overlayNote = 'skipped:budget'
    } else {
      // 复用上面那次 ensureServer 的结果：startOverlay 内部再跑一遍会把最坏
      // 耗时推到 15.8s（超出钩子超时）
      const r = await startOverlay({ svc })
      overlayNote = r.running ? (r.started ? 'started' : 'reused') : 'failed:' + (r.error || 'unknown')
    }
  }

  return {
    server: svc.running ? (svc.started ? 'started' : 'reused') : 'failed:' + (svc.error || 'unknown'),
    overlay: overlayNote,
    dock: dockNote || 'offline',
    elapsed: Date.now() - startedAt,
  }
}
