import type { Overview } from '../types'
import { RootAgents } from './RootAgents'
import { Card, Count, Empty, Stat } from './ui'

export function OverviewView({
  data,
  onOpen,
}: {
  data: Overview
  onOpen: (workspace: string) => void
}) {
  const { totals } = data
  const backends = Object.entries(totals.backends).sort((a, b) => b[1] - a[1])

  // Rank by what needs attention: failures first, then health warnings, then backlog.
  const rows = [...data.workspaces].sort((a, b) => {
    const score = (w: (typeof data.workspaces)[number]) =>
      w.doctor.fail * 1000 + w.health.fail * 500 + w.health.warn * 10 + Math.min(w.inboxTotal, 9)
    return score(b) - score(a) || a.name.localeCompare(b.name)
  })

  return (
    <>
      <div className="stat-grid">
        <Stat label="Workspaces" value={totals.workspaces} sub={`${totals.populated} populated`} />
        <Stat label="Agents" value={totals.agents} sub={backends.map(([b, n]) => `${b} ${n}`).join(' · ') || '—'} />
        <Stat label="Inbox backlog" value={totals.inbox} sub="unread messages" tone={totals.inbox > 0 ? 'warn' : undefined} />
        <Stat label="Running" value={totals.running} sub="agent processes" />
        <Stat label="Health warnings" value={totals.healthWarn} tone={totals.healthWarn > 0 ? 'warn' : undefined} sub="Aparihāniya-dhamma 7" />
        <Stat label="Doctor failures" value={totals.doctorFail} tone={totals.doctorFail > 0 ? 'fail' : undefined} sub="across all workspaces" />
      </div>

      <Card title="Workspaces" bodyless>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Workspace</th>
                <th className="num">Agents</th>
                <th className="num">Running</th>
                <th className="num">Inbox</th>
                <th>Health</th>
                <th>Doctor</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.name}>
                  <td>
                    <button className="link-cell" onClick={() => onOpen(w.name)} title={w.path}>
                      {w.name}
                    </button>
                  </td>
                  <td className="num">{w.agentCount || <span className="muted">—</span>}</td>
                  <td className="num">{w.runningCount || <span className="muted">—</span>}</td>
                  <td className="num">
                    {w.inboxTotal ? <strong>{w.inboxTotal}</strong> : <span className="muted">—</span>}
                  </td>
                  <td>
                    <div className="row">
                      <Count n={w.health.fail} status="fail" label="fail" />
                      <Count n={w.health.warn} status="warn" label="warn" />
                      {!w.health.fail && !w.health.warn && <span className="muted">ok</span>}
                    </div>
                  </td>
                  <td>
                    <div className="row">
                      <Count n={w.doctor.fail} status="fail" label="fail" />
                      <Count n={w.doctor.warn} status="warn" label="warn" />
                      <span className="muted mono">{w.doctor.pass} pass</span>
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <Empty>No BWOC workspaces found under {data.workspaceRoot}</Empty>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <RootAgents />

      {data.orphans.length > 0 && (
        <Card title={`Not a BWOC workspace (${data.orphans.length})`}>
          <p className="muted" style={{ marginTop: 0 }}>
            Directories under {data.workspaceRoot} with no <code className="mono">.bwoc/workspace.toml</code> —
            either unfinished setup or plain project folders.
          </p>
          <div className="row">
            {data.orphans.map((o) => (
              <span key={o.name} className="pill zero">
                <span className="dot" />
                {o.name}
              </span>
            ))}
          </div>
        </Card>
      )}
    </>
  )
}

/**
 * Shown while /overview runs (a few seconds of `bwoc` calls per workspace).
 * The workspace names are already known from the cheap /api/workspaces, so
 * the table's shape appears at once instead of a lone "Loading…".
 */
export function OverviewSkeleton({ names }: { names: string[] }) {
  return (
    <>
      <div className="stat-grid">
        {['Workspaces', 'Agents', 'Inbox backlog', 'Running', 'Health warnings', 'Doctor failures'].map((l) => (
          <Stat key={l} label={l} value={<span className="skeleton" style={{ width: 48 }} />} />
        ))}
      </div>
      <Card title={<span className="row">Workspaces <span className="spinner" /></span>} bodyless>
        <div className="table-wrap">
          <table>
            <tbody>
              {(names.length ? names : Array.from({ length: 8 }, (_, i) => `…${i}`)).map((n) => (
                <tr key={n}>
                  <td className="muted">{n.startsWith('…') ? <span className="skeleton" style={{ width: 140 }} /> : n}</td>
                  <td><span className="skeleton" style={{ width: 24 }} /></td>
                  <td><span className="skeleton" style={{ width: 90 }} /></td>
                  <td><span className="skeleton" style={{ width: 120 }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  )
}
