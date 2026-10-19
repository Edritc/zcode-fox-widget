// 「ZCode 一启动就拉起挂件」的登录自启装置。
//
// 为什么需要它：ZCode 插件只有 SessionStart 等 7 个钩子，没有 AppStart；
// 用户不选会话时 SessionStart 不触发，挂件就要等到第一次对话才出现。
// 这里在 Windows 启动文件夹放一个隐藏的 VBS，登录后常驻一个很轻的看门进程；
// 它只做一件事：发现 ZCode.exe 出现 → 调 boot-widget 拉起服务/浮层。
//
// 设计边界：
//   · 只写当前用户的 Startup 文件夹，不碰注册表、不需要管理员；
//   · 不存任何密钥；runtime-env.json 只记 ZCODE_HOME / ZCODE_DATA_BASE_DIR；
//   · 看门进程单实例（lock 文件）；配置 autoStartWithZcode=false 时卸载；
//   · 不自动更新：VBS 指向当前插件根的 watch 脚本；插件更新后 SessionStart
//     会重新写入新路径，并把旧实例换掉。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { DATA_DIR, PLUGIN_ROOT } from './paths.mjs'

export function watchScript() {
  return path.join(PLUGIN_ROOT, 'lib', 'zcode-watch.mjs')
}

export function defaultStartupDir(env = process.env) {
  const override = String(env.FOX_WATCH_STARTUP_DIR || '').trim()
  if (override) return override
  if (process.platform !== 'win32') return ''
  const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
}

export function watchVbsFile(startupDir = defaultStartupDir()) {
  if (!startupDir) return ''
  return path.join(startupDir, 'zcode-fox-widget-watch.vbs')
}

export function watchLockFile() {
  return path.join(DATA_DIR, 'zcode-watch.lock')
}

export function watchLogFile() {
  return path.join(DATA_DIR, 'zcode-watch.log')
}

export function runtimeEnvFile() {
  return path.join(DATA_DIR, 'runtime-env.json')
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

export function readWatchLock() {
  try {
    const j = JSON.parse(fs.readFileSync(watchLockFile(), 'utf8'))
    return j && Number.isInteger(j.pid) && j.pid > 0 ? j : null
  } catch (err) {
    return null
  }
}

export function isWatcherRunning() {
  const lock = readWatchLock()
  return !!(lock && isPidAlive(lock.pid))
}

function vbsQuote(s) {
  return '"' + String(s).replace(/"/g, '""') + '"'
}

export function buildWatchVbs(nodeExe = process.execPath, script = watchScript()) {
  // sh.Run 的第一个参数是整条命令行；外层引号 + 内部引号双写，路径有空格也安全。
  const cmd = vbsQuote(nodeExe) + ' ' + vbsQuote(script) + ' --daemon'
  const runArg = vbsQuote(cmd)
  return 'Set sh = CreateObject("WScript.Shell")\r\nsh.Run ' + runArg + ', 0, False\r\n'
}

export function installWatch(opts = {}) {
  const startupDir = opts.startupDir || defaultStartupDir(opts.env)
  if (!startupDir) return { ok: false, reason: 'unsupported-platform' }
  const file = watchVbsFile(startupDir)
  const content = opts.content || buildWatchVbs(opts.nodeExe || process.execPath, opts.script || watchScript())
  try {
    fs.mkdirSync(startupDir, { recursive: true })
    let old = ''
    try {
      // VBS 用 UTF-16LE + BOM 写（含中文用户名也能被 WScript 正确读取）
      old = fs.readFileSync(file, 'utf16le').replace(/^\uFEFF/, '')
    } catch (err) {}
    const changed = old !== content
    if (changed) fs.writeFileSync(file, '\uFEFF' + content, 'utf16le')
    return { ok: true, file, changed, startupDir }
  } catch (err) {
    return { ok: false, reason: 'write-failed', error: String((err && err.message) || err), file }
  }
}

export function stopWatcher() {
  const lock = readWatchLock()
  if (!lock || !isPidAlive(lock.pid)) {
    try {
      fs.unlinkSync(watchLockFile())
    } catch (err) {}
    return { ok: true, stopped: false }
  }
  try {
    process.kill(lock.pid)
  } catch (err) {}
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (!isPidAlive(lock.pid)) break
    // 同步等一小会：卸载/换路径是低频操作，不需要异步复杂度
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    } catch (err) {
      const until = Date.now() + 50
      while (Date.now() < until) {}
    }
  }
  if (isPidAlive(lock.pid)) {
    try {
      process.kill(lock.pid, 'SIGKILL')
    } catch (err) {}
  }
  try {
    fs.unlinkSync(watchLockFile())
  } catch (err) {}
  return { ok: true, stopped: true, pid: lock.pid }
}

export function startWatcher(opts = {}) {
  if (isWatcherRunning()) return { ok: true, started: false, pid: readWatchLock().pid }
  const script = opts.script || watchScript()
  if (!fs.existsSync(script)) return { ok: false, reason: 'watch-script-missing', script }
  try {
    const child = spawn(opts.nodeExe || process.execPath, [script, '--daemon'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: opts.env || process.env,
    })
    child.unref()
    return { ok: true, started: true, pid: child.pid }
  } catch (err) {
    return { ok: false, reason: 'spawn-failed', error: String((err && err.message) || err) }
  }
}

export function uninstallWatch(opts = {}) {
  const startupDir = opts.startupDir || defaultStartupDir(opts.env)
  const file = watchVbsFile(startupDir)
  const watcher = opts.stopWatcher === false ? { ok: true, stopped: false, skipped: true } : stopWatcher()
  let removed = false
  if (file) {
    try {
      fs.unlinkSync(file)
      removed = true
    } catch (err) {}
  }
  return { ok: true, removed, file, watcher }
}

export function watchStatus(opts = {}) {
  const startupDir = opts.startupDir || defaultStartupDir(opts.env)
  const file = watchVbsFile(startupDir)
  const lock = readWatchLock()
  return {
    supported: process.platform === 'win32',
    startupDir,
    file,
    installed: !!(file && fs.existsSync(file)),
    running: !!(lock && isPidAlive(lock.pid)),
    pid: lock && isPidAlive(lock.pid) ? lock.pid : null,
    script: watchScript(),
  }
}

// 登录环境不会继承 ZCode 启动时的 ZCODE_DATA_BASE_DIR（例如 E:\ZCodeData）。
// 把这两个只影响“找哪个目录”的环境变量落到 whale 目录，看门进程启动时先读回。
export function persistRuntimeEnv(env = process.env) {
  const out = {}
  for (const key of ['ZCODE_HOME', 'ZCODE_DATA_BASE_DIR']) {
    const v = String(env[key] || '').trim()
    if (v) out[key] = v
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(runtimeEnvFile(), JSON.stringify(out, null, 2), { encoding: 'utf8', mode: 0o600 })
    return { ok: true, file: runtimeEnvFile(), keys: Object.keys(out) }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

export function loadRuntimeEnv(env = process.env, file = runtimeEnvFile()) {
  let j = {}
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return { loaded: false, keys: [] }
  }
  const keys = []
  for (const key of ['ZCODE_HOME', 'ZCODE_DATA_BASE_DIR']) {
    if (typeof j[key] === 'string' && j[key].trim() && !env[key]) {
      env[key] = j[key].trim()
      keys.push(key)
    }
  }
  return { loaded: true, keys }
}
