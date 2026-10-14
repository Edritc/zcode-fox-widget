// 宿主正在更新时的「让路」判定与探测（issue #2 后半段：更新 ZCode 时提示「无法关闭 ZCode」）。
//
// 背景：ZCode 从 3.15.1 升 3.15.3 时，更新程序提示「无法关闭 ZCode」；把挂件停掉之后就能
// 正常更新（issue 里补充的现场）。我们无法从进程外部确证更新程序究竟在等谁，但可以确认：
//   1) 更新程序（electron-updater 的 installer.exe）在宿主退出前后一直在跑；
//   2) 本机挂件服务是宿主会话启动时派生出来的长命 node 进程，宿主退出后它仍然活着。
// 所以采取最保守的做法——只要确认处在「宿主窗口消失」或「宿主进程已退出」这一段，并且
// 更新程序在跑（或宿主已经退出），就整体让路：交还鼠标、退掉浮层、并让本机挂件服务也退出，
// 使更新流程在没有任何我们的进程参与的情况下走完。
//
// 让路是单向且可恢复的：宿主下次会话启动时 SessionStart 钩子（lib/autostart.mjs）会把服务
// 与浮层重新拉起来。
'use strict'

const fs = require('node:fs')
const path = require('node:path')

// 更新程序目录：%LOCALAPPDATA%\@zcodedesktop-updater（electron-updater 的命名惯例；与
// WorkBuddy 侧的 @genieworkbuddy-desktop-updater 同构）。WHALE_ZCODE_UPDATER_DIR 供测试注入。
function updaterInstallerPath(env) {
  const e = env || process.env
  const override = String(e.WHALE_ZCODE_UPDATER_DIR || '').trim()
  const base = override || (e.LOCALAPPDATA ? path.join(e.LOCALAPPDATA, '@zcodedesktop-updater') : '')
  return base ? path.join(base, 'installer.exe') : ''
}

// 更新程序是否正在运行。**不起子进程**：用「可执行映像被占用」这一事实探测——运行中的 exe
// 被内核以拒绝写入的方式打开，用 r+ 打开会失败（EBUSY / EPERM / EACCES）；打得开就说明没在跑。
// 注意 installer.exe 与它旁边的 pending\ **在更新完成后仍然残留**（实测：更新完一天后
// installer.exe 与 pending\ZCode-x.y.z-win-x64.exe 都还在），所以判据只能是「是否被占用」，
// 不能是「是否存在」。文件不存在（ENOENT / ENOTDIR）一律判「没在跑」。
// WHALE_FAKE_UPDATER=1 供端到端测试强制造真。
function isUpdaterRunning(file, opts) {
  const o = opts || {}
  if (String((o.env || process.env).WHALE_FAKE_UPDATER || '') === '1') return true
  const f = file || updaterInstallerPath(o.env)
  if (!f) return false
  const openSync = o.openSync || fs.openSync
  const closeSync = o.closeSync || fs.closeSync
  let fd = -1
  try {
    fd = openSync(f, 'r+')
    return false // 还能拿到写句柄 = 没有进程在跑它
  } catch (err) {
    const code = String((err && err.code) || '')
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return false
    return true // EBUSY / EPERM / EACCES：被占用 = 正在运行
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd)
      } catch (err) {}
    }
  }
}

// 让路决策（纯函数，便于单测）：
//   'quit-updater'  更新程序在跑 → 立刻让路
//   'quit-hostgone' 宿主进程已经退出 → 立刻让路
//   'wait'          其余情况交给既有的空窗兜底（MISSING_QUIT_MS）
function yieldPlan(state) {
  const s = state || {}
  if (s.updaterRunning) return 'quit-updater'
  if (s.hostGone) return 'quit-hostgone'
  return 'wait'
}

module.exports = { updaterInstallerPath, isUpdaterRunning, yieldPlan }
