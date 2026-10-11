import { useEffect, useRef, useState } from 'react'
import { ask } from './ConfirmDialog'
import {
  checkBwocUpdate,
  frameworkAction,
  frameworkBulk,
  getFrameworks,
  getSettings,
  getUpdateStatus,
  runBwocUpdate,
  type UpdateCheck,
  type UpdateJob,
  setAgentConfig,
  workspaceMaint,
} from '../api'
import type { Overview, Settings, WorkspaceFrameworks } from '../types'
import { Banner, Card, Empty, Pill, Stat } from './ui'
import type { SettingsSection } from './Sidebar'

export function SettingsView({ overview, section }: { overview: Overview | null; section: SettingsSection }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    getSettings().then(setSettings).catch((e) => setError((e as Error).message))
  }, [])

  return (
    <>
      {error && <Banner kind="error">{error}</Banner>}
      {note && <Banner kind={note.kind}>{note.text}</Banner>}

      {!settings ? (
        <Empty>
          <span className="spinner" /> Loading settings…
        </Empty>
      ) : section === 'fleet' ? (
        <FleetSettings settings={settings} overview={overview} notify={setNote} />
      ) : (
        <Frameworks settings={settings} overview={overview} notify={setNote} />
      )}
    </>
  )
}

type Notify = (n: { kind: 'ok' | 'error'; text: string }) => void

function Row({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <tr>
      <td style={{ width: 200 }}>{label}</td>
      <td className="mono wrap">{value}</td>
      <td className="muted wrap">{hint ?? ''}</td>
    </tr>
  )
}

function BwocUpdate({ notify }: { notify: Notify }) {
  const [check, setCheck] = useState<UpdateCheck | null>(null)
  const [job, setJob] = useState<UpdateJob | null>(null)
  const [canUpdate, setCanUpdate] = useState(false)
  const [checking, setChecking] = useState(false)
  const [starting, setStarting] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)

  const refreshJob = () =>
    getUpdateStatus()
      .then((r) => (setJob(r.job), setCanUpdate(r.canUpdate)))
      .catch(() => {})

  async function runCheck() {
    setChecking(true)
    try {
      setCheck(await checkBwocUpdate())
    } catch (e) {
      notify({ kind: 'error', text: (e as Error).message })
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    void refreshJob()
    void runCheck()
  }, [])

  // Poll while an update runs; re-check once it finishes.
  const running = job?.running ?? false
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => void refreshJob(), 2000)
    return () => clearInterval(t)
  }, [running])
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && !running) void runCheck()
    wasRunning.current = running
  }, [running])
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [job?.output])

  async function update() {
    if (
      !(await ask(
        'Update bwoc now?\n\nPulls the framework source, rebuilds the CLI, verifies it (rolls back on failure) and pushes it to the other hosts. Takes a few minutes; running agents keep their current binary until restarted.',
      ))
    )
      return
    setStarting(true)
    try {
      const r = await runBwocUpdate()
      setJob(r.job)
    } catch (e) {
      notify({ kind: 'error', text: (e as Error).message })
    } finally {
      setStarting(false)
    }
  }

  const tone = check?.upToDate === false ? 'warn' : undefined
  const status =
    check == null
      ? 'checking…'
      : check.upToDate === true
        ? 'up to date'
        : check.upToDate === false
          ? check.behind
            ? `${check.behind} commit${check.behind === 1 ? '' : 's'} behind`
            : 'update available'
          : 'unknown (offline?)'

  return (
    <Card
      title="bwoc version"
      actions={
        <div className="row">
          <button className="btn sm" disabled={checking || running} onClick={runCheck}>
            {checking ? <span className="spinner" /> : null} Check for updates
          </button>
          <button
            className="btn sm primary"
            disabled={!canUpdate || running || starting}
            title={canUpdate ? undefined : 'BWOC_UPDATE_CMD is not set on the server'}
            onClick={update}
          >
            {running || starting ? <span className="spinner" /> : null} Update
          </button>
        </div>
      }
    >
      <div className="stat-grid">
        <Stat label="Installed" value={check?.version.replace('bwoc ', '') ?? '…'} />
        <Stat label="Status" value={status} tone={tone} sub={check?.latestCommit ?? undefined} />
      </div>
      {check?.check && (
        <p className="muted mono" style={{ fontSize: 12, margin: '10px 0 0' }}>
          {check.check}
        </p>
      )}
      {!canUpdate && (
        <p className="muted" style={{ fontSize: 12, margin: '10px 0 0' }}>
          Updating from here is disabled — set <code className="mono">BWOC_UPDATE_CMD</code> on the server to enable it.
        </p>
      )}
      {job && (
        <>
          <p className="muted" style={{ fontSize: 12, margin: '10px 0 4px' }}>
            {job.running
              ? `Update running since ${new Date(job.startedAt).toLocaleTimeString()}…`
              : `Last update ${job.exitCode === 0 ? 'finished' : `failed (exit ${job.exitCode})`} at ${new Date(job.finishedAt ?? job.startedAt).toLocaleTimeString()}`}
          </p>
          {job.output && (
            <pre ref={logRef} className="mono" style={{ maxHeight: 220, overflow: 'auto', fontSize: 12, margin: 0 }}>
              {job.output}
            </pre>
          )}
        </>
      )}
    </Card>
  )
}

function FleetSettings({
  settings,
  overview,
  notify,
}: {
  settings: Settings
  overview: Overview | null
  notify: Notify
}) {
  const [ws, setWs] = useState(overview?.workspaces[0]?.name ?? '')
  const [agent, setAgent] = useState('')
  const [backend, setBackend] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const agents = overview?.workspaces.find((w) => w.name === ws)?.agents ?? []

  async function maint(action: 'validate' | 'prune' | 'prune-apply') {
    if (action === 'prune-apply' && !(await ask(`Apply prune to ${ws}?\n\nRemoves phantom registry entries and orphan dirs it judges safe.`))) return
    setBusy(action)
    try {
      const r = await workspaceMaint(ws, action)
      notify({ kind: 'ok', text: r.output || JSON.stringify(r.data ?? r.error ?? 'ok') })
    } catch (e) {
      notify({ kind: 'error', text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  async function applyAgentConfig() {
    if (!agent) return
    if (!(await ask(`Update ${agent}?\n\n${backend ? `backend → ${backend}\n` : ''}${model ? `primary model → ${model}` : ''}`))) return
    setBusy('set')
    try {
      const r = await setAgentConfig({
        workspace: ws,
        agent,
        backend: backend || undefined,
        primaryModel: model || undefined,
      })
      notify({ kind: 'ok', text: r.output || 'updated' })
      setBackend('')
      setModel('')
    } catch (e) {
      notify({ kind: 'error', text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="stat-grid">
        <Stat label="bwoc" value={settings.bwoc.version.replace('bwoc ', '')} sub={settings.bwoc.bin} />
        <Stat label="Workspaces" value={settings.fleet.workspaces} sub={settings.fleet.workspaceRoot} />
        <Stat label="Runtime" value={settings.server.inContainer ? 'container' : 'host'} sub={settings.server.nodeVersion} />
        <Stat label="Catalog" value={settings.catalog.available ? 'linked' : 'missing'} tone={settings.catalog.available ? undefined : 'fail'} sub={settings.framework.tag ?? '—'} />
      </div>

      <BwocUpdate notify={notify} />

      <Card title="Runtime configuration" bodyless>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Setting</th>
                <th>Value</th>
                <th>Source / note</th>
              </tr>
            </thead>
            <tbody>
              <Row label="Workspace root" value={settings.fleet.workspaceRoot} hint="BWOC_WORKSPACE_ROOT" />
              <Row label="bwoc binary" value={settings.bwoc.bin} hint="BWOC_BIN" />
              <Row label="Framework source" value={settings.framework.source} hint="BWOC_FRAMEWORK_SRC — where the skill/plugin catalog is read from" />
              <Row label="Framework tag" value={settings.framework.tag ?? '—'} hint="git describe of the source checkout" />
              <Row label="API bind" value={`${settings.server.bindHost}:${settings.server.port}`} hint="BIND_HOST / PORT — 0.0.0.0 inside a container, loopback on the host" />
              <Row label="Serving built UI" value={String(settings.server.serveStatic)} hint="SERVE_STATIC" />
              <Row label="Planner endpoint" value={settings.orchestrator.endpoint} hint="BWOC_HARNESS_ENDPOINT" />
              <Row label="Planner model" value={settings.orchestrator.model} hint="BWOC_HARNESS_MODEL" />
              <Row label="Plan timeout" value={`${settings.orchestrator.planTimeoutMs / 1000}s`} hint="BWOC_PLAN_TIMEOUT_MS" />
              <Row label="Per-todo run timeout" value={`${settings.orchestrator.runTimeoutS}s`} hint="BWOC_RUN_TIMEOUT_S" />
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ padding: '10px 16px', margin: 0, fontSize: 12 }}>
          These come from the server's environment and are read-only here — change them in{' '}
          <code className="mono">.env</code> / compose and restart, so what the UI reports always matches what the
          process is actually using.
        </p>
      </Card>

      {settings.fleet.nonWorkspaces.length > 0 && (
        <Card title={`Not a BWOC workspace (${settings.fleet.nonWorkspaces.length})`}>
          <div className="row">
            {settings.fleet.nonWorkspaces.map((n) => (
              <span key={n} className="pill warn">
                <span className="dot" />
                {n}
              </span>
            ))}
          </div>
        </Card>
      )}

      <Card
        title="Workspace maintenance"
        actions={
          <div className="row">
            <select className="text-input" value={ws} onChange={(e) => setWs(e.target.value)}>
              {overview?.workspaces.map((w) => (
                <option key={w.name} value={w.name}>
                  {w.name}
                </option>
              ))}
            </select>
            <button className="btn sm" disabled={!ws || !!busy} onClick={() => maint('validate')}>
              Validate
            </button>
            <button className="btn sm" disabled={!ws || !!busy} onClick={() => maint('prune')}>
              Prune (dry run)
            </button>
            <button className="btn sm danger" disabled={!ws || !!busy} onClick={() => maint('prune-apply')}>
              Prune --apply
            </button>
          </div>
        }
      >
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          <strong>Validate</strong> runs the workspace rules. <strong>Prune</strong> finds phantom registry entries and
          orphan agent directories — always dry-run first; <code className="mono">--apply</code> only fixes what it
          judges safe.
        </p>
      </Card>

      <Card title="Agent backend & model">
        <div className="row">
          <select className="text-input" value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">select an agent…</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id} ({a.backend})
              </option>
            ))}
          </select>
          <input
            className="text-input"
            value={backend}
            onChange={(e) => setBackend(e.target.value)}
            placeholder="backend (claude, ollama…)"
          />
          <input
            className="text-input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="primary model"
          />
          <button
            className="btn primary"
            disabled={!agent || (!backend && !model) || busy === 'set'}
            onClick={applyAgentConfig}
          >
            {busy === 'set' ? <span className="spinner" /> : null} Apply
          </button>
        </div>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          Runs <code className="mono">bwoc set</code> against the agent's manifest. Leave a field blank to keep it.
        </p>
      </Card>
    </>
  )
}

function Frameworks({
  settings,
  overview,
  notify,
}: {
  settings: Settings
  overview: Overview | null
  notify: Notify
}) {
  const populated = overview?.workspaces.filter((w) => w.agentCount > 0) ?? []
  const [ws, setWs] = useState(populated[0]?.name ?? overview?.workspaces[0]?.name ?? '')
  const [data, setData] = useState<WorkspaceFrameworks | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const load = async (name: string) => {
    if (!name) return
    try {
      setData(await getFrameworks(name))
    } catch (e) {
      notify({ kind: 'error', text: (e as Error).message })
    }
  }

  useEffect(() => {
    void load(ws)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws])

  async function act(
    key: string,
    body: Parameters<typeof frameworkAction>[0],
    confirmText?: string,
  ) {
    if (confirmText && !(await ask(confirmText))) return
    setBusy(key)
    try {
      const r = await frameworkAction(body)
      notify({ kind: 'ok', text: r.output || `${body.action} ok` })
      await load(ws)
    } catch (e) {
      notify({ kind: 'error', text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const installedSkills = new Set(data?.skills.map((s) => s.name) ?? [])
  const installedPlugins = new Set(data?.plugins.map((p) => p.name) ?? [])

  const matches = (i: { id: string; description: string | null }) =>
    !filter ||
    i.id.toLowerCase().includes(filter.toLowerCase()) ||
    (i.description ?? '').toLowerCase().includes(filter.toLowerCase())

  return (
    <>
      <div className="stat-grid">
        <Stat label="Catalog skills" value={settings.catalog.skills.length} sub={`${installedSkills.size} installed here`} />
        <Stat label="Catalog plugins" value={settings.catalog.plugins.length} sub={`${installedPlugins.size} installed here`} />
        <Stat label="Agents" value={data?.agents.length ?? 0} sub={ws} />
        <Stat
          label="Enabled plugins"
          value={data?.plugins.filter((p) => p.enabled).length ?? 0}
          sub="workspace-wide"
        />
      </div>

      <Card
        title="Scope"
        actions={
          <div className="row">
            <select className="text-input" value={ws} onChange={(e) => setWs(e.target.value)}>
              {overview?.workspaces.map((w) => (
                <option key={w.name} value={w.name}>
                  {w.name} ({w.agentCount})
                </option>
              ))}
            </select>
            <input
              className="text-input"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter catalog…"
            />
          </div>
        }
      >
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Catalog read from <code className="mono">{settings.catalog.source}</code>. Installing copies the module into
          the workspace's <code className="mono">modules/</code>; <strong>skills</strong> are then enabled per agent,
          <strong> plugins</strong> workspace-wide.
        </p>
      </Card>

      {/* SKILLS */}
      <Card title={`Skills — ${settings.catalog.skills.filter(matches).length} in catalog`} bodyless>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Skill</th>
                <th>Version</th>
                <th>Maturity</th>
                <th>Description</th>
                <th className="num">Enabled on</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {settings.catalog.skills.filter(matches).map((s) => {
                const installed = installedSkills.has(s.id)
                const on = data?.agents.filter((a) => a.skills.some((x) => x.name === s.id && x.enabled)) ?? []
                return (
                  <tr key={s.id}>
                    <td className="mono">{s.id}</td>
                    <td className="muted mono">{s.version ?? '—'}</td>
                    <td>{s.maturity ? <Pill status="info">{s.maturity}</Pill> : <span className="muted">—</span>}</td>
                    <td className="wrap muted">{(s.description ?? '').slice(0, 140)}</td>
                    <td className="num">
                      {installed ? (
                        <span title={on.map((a) => a.agent).join(', ')}>
                          {on.length}/{data?.agents.length ?? 0}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <div className="row">
                        {!installed ? (
                          <button
                            className="btn sm primary"
                            disabled={busy === s.id}
                            onClick={() => act(s.id, { workspace: ws, kind: 'skill', name: s.id, action: 'install' })}
                          >
                            Install
                          </button>
                        ) : (
                          <>
                            <button
                              className="btn sm"
                              disabled={busy === s.id}
                              onClick={async () => {
                                if (!(await ask(`Enable "${s.id}" on all ${data?.agents.length ?? 0} agent(s) in ${ws}?`))) return
                                setBusy(s.id)
                                try {
                                  const r = await frameworkBulk(ws, s.id, 'enable', [])
                                  notify({
                                    kind: r.ok ? 'ok' : 'error',
                                    text: `${r.succeeded} enabled${r.failed ? `, ${r.failed} failed` : ''}`,
                                  })
                                  await load(ws)
                                } catch (e) {
                                  notify({ kind: 'error', text: (e as Error).message })
                                } finally {
                                  setBusy(null)
                                }
                              }}
                            >
                              Enable all
                            </button>
                            <button
                              className="btn sm danger"
                              disabled={busy === s.id}
                              onClick={() =>
                                act(
                                  s.id,
                                  { workspace: ws, kind: 'skill', name: s.id, action: 'remove' },
                                  `Remove skill "${s.id}" from ${ws}?\n\nDeletes modules/skills/${s.id} and cleans every consuming agent's manifest.`,
                                )
                              }
                            >
                              Remove
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* PER-AGENT SKILL MATRIX */}
      {data && data.skills.length > 0 && (
        <Card title="Per-agent skills" bodyless>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  {data.skills.map((s) => (
                    <th key={s.name}>{s.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.agents.map((a) => (
                  <tr key={a.agent}>
                    <td>{a.agent}</td>
                    {data.skills.map((s) => {
                      const entry = a.skills.find((x) => x.name === s.name)
                      const on = !!entry?.enabled
                      return (
                        <td key={s.name}>
                          <button
                            className={`btn sm${on ? ' primary' : ''}`}
                            disabled={busy === `${a.agent}:${s.name}`}
                            title={on ? 'Click to disable' : 'Click to enable'}
                            onClick={() =>
                              act(`${a.agent}:${s.name}`, {
                                workspace: ws,
                                kind: 'skill',
                                name: s.name,
                                action: on ? 'disable' : 'enable',
                                agent: a.agent,
                              })
                            }
                          >
                            {on ? 'on' : 'off'}
                          </button>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* PLUGINS */}
      <Card title={`Plugins — ${settings.catalog.plugins.filter(matches).length} in catalog`} bodyless>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Plugin</th>
                <th>Kind</th>
                <th>Compat</th>
                <th>Description</th>
                <th>State</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {settings.catalog.plugins.filter(matches).map((p) => {
                const inst = data?.plugins.find((x) => x.name === p.id)
                return (
                  <tr key={`${p.group ?? ''}/${p.id}`}>
                    <td className="mono">
                      {p.id}
                      {p.group && <span className="muted"> ({p.group})</span>}
                    </td>
                    <td className="mono muted">{p.kind ?? '—'}</td>
                    <td className="mono muted">{p.compat ?? '—'}</td>
                    <td className="wrap muted">{(p.description ?? '').slice(0, 120)}</td>
                    <td>
                      {!inst ? (
                        <span className="muted">not installed</span>
                      ) : inst.enabled == null ? (
                        // Freshly installed: no [plugins.x] entry in workspace.toml yet, so
                        // it is neither enabled nor disabled — and `disable` would error.
                        <Pill status="info">installed, unconfigured</Pill>
                      ) : (
                        <Pill status={inst.enabled ? 'ok' : 'warn'}>{inst.enabled ? 'enabled' : 'disabled'}</Pill>
                      )}
                    </td>
                    <td>
                      <div className="row">
                        {!inst ? (
                          <button
                            className="btn sm primary"
                            disabled={busy === p.id}
                            onClick={() => act(p.id, { workspace: ws, kind: 'plugin', name: p.id, action: 'install' })}
                          >
                            Install
                          </button>
                        ) : (
                          <>
                            <button
                              className="btn sm"
                              disabled={busy === p.id}
                              onClick={() =>
                                act(p.id, {
                                  workspace: ws,
                                  kind: 'plugin',
                                  name: p.id,
                                  action: inst.enabled ? 'disable' : 'enable',
                                })
                              }
                            >
                              {inst.enabled ? 'Disable' : 'Enable'}
                            </button>
                            <button
                              className="btn sm danger"
                              disabled={busy === p.id}
                              onClick={() =>
                                act(
                                  p.id,
                                  { workspace: ws, kind: 'plugin', name: p.id, action: 'remove' },
                                  `Remove plugin "${p.id}" from ${ws}?`,
                                )
                              }
                            >
                              Remove
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ padding: '10px 16px', margin: 0, fontSize: 12 }}>
          A plugin's <code className="mono">compat</code> gate is checked against the running bwoc (
          {settings.bwoc.version}) — the workspace refuses to load one that needs a newer binary.
        </p>
      </Card>
    </>
  )
}
