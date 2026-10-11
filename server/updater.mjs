// bwoc version check + update runner.
//
// "Check" is read-only: `bwoc update --check` (embedded CalVer vs latest
// release) plus, when a framework checkout is configured, how many commits it
// is behind origin/main — the host's updater is a git-pull + cargo-install
// script, so that is the drift that actually matters.
//
// "Run" executes BWOC_UPDATE_CMD (an operator-supplied command, never request
// input) detached from the request, one at a time, with its output kept in a
// ring buffer for the UI to poll. Unset ⇒ updating from the UI is disabled
// (e.g. in the container, where the binary is not the host's).

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const BWOC = process.env.BWOC_BIN || 'bwoc'
const UPDATE_CMD = process.env.BWOC_UPDATE_CMD || ''
const FRAMEWORK_SRC = process.env.BWOC_FRAMEWORK_SRC || ''
const MAX_LINES = 300

function exec(file, args, { cwd, timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: stdout?.trim() ?? '', stderr: stderr?.trim() ?? '' })
    })
  })
}

let job = null // { running, startedAt, finishedAt, exitCode, lines[] }

export function updateEnabled() {
  return Boolean(UPDATE_CMD)
}

export function jobStatus() {
  return job
    ? { running: job.running, startedAt: job.startedAt, finishedAt: job.finishedAt, exitCode: job.exitCode, output: job.lines.join('\n') }
    : null
}

export async function checkUpdate() {
  const [ver, chk] = await Promise.all([exec(BWOC, ['--version']), exec(BWOC, ['update', '--check'])])
  const checkText = (chk.stdout || chk.stderr).trim()
  const result = {
    version: ver.stdout || 'unavailable',
    check: checkText,
    // `bwoc update --check` prints "up to date (...)" when current. Anything
    // else that exits 0 is drift; a failure (offline) is reported as unknown.
    upToDate: chk.ok ? /up to date/i.test(checkText) : null,
    behind: null,
    latestCommit: null,
    checkedAt: new Date().toISOString(),
    canUpdate: updateEnabled(),
  }
  if (FRAMEWORK_SRC && existsSync(FRAMEWORK_SRC)) {
    const fetch = await exec('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: FRAMEWORK_SRC, timeout: 25_000 })
    if (fetch.ok) {
      const n = await exec('git', ['rev-list', '--count', 'HEAD..origin/main'], { cwd: FRAMEWORK_SRC })
      const top = await exec('git', ['log', '-1', '--format=%h %s', 'origin/main'], { cwd: FRAMEWORK_SRC })
      if (n.ok) result.behind = Number(n.stdout)
      if (top.ok) result.latestCommit = top.stdout
    }
  }
  // The git drift is authoritative when available: a source build never says
  // "up to date" itself, it just names the latest release.
  if (result.behind !== null) result.upToDate = result.behind === 0
  return result
}

export function startUpdate() {
  if (!UPDATE_CMD) throw Object.assign(new Error('update from the UI is not configured (set BWOC_UPDATE_CMD)'), { code: 400 })
  if (job?.running) throw Object.assign(new Error('an update is already running'), { code: 409 })
  job = { running: true, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, lines: [] }
  const mine = job
  const push = (chunk) => {
    for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) mine.lines.push(line)
    if (mine.lines.length > MAX_LINES) mine.lines.splice(0, mine.lines.length - MAX_LINES)
  }
  const child = spawn('bash', ['-c', UPDATE_CMD], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', push)
  child.stderr.on('data', push)
  const done = (code, note) => {
    if (note) push(note)
    mine.running = false
    mine.exitCode = code
    mine.finishedAt = new Date().toISOString()
  }
  child.on('error', (e) => done(-1, `failed to start: ${e.message}`))
  child.on('close', (code) => done(code ?? -1))
  return jobStatus()
}
