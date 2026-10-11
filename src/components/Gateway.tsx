import { useCallback, useEffect, useRef, useState } from 'react'
import { ask } from './ConfirmDialog'
import { gatewayBridge, getGatewayRoom, getGatewayStatus, sendGateway } from '../api'
import type { GatewayRoom, GatewayStatus } from '../types'
import { Banner, Card, Empty, Pill, Stat } from './ui'

const POLL_MS = 8000

/**
 * Gateway mesh — cross-machine agent messaging over the bwoc-gateway relay.
 *
 * Everything here lives on the HOST (identity key, inbox, recv bridge, send
 * client), so the API proxies to the sidecar. If the sidecar is down this page
 * is the thing that tells you, rather than failing silently.
 */
export function GatewayView() {
  const [status, setStatus] = useState<GatewayStatus | null>(null)
  const [room, setRoom] = useState<GatewayRoom | null>(null)
  const [draft, setDraft] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async (silent = false) => {
    try {
      const [s, r] = await Promise.all([getGatewayStatus(), getGatewayRoom(80)])
      setStatus(s)
      setRoom(r)
      setError(null)
    } catch (err) {
      if (!silent) setError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(true), POLL_MS)
    return () => clearInterval(t)
  }, [load])

  // Keep the newest message in view, the way a chat log should behave.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest' })
  }, [room?.messages.length])

  async function post() {
    const text = draft.trim()
    if (!text) return
    const target = to || 'everyone in the room'
    if (!(await ask(`Send to ${target}?\n\n${text.slice(0, 300)}`))) return
    setBusy('send')
    setNote(null)
    try {
      const res = await sendGateway(text, to || undefined)
      const ok = res.results.filter((r) => r.ok).length
      const bad = res.results.filter((r) => !r.ok)
      setNote(
        bad.length === 0
          ? `delivered to ${ok} member(s)`
          : `${ok} delivered · ${bad.map((b) => `${b.to}: ${b.detail}`).join('; ')}`,
      )
      setDraft('')
      await load(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function toggleBridge(action: 'start' | 'stop') {
    if (action === 'stop' && !(await ask('Stop the recv bridge?\n\nThis machine stops receiving mesh messages until restarted.'))) return
    setBusy(action)
    try {
      const res = await gatewayBridge(action)
      setNote(`bridge ${action}: ${res.bridge.running ? `running (pid ${res.bridge.pids.join(', ')})` : 'stopped'}`)
      await load(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (error && !status) {
    return (
      <Banner kind="error">
        {error}
        <div style={{ marginTop: 8 }}>
          <button className="btn sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      </Banner>
    )
  }

  if (!status) return <Empty><span className="spinner" /> Loading mesh…</Empty>

  const roomMsgs = room?.messages.filter((m) => m.inRoom) ?? []
  const directMsgs = room?.messages.filter((m) => !m.inRoom) ?? []

  return (
    <>
      <div className="stat-grid">
        <Stat label="Identity" value={status.self} sub={status.identity ? 'key present' : 'no key — mesh off on this host'} />
        <Stat
          label="Recv bridge"
          value={status.bridge.running ? 'up' : 'down'}
          tone={status.bridge.running ? (status.bridge.duplicate ? 'warn' : undefined) : status.identity ? 'fail' : undefined}
          sub={status.bridge.duplicate ? `${status.bridge.pids.length} processes — duplicate!` : status.bridge.pids.join(', ') || 'not running'}
        />
        <Stat label="Room" value={status.room} sub={`${roomMsgs.length} message(s)`} />
        <Stat label="Members" value={status.members.length} sub={status.members.join(' · ')} />
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {note && <Banner kind="ok">{note}</Banner>}
      {!status.identity && (
        <Banner kind="info">
          This host has no mesh identity, so it can't send to the room or run the recv bridge. That is fine for a
          dashboard-only host. To join the mesh, give the planner sidecar an agent id and key (
          <code className="mono">BWOC_GW_AGENT</code>, <code className="mono">BWOC_GW_KEY</code>) and restart it.
        </Banner>
      )}
      {status.bridge.duplicate && (
        <Banner kind="error">
          Two recv bridges are running for {status.self}. The relay allows one connection per agent id, so they will
          evict each other in a loop — stop the bridge and start it once.
        </Banner>
      )}
      {!status.clientInstalled && (
        <Banner kind="error">
          <code className="mono">bwoc-gateway-send</code> not found on the host — build it from the{' '}
          <code className="mono">bwoc-gateway</code> repo.
        </Banner>
      )}

      <Card
        title={`Room — ${status.room}`}
        actions={
          <div className="row">
            <span className="muted mono" style={{ fontSize: 11 }}>{status.relay}</span>
            <button
              className="btn sm"
              disabled={!!busy}
              onClick={() => toggleBridge(status.bridge.running ? 'stop' : 'start')}
            >
              {busy === 'start' || busy === 'stop' ? <span className="spinner" /> : null}
              {status.bridge.running ? 'Stop bridge' : 'Start bridge'}
            </button>
            <button className="btn sm" onClick={() => void load()}>Refresh</button>
          </div>
        }
      >
        <div className="room-log">
          {roomMsgs.length === 0 ? (
            <Empty>No room messages yet. Say something below.</Empty>
          ) : (
            roomMsgs.map((m, i) => (
              <div className="msg" key={i}>
                <div className="msg-head">
                  <Pill status={m.from === status.self ? 'info' : 'ok'}>{m.from ?? 'unknown'}</Pill>
                  <span>{m.ts ? new Date(m.ts).toLocaleString() : ''}</span>
                </div>
                <div className="msg-body">{m.text || m.raw}</div>
              </div>
            ))
          )}
          <div ref={bottom} />
        </div>

        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Broadcast to ${status.members.join(', ')} — prefixed with [room:${status.room}] automatically.`}
          style={{ marginTop: 12 }}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <select className="text-input" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">everyone ({status.members.length})</option>
            {status.members.map((m) => (
              <option key={m} value={m}>{m} only</option>
            ))}
          </select>
          <button className="btn primary" onClick={post} disabled={!draft.trim() || busy === 'send'}>
            {busy === 'send' ? <span className="spinner" /> : null} Send
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            Delivery is store-and-forward: <strong>delivered</strong> means the relay accepted it, not that the
            recipient read it.
          </span>
        </div>
      </Card>

      {directMsgs.length > 0 && (
        <Card title={`Direct messages (${directMsgs.length}) — not room traffic`}>
          {directMsgs.slice(-10).map((m, i) => (
            <div className="msg" key={i}>
              <div className="msg-head">
                <Pill status="warn">{m.from ?? 'unknown'}</Pill>
                <span>{m.ts ? new Date(m.ts).toLocaleString() : ''}</span>
              </div>
              <div className="msg-body">{m.raw}</div>
            </div>
          ))}
        </Card>
      )}
    </>
  )
}
