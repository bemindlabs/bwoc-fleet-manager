export type SignalStatus = 'ok' | 'warn' | 'fail' | 'info'

export interface Agent {
  id: string
  path: string
  backend: string
  /** From the agent's manifest via `bwoc status --json`; null if unreadable. */
  primary_model?: string | null
  status: string
  running: boolean
  inbox_count: number
  incarnated: string | null
  trust_tier: string | null
  uptime_seconds: number | null
}

export interface HealthSignal {
  condition: number
  name: string
  status: SignalStatus
  finding: string
}

export interface HealthSummary {
  signals: HealthSignal[]
  ok: number
  warn: number
  fail: number
  info: number
}

export interface DoctorResult {
  name: string
  status: 'pass' | 'warn' | 'fail'
  detail: string | null
}

export interface DoctorSummary {
  results: DoctorResult[]
  pass: number
  warn: number
  fail: number
}

export interface WorkspaceRow {
  name: string
  path: string
  error: string | null
  agents: Agent[]
  agentCount: number
  inboxTotal: number
  runningCount: number
  stoppedCount: number
  health: HealthSummary
  doctor: DoctorSummary
}

export interface Overview {
  generatedAt: string
  workspaceRoot: string
  orphans: { name: string; path: string; isWorkspace: boolean }[]
  workspaces: WorkspaceRow[]
  totals: {
    workspaces: number
    populated: number
    agents: number
    inbox: number
    running: number
    healthWarn: number
    doctorFail: number
    backends: Record<string, number>
  }
}

export interface Session {
  pid: number
  backend: string
  agentId: string | null
  state: string
  source: string
  startedAt: string | null
  lastActivity: string | null
}

export type LifecycleAction = 'start' | 'pause' | 'stop'

export interface TeamTask {
  id?: string
  title?: string
  state?: string
  claimed_by?: string | null
  [k: string]: unknown
}

export interface TeamRow {
  team: string
  createdAt: string | null
  members: { member: string; agent: Agent | null }[]
  memberCount: number
  liveCount: number
  danglingCount: number
  tasks: TeamTask[]
}

export interface BulkResult {
  ok: boolean
  scope: 'all' | 'selection'
  action: LifecycleAction
  succeeded?: number
  failed?: number
  results?: { agent: string; ok: boolean; output?: string; error?: string }[]
  output?: string
}

export interface WorkspaceDetail {
  name: string
  path: string
  agents: Agent[]
  health: HealthSummary
  doctor: DoctorSummary
  sessions: Session[]
  tasks: unknown[]
  skills: { skills?: { name: string; version: string; maturity: string; description: string }[] } | null
  teams: TeamRow[]
}

export interface InboxMessage {
  from?: string
  message?: string
  ts?: string
  [k: string]: unknown
}

export interface AgentDetail {
  workspace: string
  id: string
  dir: string
  agent: Agent
  status: Record<string, unknown> | null
  statusError: string | null
  inbox: InboxMessage[]
  inboxPath: string | null
}

// ---- orchestrator ----

export interface PlanItem {
  title: string
  agent: string
  dir: string
  role: string | null
  why?: string
  acceptance?: string
  committed?: { task: string | null; inbox: string | null }
  run?: { ok: boolean; exitCode: number | null; durationMs: number }
}

export interface OrchestrationJob {
  id: string
  createdAt: string
  state: 'planning' | 'committing' | 'executing' | 'done' | 'failed'
  input: { workspace: string; need: string; team: string | null; execute: boolean; dryRun: boolean }
  phases: { name: string; status: string; detail: string; at: string }[]
  plan: { summary: string | null; plan: PlanItem[]; rejected: { title: string; agent: string; reason: string }[] } | null
  output: { agent: string; title: string; ok: boolean; durationMs: number; text: string }[]
  outcome: { ok: number; failed: number; queued: number; rejected?: number; dryRun?: boolean; byAgent?: Record<string, number> } | null
  summary: string | null
  error: string | null
}

export interface JobSummary {
  id: string
  createdAt: string
  state: OrchestrationJob['state']
  need: string
  workspace: string
  taskCount: number
  outcome: { ok: number; failed: number } | null
}

// ---- settings / frameworks ----

export interface CatalogItem {
  id: string
  group: string | null
  path: string
  name: string | null
  version: string | null
  description: string | null
  maturity: string | null
  kind: string | null
  compat: string | null
}

export interface Settings {
  bwoc: { version: string; bin: string; info: string }
  framework: { source: string; tag: string | null; modulesMtime: string | null }
  fleet: { workspaceRoot: string; workspaces: number; nonWorkspaces: string[] }
  server: { port: number; bindHost: string; serveStatic: boolean; inContainer: boolean; nodeVersion: string }
  orchestrator: {
    harnessBin: string
    endpoint: string
    model: string
    planTimeoutMs: number
    runTimeoutS: number
  }
  catalog: { source: string; available: boolean; skills: CatalogItem[]; plugins: CatalogItem[] }
}

export interface InstalledSkill {
  name: string
  version: string
  maturity: string
  description: string
}

export interface InstalledPlugin {
  name: string
  kind: string
  version: string
  /** null = installed but with no workspace.toml entry yet (disable would error). */
  enabled: boolean | null
  description: string
  compat?: string
}

export interface WorkspaceFrameworks {
  workspace: string
  skills: InstalledSkill[]
  plugins: InstalledPlugin[]
  agents: { agent: string; dir: string; skills: { name: string; enabled: boolean }[] }[]
}

// ---- gateway mesh ----

export interface GatewayStatus {
  self: string
  relay: string
  room: string
  members: string[]
  identity: boolean
  clientInstalled: boolean
  bridge: { running: boolean; pids: string[]; duplicate: boolean }
  inboxMissing: boolean
}

export interface GatewayMessage {
  from: string | null
  ts: string | null
  inRoom: boolean
  text: string
  raw: string
}

export interface GatewayRoom {
  room: string
  messages: GatewayMessage[]
  inboxMissing: boolean
}

// ---- root (standalone) agents ----

export interface RootAgent {
  id: string
  name: string
  dir: string
  role: string | null
  model: string | null
  version: string | null
  inboxCount: number
  hasIdentity: boolean
  meshMember: boolean
}

export interface RootInbox {
  agent: string
  inbox: string
  total?: number
  missing: boolean
  messages: { from: string | null; to: string | null; ts: string | null; messageId: string | null; room: string | null; text: string }[]
}

export interface ProjectRow {
  name: string
  git: {
    branch: string
    dirty: number | null
    lastCommit: { hash: string; date: string; subject: string } | null
  } | null
}

export interface TreeEntry {
  name: string
  type: 'dir' | 'file'
  path: string
}

export interface ProjectFile {
  path: string
  size: number
  mtimeMs: number
  content: string | null
  binary?: boolean
  tooLarge?: boolean
}
