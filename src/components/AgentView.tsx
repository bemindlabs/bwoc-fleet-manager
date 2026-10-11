import { useState } from 'react'
import { ask } from './ConfirmDialog'
import { sendMessage, setAgentState } from '../api'
import type { AgentDetail } from '../types'
import { Banner, Card, Empty, Pill, Stat, age } from './ui'

export function AgentView({ data, onChanged }: { data: AgentDetail; onChanged: () => void }) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  async function act(label: string, fn: () => Promise<{ output: string }>, confirmText: string) {
    if (!(await ask(confirmText))) return
    setBusy(label)
    setResult(null)
    try {
      const res = await fn()
      setResult({ kind: 'ok', text: res.output || `${label} ok` })
      onChanged()
      return true
    } catch (err) {
      setResult({ kind: 'error', text: (err as Error).message })
      return false
    } finally {
      setBusy(null)
    }
  }

  async function doSend() {
    const text = draft.trim()
    if (!text) return
    const ok = await act(
      'send',
      () => sendMessage(data.workspace, data.id, text),
      `Append this message to ${data.id}'s inbox?\n\n${text.slice(0, 300)}`,
    )
    if (ok) setDraft('')
  }

  const isActive = data.agent.status === 'active'
  // `bwoc status <id> --json` wraps the agent: { workspace, agents: [ { primary_model, … } ] }.
  const statusAgents = data.status?.agents as { primary_model?: string | null }[] | undefined
  const model = statusAgents?.[0]?.primary_model ?? data.agent.primary_model

  return (
    <>
      <div className="stat-grid">
        <Stat label="Status" value={data.agent.running ? 'running' : data.agent.status} sub={model ? `${data.agent.backend} · ${model}` : data.agent.backend} />
        <Stat label="Inbox" value={data.inbox.length} sub="messages on file" tone={data.inbox.length > 0 ? 'warn' : undefined} />
        <Stat label="Trust tier" value={data.agent.trust_tier ?? '—'} sub="Kalyāṇamitta-7" />
        <Stat label="Incarnated" value={age(data.agent.incarnated)} sub="ago" />
      </div>

      {result && <Banner kind={result.kind}>{result.text}</Banner>}
      {data.statusError && <Banner kind="error">{data.statusError}</Banner>}

      <div className="split">
        <Card title="Send to inbox">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Task for ${data.id} — state what is needed, not how. Include the task id and file:line when referencing code.`}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn primary" onClick={doSend} disabled={!draft.trim() || busy === 'send'}>
              {busy === 'send' ? <span className="spinner" /> : null} Send
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              Appends to <code className="mono">.bwoc/inbox.jsonl</code>
            </span>
          </div>
        </Card>

        <Card title="Lifecycle">
          <div className="row">
            <button
              className="btn primary"
              disabled={data.agent.running || busy === 'start'}
              title="Set status active and spawn the bwoc-agent daemon"
              onClick={() =>
                act(
                  'start',
                  () => setAgentState(data.workspace, data.id, 'start'),
                  `Start ${data.id}?\n\nSets status = active and spawns its daemon (bwoc-agent --serve).`,
                )
              }
            >
              {busy === 'start' ? <span className="spinner" /> : null} Start
            </button>
            <button
              className="btn"
              disabled={busy === 'pause'}
              title="Stay registered and active, but tear the daemon down"
              onClick={() =>
                act(
                  'pause',
                  () => setAgentState(data.workspace, data.id, 'pause'),
                  `Pause ${data.id}?\n\nKeeps it active in the registry but tears its daemon down — it stops answering, and no state is lost.`,
                )
              }
            >
              {busy === 'pause' ? <span className="spinner" /> : null} Pause
            </button>
            <button
              className="btn danger"
              disabled={!isActive || busy === 'stop'}
              title="Set status stopped; files kept"
              onClick={() =>
                act(
                  'stop',
                  () => setAgentState(data.workspace, data.id, 'stop'),
                  `Stop ${data.id}?\n\nSets status = "stopped" and tears the daemon down. Files are kept; reversible with Start.`,
                )
              }
            >
              {busy === 'stop' ? <span className="spinner" /> : null} Stop
            </button>
          </div>
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            <strong>Start</strong> = active + daemon · <strong>Pause</strong> = active, daemon down ·{' '}
            <strong>Stop</strong> = registry stopped. Retiring an agent is deliberately not exposed here — do that from
            the CLI, where succession can be checked first.
          </p>
        </Card>
      </div>

      <Card title={`Inbox — ${data.inbox.length} message${data.inbox.length === 1 ? '' : 's'}`}>
        {data.inboxPath && <p className="mono muted" style={{ marginTop: 0 }}>{data.inboxPath}</p>}
        {data.inbox.length === 0 ? (
          <Empty>Inbox is empty.</Empty>
        ) : (
          // Newest first — the backlog is read from the top.
          [...data.inbox].reverse().map((m, i) => (
            <div className="msg" key={i}>
              <div className="msg-head">
                <Pill status="info">{String(m.from ?? 'unknown')}</Pill>
                <span>{typeof m.ts === 'string' ? new Date(m.ts).toLocaleString() : ''}</span>
                <span className="topbar-spacer" />
                <span className="mono">#{data.inbox.length - i}</span>
              </div>
              <div className="msg-body">{String(m.message ?? JSON.stringify(m))}</div>
            </div>
          ))
        )}
      </Card>
    </>
  )
}
