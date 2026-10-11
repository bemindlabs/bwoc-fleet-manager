import type { ReactNode } from 'react'
import type { SignalStatus } from '../types'

export function Card({
  title,
  actions,
  children,
  bodyless,
  fill,
}: {
  title: ReactNode
  actions?: ReactNode
  children: ReactNode
  bodyless?: boolean
  /** Stretch to the remaining height of the page (editor-style views). */
  fill?: boolean
}) {
  return (
    <section className={`card${fill ? ' fill' : ''}`}>
      <header className="card-head">
        <h2>{title}</h2>
        <div className="topbar-spacer" />
        {actions}
      </header>
      {bodyless ? children : <div className="card-body">{children}</div>}
    </section>
  )
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: 'warn' | 'fail'
}) {
  return (
    <div className={`stat${tone ? ` is-${tone}` : ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  )
}

export function Pill({
  status,
  children,
}: {
  status: SignalStatus | 'zero'
  children: ReactNode
}) {
  return (
    <span className={`pill ${status}`}>
      <span className="dot" />
      {children}
    </span>
  )
}

/** Count pill — renders nothing at zero, so a healthy fleet stays visually quiet. */
export function Count({ n, status, label }: { n: number; status: SignalStatus; label: string }) {
  if (!n) return null
  return (
    <Pill status={status}>
      {n} {label}
    </Pill>
  )
}

export function Banner({ kind, children }: { kind: 'error' | 'ok' | 'info'; children: ReactNode }) {
  return <div className={`banner ${kind}`}>{children}</div>
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

/** "55d" / "3h" — how long since an agent was last touched. */
export function age(iso: string | null | undefined): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return '—'
  const mins = Math.floor((Date.now() - then) / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
