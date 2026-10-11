import { useState } from 'react'
import { ask } from './ConfirmDialog'
import { addTask, bulkState, createTeam, retireTeam } from '../api'
import type { Agent, LifecycleAction, TeamRow } from '../types'
import { Card, Empty, Pill } from './ui'

type Notify = (kind: 'ok' | 'error', text: string) => void

/**
 * Saṅgha teams — a named subset of agents sharing a task list. This is the
 * unit of group management: lifecycle actions and task hand-offs apply to a
 * whole team at once.
 */
export function Teams({
  workspace,
  teams,
  agents,
  selection,
  onToggle,
  onChanged,
  notify,
}: {
  workspace: string
  teams: TeamRow[]
  agents: Agent[]
  /** Shared with the Overview agent table, so a selection made there carries over. */
  selection: string[]
  onToggle: (agentId: string) => void
  onChanged: () => void
  notify: Notify
}) {
  const [newTeam, setNewTeam] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [taskDraft, setTaskDraft] = useState<Record<string, string>>({})
  const [requiresPlan, setRequiresPlan] = useState<Record<string, boolean>>({})

  async function guard(key: string, confirmText: string, fn: () => Promise<{ output: string }>) {
    if (!(await ask(confirmText))) return
    setBusy(key)
    try {
      const res = await fn()
      notify('ok', res.output || `${key} ok`)
      onChanged()
    } catch (err) {
      notify('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function teamLifecycle(team: TeamRow, action: LifecycleAction) {
    // Only members that resolve to a real agent can be acted on; dangling
    // names are reported rather than silently dropped.
    const live = team.members.filter((m) => m.agent).map((m) => m.agent!.id)
    if (live.length === 0) {
      notify('error', `${team.team} has no resolvable agents in this workspace.`)
      return
    }
    const skipped = team.danglingCount ? `\n\n${team.danglingCount} member(s) not in this registry will be skipped.` : ''
    await guard(
      `${team.team}:${action}`,
      `${action[0].toUpperCase() + action.slice(1)} all ${live.length} live member(s) of "${team.team}"?\n\n${live.join(', ')}${skipped}`,
      async () => {
        const res = await bulkState(workspace, action, live)
        return {
          output:
            res.failed && res.failed > 0
              ? `${res.succeeded} ok, ${res.failed} failed — ${res.results?.filter((r) => !r.ok).map((r) => `${r.agent}: ${r.error}`).join('; ')}`
              : `${action} applied to ${res.succeeded} agent(s) in ${team.team}`,
        }
      },
    )
  }

  return (
    <Card
      title={`Groups — Saṅgha teams (${teams.length})`}
      actions={
        <div className="row">
          <input
            value={newTeam}
            onChange={(e) => setNewTeam(e.target.value)}
            placeholder="new team id"
            className="text-input"
          />
          <button
            className="btn primary sm"
            disabled={!newTeam.trim() || selection.length === 0 || busy === 'create'}
            title={
              selection.length === 0
                ? 'Pick members below to form a team'
                : `Create from ${selection.length} selected agent(s)`
            }
            onClick={() =>
              guard(
                'create',
                `Create team "${newTeam.trim()}" with ${selection.length} member(s)?\n\n${selection.join(', ')}`,
                async () => {
                  const res = await createTeam(workspace, newTeam.trim(), selection)
                  setNewTeam('')
                  return res
                },
              )
            }
          >
            {busy === 'create' ? <span className="spinner" /> : null} Create from selection ({selection.length})
          </button>
        </div>
      }
      bodyless
    >
      {agents.length > 0 && (
        <div className="member-picker">
          <span className="muted">New team members:</span>
          {agents.map((a) => {
            const on = selection.includes(a.id)
            return (
              <button
                key={a.id}
                className={`pill pick${on ? ' info' : ' zero'}`}
                aria-pressed={on}
                onClick={() => onToggle(a.id)}
              >
                <span className="dot" />
                {a.id}
              </button>
            )
          })}
        </div>
      )}
      {teams.length === 0 ? (
        <Empty>
          No teams in this workspace. Pick members above, name the team and create it — a team shares a task list
          (<code className="mono">bwoc task</code>) and can be started or stopped together.
        </Empty>
      ) : (
        teams.map((t) => (
          <div key={t.team} className="team">
            <div className="team-head">
              <div>
                <span className="team-name">{t.team}</span>{' '}
                <span className="muted" style={{ fontSize: 12 }}>
                  {t.liveCount}/{t.memberCount} live
                  {t.danglingCount > 0 && (
                    <> · <span style={{ color: 'var(--warn)' }}>{t.danglingCount} not in registry</span></>
                  )}
                  {t.tasks.length > 0 && <> · {t.tasks.length} task(s)</>}
                </span>
              </div>
              <div className="topbar-spacer" />
              <div className="row">
                <button className="btn sm" disabled={!!busy} onClick={() => teamLifecycle(t, 'start')}>
                  Start all
                </button>
                <button className="btn sm" disabled={!!busy} onClick={() => teamLifecycle(t, 'pause')}>
                  Pause all
                </button>
                <button className="btn sm danger" disabled={!!busy} onClick={() => teamLifecycle(t, 'stop')}>
                  Stop all
                </button>
                <button
                  className="btn sm danger"
                  disabled={!!busy}
                  onClick={() =>
                    guard(
                      `retire:${t.team}`,
                      `Retire team "${t.team}"?\n\nRemoves its membership file and task list. The agents themselves are untouched.`,
                      () => retireTeam(workspace, t.team),
                    )
                  }
                >
                  Retire
                </button>
              </div>
            </div>

            <div className="team-members">
              {t.members.map((m) => (
                <span
                  key={m.member}
                  className={`pill ${m.agent ? (m.agent.running ? 'ok' : 'info') : 'warn'}`}
                  title={m.agent ? `${m.agent.id} — ${m.agent.status}` : 'not registered in this workspace'}
                >
                  <span className="dot" />
                  {m.member}
                  {!m.agent && ' ?'}
                </span>
              ))}
            </div>

            <div className="team-task-row">
              <input
                className="text-input grow"
                value={taskDraft[t.team] ?? ''}
                onChange={(e) => setTaskDraft({ ...taskDraft, [t.team]: e.target.value })}
                placeholder={`Add a task to ${t.team}'s shared list…`}
              />
              <label className="row muted" style={{ fontSize: 12, gap: 5 }} title="Pavāraṇā — lead must approve a plan before the claimant can complete">
                <input
                  type="checkbox"
                  checked={!!requiresPlan[t.team]}
                  onChange={(e) => setRequiresPlan({ ...requiresPlan, [t.team]: e.target.checked })}
                />
                requires plan
              </label>
              <button
                className="btn sm"
                disabled={!taskDraft[t.team]?.trim() || busy === `task:${t.team}`}
                onClick={() =>
                  guard(`task:${t.team}`, `Add task to ${t.team}?\n\n${taskDraft[t.team]}`, async () => {
                    const res = await addTask(workspace, t.team, taskDraft[t.team].trim(), !!requiresPlan[t.team])
                    setTaskDraft({ ...taskDraft, [t.team]: '' })
                    return res
                  })
                }
              >
                Add task
              </button>
            </div>

            {t.tasks.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>State</th>
                      <th>Claimed by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.tasks.map((task, i) => (
                      <tr key={String(task.id ?? i)}>
                        <td className="wrap">
                          <span className="mono muted">{String(task.id ?? '')}</span> {String(task.title ?? '')}
                        </td>
                        <td>
                          <Pill status={task.state === 'completed' ? 'ok' : task.state === 'in_progress' ? 'info' : 'warn'}>
                            {String(task.state ?? 'pending')}
                          </Pill>
                        </td>
                        <td className="mono muted">{String(task.claimed_by ?? '—')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))
      )}
      <p className="muted" style={{ padding: '10px 16px', margin: 0, fontSize: 12 }}>
        Members marked <span style={{ color: 'var(--warn)' }}>?</span> are named in the team file but not registered in
        this workspace — group actions skip them. {agents.length} agent(s) available here.
      </p>
    </Card>
  )
}
