import { useMemo, useState } from 'react'
import { ask } from './ConfirmDialog'
import { bulkState, doctorAuto, pingAll } from '../api'
import type { LifecycleAction, WorkspaceDetail } from '../types'
import { Orchestrator } from './Orchestrator'
import { Projects } from './Projects'
import { Teams } from './Teams'
import { Banner, Card, Count, Empty, Pill, Stat, age } from './ui'

/** Sub-pages of a workspace — the sidebar's second level. */
export const WS_SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'teams', label: 'Teams' },
  { id: 'health', label: 'Health' },
  { id: 'skills', label: 'Skills' },
  { id: 'orchestrate', label: 'Orchestrate' },
  { id: 'projects', label: 'Projects' },
] as const
export type WsSection = (typeof WS_SECTIONS)[number]['id']

export function WorkspaceView({
  data,
  section,
  onOpenAgent,
  onChanged,
}: {
  data: WorkspaceDetail
  section: WsSection
  onOpenAgent: (agentId: string) => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [selected, setSelected] = useState<string[]>([])

  const fixable = data.doctor.fail > 0
  const notify = (kind: 'ok' | 'error', text: string) => setResult({ kind, text })

  // Drop any selection that no longer exists after a refresh.
  const selection = useMemo(
    () => selected.filter((id) => data.agents.some((a) => a.id === id)),
    [selected, data.agents],
  )
  const allSelected = data.agents.length > 0 && selection.length === data.agents.length

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  async function runBulk(action: LifecycleAction) {
    const scope = selection.length > 0 ? `${selection.length} selected agent(s)` : `ALL ${data.agents.length} agents`
    const detail = selection.length > 0 ? `\n\n${selection.join(', ')}` : ''
    if (!(await ask(`${action[0].toUpperCase() + action.slice(1)} ${scope} in ${data.name}?${detail}`))) return
    setBusy(true)
    setResult(null)
    try {
      const res = await bulkState(data.name, action, selection)
      const text =
        res.scope === 'all'
          ? res.output || `${action} applied workspace-wide`
          : res.failed && res.failed > 0
            ? `${res.succeeded} ok, ${res.failed} failed — ${res.results?.filter((r) => !r.ok).map((r) => `${r.agent}: ${r.error}`).join('; ')}`
            : `${action} applied to ${res.succeeded} agent(s)`
      notify(res.ok ? 'ok' : 'error', text)
      onChanged()
    } catch (err) {
      notify('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function runPing() {
    setBusy(true)
    try {
      const res = await pingAll(data.name)
      notify('ok', res.output || 'ping complete')
    } catch (err) {
      notify('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function runDoctorAuto() {
    // `doctor --auto` only removes provably-dead artifacts (stale PID/socket
    // files), but it is still a write — so it is explicit, never automatic.
    if (!(await ask(`Run \`bwoc doctor --auto\` on ${data.name}?\n\nThis removes stale PID/socket files in place.`))) return
    setBusy(true)
    setResult(null)
    try {
      const res = await doctorAuto(data.name)
      setResult({ kind: 'ok', text: res.output || 'done' })
      onChanged()
    } catch (err) {
      setResult({ kind: 'error', text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const inboxTotal = data.agents.reduce((n, a) => n + (a.inbox_count || 0), 0)

  if (section === 'projects') return <Projects workspace={data.name} />

  if (section === 'orchestrate') {
    return data.agents.length === 0 ? (
      <Empty>No agents to route work to in this workspace.</Empty>
    ) : (
      <Orchestrator data={data} onChanged={onChanged} />
    )
  }

  return (
    <>
      {result && <Banner kind={result.kind}>{result.text}</Banner>}

      {section === 'overview' && (
      <>
      <div className="stat-grid">
        <Stat label="Agents" value={data.agents.length} sub={`${data.agents.filter((a) => a.status === 'active').length} active`} />
        <Stat label="Inbox backlog" value={inboxTotal} tone={inboxTotal > 0 ? 'warn' : undefined} sub="unread messages" />
        <Stat label="Health" value={`${data.health.ok}/${data.health.signals.length}`} sub="signals ok" tone={data.health.warn > 0 ? 'warn' : undefined} />
        <Stat label="Doctor" value={data.doctor.pass} sub={`${data.doctor.warn} warn · ${data.doctor.fail} fail`} tone={data.doctor.fail > 0 ? 'fail' : undefined} />
        <Stat label="Sessions" value={data.sessions.length} sub="detected processes" />
        <Stat label="Tasks" value={data.tasks.length} sub="fleet-wide" />
      </div>

      <Card
        title={
          <span className="row">
            Agents
            {selection.length > 0 && <span className="pill info"><span className="dot" />{selection.length} selected</span>}
          </span>
        }
        actions={
          <div className="row">
            <button className="btn sm" onClick={runPing} disabled={busy} title="bwoc ping --all">
              Ping
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              {selection.length > 0 ? 'selection →' : 'whole workspace →'}
            </span>
            <button className="btn sm primary" disabled={busy || data.agents.length === 0} onClick={() => runBulk('start')}>
              Start
            </button>
            <button className="btn sm" disabled={busy || data.agents.length === 0} onClick={() => runBulk('pause')}>
              Pause
            </button>
            <button className="btn sm danger" disabled={busy || data.agents.length === 0} onClick={() => runBulk('stop')}>
              Stop
            </button>
          </div>
        }
        bodyless
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 34 }}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? [] : data.agents.map((a) => a.id))}
                    title={allSelected ? 'Clear selection' : 'Select all'}
                  />
                </th>
                <th>Agent</th>
                <th>Status</th>
                <th>Backend · model</th>
                <th>Trust</th>
                <th className="num">Inbox</th>
                <th className="num">Age</th>
                <th>Path</th>
              </tr>
            </thead>
            <tbody>
              {data.agents.map((a) => (
                <tr key={a.id}>
                  <td>
                    <input type="checkbox" checked={selection.includes(a.id)} onChange={() => toggle(a.id)} />
                  </td>
                  <td>
                    <button className="link-cell" onClick={() => onOpenAgent(a.id)}>
                      {a.id}
                    </button>
                  </td>
                  <td>
                    <Pill status={a.running ? 'ok' : a.status === 'active' ? 'info' : 'warn'}>
                      {a.running ? 'running' : a.status}
                    </Pill>
                  </td>
                  <td className="mono">
                    {a.backend}
                    {a.primary_model && <span className="muted"> · {a.primary_model}</span>}
                  </td>
                  <td className="mono muted">{a.trust_tier ?? '—'}</td>
                  <td className="num">
                    {a.inbox_count ? <strong>{a.inbox_count}</strong> : <span className="muted">—</span>}
                  </td>
                  <td className="num muted">{age(a.incarnated)}</td>
                  <td className="mono muted">{a.path}</td>
                </tr>
              ))}
              {data.agents.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <Empty>No agents registered in this workspace.</Empty>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      </>
      )}

      {section === 'teams' && (
      <Teams
        workspace={data.name}
        teams={data.teams}
        agents={data.agents}
        selection={selection}
        onToggle={toggle}
        onChanged={onChanged}
        notify={notify}
      />
      )}

      {section === 'health' && (
      <div className="split">
        <Card
          title={
            <span className="row">
              Fleet health
              <Count n={data.health.warn} status="warn" label="warn" />
              <Count n={data.health.fail} status="fail" label="fail" />
            </span>
          }
          bodyless
        >
          {data.health.signals.length === 0 ? (
            <Empty>No health signals returned.</Empty>
          ) : (
            data.health.signals.map((s) => (
              <div className="signal" key={s.condition}>
                <Pill status={s.status}>{s.status}</Pill>
                <div>
                  <div className="signal-name">
                    {s.condition}. {s.name}
                  </div>
                  <div className="signal-finding">{s.finding}</div>
                </div>
              </div>
            ))
          )}
        </Card>

        <Card
          title={
            <span className="row">
              Doctor
              <Count n={data.doctor.warn} status="warn" label="warn" />
              <Count n={data.doctor.fail} status="fail" label="fail" />
            </span>
          }
          actions={
            <button className="btn sm" onClick={runDoctorAuto} disabled={busy || !fixable}
              title={fixable ? 'Remove stale PID/socket files' : 'Nothing failing to fix'}>
              {busy ? <span className="spinner" /> : null} doctor --auto
            </button>
          }
          bodyless
        >
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Status</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {data.doctor.results
                  .filter((r) => r.status !== 'pass')
                  .map((r, i) => (
                    <tr key={`${r.name}-${i}`}>
                      <td>{r.name}</td>
                      <td>
                        <Pill status={r.status === 'fail' ? 'fail' : 'warn'}>{r.status}</Pill>
                      </td>
                      <td className="wrap muted">{r.detail ?? '—'}</td>
                    </tr>
                  ))}
                {data.doctor.results.every((r) => r.status === 'pass') && (
                  <tr>
                    <td colSpan={3}>
                      <Empty>All {data.doctor.pass} checks pass.</Empty>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ padding: '10px 16px', margin: 0, fontSize: 12 }}>
            Passing checks hidden — {data.doctor.pass} pass.
          </p>
        </Card>
      </div>
      )}

      {section === 'skills' && !data.skills?.skills?.length && <Empty>No skills installed in this workspace.</Empty>}
      {section === 'skills' && data.skills?.skills && data.skills.skills.length > 0 && (
        <Card title={`Installed skills (${data.skills.skills.length})`} bodyless>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Skill</th>
                  <th>Version</th>
                  <th>Maturity</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {data.skills.skills.map((s) => (
                  <tr key={s.name}>
                    <td className="mono">{s.name}</td>
                    <td className="mono muted">{s.version}</td>
                    <td>
                      <Pill status="info">{s.maturity}</Pill>
                    </td>
                    <td className="wrap muted">{s.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  )
}
