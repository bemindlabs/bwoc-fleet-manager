import { useEffect, useRef, useState } from 'react'
import { ask } from './ConfirmDialog'
import { getJob, listJobs, startOrchestration } from '../api'
import type { JobSummary, OrchestrationJob, WorkspaceDetail } from '../types'
import { Banner, Card, Empty, Pill, Stat } from './ui'

const TERMINAL = ['done', 'failed']

/**
 * Human need → plan → todos on the fleet → report.
 *
 * The planner runs `bwoc-harness` against the live agent roster, so routing is
 * grounded in who actually exists and what their manifest says they are for.
 */
export function Orchestrator({ data, onChanged }: { data: WorkspaceDetail; onChanged: () => void }) {
  const [need, setNeed] = useState('')
  const [team, setTeam] = useState('')
  const [execute, setExecute] = useState(false)
  const [dryRun, setDryRun] = useState(true)
  const [job, setJob] = useState<OrchestrationJob | null>(null)
  const [history, setHistory] = useState<JobSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const poll = useRef<number | null>(null)

  useEffect(() => {
    listJobs().then((r) => setHistory(r.jobs)).catch(() => setHistory([]))
  }, [])

  // Poll only while a job is live; stop the moment it reaches a terminal state.
  useEffect(() => {
    if (!job || TERMINAL.includes(job.state)) {
      if (poll.current) window.clearInterval(poll.current)
      poll.current = null
      return
    }
    poll.current = window.setInterval(async () => {
      try {
        const fresh = await getJob(job.id)
        setJob(fresh)
        if (TERMINAL.includes(fresh.state)) {
          onChanged()
          listJobs().then((r) => setHistory(r.jobs)).catch(() => {})
        }
      } catch (err) {
        setError((err as Error).message)
      }
    }, 3000)
    return () => {
      if (poll.current) window.clearInterval(poll.current)
    }
  }, [job, onChanged])

  async function run() {
    const text = need.trim()
    if (!text) return
    const mode = dryRun
      ? 'PLAN ONLY — nothing will be dispatched.'
      : execute
        ? `Dispatch to inboxes${team ? ` + team "${team}"` : ''} AND run each todo through its agent (bwoc run). This spends model time.`
        : `Dispatch to inboxes${team ? ` + team "${team}"` : ''}. Agents pick the work up themselves.`
    if (!(await ask(`Orchestrate in ${data.name}?\n\n${text}\n\n${mode}`))) return
    setStarting(true)
    setError(null)
    try {
      const { id } = await startOrchestration({
        workspace: data.name,
        need: text,
        team: team.trim() || null,
        execute,
        dryRun,
      })
      setJob(await getJob(id))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setStarting(false)
    }
  }

  const live = job && !TERMINAL.includes(job.state)

  return (
    <>
      <Card title="Orchestrator — human need → fleet todos">
        <textarea
          value={need}
          onChange={(e) => setNeed(e.target.value)}
          placeholder={`What do you need? e.g. "The OAuth console login is broken for social sign-in — find out why and get a fix ready for UAT."\n\nThe planner reads ${data.agents.length} agent(s) in ${data.name} with their roles, decomposes the need into todos, and routes each to one owner.`}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <input
            className="text-input"
            value={team}
            onChange={(e) => setTeam(e.target.value)}
            placeholder="team id (optional)"
            title="Also add each todo to this team's shared task list — created if it doesn't exist"
          />
          <label className="row muted" style={{ fontSize: 12, gap: 5 }}>
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
            plan only
          </label>
          <label className="row muted" style={{ fontSize: 12, gap: 5 }} title="Run each todo through its agent with `bwoc run` and capture the output">
            <input
              type="checkbox"
              checked={execute}
              disabled={dryRun}
              onChange={(e) => setExecute(e.target.checked)}
            />
            execute todos
          </label>
          <button className="btn primary" onClick={run} disabled={!need.trim() || starting || !!live}>
            {starting || live ? <span className="spinner" /> : null}{' '}
            {live ? `${job!.state}…` : dryRun ? 'Plan' : 'Plan & dispatch'}
          </button>
        </div>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          Planning runs <code className="mono">bwoc-harness</code> locally. Todos routed to an agent that isn't in this
          workspace are dropped, not guessed at.
        </p>
      </Card>

      {error && <Banner kind="error">{error}</Banner>}
      {job?.error && <Banner kind="error">{job.error}</Banner>}

      {job && (
        <>
          <div className="stat-grid">
            <Stat label="State" value={job.state} sub={job.id} tone={job.state === 'failed' ? 'fail' : undefined} />
            <Stat label="Todos" value={job.plan?.plan.length ?? 0} sub={job.input.dryRun ? 'plan only' : 'dispatched'} />
            <Stat
              label="Succeeded"
              value={job.outcome?.ok ?? 0}
              sub={job.input.execute ? 'bwoc run' : 'not executed'}
            />
            <Stat
              label="Failed"
              value={job.outcome?.failed ?? 0}
              tone={(job.outcome?.failed ?? 0) > 0 ? 'fail' : undefined}
              sub={job.outcome?.rejected ? `${job.outcome.rejected} rejected` : '—'}
            />
          </div>

          {/* PLAN */}
          <Card title="Plan" bodyless>
            {!job.plan ? (
              <Empty>
                <span className="spinner" /> The planner is decomposing the need…
              </Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Todo</th>
                      <th>Owner</th>
                      <th>Why this owner</th>
                      <th>Done when</th>
                      <th>Dispatch</th>
                    </tr>
                  </thead>
                  <tbody>
                    {job.plan.plan.map((it, i) => (
                      <tr key={i}>
                        <td className="wrap">{it.title}</td>
                        <td>
                          <div>{it.agent}</div>
                          {it.role && <div className="muted" style={{ fontSize: 11 }}>{it.role}</div>}
                        </td>
                        <td className="wrap muted">{it.why ?? '—'}</td>
                        <td className="wrap muted">{it.acceptance ?? '—'}</td>
                        <td>
                          {it.run ? (
                            <Pill status={it.run.ok ? 'ok' : 'fail'}>
                              {it.run.ok ? 'ran ok' : `exit ${it.run.exitCode}`}
                            </Pill>
                          ) : it.committed ? (
                            <Pill status="info">queued</Pill>
                          ) : (
                            <Pill status="warn">planned</Pill>
                          )}
                        </td>
                      </tr>
                    ))}
                    {job.plan.rejected.map((r, i) => (
                      <tr key={`rej-${i}`}>
                        <td className="wrap muted">{r.title}</td>
                        <td colSpan={4}>
                          <Pill status="fail">dropped — {r.reason}</Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="split">
            {/* OUTCOME */}
            <Card title="Outcome" bodyless>
              {job.phases.length === 0 ? (
                <Empty>No phases yet.</Empty>
              ) : (
                job.phases.map((p, i) => (
                  <div className="signal" key={i}>
                    <Pill
                      status={
                        p.status === 'ok' ? 'ok' : p.status === 'fail' ? 'fail' : p.status === 'skipped' ? 'info' : 'warn'
                      }
                    >
                      {p.status}
                    </Pill>
                    <div>
                      <div className="signal-name">{p.name}</div>
                      <div className="signal-finding">{p.detail}</div>
                      <div className="muted mono" style={{ fontSize: 11 }}>
                        {new Date(p.at).toLocaleTimeString()}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </Card>

            {/* SUMMARY */}
            <Card title="Summary">
              {job.summary ? (
                <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{job.summary}</p>
              ) : (
                <Empty>Written when the run reaches a terminal state.</Empty>
              )}
              {job.outcome?.byAgent && (
                <div className="row" style={{ marginTop: 12 }}>
                  {Object.entries(job.outcome.byAgent).map(([a, n]) => (
                    <span key={a} className="pill info">
                      <span className="dot" />
                      {a} · {n}
                    </span>
                  ))}
                </div>
              )}
            </Card>
          </div>

          {/* OUTPUT */}
          <Card title={`Output — ${job.output.length} agent run(s)`}>
            {job.output.length === 0 ? (
              <Empty>
                {job.input.execute
                  ? 'No agent output yet.'
                  : 'Not executed — todos were dispatched to inboxes for the agents to pick up.'}
              </Empty>
            ) : (
              job.output.map((o, i) => (
                <div className="msg" key={i}>
                  <div className="msg-head">
                    <Pill status={o.ok ? 'ok' : 'fail'}>{o.agent}</Pill>
                    <span>{o.title}</span>
                    <span className="topbar-spacer" />
                    <span className="mono">{(o.durationMs / 1000).toFixed(1)}s</span>
                  </div>
                  <div className="msg-body">{o.text || '(no output)'}</div>
                </div>
              ))
            )}
          </Card>
        </>
      )}

      {history.length > 0 && (
        <Card title={`Previous runs (${history.length})`} bodyless>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Workspace</th>
                  <th>Need</th>
                  <th className="num">Todos</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className="muted mono">{new Date(h.createdAt).toLocaleTimeString()}</td>
                    <td>{h.workspace}</td>
                    <td className="wrap">
                      <button className="link-cell" onClick={() => getJob(h.id).then(setJob).catch(() => {})}>
                        {h.need.slice(0, 90)}
                        {h.need.length > 90 ? '…' : ''}
                      </button>
                    </td>
                    <td className="num">{h.taskCount}</td>
                    <td>
                      <Pill status={h.state === 'done' ? 'ok' : h.state === 'failed' ? 'fail' : 'warn'}>{h.state}</Pill>
                    </td>
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
