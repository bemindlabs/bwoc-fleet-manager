// Planner sidecar — runs bwoc-harness ON THE HOST, for the containerised stack.
//
// Why this exists: bwoc-harness hardens itself against same-uid ptrace and
// fail-closes when `kernel.yama.ptrace_scope=0`. That sysctl is not namespaced,
// so no per-container setting can satisfy it, and the guard is Linux-only —
// a no-op on macOS. So the planner runs here, on the host, and the container
// calls it over host.docker.internal.
//
// Loopback-only and single-purpose: it accepts a prompt and a workdir that must
// be inside the workspace root, runs one harness invocation, returns its stdout.
// It does not execute agents, write inboxes, or touch registries.

import http from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { appendFile, readFile, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

const PORT = Number(process.env.PLANNER_PORT || 8792)
// LOOPBACK ONLY — and the container still reaches it.
//
// This sidecar can send mesh messages as the configured gateway agent, run bwoc-harness with an
// arbitrary prompt, read the inbox and stop the recv bridge. It has no auth, so
// its reachability IS its security boundary.
//
// Binding 0.0.0.0 (the earlier default) put all of that in reach of every device
// on the tailnet — verified: another tailnet host could call /gateway/status and get 200.
// Loopback closes that at the kernel, with no app-level allowlist to get wrong.
//
// Why the container is unaffected: OrbStack NATs container→host traffic so it
// arrives with source 127.0.0.1 on the loopback interface. Measured on this host:
//   container → 127.0.0.1 ✅   loopback → 127.0.0.1 ✅   tailnet → refused ✅
// On a Docker runtime that instead presents the bridge gateway address, set
// PLANNER_BIND to that address (or 0.0.0.0 behind a firewall).
const HOST = process.env.PLANNER_BIND || '127.0.0.1'
const HARNESS = process.env.BWOC_HARNESS_BIN || 'bwoc-harness'
const ENDPOINT = process.env.BWOC_HARNESS_ENDPOINT || 'http://localhost:11434/v1'
const MODEL = process.env.BWOC_HARNESS_MODEL || 'gemma4:latest'
const TIMEOUT_MS = Number(process.env.BWOC_PLAN_TIMEOUT_MS || 300_000)
const WORKSPACE_ROOT = process.env.BWOC_WORKSPACE_ROOT_HOST || path.join(homedir(), 'Workspaces')

// Fleet standard (operator directive): every agent stamps time in +07:00
// (Asia/Bangkok), never UTC. one peer already emitted +07 via `date -Iseconds`;
// one peer was the odd one out with toISOString()'s trailing `Z`.
const TZ_OFFSET_MIN = Number(process.env.BWOC_TZ_OFFSET_MIN || 420) // +07:00

function nowLocalIso() {
  const shifted = new Date(Date.now() + TZ_OFFSET_MIN * 60_000)
  const sign = TZ_OFFSET_MIN >= 0 ? '+' : '-'
  const abs = Math.abs(TZ_OFFSET_MIN)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  return shifted.toISOString().replace(/\.\d+Z$/, '') + `${sign}${hh}:${mm}`
}

// ---- gateway mesh (host-side too: the key, inbox and recv bridge all live here) ----
// No built-in identity or relay: the mesh is off until BWOC_GW_AGENT and
// BWOC_GW_RELAY are set. Key and inbox default to ~/.bwoc/gateway/<agent>/.
const GW_SELF = process.env.BWOC_GW_AGENT || ''
const GW_HOME = GW_SELF ? path.join(homedir(), '.bwoc/gateway', GW_SELF) : ''
const GW = {
  self: GW_SELF,
  relay: process.env.BWOC_GW_RELAY || '',
  key: process.env.BWOC_GW_KEY || (GW_HOME && path.join(GW_HOME, 'agent.key')),
  inbox: process.env.BWOC_GW_INBOX || (GW_HOME && path.join(GW_HOME, 'inbox.jsonl')),
  room: process.env.BWOC_GW_ROOM || 'fleet',
  members: (process.env.BWOC_GW_MEMBERS || '').split(',').filter(Boolean),
  send: process.env.BWOC_GW_SEND || path.join(homedir(), '.local/bin/bwoc-gateway-send'),
  recv: process.env.BWOC_GW_RECV || path.join(homedir(), '.local/bin/bwoc-gateway-recv'),
  // Optional shell command that restarts the recv bridge after a send (see gatewaySend).
  kick: process.env.BWOC_GW_KICK_CMD || '',
}
const gwConfigured = () => Boolean(GW.self && GW.relay)

// ---- notification center ----
//
// A host can act as the fleet's notification hub: any mesh message tagged [noti] or
// [noti:<level>] becomes a native macOS notification here. Agents on other
// hosts cannot raise a notification on this machine directly — they send it
// over the relay and this watcher surfaces it.
const NOTI = {
  enabled: process.env.BWOC_NOTI !== '0',
  log: process.env.BWOC_NOTI_LOG || path.join(homedir(), '.bwoc/fleet-manager/noti.jsonl'),
  seen: 0,          // how many inbox lines we have already considered
  history: [],      // recent notifications, newest last
}

const SOUND = { crit: 'Basso', warn: 'Funk', info: 'Ping' }

function raiseNotification({ title, subtitle, body, level }) {
  const esc = (v) => String(v ?? '').replace(/["\\]/g, '\\$&').slice(0, 240)
  const sound = SOUND[level] || SOUND.info
  const script =
    `display notification "${esc(body)}" with title "${esc(title)}" ` +
    `subtitle "${esc(subtitle)}" sound name "${sound}"`
  return sh('osascript', ['-e', script])
}

/** `[noti:warn] title — body` → structured. Returns null when not a notification. */
function parseNoti(text, from) {
  const m = String(text).match(/\[noti(?::(crit|warn|info))?\]\s*([^\n]*)/i)
  if (!m) return null
  const level = (m[1] || 'info').toLowerCase()
  const rest = (m[2] || '').trim()
  const [head, ...tail] = rest.split(/\s+[—-]\s+/)
  return {
    level,
    from,
    title: `BWOC · ${from ?? 'fleet'}`,
    subtitle: (head || 'notification').slice(0, 120),
    body: (tail.join(' — ') || rest || text).slice(0, 300),
    at: nowLocalIso(),
  }
}

/**
 * Poll the inbox and surface anything newly arrived that carries a [noti] tag.
 * Only lines beyond `seen` are considered, so a restart never replays the
 * backlog as a burst of alerts.
 */
async function pumpNotifications() {
  if (!NOTI.enabled) return
  let lines = []
  try {
    lines = (await readFile(GW.inbox, 'utf8')).split('\n').filter((l) => l.trim())
  } catch {
    return
  }
  const fresh = lines.slice(NOTI.seen)
  NOTI.seen = lines.length
  for (const line of fresh) {
    let d
    try { d = JSON.parse(line) } catch { continue }
    const noti = parseNoti(d.message ?? '', d.from)
    if (!noti) continue
    await raiseNotification(noti)
    NOTI.history.push(noti)
    if (NOTI.history.length > 200) NOTI.history.shift()
    await appendFile(NOTI.log, JSON.stringify(noti) + '\n').catch(() => {})
  }
}

// ---- root agents ----
//
// Standalone agents live outside any workspace (~/agents/<name>), so `bwoc list`
// never sees them and the dashboard was blind to them. They are read here rather
// than in the container: this directory holds the mesh private key, and mounting
// it into a container would put that key somewhere it has no reason to be.
const ROOT_AGENTS_DIR = process.env.BWOC_ROOT_AGENTS || path.join(homedir(), 'agents')

async function readRootAgents() {
  let names = []
  try {
    const { readdir } = await import('node:fs/promises')
    names = (await readdir(ROOT_AGENTS_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }

  return Promise.all(
    names.map(async (name) => {
      const dir = path.join(ROOT_AGENTS_DIR, name)
      const bwocDir = path.join(dir, '.bwoc')
      let manifest = {}
      try {
        manifest = JSON.parse(await readFile(path.join(dir, 'config.manifest.json'), 'utf8'))
      } catch {
        /* an agent without a manifest is still worth listing */
      }
      const inboxPath = path.join(bwocDir, 'inbox.jsonl')
      let inboxCount = 0
      try {
        inboxCount = (await readFile(inboxPath, 'utf8')).split('\n').filter((l) => l.trim()).length
      } catch {
        /* no inbox yet */
      }
      return {
        id: manifest.agentId || name,
        name,
        dir,
        role: manifest.agentRole ?? null,
        model: manifest.primaryModel ?? null,
        version: manifest.version ?? null,
        inboxCount,
        hasIdentity: existsSync(path.join(bwocDir, 'agent.key')),
        // The key itself is never read, listed, or returned — only its presence.
        meshMember: existsSync(path.join(bwocDir, 'agent.key')),
      }
    }),
  )
}

async function readRootInbox(name, limit = 100) {
  // Reject anything that could escape the agents dir.
  if (!/^[\w.@-]+$/.test(name)) throw Object.assign(new Error('bad agent name'), { code: 400 })
  const file = path.join(ROOT_AGENTS_DIR, name, '.bwoc', 'inbox.jsonl')
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { agent: name, inbox: file, messages: [], missing: true }
  }
  const messages = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const d = JSON.parse(line)
      const body = String(d.message ?? '')
      const roomMatch = body.match(/^\[room:([^\]]+)\]/)
      messages.push({
        from: d.from ?? null,
        to: d.to ?? null,
        ts: d.ts ?? null,
        messageId: d.messageId ?? null,
        room: roomMatch ? roomMatch[1] : null,
        text: body,
      })
    } catch {
      /* skip malformed line */
    }
  }
  return { agent: name, inbox: file, messages: messages.slice(-limit), missing: false, total: messages.length }
}

// ---- agent lifecycle (host-side) ----
//
// Why this lives here and not in the container: `bwoc start` spawns a
// `bwoc-agent --serve` daemon. Started inside the container that daemon is a
// CONTAINER process — it dies on every image rebuild and leaves PID files
// holding container-namespace pids (21, 25, 29 …) that a host-side doctor then
// reports as stale. 26 such files had to be cleared by hand. The container also
// has no backend CLI, so an agent started there can answer a ping but cannot
// run a task. Driving lifecycle from the host fixes both.
const LIFECYCLE = {
  start: ['start', '--yes'],
  pause: ['start', '--yes', '--no-daemon'],
  stop: ['stop', '--yes'],
}

function wsPathFromName(name) {
  if (!/^[\w.-]+$/.test(name)) throw Object.assign(new Error('bad workspace name'), { code: 400 })
  const p = path.join(WORKSPACE_ROOT, name)
  if (!existsSync(path.join(p, '.bwoc', 'workspace.toml'))) {
    throw Object.assign(new Error(`unknown workspace: ${name}`), { code: 404 })
  }
  return p
}

/** Registry id → directory name; `bwoc start|stop` wants the directory. */
async function resolveAgentDir(wsPath, key) {
  const r = await sh(process.env.BWOC_BIN || 'bwoc', ['list', '--workspace', wsPath, '--json'])
  let agents = []
  try { agents = JSON.parse(r.stdout).agents ?? [] } catch { /* fall through to 404 */ }
  const bare = (v) => v.replace(/^agent-/, '')
  const hit = agents.find((a) => {
    const dir = a.path.split('/').pop()
    return [a.id, dir, bare(a.id), bare(dir)].includes(key)
  })
  if (!hit) throw Object.assign(new Error(`unknown agent: ${key}`), { code: 404 })
  return { id: hit.id, dir: hit.path.split('/').pop() }
}

async function runLifecycle(wsPath, agentDir, action) {
  const verb = LIFECYCLE[action]
  if (!verb) throw Object.assign(new Error(`unsupported action: ${action}`), { code: 400 })
  const bin = process.env.BWOC_BIN || 'bwoc'
  // Pausing a live agent means tearing the daemon down first — `start
  // --no-daemon` alone would leave a running one running.
  if (action === 'pause') await sh(bin, ['stop', agentDir, '--workspace', wsPath, '--yes'])
  const [cmd, ...flags] = verb
  const r = await sh(bin, [cmd, agentDir, '--workspace', wsPath, ...flags], { timeout: 60_000 })
  return (r.stdout || r.stderr || '').trim()
}

const sh = (cmd, args, opts = {}) =>
  new Promise((resolve) =>
    execFile(cmd, args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', code: err?.code ?? 0 }),
    ),
  )

/** Is our recv bridge process alive? It is what turns relay traffic into inbox lines. */
async function bridgeStatus() {
  if (!GW.self) return { running: false, pids: [], duplicate: false }
  const r = await sh('pgrep', ['-f', `bwoc-gateway-recv.*${GW.self}`])
  const pids = r.stdout.trim().split('\n').filter(Boolean)
  return { running: pids.length > 0, pids, duplicate: pids.length > 1 }
}

/**
 * Read the room transcript out of the inbox. Messages carry a `[room:<id>]`
 * prefix by convention (agreed between the peers), so anything else in the
 * inbox is a direct message rather than room traffic.
 */
async function readRoom(limit = 50) {
  let text = ''
  try {
    text = await readFile(GW.inbox, 'utf8')
  } catch {
    return { room: GW.room, messages: [], inboxMissing: true }
  }
  const tag = `[room:${GW.room}]`
  const messages = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const d = JSON.parse(line)
      const body = String(d.message ?? '')
      messages.push({
        from: d.from ?? null,
        ts: d.ts ?? null,
        inRoom: body.includes(tag),
        // Strip the convention header so the UI shows just what was said —
        // but only when a body actually follows it. Some agents put the header
        // and their message on ONE line, and the old rule ate the whole thing,
        // rendering a blank row in the transcript.
        text: (() => {
          const m = body.match(/^\[room:[^\]]+\]([^\n]*)\n([\s\S]*)$/)
          if (m) return m[2].trim() || m[1].trim()
          const single = body.match(/^\[room:[^\]]+\]\s*(.*)$/s)
          return single ? single[1].trim() : body
        })(),
        raw: body,
      })
    } catch {
      /* a malformed line is not worth failing the whole read over */
    }
  }
  return { room: GW.room, messages: messages.slice(-limit), inboxMissing: false }
}

async function gatewaySend(message, to) {
  if (!gwConfigured()) throw new Error('gateway not configured (set BWOC_GW_AGENT and BWOC_GW_RELAY)')
  if (!existsSync(GW.key)) throw new Error(`no gateway identity at ${GW.key}`)
  const targets = to ? [to] : GW.members
  const ts = nowLocalIso()
  const full = `[room:${GW.room}] ${GW.self} · ${ts}\n${message}`
  const body = JSON.stringify({ message: full })

  const results = []
  for (const m of targets) {
    // NOTE: bwoc-gateway-send prints a parse error but still exits 0 on a bad
    // body, so success is judged on stdout — never on the exit code alone.
    const r = await new Promise((resolve) => {
      const p = spawn(GW.send, ['--url', GW.relay, '--agent-id', GW.self, '--to', m, '--key-file', GW.key])
      let out = '', err = ''
      p.stdout.on('data', (d) => (out += d))
      p.stderr.on('data', (d) => (err += d))
      p.on('close', () => resolve({ out, err }))
      p.on('error', (e) => resolve({ out: '', err: e.message }))
      p.stdin.end(body)
    })
    const combined = `${r.out}${r.err}`.trim()
    results.push({ to: m, ok: /delivered|parked/i.test(combined), detail: combined })
  }

  // CRITICAL: bwoc-gateway-send connects with the SAME agent id as our recv
  // bridge, and the relay allows one connection per id — so every send evicts
  // our own receiver. Worse, the receiver never notices: its TCP socket stays
  // half-open, `pgrep` still shows it alive, and inbound messages silently
  // park. Kick the bridge after sending so presence is restored.
  // The restart mechanism is host-specific (launchd, systemd, …), so it is
  // supplied as BWOC_GW_KICK_CMD rather than guessed here.
  if (GW.kick) await sh('sh', ['-c', GW.kick])

  return { ts, sent: full, results, presenceRestored: Boolean(GW.kick) }
}

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 2_000_000) {
        reject(new Error('prompt too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * The container sends a container-side path (/workspaces/x); translate it to the
 * host path and refuse anything that escapes the workspace root. The harness
 * confines its own file operations to this directory, so it is the blast radius.
 */
async function resolveWorkdir(requested) {
  const mapped = requested?.startsWith('/workspaces')
    ? path.join(WORKSPACE_ROOT, requested.slice('/workspaces'.length))
    : requested || WORKSPACE_ROOT
  const real = await realpath(mapped).catch(() => null)
  const rootReal = await realpath(WORKSPACE_ROOT)
  if (!real || (real !== rootReal && !real.startsWith(rootReal + path.sep))) {
    const err = new Error(`workdir must be inside ${WORKSPACE_ROOT}`)
    err.code = 400
    throw err
  }
  return real
}

function runHarness(prompt, workdir) {
  return new Promise((resolve, reject) => {
    execFile(
      HARNESS,
      ['--task', prompt, '--endpoint', ENDPOINT, '--model', MODEL, '--workdir', workdir,
       '--max-iterations', '4'],
      { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(stderr?.trim() || err.message))
        resolve(stdout)
      },
    )
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)

  // ---- gateway mesh ----
  // ---- lifecycle ----
  if (req.method === 'POST' && url.pathname === '/lifecycle') {
    try {
      const { workspace, agent, action } = await readBody(req)
      const wsPath = wsPathFromName(workspace)
      const { id, dir } = await resolveAgentDir(wsPath, agent)
      return send(res, 200, { ok: true, agent: id, action, output: await runLifecycle(wsPath, dir, action) })
    } catch (err) {
      return send(res, err.code === 404 ? 404 : err.code === 400 ? 400 : 500, { error: err.message })
    }
  }

  if (req.method === 'POST' && url.pathname === '/lifecycle/bulk') {
    try {
      const { workspace, action, agents } = await readBody(req)
      const wsPath = wsPathFromName(workspace)
      const bin = process.env.BWOC_BIN || 'bwoc'

      if (!Array.isArray(agents) || agents.length === 0) {
        const flags = action === 'start' ? ['start', '--all', '--yes']
          : action === 'pause' ? ['start', '--all', '--yes', '--no-daemon']
          : action === 'stop' ? ['stop', '--all', '--yes'] : null
        if (!flags) return send(res, 400, { error: `unsupported action: ${action}` })
        const [cmd, ...rest] = flags
        const r = await sh(bin, [cmd, ...rest.slice(0, 1), '--workspace', wsPath, ...rest.slice(1)], { timeout: 180_000 })
        return send(res, 200, { ok: true, scope: 'all', action, output: (r.stdout || r.stderr).trim() })
      }

      // Per-agent so one failure cannot abort the rest.
      const results = []
      for (const key of agents) {
        try {
          const { id, dir } = await resolveAgentDir(wsPath, key)
          results.push({ agent: id, ok: true, output: await runLifecycle(wsPath, dir, action) })
        } catch (err) {
          results.push({ agent: key, ok: false, error: err.message })
        }
      }
      return send(res, 200, {
        ok: results.every((r) => r.ok), scope: 'selection', action,
        succeeded: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length, results,
      })
    } catch (err) {
      return send(res, err.code === 404 ? 404 : 400, { error: err.message })
    }
  }

  if (req.method === 'GET' && url.pathname === '/gateway/status') {
    const [bridge, room] = await Promise.all([bridgeStatus(), readRoom(1)])
    return send(res, 200, {
      self: GW.self, relay: GW.relay, room: GW.room, members: GW.members,
      identity: existsSync(GW.key), clientInstalled: existsSync(GW.send),
      bridge, inboxMissing: room.inboxMissing,
    })
  }

  if (req.method === 'GET' && url.pathname === '/gateway/room') {
    return send(res, 200, await readRoom(Number(url.searchParams.get('limit') || 50)))
  }

  if (req.method === 'POST' && url.pathname === '/gateway/send') {
    try {
      const { message, to } = await readBody(req)
      if (!message?.trim()) return send(res, 400, { error: 'message is required' })
      if (to && !GW.members.includes(to)) return send(res, 400, { error: `unknown member: ${to}` })
      return send(res, 200, await gatewaySend(message.trim(), to))
    } catch (err) {
      return send(res, 500, { error: err.message })
    }
  }

  if (req.method === 'POST' && url.pathname === '/gateway/bridge') {
    const { action } = await readBody(req)
    if (action === 'stop') {
      await (GW.self ? sh('pkill', ['-f', `bwoc-gateway-recv.*${GW.self}`]) : null)
      return send(res, 200, { ok: true, bridge: await bridgeStatus() })
    }
    if (action === 'start') {
      if (!gwConfigured()) return send(res, 400, { error: 'gateway not configured (set BWOC_GW_AGENT and BWOC_GW_RELAY)' })
      const cur = await bridgeStatus()
      if (cur.running) return send(res, 200, { ok: true, already: true, bridge: cur })
      spawn(GW.recv, ['--url', GW.relay, '--agent-id', GW.self, '--key-file', GW.key, '--inbox', GW.inbox], {
        detached: true, stdio: 'ignore',
      }).unref()
      await new Promise((r) => setTimeout(r, 1500))
      return send(res, 200, { ok: true, bridge: await bridgeStatus() })
    }
    return send(res, 400, { error: 'action must be start or stop' })
  }

  // ---- root (standalone) agents ----
  if (req.method === 'GET' && url.pathname === '/root/agents') {
    return send(res, 200, { dir: ROOT_AGENTS_DIR, agents: await readRootAgents() })
  }

  if (req.method === 'GET' && url.pathname.startsWith('/root/inbox/')) {
    try {
      const name = decodeURIComponent(url.pathname.slice('/root/inbox/'.length))
      return send(res, 200, await readRootInbox(name, Number(url.searchParams.get('limit') || 100)))
    } catch (err) {
      return send(res, err.code === 400 ? 400 : 500, { error: err.message })
    }
  }

  // Fired by the launchd WatchPaths agent the instant inbox.jsonl changes —
  // this is what replaces the 5s poll (fleet standard: native file-watch).
  if (req.method === 'POST' && url.pathname === '/gateway/noti/pump') {
    await pumpNotifications()
    return send(res, 200, { ok: true, seen: NOTI.seen })
  }

  if (req.method === 'GET' && url.pathname === '/gateway/noti') {
    // Read the durable log, not the in-memory ring: a sidecar restart used to
    // make every past notification vanish from the UI even though noti.jsonl
    // still had them.
    const limit = Number(url.searchParams.get('limit') || 30)
    let rows = []
    try {
      rows = (await readFile(NOTI.log, 'utf8'))
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => { try { return JSON.parse(l) } catch { return null } })
        .filter(Boolean)
    } catch {
      rows = NOTI.history // no log yet — fall back to whatever this process saw
    }
    return send(res, 200, {
      enabled: NOTI.enabled,
      count: rows.length,
      notifications: rows.slice(-limit),
    })
  }

  if (req.method === 'POST' && url.pathname === '/gateway/noti/test') {
    const { level = 'info', text = 'test notification' } = await readBody(req)
    const noti = parseNoti(`[noti:${level}] ${text}`, GW.self)
    await raiseNotification(noti)
    NOTI.history.push(noti)
    // Append to the durable log too — otherwise a notification raised through
    // this endpoint (autoclean, scripts) shows on screen but is missing from
    // /gateway/noti, which reads the log. Two sources of truth is one too many.
    await appendFile(NOTI.log, JSON.stringify(noti) + '\n').catch(() => {})
    return send(res, 200, { ok: true, noti })
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, harness: HARNESS, model: MODEL, endpoint: ENDPOINT })
  }

  if (req.method === 'POST' && url.pathname === '/plan') {
    try {
      const { prompt, workdir } = await readBody(req)
      if (!prompt?.trim()) return send(res, 400, { error: 'prompt is required' })
      const dir = await resolveWorkdir(workdir)
      const stdout = await runHarness(prompt, dir)
      return send(res, 200, { ok: true, stdout })
    } catch (err) {
      return send(res, err.code === 400 ? 400 : 500, { error: err.message })
    }
  }

  return send(res, 404, { error: `no route for ${req.method} ${url.pathname}` })
})

server.listen(PORT, HOST, () => {
  console.log(`[planner-sidecar] listening on http://${HOST}:${PORT}`)
  console.log(`[planner-sidecar] harness ${HARNESS} · ${MODEL} @ ${ENDPOINT}`)
  console.log(`[planner-sidecar] workspace root ${WORKSPACE_ROOT}`)
  if (NOTI.enabled) {
    // Prime `seen` to the current inbox depth so existing history is not
    // replayed as notifications on every restart.
    readFile(GW.inbox, 'utf8')
      .then((t) => { NOTI.seen = t.split('\n').filter((l) => l.trim()).length })
      .catch(() => {})
      .finally(() => {
        setInterval(() => { void pumpNotifications() }, 5000)
        console.log(`[planner-sidecar] notification center armed → ${GW.inbox}`)
      })
  }
})
