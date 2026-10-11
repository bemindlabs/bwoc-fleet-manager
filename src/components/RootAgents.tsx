import { useEffect, useState } from 'react'
import { getRootAgents, getRootInbox } from '../api'
import type { RootAgent, RootInbox } from '../types'
import { Banner, Card, Empty, Pill } from './ui'

/**
 * Root agents — standalone agents under ~/agents that belong to no workspace.
 * `bwoc list` never reports them, so without this the orchestrator's own
 * mailbox was invisible in its own dashboard.
 */
export function RootAgents({ compact }: { compact?: boolean }) {
  const [agents, setAgents] = useState<RootAgent[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [inbox, setInbox] = useState<RootInbox | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getRootAgents()
      .then((r) => setAgents(r.agents))
      .catch((e) => setError((e as Error).message))
  }, [])

  useEffect(() => {
    if (!open) {
      setInbox(null)
      return
    }
    getRootInbox(open, 100)
      .then(setInbox)
      .catch((e) => setError((e as Error).message))
  }, [open])

  if (error) return <Banner kind="error">{error}</Banner>
  if (!agents) return compact ? null : <Empty><span className="spinner" /> Loading root agents…</Empty>
  if (agents.length === 0) return compact ? null : <Empty>No standalone agents under ~/agents.</Empty>

  return (
    <>
      <Card title={`Root agents (${agents.length}) — outside every workspace`} bodyless>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Role</th>
                <th className="num">Inbox</th>
                <th>Mesh</th>
                <th>Path</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id}>
                  <td>
                    <button className="link-cell" onClick={() => setOpen(open === a.name ? null : a.name)}>
                      {a.id}
                    </button>
                  </td>
                  <td className="wrap muted">{a.role ?? '—'}</td>
                  <td className="num">{a.inboxCount || <span className="muted">—</span>}</td>
                  <td>
                    {a.meshMember ? (
                      <Pill status="ok">enrolled</Pill>
                    ) : (
                      <Pill status="zero">no identity</Pill>
                    )}
                  </td>
                  <td className="mono muted">{a.dir}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ padding: '10px 16px', margin: 0, fontSize: 12 }}>
          Read through the host sidecar — <code className="mono">~/agents</code> is deliberately not mounted into the
          container, because it holds the mesh private key.
        </p>
      </Card>

      {open && inbox && (
        <Card title={`${open} — inbox (${inbox.total ?? inbox.messages.length})`}>
          <p className="mono muted" style={{ marginTop: 0 }}>{inbox.inbox}</p>
          {inbox.messages.length === 0 ? (
            <Empty>{inbox.missing ? 'No inbox file yet.' : 'Inbox is empty.'}</Empty>
          ) : (
            // Newest first — a backlog is read from the top.
            [...inbox.messages].reverse().map((m, i) => (
              <div className="msg" key={i}>
                <div className="msg-head">
                  <Pill status={m.room ? 'ok' : 'info'}>{m.from ?? 'unknown'}</Pill>
                  {m.room && <span className="mono">room:{m.room}</span>}
                  <span>{m.ts ? new Date(m.ts).toLocaleString() : ''}</span>
                  <span className="topbar-spacer" />
                  <span className="mono">#{inbox.messages.length - i}</span>
                </div>
                <div className="msg-body">{m.text}</div>
              </div>
            ))
          )}
        </Card>
      )}
    </>
  )
}
