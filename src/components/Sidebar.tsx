import { useEffect, useState, type ReactNode } from 'react'
import { WS_SECTIONS, type WsSection } from './WorkspaceView'

export type Route =
  | { view: 'overview' }
  | { view: 'settings'; section: SettingsSection }
  | { view: 'gateway' }
  | { view: 'workspace'; workspace: string; section: WsSection }
  | { view: 'agent'; workspace: string; agent: string }

const enc = encodeURIComponent

export const SETTINGS_SECTIONS = [
  { id: 'fleet', label: 'Fleet settings' },
  { id: 'frameworks', label: 'Frameworks' },
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id']

export const hrefFor = (r: Route): string =>
  r.view === 'overview'
    ? '#/'
    : r.view === 'settings'
      ? `#/settings${r.section === 'fleet' ? '' : `/${r.section}`}`
      : r.view === 'gateway'
        ? '#/gateway'
        : r.view === 'workspace'
          ? `#/ws/${enc(r.workspace)}${r.section === 'overview' ? '' : `/${r.section}`}`
          : `#/ws/${enc(r.workspace)}/agent/${enc(r.agent)}`

/** Hash routing — no router dependency. */
export function parseHash(): Route {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  if (parts[0] === 'settings') {
    return { view: 'settings', section: SETTINGS_SECTIONS.find((s) => s.id === parts[1])?.id ?? 'fleet' }
  }
  if (parts[0] === 'gateway') return { view: 'gateway' }
  if (parts[0] === 'ws' && parts[1]) {
    if (parts[2] === 'agent' && parts[3]) return { view: 'agent', workspace: parts[1], agent: parts[3] }
    const section = WS_SECTIONS.find((s) => s.id === parts[2])?.id ?? 'overview'
    return { view: 'workspace', workspace: parts[1], section }
  }
  return { view: 'overview' }
}

const routeWorkspace = (r: Route) => (r.view === 'workspace' || r.view === 'agent' ? r.workspace : null)

export function Sidebar({
  route,
  workspaces,
  status,
  version,
  open,
  onNavigate,
}: {
  route: Route
  workspaces: string[]
  /** Per-workspace badges; a workspace missing here just shows none. */
  status: Record<string, { inbox: number; fail: number }>
  version: string
  /** Drawer state on narrow screens; ignored on wide ones. */
  open: boolean
  onNavigate: () => void
}) {
  const current = routeWorkspace(route)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(current ? [current] : []))
  const [filter, setFilter] = useState('')

  // Navigating into a workspace (from the overview, a link, the URL) opens its menu.
  useEffect(() => {
    if (current) setExpanded((e) => (e.has(current) ? e : new Set(e).add(current)))
  }, [current])

  const toggle = (ws: string) =>
    setExpanded((e) => {
      const next = new Set(e)
      if (next.has(ws)) next.delete(ws)
      else next.add(ws)
      return next
    })

  const shown = filter ? workspaces.filter((w) => w.toLowerCase().includes(filter.toLowerCase())) : workspaces

  const item = (href: string, label: string, active: boolean, level: 0 | 1 | 2, icon?: string, badges?: ReactNode) => (
    <a
      className={`nav-item l${level}${active ? ' active' : ''}`}
      href={href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
    >
      {icon && <span className="nav-icon">{icon}</span>}
      <span className="nav-label">{label}</span>
      {badges}
    </a>
  )

  // Only what needs a human: failures (doctor or health) and unread inbox.
  // Health warnings are left out — nearly every workspace has one.
  const badgesFor = (ws: string) => {
    const s = status[ws]
    if (!s || (!s.fail && !s.inbox)) return null
    return (
      <span className="nav-badges">
        {s.inbox > 0 && (
          <span className="nav-count" title={`${s.inbox} unread inbox message(s)`}>
            {s.inbox}
          </span>
        )}
        {s.fail > 0 && <span className="nav-dot fail" title={`${s.fail} failing check(s)`} />}
      </span>
    )
  }

  return (
    <aside className={`sidebar${open ? ' open' : ''}`}>
      <div className="side-brand">
        <span className="brand-mark" aria-hidden="true">🌿</span>
        <span>Fleet Manager</span>
        <small>{version || 'bwoc'}</small>
      </div>

      <nav className="side-nav">
        {item('#/', 'Fleet', route.view === 'overview', 0, '◉')}

        <div className="nav-section">
          <span>Workspaces</span>
          <span className="muted">{workspaces.length}</span>
        </div>
        {workspaces.length > 8 && (
          <input
            className="nav-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter workspaces…"
          />
        )}

        {shown.map((ws) => {
          const isOpen = expanded.has(ws)
          return (
            <div key={ws} className="nav-group">
              <div className={`nav-row${current === ws ? ' current' : ''}`}>
                <button
                  className={`nav-caret${isOpen ? ' open' : ''}`}
                  onClick={() => toggle(ws)}
                  aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${ws}`}
                  aria-expanded={isOpen}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                    <path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                {item(hrefFor({ view: 'workspace', workspace: ws, section: 'overview' }), ws, false, 1, undefined, badgesFor(ws))}
              </div>
              {isOpen &&
                WS_SECTIONS.map((s) => (
                  <div key={s.id}>
                    {item(
                      hrefFor({ view: 'workspace', workspace: ws, section: s.id }),
                      s.label,
                      route.view === 'workspace' && route.workspace === ws && route.section === s.id,
                      2,
                    )}
                    {/* The open agent sits under Overview, where the agent table lives. */}
                    {s.id === 'overview' &&
                      route.view === 'agent' &&
                      route.workspace === ws &&
                      item(hrefFor(route), route.agent, true, 2, '↳')}
                  </div>
                ))}
            </div>
          )
        })}
        {filter && shown.length === 0 && <div className="nav-empty">No match</div>}

        <div className="nav-section">
          <span>System</span>
        </div>
        {item('#/gateway', 'Mesh', route.view === 'gateway', 0, '⇄')}
        {item('#/settings', 'Settings', false, 0, '⚙')}
        {SETTINGS_SECTIONS.map((s) => (
          <div key={s.id}>
            {item(hrefFor({ view: 'settings', section: s.id }), s.label, route.view === 'settings' && route.section === s.id, 2)}
          </div>
        ))}
      </nav>
    </aside>
  )
}
