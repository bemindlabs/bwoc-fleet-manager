// Fleet Manager API — a loopback-only sidecar that fronts the `bwoc` CLI.
//
// Bound to 127.0.0.1 by design: it can start/stop agents and write to inboxes,
// so it must never be reachable off-host. There is no auth layer; loopback IS
// the boundary. Do not put this behind a public reverse proxy.

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as bwoc from './bwoc.mjs'
import * as files from './files.mjs'
import { checkUpdate, jobStatus, startUpdate, updateEnabled } from './updater.mjs'
import { getJob, listJobs, startOrchestration } from './orchestrator.mjs'
import { catalog, resolveCatalogPath, runtimeSettings, workspaceFrameworks } from './frameworks.mjs'

const PORT = Number(process.env.PORT || 8791)
// Loopback by default so a bare-metal run is never exposed. In a container the
// process MUST bind 0.0.0.0 or Docker cannot forward to it — the published port
// stays pinned to 127.0.0.1 on the host, so the security property is unchanged.
const HOST = process.env.BIND_HOST || '127.0.0.1'
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const SERVE_STATIC = process.env.SERVE_STATIC === '1'

// Fanning out across ~10 workspaces × 3 calls would spawn 30 processes at once.
// Cap it so a refresh doesn't stampede the machine.
const LIMIT = 6
async function mapLimited(items, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(LIMIT, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

// Short TTL cache — the dashboard polls, and each miss costs a process spawn.
const cache = new Map()
const TTL_MS = 4000
async function cached(key, fn) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = await fn()
  cache.set(key, { at: Date.now(), value })
  return value
}
const invalidate = () => cache.clear()

function summarizeHealth(health) {
  const signals = Array.isArray(health?.data) ? health.data : []
  return {
    signals,
    ok: signals.filter((s) => s.status === 'ok').length,
    warn: signals.filter((s) => s.status === 'warn').length,
    fail: signals.filter((s) => s.status === 'fail').length,
    info: signals.filter((s) => s.status === 'info').length,
  }
}

function summarizeDoctor(doc) {
  const results = doc?.data?.results ?? []
  return {
    results,
    pass: results.filter((r) => r.status === 'pass').length,
    warn: results.filter((r) => r.status === 'warn').length,
    fail: results.filter((r) => r.status === 'fail').length,
  }
}

/** Fleet-wide rollup: one row per workspace, plus machine totals. */
async function overview() {
  const discovered = await bwoc.discoverWorkspaces()
  const workspaces = discovered.filter((w) => w.isWorkspace)
  const orphans = discovered.filter((w) => !w.isWorkspace)

  const rows = await mapLimited(workspaces, async (ws) => {
    const [list, health, doc] = await Promise.all([
      bwoc.listAgents(ws.path),
      bwoc.fleetHealth(ws.path),
      bwoc.doctor(ws.path),
    ])
    const agents = list?.data?.agents ?? []
    return {
      name: ws.name,
      path: ws.path,
      error: list?.error ?? null,
      agents,
      agentCount: agents.length,
      inboxTotal: agents.reduce((n, a) => n + (a.inbox_count || 0), 0),
      runningCount: agents.filter((a) => a.running).length,
      stoppedCount: agents.filter((a) => a.status !== 'active').length,
      health: summarizeHealth(health),
      doctor: summarizeDoctor(doc),
    }
  })

  const allAgents = rows.flatMap((r) => r.agents)
  return {
    generatedAt: new Date().toISOString(),
    workspaceRoot: bwoc.WORKSPACE_ROOT,
    orphans,
    workspaces: rows,
    totals: {
      workspaces: rows.length,
      populated: rows.filter((r) => r.agentCount > 0).length,
      agents: allAgents.length,
      inbox: rows.reduce((n, r) => n + r.inboxTotal, 0),
      running: rows.reduce((n, r) => n + r.runningCount, 0),
      healthWarn: rows.reduce((n, r) => n + r.health.warn, 0),
      doctorFail: rows.reduce((n, r) => n + r.doctor.fail, 0),
      backends: allAgents.reduce((acc, a) => {
        acc[a.backend] = (acc[a.backend] || 0) + 1
        return acc
      }, {}),
    },
  }
}

async function workspaceDetail(name) {
  const wsPath = await bwoc.resolveWorkspace(name)
  const [list, health, doc, sess, tsk, peer, skl, tms, stat] = await Promise.all([
    bwoc.listAgents(wsPath),
    bwoc.fleetHealth(wsPath),
    bwoc.doctor(wsPath),
    bwoc.sessions(wsPath),
    bwoc.tasks(wsPath),
    bwoc.peers(wsPath),
    bwoc.skills(wsPath),
    bwoc.listTeams(wsPath),
    bwoc.statusAll(wsPath),
  ])
  const models = new Map((stat?.data?.agents ?? []).map((s) => [s.id, s.primary_model ?? null]))
  const agents = (list?.data?.agents ?? []).map((a) => ({ ...a, primary_model: models.get(a.id) ?? null }))
  const teams = Array.isArray(tms?.data) ? tms.data : []

  // Team membership is free text — a member may name an agent that was never
  // incarnated or has since been retired. Resolve each one so the UI can show
  // "12 members, 6 live" instead of implying they all exist.
  // A member may be written any of four ways: registry id (`agent-foo`), the
  // directory name, or either with the `agent-` prefix stripped — `bwoc team
  // create` stores bare names, while some workspaces name their directories
  // `agents/agent-foo` and others `agents/foo`. Index every spelling.
  const registry = new Map()
  const bare = (s) => s.replace(/^agent-/, '')
  for (const a of agents) {
    const dir = a.path.split('/').pop()
    for (const key of [a.id, dir, bare(a.id), bare(dir)]) registry.set(key, a)
  }
  const teamRows = await Promise.all(
    teams.map(async (t) => {
      const tasks = await bwoc.listTasks(wsPath, t.team)
      const resolved = t.members.map((m) => ({ member: m, agent: registry.get(m) ?? null }))
      return {
        team: t.team,
        createdAt: t.created_at ?? null,
        members: resolved,
        memberCount: t.members.length,
        liveCount: resolved.filter((r) => r.agent).length,
        danglingCount: resolved.filter((r) => !r.agent).length,
        tasks: Array.isArray(tasks?.data) ? tasks.data : [],
      }
    }),
  )

  return {
    name,
    path: wsPath,
    agents,
    health: summarizeHealth(health),
    doctor: summarizeDoctor(doc),
    sessions: sess?.data?.sessions ?? [],
    tasks: tsk?.data?.tasks ?? [],
    peers: peer?.data ?? peer?.error ?? null,
    skills: skl?.data ?? null,
    teams: teamRows,
  }
}

async function agentDetail(wsName, agentKey) {
  const wsPath = await bwoc.resolveWorkspace(wsName)
  const { id, dir, agent } = await bwoc.resolveAgent(wsPath, agentKey)
  const [status, box] = await Promise.all([
    bwoc.agentStatus(wsPath, id),
    bwoc.inbox(wsPath, dir),
  ])
  return {
    workspace: wsName,
    id,
    dir,
    agent,
    status: status?.data ?? null,
    statusError: status?.error ?? null,
    inbox: box?.data?.messages ?? [],
    inboxPath: box?.data?.inbox ?? null,
  }
}

const send = (res, code, body) => {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`))
      }
    })
    req.on('error', reject)
  })
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
}

async function serveStatic(url, res) {
  const rel = url === '/' ? 'index.html' : url.slice(1)
  const target = path.join(DIST, rel)
  // Path-traversal guard: the resolved file must stay inside dist/.
  if (!target.startsWith(DIST)) return send(res, 403, { error: 'forbidden' })
  try {
    const buf = await readFile(target)
    res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream' })
    res.end(buf)
  } catch {
    try {
      const buf = await readFile(path.join(DIST, 'index.html'))
      res.writeHead(200, { 'content-type': MIME['.html'] })
      res.end(buf)
    } catch {
      send(res, 404, { error: 'not found — run `pnpm build` first' })
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  const seg = url.pathname.split('/').filter(Boolean)

  try {
    if (seg[0] !== 'api') {
      if (SERVE_STATIC) return await serveStatic(url.pathname, res)
      return send(res, 404, { error: 'API server only — the UI is served by Vite in dev' })
    }

    // CSRF guard. The API has no auth — the tailnet is the boundary — so any
    // page open in the operator's browser could otherwise POST here (a
    // `text/plain` form post needs no preflight, and readBody parses it
    // anyway). Writes must carry a header only a same-origin script can set.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-fleet-manager'] !== '1') {
      return send(res, 403, { error: 'writes need the x-fleet-manager header (use the dashboard)' })
    }

    // ---- reads ----
    if (req.method === 'GET' && seg[1] === 'health') return send(res, 200, { ok: true })
    if (req.method === 'GET' && seg[1] === 'version') {
      return send(res, 200, await cached('version', () => bwoc.version()))
    }
    if (req.method === 'GET' && seg[1] === 'bwoc-update') {
      return send(res, 200, { canUpdate: updateEnabled(), job: jobStatus() })
    }
    // Cheap list for the sidebar: a directory scan, no `bwoc` process per
    // workspace (unlike /overview, which takes seconds).
    if (req.method === 'GET' && seg[1] === 'workspaces') {
      const all = await bwoc.discoverWorkspaces()
      return send(res, 200, { workspaces: all.filter((w) => w.isWorkspace).map((w) => w.name) })
    }
    if (req.method === 'GET' && seg[1] === 'overview') {
      return send(res, 200, await cached('overview', overview))
    }
    if (req.method === 'GET' && seg[1] === 'workspace' && seg[2]) {
      const name = decodeURIComponent(seg[2])
      if (seg[3] === 'agent' && seg[4]) {
        const key = decodeURIComponent(seg[4])
        return send(res, 200, await cached(`agent:${name}:${key}`, () => agentDetail(name, key)))
      }
      return send(res, 200, await cached(`ws:${name}`, () => workspaceDetail(name)))
    }

    // ---- projects + file editor ----
    // /api/projects/<ws>                         → projects/* with git info
    // /api/projects/<ws>/<project>/tree?path=    → one directory level
    // /api/projects/<ws>/<project>/file?path=    → GET read · PUT save
    if (seg[1] === 'projects' && seg[2]) {
      const wsPath = await bwoc.resolveWorkspace(decodeURIComponent(seg[2]))
      if (req.method === 'GET' && !seg[3]) return send(res, 200, { projects: await files.listProjects(wsPath) })
      const project = seg[3] && decodeURIComponent(seg[3])
      const rel = url.searchParams.get('path') ?? ''
      if (req.method === 'GET' && seg[4] === 'tree') return send(res, 200, await files.listDir(wsPath, project, rel))
      if (req.method === 'GET' && seg[4] === 'file') return send(res, 200, await files.readProjectFile(wsPath, project, rel))
      if (req.method === 'PUT' && seg[4] === 'file') {
        // A cross-site page cannot set a custom header without a CORS
        // preflight, which this server never answers — so a hostile tab in
        // the same browser cannot write files through the tailnet URL.
        if (req.headers['x-fleet-manager'] !== '1' || !req.headers['content-type']?.startsWith('application/json')) {
          return send(res, 403, { error: 'missing x-fleet-manager header' })
        }
        const { content, mtimeMs } = await readBody(req, 3 * files.MAX_FILE_BYTES)
        return send(res, 200, await files.writeProjectFile(wsPath, project, rel, content, mtimeMs))
      }
    }

    // ---- writes ----
    if (req.method === 'POST' && seg[1] === 'send') {
      const { workspace, agent, message } = await readBody(req)
      if (!workspace || !agent || !message?.trim()) {
        return send(res, 400, { error: 'workspace, agent and a non-empty message are required' })
      }
      const wsPath = await bwoc.resolveWorkspace(workspace)
      const { dir, id } = await bwoc.resolveAgent(wsPath, agent)
      const out = await bwoc.sendMessage(wsPath, dir, message)
      invalidate()
      return send(res, 200, { ok: true, agent: id, output: out.stdout.trim() || out.stderr.trim() })
    }

    if (req.method === 'POST' && seg[1] === 'doctor-auto') {
      const { workspace } = await readBody(req)
      const wsPath = await bwoc.resolveWorkspace(workspace)
      const out = await bwoc.doctorAuto(wsPath)
      invalidate()
      return send(res, 200, { ok: true, output: out.stdout.trim() || out.stderr.trim() })
    }

    // Lifecycle is delegated to the HOST sidecar. Running `bwoc start` in this
    // container spawns the agent daemon as a container process: it dies on the
    // next image rebuild and leaves PID files with container-namespace pids that
    // a host-side doctor flags as stale (26 of those had to be cleared by hand).
    // The container also lacks a backend CLI, so such an agent cannot run tasks.
    if (req.method === 'POST' && (seg[1] === 'agent-state' || seg[1] === 'bulk-state')) {
      const base = process.env.BWOC_PLANNER_URL
      const body = await readBody(req)
      if (!base) {
        return send(res, 503, {
          error: 'lifecycle needs the host sidecar (BWOC_PLANNER_URL unset) — start it with `pnpm planner`',
        })
      }
      const target = new URL(seg[1] === 'agent-state' ? '/lifecycle' : '/lifecycle/bulk', base)
      try {
        const upstream = await fetch(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(200_000),
        })
        const out = await upstream.json().catch(() => ({ error: 'sidecar returned non-JSON' }))
        invalidate()
        return send(res, upstream.status, out)
      } catch (err) {
        return send(res, 502, { error: `host sidecar unreachable (${err.message})` })
      }
    }


    if (req.method === 'POST' && seg[1] === 'ping') {
      const { workspace } = await readBody(req)
      const wsPath = await bwoc.resolveWorkspace(workspace)
      const out = await bwoc.ping(wsPath)
      return send(res, 200, { ok: true, output: out.stdout.trim() })
    }

    // ---- groups (Saṅgha teams) ----

    if (req.method === 'POST' && seg[1] === 'team') {
      const { workspace, id, members } = await readBody(req)
      const wsPath = await bwoc.resolveWorkspace(workspace)
      if (!id?.trim()) return send(res, 400, { error: 'a team id is required' })
      if (!Array.isArray(members) || members.length === 0) {
        return send(res, 400, { error: 'at least one member is required' })
      }
      // Every member must be a real agent — a team of ghosts is how the
      // dangling membership in the existing teams happened.
      const resolved = []
      for (const m of members) {
        const { id: agentId } = await bwoc.resolveAgent(wsPath, m)
        resolved.push(agentId.replace(/^agent-/, ''))
      }
      const out = await bwoc.createTeam(wsPath, id.trim(), resolved)
      invalidate()
      return send(res, 200, { ok: true, team: id, members: resolved, output: out.stdout.trim() })
    }

    if (req.method === 'POST' && seg[1] === 'team-retire') {
      const { workspace, id } = await readBody(req)
      const wsPath = await bwoc.resolveWorkspace(workspace)
      await bwoc.resolveTeam(wsPath, id)
      const out = await bwoc.retireTeam(wsPath, id)
      invalidate()
      return send(res, 200, { ok: true, output: out.stdout.trim() })
    }

    if (req.method === 'POST' && seg[1] === 'task') {
      const { workspace, team, title, requiresPlan } = await readBody(req)
      const wsPath = await bwoc.resolveWorkspace(workspace)
      await bwoc.resolveTeam(wsPath, team)
      if (!title?.trim()) return send(res, 400, { error: 'a task title is required' })
      const out = await bwoc.addTask(wsPath, team, title.trim(), { requiresPlan: !!requiresPlan })
      invalidate()
      return send(res, 200, { ok: true, output: out.stdout.trim() })
    }

    // ---- root (standalone) agents ----
    //
    // Same reason as the gateway routes: standalone agents live in ~/agents on
    // the HOST, which is deliberately not mounted into this container.
    if (seg[1] === 'root') {
      const base = process.env.BWOC_PLANNER_URL
      if (!base) return send(res, 503, { error: 'root agents need the host sidecar (BWOC_PLANNER_URL unset)' })
      const sub = seg.slice(2).join('/') || 'agents'
      try {
        const upstream = await fetch(new URL(`/root/${sub}${url.search}`, base), {
          signal: AbortSignal.timeout(20_000),
        })
        return send(res, upstream.status, await upstream.json())
      } catch (err) {
        return send(res, 502, { error: `host sidecar unreachable (${err.message})` })
      }
    }

    // ---- gateway mesh ----
    //
    // Everything mesh-related (identity key, inbox, recv bridge, send client)
    // lives on the HOST, not in this container — so these routes proxy to the
    // sidecar rather than shelling out locally.
    if (seg[1] === 'gateway') {
      const base = process.env.BWOC_PLANNER_URL
      if (!base) {
        return send(res, 503, {
          error: 'gateway needs the host sidecar (BWOC_PLANNER_URL unset) — start it with `pnpm planner`',
        })
      }
      const sub = seg.slice(2).join('/') || 'status'
      const target = new URL(`/gateway/${sub}${url.search}`, base)
      try {
        const init = { method: req.method, signal: AbortSignal.timeout(60_000) }
        if (req.method === 'POST') {
          init.body = JSON.stringify(await readBody(req))
          init.headers = { 'content-type': 'application/json' }
        }
        const upstream = await fetch(target, init)
        const body = await upstream.json().catch(() => ({ error: 'sidecar returned non-JSON' }))
        if (req.method === 'POST') invalidate()
        return send(res, upstream.status, body)
      } catch (err) {
        return send(res, 502, {
          error: `host sidecar unreachable at ${base} (${err.message}) — is \`pnpm planner\` running?`,
        })
      }
    }

    // ---- settings: fleet runtime + framework catalog ----

    if (req.method === 'GET' && seg[1] === 'settings') {
      return send(res, 200, await cached('settings', async () => {
        const [runtime, cat] = await Promise.all([runtimeSettings(), catalog()])
        return { ...runtime, catalog: cat }
      }))
    }

    if (req.method === 'GET' && seg[1] === 'frameworks' && seg[2]) {
      const name = decodeURIComponent(seg[2])
      const wsPath = await bwoc.resolveWorkspace(name)
      return send(res, 200, await cached(`fw:${name}`, async () => ({
        workspace: name,
        ...(await workspaceFrameworks(wsPath)),
      })))
    }

    if (req.method === 'POST' && seg[1] === 'framework') {
      const { workspace, kind, name, action, agent, upgrade } = await readBody(req)
      if (kind !== 'skill' && kind !== 'plugin') {
        return send(res, 400, { error: 'kind must be "skill" or "plugin"' })
      }
      const wsPath = await bwoc.resolveWorkspace(workspace)

      let out
      if (action === 'install') {
        const src = await resolveCatalogPath(kind, name)
        out = await bwoc.installModule(wsPath, kind, src, !!upgrade)
      } else if (action === 'enable' || action === 'disable') {
        // Skills bind to an agent; plugins are workspace-wide.
        let agentDir = null
        if (kind === 'skill' && agent) {
          agentDir = (await bwoc.resolveAgent(wsPath, agent)).dir
        }
        out = await bwoc.setModuleState(wsPath, kind, name, action === 'enable', agentDir)
      } else if (action === 'remove') {
        out = await bwoc.removeModule(wsPath, kind, name)
      } else {
        return send(res, 400, { error: `unknown framework action: ${action}` })
      }
      invalidate()
      return send(res, 200, { ok: true, output: (out.stdout || out.stderr || '').trim() })
    }

    // Bulk-enable one skill across many agents in a workspace.
    if (req.method === 'POST' && seg[1] === 'framework-bulk') {
      const { workspace, name, action, agents } = await readBody(req)
      const wsPath = await bwoc.resolveWorkspace(workspace)
      const targets = Array.isArray(agents) && agents.length > 0
        ? agents
        : (await bwoc.listAgents(wsPath))?.data?.agents?.map((a) => a.id) ?? []
      const results = []
      for (const key of targets) {
        try {
          const { dir, id } = await bwoc.resolveAgent(wsPath, key)
          const out = await bwoc.setModuleState(wsPath, 'skill', name, action === 'enable', dir)
          results.push({ agent: id, ok: true, output: out.stdout.trim() })
        } catch (err) {
          results.push({ agent: key, ok: false, error: err.message })
        }
      }
      invalidate()
      return send(res, 200, {
        ok: results.every((r) => r.ok),
        succeeded: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      })
    }

    if (req.method === 'POST' && seg[1] === 'bwoc-update') {
      const { action } = await readBody(req)
      if (action === 'check') return send(res, 200, await checkUpdate())
      if (action === 'run') {
        const job = startUpdate()
        invalidate()
        return send(res, 202, { ok: true, job })
      }
      return send(res, 400, { error: `unknown update action: ${action}` })
    }

    if (req.method === 'POST' && seg[1] === 'agent-config') {
      const { workspace, agent, backend, primaryModel, fallbackModel } = await readBody(req)
      const wsPath = await bwoc.resolveWorkspace(workspace)
      const { dir, id } = await bwoc.resolveAgent(wsPath, agent)
      const out = await bwoc.setAgentConfig(wsPath, dir, { backend, primaryModel, fallbackModel })
      invalidate()
      return send(res, 200, { ok: true, agent: id, output: out.stdout.trim() })
    }

    if (req.method === 'POST' && seg[1] === 'workspace-maint') {
      const { workspace, action } = await readBody(req)
      const wsPath = await bwoc.resolveWorkspace(workspace)
      if (action === 'validate') {
        const r = await bwoc.workspaceValidate(wsPath)
        return send(res, 200, { ok: true, data: r?.data ?? null, error: r?.error ?? null })
      }
      if (action === 'prune' || action === 'prune-apply') {
        const out = await bwoc.workspacePrune(wsPath, action === 'prune-apply')
        if (action === 'prune-apply') invalidate()
        return send(res, 200, { ok: true, output: (out.stdout || out.stderr || '').trim() })
      }
      return send(res, 400, { error: `unknown maintenance action: ${action}` })
    }

    // ---- orchestrator ----

    if (req.method === 'GET' && seg[1] === 'orchestrate') {
      if (seg[2]) {
        const job = getJob(seg[2])
        if (!job) return send(res, 404, { error: `no orchestration job ${seg[2]}` })
        return send(res, 200, job)
      }
      return send(res, 200, { jobs: listJobs() })
    }

    if (req.method === 'POST' && seg[1] === 'orchestrate') {
      const { workspace, need, team, execute, dryRun } = await readBody(req)
      if (!need?.trim()) return send(res, 400, { error: 'a human need is required' })
      await bwoc.resolveWorkspace(workspace) // reject unknown workspaces up front
      const job = startOrchestration({
        workspace,
        need: need.trim(),
        team: team?.trim() || null,
        execute,
        dryRun,
      })
      invalidate()
      return send(res, 202, { id: job.id, state: job.state })
    }

    if (req.method === 'POST' && seg[1] === 'refresh') {
      invalidate()
      return send(res, 200, { ok: true })
    }

    return send(res, 404, { error: `no route for ${req.method} ${url.pathname}` })
  } catch (err) {
    const code = [400, 403, 404, 409, 413].includes(err?.code) ? err.code : 500
    return send(res, code, { error: err.message || String(err) })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[fleet-manager] api  → http://${HOST}:${PORT}`)
  console.log(`[fleet-manager] root → ${bwoc.WORKSPACE_ROOT}`)
  if (SERVE_STATIC) console.log(`[fleet-manager] serving built UI from ${DIST}`)
})
