import type {
  AgentDetail,
  BulkResult,
  JobSummary,
  LifecycleAction,
  OrchestrationJob,
  Overview,
  ProjectFile,
  ProjectRow,
  TreeEntry,
  GatewayRoom,
  GatewayStatus,
  RootAgent,
  RootInbox,
  Settings,
  WorkspaceDetail,
  WorkspaceFrameworks,
} from './types'

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    // Every call carries `x-fleet-manager`; the server refuses writes without
    // it. A cross-site page cannot add a custom header without a CORS
    // preflight, which this server never answers.
    headers: init?.body
      ? { 'content-type': 'application/json', 'x-fleet-manager': '1' }
      : { 'x-fleet-manager': '1' },
  })
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`bad response from ${url}: ${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? res.statusText
    throw new Error(msg)
  }
  return body as T
}

export const getOverview = () => req<Overview>('/api/overview')

export const getWorkspaceNames = () => req<{ workspaces: string[] }>('/api/workspaces')

export const getVersion = () => req<{ version: string; info: string }>('/api/version')

export interface UpdateJob {
  running: boolean
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  output: string
}
export interface UpdateCheck {
  version: string
  check: string
  upToDate: boolean | null
  behind: number | null
  latestCommit: string | null
  checkedAt: string
  canUpdate: boolean
}
export const getUpdateStatus = () => req<{ canUpdate: boolean; job: UpdateJob | null }>('/api/bwoc-update')
export const checkBwocUpdate = () =>
  req<UpdateCheck>('/api/bwoc-update', { method: 'POST', body: JSON.stringify({ action: 'check' }) })
export const runBwocUpdate = () =>
  req<{ ok: true; job: UpdateJob }>('/api/bwoc-update', { method: 'POST', body: JSON.stringify({ action: 'run' }) })

export const getWorkspace = (name: string) =>
  req<WorkspaceDetail>(`/api/workspace/${encodeURIComponent(name)}`)

export const getAgent = (workspace: string, agent: string) =>
  req<AgentDetail>(
    `/api/workspace/${encodeURIComponent(workspace)}/agent/${encodeURIComponent(agent)}`,
  )

export const sendMessage = (workspace: string, agent: string, message: string) =>
  req<{ ok: true; output: string }>('/api/send', {
    method: 'POST',
    body: JSON.stringify({ workspace, agent, message }),
  })

export const doctorAuto = (workspace: string) =>
  req<{ ok: true; output: string }>('/api/doctor-auto', {
    method: 'POST',
    body: JSON.stringify({ workspace }),
  })

export const setAgentState = (workspace: string, agent: string, action: LifecycleAction) =>
  req<{ ok: true; output: string }>('/api/agent-state', {
    method: 'POST',
    body: JSON.stringify({ workspace, agent, action }),
  })

/** Empty `agents` means the whole workspace (`bwoc start|stop --all`). */
export const bulkState = (workspace: string, action: LifecycleAction, agents: string[]) =>
  req<BulkResult>('/api/bulk-state', {
    method: 'POST',
    body: JSON.stringify({ workspace, action, agents }),
  })

export const pingAll = (workspace: string) =>
  req<{ ok: true; output: string }>('/api/ping', {
    method: 'POST',
    body: JSON.stringify({ workspace }),
  })

export const createTeam = (workspace: string, id: string, members: string[]) =>
  req<{ ok: true; output: string }>('/api/team', {
    method: 'POST',
    body: JSON.stringify({ workspace, id, members }),
  })

export const retireTeam = (workspace: string, id: string) =>
  req<{ ok: true; output: string }>('/api/team-retire', {
    method: 'POST',
    body: JSON.stringify({ workspace, id }),
  })

export const addTask = (workspace: string, team: string, title: string, requiresPlan: boolean) =>
  req<{ ok: true; output: string }>('/api/task', {
    method: 'POST',
    body: JSON.stringify({ workspace, team, title, requiresPlan }),
  })

// ---- orchestrator ----

export const startOrchestration = (body: {
  workspace: string
  need: string
  team?: string | null
  execute?: boolean
  dryRun?: boolean
}) => req<{ id: string; state: string }>('/api/orchestrate', { method: 'POST', body: JSON.stringify(body) })

export const getJob = (id: string) => req<OrchestrationJob>(`/api/orchestrate/${encodeURIComponent(id)}`)

export const listJobs = () => req<{ jobs: JobSummary[] }>('/api/orchestrate')

// ---- settings / frameworks ----

export const getSettings = () => req<Settings>('/api/settings')

export const getFrameworks = (workspace: string) =>
  req<WorkspaceFrameworks>(`/api/frameworks/${encodeURIComponent(workspace)}`)

export const frameworkAction = (body: {
  workspace: string
  kind: 'skill' | 'plugin'
  name: string
  action: 'install' | 'enable' | 'disable' | 'remove'
  agent?: string
  upgrade?: boolean
}) => req<{ ok: true; output: string }>('/api/framework', { method: 'POST', body: JSON.stringify(body) })

export const frameworkBulk = (workspace: string, name: string, action: 'enable' | 'disable', agents: string[]) =>
  req<{ ok: boolean; succeeded: number; failed: number; results: { agent: string; ok: boolean; error?: string }[] }>(
    '/api/framework-bulk',
    { method: 'POST', body: JSON.stringify({ workspace, name, action, agents }) },
  )

export const setAgentConfig = (body: {
  workspace: string
  agent: string
  backend?: string
  primaryModel?: string
  fallbackModel?: string
}) => req<{ ok: true; output: string }>('/api/agent-config', { method: 'POST', body: JSON.stringify(body) })

export const workspaceMaint = (workspace: string, action: 'validate' | 'prune' | 'prune-apply') =>
  req<{ ok: true; output?: string; data?: unknown; error?: string | null }>('/api/workspace-maint', {
    method: 'POST',
    body: JSON.stringify({ workspace, action }),
  })

// ---- gateway mesh ----

export const getGatewayStatus = () => req<GatewayStatus>('/api/gateway/status')

export const getGatewayRoom = (limit = 50) => req<GatewayRoom>(`/api/gateway/room?limit=${limit}`)

export const sendGateway = (message: string, to?: string) =>
  req<{ ts: string; sent: string; results: { to: string; ok: boolean; detail: string }[] }>(
    '/api/gateway/send',
    { method: 'POST', body: JSON.stringify({ message, to }) },
  )

export const gatewayBridge = (action: 'start' | 'stop') =>
  req<{ ok: true; bridge: GatewayStatus['bridge'] }>('/api/gateway/bridge', {
    method: 'POST',
    body: JSON.stringify({ action }),
  })

// ---- root (standalone) agents ----

export const getRootAgents = () => req<{ dir: string; agents: RootAgent[] }>('/api/root/agents')

export const getRootInbox = (name: string, limit = 100) =>
  req<RootInbox>(`/api/root/inbox/${encodeURIComponent(name)}?limit=${limit}`)

const projectBase = (ws: string, project: string) =>
  `/api/projects/${encodeURIComponent(ws)}/${encodeURIComponent(project)}`

export const getProjects = (ws: string) =>
  req<{ projects: ProjectRow[] }>(`/api/projects/${encodeURIComponent(ws)}`)

export const getTree = (ws: string, project: string, path = '') =>
  req<{ path: string; entries: TreeEntry[]; truncated: boolean }>(
    `${projectBase(ws, project)}/tree?path=${encodeURIComponent(path)}`,
  )

export const getFile = (ws: string, project: string, path: string) =>
  req<ProjectFile>(`${projectBase(ws, project)}/file?path=${encodeURIComponent(path)}`)

export const saveFile = (ws: string, project: string, path: string, content: string, mtimeMs: number) =>
  req<{ path: string; size: number; mtimeMs: number }>(
    `${projectBase(ws, project)}/file?path=${encodeURIComponent(path)}`,
    { method: 'PUT', body: JSON.stringify({ content, mtimeMs }) },
  )
