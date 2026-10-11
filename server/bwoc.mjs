// Thin, safe wrapper around the `bwoc` CLI.
//
// Every call goes through execFile with an argv array — never a shell string —
// so workspace paths and agent names can't inject. Callers additionally resolve
// workspace/agent identifiers against the discovered fleet before they get here.

import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const BWOC = process.env.BWOC_BIN || 'bwoc'
const WORKSPACE_ROOT = process.env.BWOC_WORKSPACE_ROOT || path.join(homedir(), 'Workspaces')
const TIMEOUT_MS = 30_000

class BwocError extends Error {
  constructor(message, { code, stderr } = {}) {
    super(message)
    this.name = 'BwocError'
    this.code = code
    this.stderr = stderr
  }
}

function run(args, { timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(BWOC, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      // `bwoc doctor` exits non-zero when it finds problems and `bwoc audit`
      // uses the exit code as a finding count — a non-zero exit is data, not a
      // crash. Keep stdout whenever we got any, and let the caller decide.
      if (err && !stdout) {
        reject(new BwocError(stderr?.trim() || err.message, { code: err.code, stderr }))
        return
      }
      resolve({ stdout, stderr, code: err?.code ?? 0 })
    })
  })
}

async function runJson(args, fallback = null) {
  try {
    const { stdout, code } = await run([...args, '--json'])
    if (!stdout.trim()) return fallback
    return { data: JSON.parse(stdout), exitCode: code }
  } catch (err) {
    if (err instanceof BwocError) return { error: err.message, exitCode: err.code ?? 1 }
    // A non-JSON body means the CLI changed shape under us — surface it rather
    // than silently rendering an empty dashboard.
    return { error: `unparseable output from \`bwoc ${args.join(' ')}\`: ${err.message}` }
  }
}

/** Discover every BWOC workspace under the workspace root. */
export async function discoverWorkspaces() {
  let entries = []
  try {
    entries = await readdir(WORKSPACE_ROOT, { withFileTypes: true })
  } catch {
    return []
  }

  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dir = path.join(WORKSPACE_ROOT, entry.name)
    const marker = path.join(dir, '.bwoc', 'workspace.toml')
    const isWorkspace = existsSync(marker)
    let mtime = null
    try {
      mtime = (await stat(isWorkspace ? marker : dir)).mtime.toISOString()
    } catch {
      /* unreadable — reported as a non-workspace below */
    }
    found.push({ name: entry.name, path: dir, isWorkspace, mtime })
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Resolve a caller-supplied workspace name to a real path.
 * Anything not in the discovered set is rejected — this is the trust boundary.
 */
export async function resolveWorkspace(name) {
  const all = await discoverWorkspaces()
  const hit = all.find((w) => w.name === name && w.isWorkspace)
  if (!hit) throw new BwocError(`unknown workspace: ${name}`, { code: 404 })
  return hit.path
}

/**
 * Resolve an agent within a workspace. `bwoc --agent` wants the *directory*
 * name (agents/<dir>), which is not always the registry id (agent-<dir>), so
 * map through the registry rather than trusting the caller's spelling.
 */
export async function resolveAgent(wsPath, idOrDir) {
  const listed = await listAgents(wsPath)
  const agents = listed.data?.agents ?? []
  const hit = agents.find((a) => a.id === idOrDir || path.basename(a.path) === idOrDir)
  if (!hit) throw new BwocError(`unknown agent: ${idOrDir}`, { code: 404 })
  return { id: hit.id, dir: path.basename(hit.path), agent: hit }
}

export const listAgents = (wsPath) => runJson(['list', '--workspace', wsPath])
export const fleetHealth = (wsPath) => runJson(['fleet', 'health', '--workspace', wsPath])
export const doctor = (wsPath) => runJson(['doctor', '--workspace', wsPath])
export const sessions = (wsPath) => runJson(['sessions', '--workspace', wsPath])
// `bwoc tasks` is deprecated since 3.2 (removal in 4.0); `task list --all` is
// the canonical form with byte-identical --json output.
export const tasks = (wsPath) => runJson(['task', 'list', '--all', '--workspace', wsPath])
// `bwoc peer list` has no --json (no bwoc version has had it), so runJson
// always failed here. Return its text report as-is.
export const peers = async (wsPath) => {
  try {
    const { stdout } = await run(['peer', 'list', '--workspace', wsPath])
    return { data: stdout.trim() }
  } catch (err) {
    return { error: err.message }
  }
}
export const agentStatus = (wsPath, agentId) =>
  runJson(['status', agentId, '--workspace', wsPath])
// `bwoc list --json` carries the backend but not the model; `status --json`
// with no agent name reports every agent's `primary_model` in one call.
export const statusAll = (wsPath) => runJson(['status', '--workspace', wsPath])
export const inbox = (wsPath, agentDir) =>
  runJson(['inbox', agentDir, '--workspace', wsPath])
export const skills = (wsPath) => runJson(['skill', 'list', '--workspace', wsPath])
export const plugins = (wsPath) => runJson(['plugin', 'list', '--workspace', wsPath])
export const workspaceInfo = (wsPath) => runJson(['workspace', 'info', wsPath])
export const workspaceValidate = (wsPath) => runJson(['workspace', 'validate', wsPath])
export const workspacePrune = (wsPath, apply) =>
  run(['workspace', 'prune', wsPath, ...(apply ? ['--apply'] : [])])

// ---- framework skill / plugin management ----

/**
 * `--allow-new-source` is required the first time a given source path is
 * installed into a workspace; passing it always is safe because the path
 * itself is resolved from the vetted catalog, never from the caller.
 */
export const installModule = (wsPath, kind, srcPath, upgrade) =>
  run([
    kind,
    'install',
    srcPath,
    '--workspace',
    wsPath,
    '--allow-new-source',
    ...(upgrade ? ['--upgrade'] : []),
  ])

export const setModuleState = (wsPath, kind, name, enabled, agentDir) =>
  run([
    kind,
    enabled ? 'enable' : 'disable',
    name,
    '--workspace',
    wsPath,
    // Skills are enabled per agent; plugins are workspace-wide and reject --agent.
    ...(kind === 'skill' && agentDir ? ['--agent', agentDir] : []),
  ])

export const removeModule = (wsPath, kind, name) =>
  run([kind, 'remove', name, '--workspace', wsPath, '--yes'])

/** Change an agent's backend / models in place (`bwoc set`). */
export const setAgentConfig = (wsPath, agentDir, { backend, primaryModel, fallbackModel }) => {
  const args = ['set', agentDir, '--workspace', wsPath]
  if (backend) args.push('--backend', backend)
  if (primaryModel) args.push('--primary-model', primaryModel)
  if (fallbackModel) args.push('--fallback-model', fallbackModel)
  if (args.length === 4) {
    throw new BwocError('nothing to change — pass a backend or a model', { code: 400 })
  }
  return run(args)
}

// ---- writes (each one is gated behind an explicit confirm in the UI) ----

export const sendMessage = (wsPath, agentDir, message) =>
  run(['send', agentDir, message, '--workspace', wsPath])

export const doctorAuto = (wsPath) => run(['doctor', '--workspace', wsPath, '--auto'])

/**
 * Agent lifecycle. `bwoc` models two *registry* states (active / stopped) and,
 * orthogonally, whether a `bwoc-agent --serve` daemon is running. That gives
 * three reachable positions, which is what the UI exposes:
 *
 *   start    → active  + daemon spawned   (live, answers `bwoc ping`)
 *   pause    → active  + no daemon        (registered and idle)
 *   stop     → stopped + daemon torn down (paused; files kept, reversible)
 *
 * There is no separate "pause" verb in the CLI — `bwoc start --no-daemon`
 * reaches the middle state, so pausing a *live* agent is stop-then-reactivate.
 * `--yes` is mandatory here: the server is not a TTY, so the CLI would
 * otherwise block on its confirmation prompt forever.
 */
const LIFECYCLE = {
  start: ['start', '--yes'],
  pause: ['start', '--yes', '--no-daemon'],
  stop: ['stop', '--yes'],
}

export async function setAgentState(wsPath, agentDir, action) {
  const verb = LIFECYCLE[action]
  if (!verb) throw new BwocError(`unsupported agent action: ${action}`, { code: 400 })

  // Pausing something that is currently live means tearing the daemon down
  // first; `start --no-daemon` on a running agent would leave it running.
  if (action === 'pause') {
    await run(['stop', agentDir, '--workspace', wsPath, '--yes']).catch(() => null)
  }
  const [cmd, ...flags] = verb
  return run([cmd, agentDir, '--workspace', wsPath, ...flags])
}

/** Same three verbs applied to every agent in the workspace (`--all`). */
export async function setAllAgentState(wsPath, action) {
  if (action === 'start') return run(['start', '--all', '--workspace', wsPath, '--yes'])
  if (action === 'pause') return run(['start', '--all', '--workspace', wsPath, '--yes', '--no-daemon'])
  if (action === 'stop') return run(['stop', '--all', '--workspace', wsPath, '--yes'])
  throw new BwocError(`unsupported bulk action: ${action}`, { code: 400 })
}

export const ping = (wsPath) => run(['ping', '--all', '--workspace', wsPath])

// ---- Saṅgha teams (groups) ----

export const listTeams = (wsPath) => runJson(['team', 'list', '--workspace', wsPath])
export const listTasks = (wsPath, team) => runJson(['task', 'list', team, '--workspace', wsPath])

export const createTeam = (wsPath, id, members) =>
  run(['team', 'create', id, '--members', members.join(','), '--workspace', wsPath])

export const retireTeam = (wsPath, id) =>
  run(['team', 'retire', id, '--workspace', wsPath, '--yes'])

export const addTask = (wsPath, team, title, { requiresPlan = false } = {}) =>
  run([
    'task',
    'add',
    team,
    title,
    '--workspace',
    wsPath,
    // bwoc 3.0 made the plan-approval gate the default and replaced
    // --requires-plan (opt in) with --no-plan (opt out).
    ...(requiresPlan ? [] : ['--no-plan']),
  ])

/** A team id must exist before it can be targeted — same trust rule as workspaces. */
export async function resolveTeam(wsPath, id) {
  const teams = await listTeams(wsPath)
  const hit = (teams?.data ?? []).find((t) => t.team === id)
  if (!hit) throw new BwocError(`unknown team: ${id}`, { code: 404 })
  return hit
}

export async function version() {
  try {
    const { stdout } = await run(['--version'])
    const { stdout: info } = await run(['info'])
    return { version: stdout.trim(), info: info.trim() }
  } catch (err) {
    return { version: 'unavailable', info: err.message }
  }
}

export { BwocError, WORKSPACE_ROOT }
