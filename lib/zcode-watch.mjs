#!/usr/bin/env node
// 登录后常驻的轻量看门进程：ZCode.exe 一出现就拉起挂件服务/浮层。
//
// 为什么不是钩子：ZCode 只有 SessionStart 等 7 个事件，没有 AppStart；
// 用户不选会话时钩子不触发，挂件就等到第一次对话才出现。
//
// 启动方式：lib/watch-install.mjs 在 Startup 文件夹写一个隐藏 VBS，登录时跑
// `node lib/zcode-watch.mjs --daemon`。它只做进程探测（tasklist），发现状态
// 从「没有 ZCode」变成「有 ZCode」时调用一次 boot-widget 的幂等启动。
//
// 使用：
//   node lib/zcode-watch.mjs --daemon     常驻（VBS 用）
//   node lib/zcode-watch.mjs --once       检测一次并启动（测试/排障）
//   node lib/zcode-watch.mjs --status     查看看门进程与 Startup 项
//   node lib/zcode-watch.mjs --install    安装 Startup 项并启动看门进程
//   node lib/zcode-watch.mjs --uninstall  移除
//   node lib/zcode-watch.mjs --stop       只停看门进程

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// 先读回 ZCode 启动时保存的目录环境（登录环境通常没有 ZCODE_DATA_BASE_DIR）。
// 必须在动态 import 业务模块之前做：paths.mjs 在 import 时就定了 DATA_DIR。
function applyRuntimeEnv() {
  const home = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode')
  const file = path.join(home, 'whale', 'runtime-env.json')
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const key of ['ZCODE_HOME', 'ZCODE_DATA_BASE_DIR']) {
      const v = typeof j[key] === 'string' ? j[key].trim() : ''
      if (v && !process.env[key]) process.env[key] = v
    }
  } catch (err) {}
}
applyRuntimeEnv()

const HOME = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode')
const DATA_DIR = path.join(HOME, 'whale')
const LOCK_FILE = path.join(DATA_DIR, 'zcode-watch.lock')
const LOG_FILE = path.join(DATA_DIR, 'zcode-watch.log')
const LOG_KEEP = 200
const INTERVAL_MS = 3000

const { ensureWidgetStarted } = await import('./boot-widget.mjs')
const { readPluginConfig } = await import('./credentials.mjs')
const { installWatch, startWatcher, stopWatcher, uninstallWatch, watchStatus, persistRuntimeEnv } = await import('./watch-install.mjs')

function log(text) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + text + '\n', 'utf8')
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean)
    if (lines.length > LOG_KEEP) fs.writeFileSync(LOG_FILE, lines.slice(-LOG_KEEP).join('\n') + '\n', 'utf8')
  } catch (err) {}
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

function readLock() {
  try {
    const j = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))
    return j && Number.isInteger(j.pid) ? j : null
  } catch (err) {
    return null
  }
}

function acquireLock() {
  const cur = readLock()
  if (cur && cur.pid !== process.pid && pidAlive(cur.pid)) return false
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }))
    return true
  } catch (err) {
    return false
  }
}

function releaseLock() {
  const cur = readLock()
  if (cur && cur.pid === process.pid) {
    try {
      fs.unlinkSync(LOCK_FILE)
    } catch (err) {}
  }
}

export function parseTasklistOutput(text) {
  return /\bzcode\.exe\b/i.test(String(text || ''))
}

export async function isZCodeRunning(opts = {}) {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq ZCode.exe', '/NH'], {
        windowsHide: true,
        timeout: 3000,
        maxBuffer: 64 * 1024,
      })
      return parseTasklistOutput(stdout)
    } catch (err) {
      return false
    }
  }
  try {
    const { stdout } = await execFileAsync('pgrep', ['-x', 'ZCode'], { timeout: 2000 })
    return String(stdout || '').trim().length > 0
  } catch (err) {
    return false
  }
}

async function runOnce() {
  const running = await isZCodeRunning()
  if (!running) {
    log('probe zcode=absent')
    return { ok: true, zcodeRunning: false, started: false }
  }
  const cfg = readPluginConfig()
  if (!cfg.autoStartWithZcode) {
    log('skip autoStartWithZcode=false')
    return { ok: true, zcodeRunning: true, skipped: 'autoStartWithZcode=false' }
  }
  const startedAt = Date.now()
  const r = await ensureWidgetStarted({ cfg, startedAt, source: 'zcode-watch' })
  log(
    'zcode=present server=' + r.server +
      ' overlay=' + r.overlay +
      ' dock=' + r.dock +
      ' elapsed=' + (Date.now() - startedAt) + 'ms'
  )
  return { ok: true, zcodeRunning: true, ...r }
}

async function daemon() {
  if (!acquireLock()) {
    return 0
  }
  log('watch start pid=' + process.pid)
  const stop = (signal) => {
    log('watch stop ' + signal)
    releaseLock()
    process.exit(0)
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('exit', releaseLock)

  let last = null
  for (;;) {
    const running = await isZCodeRunning()
    if (running && last !== true) {
      await runOnce()
    } else if (!running && last === true) {
      log('zcode=absent (process exit); keep service running')
    }
    last = running
    await new Promise((r) => setTimeout(r, INTERVAL_MS))
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--install')) {
    persistRuntimeEnv()
    const w = installWatch()
    const s = startWatcher()
    console.log(JSON.stringify({ install: w, watcher: s, status: watchStatus() }, null, 2))
    return 0
  }
  if (args.includes('--uninstall')) {
    console.log(JSON.stringify(uninstallWatch(), null, 2))
    return 0
  }
  if (args.includes('--stop')) {
    console.log(JSON.stringify(stopWatcher(), null, 2))
    return 0
  }
  if (args.includes('--status')) {
    console.log(JSON.stringify({ ...watchStatus(), zcodeRunning: await isZCodeRunning() }, null, 2))
    return 0
  }
  if (args.includes('--once') || args.includes('--dry-run')) {
    if (args.includes('--dry-run')) {
      console.log(JSON.stringify({ zcodeRunning: await isZCodeRunning() }, null, 2))
      return 0
    }
    console.log(JSON.stringify(await runOnce(), null, 2))
    return 0
  }
  return daemon()
}

function isEntry() {
  try {
    return process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
  } catch (err) {
    return false
  }
}

// 被 selftest/CLI import 时只导出函数，不启动看门循环。
if (isEntry()) {
  const code = await main()
  if (typeof code === 'number') process.exit(code)
}
