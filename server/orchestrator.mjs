// Orchestrator — human need → plan → todos on the fleet → report.
//
// Four phases, matching the four things a run reports back:
//
//   PLAN     bwoc-harness decomposes the need against the live agent roster
//   COMMIT   each todo lands on a team's shared task list + the owner's inbox
//   EXECUTE  (optional) `bwoc run <agent> --task` per todo, output captured
//   REPORT   plan · output · outcome · summary
//
// Runs take minutes, so this is a job store: start one, poll it. Jobs live in
// memory — a restart loses history, which is the right trade for a local tool.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import * as bwoc from './bwoc.mjs'

const HARNESS = process.env.BWOC_HARNESS_BIN || 'bwoc-harness'
// When set, planning is delegated to a host-side sidecar instead of spawning the
// harness locally. Required in a container: the harness fail-closes on Linux when
// `kernel.yama.ptrace_scope=0`, and that sysctl is not namespaced.
const PLANNER_URL = process.env.BWOC_PLANNER_URL || null
const ENDPOINT = process.env.BWOC_HARNESS_ENDPOINT || 'http://localhost:11434/v1'
const MODEL = process.env.BWOC_HARNESS_MODEL || 'gemma4:latest'
const PLAN_TIMEOUT_MS = Number(process.env.BWOC_PLAN_TIMEOUT_MS || 300_000)
const RUN_TIMEOUT_S = Number(process.env.BWOC_RUN_TIMEOUT_S || 900)

const jobs = new Map()
let seq = 0

const nowIso = () => new Date().toISOString()

function newJob(input) {
  const id = `orc-${Date.now().toString(36)}-${(++seq).toString(36)}`
  const job = {
    id,
    createdAt: nowIso(),
    state: 'planning', // planning → committing → executing → done | failed
    input,
    phases: [],
    plan: null,
    output: [],
    outcome: null,
    summary: null,
    error: null,
  }
  jobs.set(id, job)
  return job
}

const phase = (job, name, status, detail) => {
  job.phases.push({ name, status, detail, at: nowIso() })
}

export const getJob = (id) => jobs.get(id) ?? null
export const listJobs = () =>
  [...jobs.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ id, createdAt, state, input, plan, outcome }) => ({
      id,
      createdAt,
      state,
      need: input.need,
      workspace: input.workspace,
      taskCount: plan?.plan?.length ?? 0,
      outcome: outcome ? { ok: outcome.ok, failed: outcome.failed } : null,
    }))

/** Roster the planner routes against: who exists, what they're for, how loaded. */
async function roster(wsPath) {
  const listed = await bwoc.listAgents(wsPath)
  const agents = listed?.data?.agents ?? []
  return Promise.all(
    agents.map(async (a) => {
      let role = null
      try {
        const manifest = JSON.parse(
          await readFile(path.join(wsPath, a.path, 'config.manifest.json'), 'utf8'),
        )
        role = manifest.agentRole ?? null
      } catch {
        // An agent without a readable manifest still gets routed — by id alone.
      }
      return {
        id: a.id,
        dir: a.path.split('/').pop(),
        role,
        backend: a.backend,
        status: a.status,
        inbox: a.inbox_count,
      }
    }),
  )
}

function planPrompt(need, agents) {
  const lines = agents
    .map((a) => `- ${a.id} — ${a.role ?? 'role unstated'} (backend: ${a.backend}, inbox: ${a.inbox})`)
    .join('\n')

  // The harness is a general agent; without a hard shape instruction it returns
  // prose. Ask for one JSON object and nothing else, then parse defensively.
  return `You are the fleet orchestrator. Decompose ONE human need into concrete todos and assign each to exactly one agent from the roster.

HUMAN NEED:
${need}

AGENT ROSTER (assign only these ids):
${lines}

Rules:
- Between 1 and 8 todos. Fewer, well-scoped todos beat many vague ones.
- Each todo states WHAT is needed, not how. One owner each.
- Route by role. Do not invent agent ids.
- "acceptance" must be checkable by someone who did not do the work.

Reply with ONE JSON object and NOTHING else — no prose, no code fence:
{"summary":"<2-3 sentence read of the need and the routing logic>","plan":[{"title":"<imperative todo>","agent":"<agent id from roster>","why":"<why this owner>","acceptance":"<how we know it is done>"}]}`
}

/**
 * A missing planner surfaces as a bare `spawn bwoc-harness ENOENT`, which says
 * nothing about what to do. Check once and fail with the actual remedy.
 */
async function assertHarnessPresent() {
  if (PLANNER_URL) {
    // Delegated planning — the local binary is irrelevant; the sidecar's health
    // is what determines whether a run can proceed.
    const res = await fetch(new URL('/health', PLANNER_URL), { signal: AbortSignal.timeout(8000) }).catch(
      (err) => {
        throw new Error(
          `planner sidecar at ${PLANNER_URL} is unreachable (${err.message}). Start it on the host ` +
            `with \`pnpm planner\` — the harness cannot run inside the container.`,
        )
      },
    )
    if (!res.ok) throw new Error(`planner sidecar at ${PLANNER_URL} returned ${res.status}`)
    return
  }
  const { execFile } = await import('node:child_process')
  await new Promise((resolve, reject) => {
    execFile(HARNESS, ['--help'], { timeout: 15_000 }, (err, _stdout, stderr) => {
      if (err && (err.code === 'ENOENT' || /ENOENT/.test(err.message))) {
        reject(
          new Error(
            `planner binary "${HARNESS}" is not on PATH. The orchestrator needs bwoc-harness; ` +
              `set BWOC_HARNESS_BIN to its path, or rebuild the image (it is built from the ` +
              `framework source alongside bwoc).`,
          ),
        )
        return
      }
      // The harness hardens itself against same-uid ptrace and refuses to start
      // when the kernel permits it (exit 70). `kernel.yama.ptrace_scope` is NOT
      // namespaced, so no per-container sysctl can satisfy it — the fix is
      // either host-wide or "run the planner outside the container".
      if (stderr && /ptrace_scope=0|PR_SET_DUMPABLE/.test(stderr)) {
        reject(
          new Error(
            'bwoc-harness refuses to start here: it fail-closes when the kernel permits same-uid ' +
              'ptrace (kernel.yama.ptrace_scope=0), because a turn-executor could read provider ' +
              'keys out of the parent\'s memory. This sysctl is not namespaced, so it cannot be set ' +
              'per-container. Either run the Fleet Manager on the host (macOS is unaffected — the ' +
              'guard is Linux-only), or harden the Docker VM once with ' +
              '`sysctl -w kernel.yama.ptrace_scope=1`. Planning is unavailable until then; every ' +
              'other feature works in the container.',
          ),
        )
        return
      }
      resolve() // any other exit code still proves the binary is usable
    })
  })
}

async function runHarness(prompt, workdir) {
  if (PLANNER_URL) {
    const res = await fetch(new URL('/plan', PLANNER_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, workdir }),
      signal: AbortSignal.timeout(PLAN_TIMEOUT_MS + 15_000),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.ok) throw new Error(body.error || `planner sidecar returned ${res.status}`)
    return body.stdout
  }
  return runHarnessLocal(prompt, workdir)
}

function runHarnessLocal(prompt, workdir) {
  return new Promise((resolve, reject) => {
    const args = [
      '--task',
      prompt,
      '--endpoint',
      ENDPOINT,
      '--model',
      MODEL,
      '--workdir',
      workdir,
      '--max-iterations',
      '4',
    ]
    execFile(
      HARNESS,
      args,
      { timeout: PLAN_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(stderr?.trim() || err.message))
        resolve(stdout)
      },
    )
  })
}

/**
 * The harness prints a banner, a retrospective, then the answer. Pull the last
 * balanced JSON object out rather than assuming the model obeyed "nothing else".
 */
export function extractPlan(text) {
  const candidates = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    let depth = 0
    let inStr = false
    let esc = false
    for (let j = i; j < text.length; j++) {
      const c = text[j]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          candidates.push(text.slice(i, j + 1))
          i = j
          break
        }
      }
    }
  }
  for (const raw of candidates.reverse()) {
    try {
      const obj = JSON.parse(raw)
      if (Array.isArray(obj?.plan)) return obj
    } catch {
      /* not the object we want — keep looking */
    }
  }
  throw new Error('the planner did not return a JSON object with a "plan" array')
}

function bwocRun(wsPath, agentDir, task) {
  return new Promise((resolve) => {
    const started = Date.now()
    execFile(
      process.env.BWOC_BIN || 'bwoc',
      [
        'run',
        agentDir,
        '--task',
        task,
        '--workspace',
        wsPath,
        '--timeout',
        String(RUN_TIMEOUT_S),
        '--json',
      ],
      { timeout: (RUN_TIMEOUT_S + 30) * 1000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - started
        try {
          const parsed = JSON.parse(stdout)
          resolve({ ok: parsed.exit_code === 0, durationMs, ...parsed })
        } catch {
          resolve({
            ok: false,
            durationMs,
            output: stdout || '',
            error: stderr?.trim() || err?.message || 'no JSON from bwoc run',
          })
        }
      },
    )
  })
}

/** Start a run. Returns immediately; the work continues in the background. */
export function startOrchestration({ workspace, need, team, execute, dryRun }) {
  const job = newJob({ workspace, need, team, execute: !!execute, dryRun: !!dryRun })
  void drive(job).catch((err) => {
    job.state = 'failed'
    job.error = err.message
    phase(job, 'error', 'fail', err.message)
  })
  return job
}

async function drive(job) {
  const { workspace, need, team, execute, dryRun } = job.input
  const wsPath = await bwoc.resolveWorkspace(workspace)

  // ---- PLAN ----
  phase(
    job,
    'plan',
    'running',
    PLANNER_URL ? `host planner sidecar ${PLANNER_URL}` : `harness ${MODEL} @ ${ENDPOINT}`,
  )
  await assertHarnessPresent()
  const agents = await roster(wsPath)
  if (agents.length === 0) throw new Error(`${workspace} has no agents to route to`)

  const raw = await runHarness(planPrompt(need, agents), wsPath)
  const parsed = extractPlan(raw)

  // Drop anything routed to an agent that isn't real — the model will
  // occasionally invent an owner, and a todo with no owner is worse than none.
  const byId = new Map(agents.map((a) => [a.id, a]))
  const rejected = []
  const items = []
  for (const item of parsed.plan) {
    const owner = byId.get(item.agent) ?? byId.get(`agent-${item.agent}`)
    if (!owner) {
      rejected.push({ ...item, reason: `unknown agent "${item.agent}"` })
      continue
    }
    items.push({ ...item, agent: owner.id, dir: owner.dir, role: owner.role })
  }
  if (items.length === 0) {
    throw new Error(`every todo was routed to an unknown agent (${rejected.length} rejected)`)
  }

  job.plan = { summary: parsed.summary ?? null, plan: items, rejected, rawPlanner: raw }
  phase(job, 'plan', 'ok', `${items.length} todo(s)${rejected.length ? `, ${rejected.length} rejected` : ''}`)

  if (dryRun) {
    job.state = 'done'
    job.outcome = { ok: 0, failed: 0, queued: 0, dryRun: true }
    job.summary = `${parsed.summary ?? ''}\n\nDry run — ${items.length} todo(s) planned, nothing dispatched.`.trim()
    phase(job, 'commit', 'skipped', 'dry run')
    return
  }

  // ---- COMMIT ----
  job.state = 'committing'
  phase(job, 'commit', 'running', team ? `team ${team}` : 'inbox only')

  if (team) {
    // A team may already exist; creating it again is not an error worth failing
    // the run over, so try and carry on either way.
    const members = [...new Set(items.map((i) => i.dir))]
    try {
      await bwoc.resolveTeam(wsPath, team)
    } catch {
      await bwoc.createTeam(wsPath, team, members).catch(() => null)
    }
  }

  for (const item of items) {
    item.committed = { task: null, inbox: null }
    if (team) {
      const res = await bwoc.addTask(wsPath, team, item.title).catch((e) => ({ stdout: '', error: e.message }))
      item.committed.task = res.error ?? res.stdout?.trim() ?? null
    }
    const msg = `${item.title}\n\nWhy you: ${item.why ?? '—'}\nDone when: ${item.acceptance ?? '—'}\n\n(from orchestrator ${job.id} — need: ${need})`
    const sent = await bwoc.sendMessage(wsPath, item.dir, msg).catch((e) => ({ stdout: '', error: e.message }))
    item.committed.inbox = sent.error ?? 'delivered'
  }
  phase(job, 'commit', 'ok', `${items.length} todo(s) dispatched`)

  // ---- EXECUTE ----
  if (execute) {
    job.state = 'executing'
    phase(job, 'execute', 'running', `bwoc run × ${items.length}`)
    for (const item of items) {
      const res = await bwocRun(wsPath, item.dir, item.title)
      item.run = { ok: res.ok, exitCode: res.exit_code ?? null, durationMs: res.durationMs }
      job.output.push({
        agent: item.agent,
        title: item.title,
        ok: res.ok,
        durationMs: res.durationMs,
        text: (res.output ?? res.error ?? '').toString(),
      })
    }
    phase(job, 'execute', 'ok', `${job.output.filter((o) => o.ok).length}/${items.length} succeeded`)
  } else {
    phase(job, 'execute', 'skipped', 'dispatch only — agents pick the work up from their inbox')
  }

  // ---- REPORT ----
  const ran = items.filter((i) => i.run)
  job.outcome = {
    ok: ran.filter((i) => i.run.ok).length,
    failed: ran.filter((i) => !i.run.ok).length,
    queued: items.length - ran.length,
    rejected: rejected.length,
    byAgent: items.reduce((acc, i) => {
      acc[i.agent] = (acc[i.agent] || 0) + 1
      return acc
    }, {}),
  }

  const head = job.plan.summary ? `${job.plan.summary}\n\n` : ''
  const routing = Object.entries(job.outcome.byAgent)
    .map(([a, n]) => `${a} (${n})`)
    .join(', ')
  const executed = execute
    ? `Executed ${ran.length}: ${job.outcome.ok} succeeded, ${job.outcome.failed} failed.`
    : `Dispatched to inboxes${team ? ` and team "${team}"` : ''}; not executed.`
  job.summary =
    `${head}${items.length} todo(s) routed to ${routing}. ${executed}` +
    (rejected.length ? ` ${rejected.length} todo(s) dropped for naming an unknown agent.` : '')

  job.state = 'done'
  phase(job, 'report', 'ok', job.summary)
}
