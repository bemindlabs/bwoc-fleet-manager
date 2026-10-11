import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAgent, getOverview, getVersion, getWorkspace, getWorkspaceNames } from './api'
import type { AgentDetail, Overview, WorkspaceDetail } from './types'
import { AgentView } from './components/AgentView'
import { OverviewSkeleton, OverviewView } from './components/Overview'
import { GatewayView } from './components/Gateway'
import { SettingsView } from './components/Settings'
import { WorkspaceView, WS_SECTIONS } from './components/WorkspaceView'
import { Sidebar, hrefFor, parseHash, type Route } from './components/Sidebar'
import { Banner } from './components/ui'
import { ConfirmHost } from './components/ConfirmDialog'

const REFRESH_MS = 15_000

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceDetail | null>(null)
  const [agent, setAgent] = useState<AgentDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [version, setVersion] = useState<string>('')
  const [auto, setAuto] = useState(true)
  const [lastLoad, setLastLoad] = useState<Date | null>(null)
  const [names, setNames] = useState<string[]>([])
  const [drawer, setDrawer] = useState(false)

  // Guards against a slow response for an abandoned route overwriting the
  // data for the route the user has since navigated to.
  const reqId = useRef(0)

  useEffect(() => {
    const onHash = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const loadNames = useCallback(() => {
    getWorkspaceNames()
      .then((r) => setNames(r.workspaces))
      .catch(() => {})
  }, [])
  useEffect(loadNames, [loadNames])

  // The sidebar's per-workspace badges come from /overview, which costs a
  // few seconds of `bwoc` calls — refresh it in the background once a
  // minute rather than on every 15s poll. The Fleet page polls it anyway.
  useEffect(() => {
    const fetchOverview = () => {
      getOverview()
        .then(setOverview)
        .catch(() => {})
    }
    fetchOverview()
    const t = setInterval(fetchOverview, 60_000)
    return () => clearInterval(t)
  }, [])
  const sideStatus = useMemo(
    () =>
      Object.fromEntries(
        (overview?.workspaces ?? []).map((w) => [
          w.name,
          { inbox: w.inboxTotal, fail: w.doctor.fail + w.health.fail },
        ]),
      ),
    [overview],
  )

  useEffect(() => {
    getVersion()
      .then((v) => setVersion(v.version))
      .catch(() => setVersion(''))
  }, [])

  const load = useCallback(
    async (silent = false) => {
      const id = ++reqId.current
      if (!silent) setLoading(true)
      try {
        if (route.view === 'gateway') {
          // The Gateway page loads its own data from the sidecar.
        } else if (route.view === 'overview' || route.view === 'settings') {
          const data = await getOverview()
          if (id === reqId.current) setOverview(data)
        } else if (route.view === 'workspace') {
          const data = await getWorkspace(route.workspace)
          if (id === reqId.current) setWorkspace(data)
        } else {
          const data = await getAgent(route.workspace, route.agent)
          if (id === reqId.current) setAgent(data)
        }
        if (id === reqId.current) {
          setError(null)
          setLastLoad(new Date())
        }
      } catch (err) {
        if (id === reqId.current) setError((err as Error).message)
      } finally {
        if (id === reqId.current) setLoading(false)
      }
    },
    // Switching sections within a workspace reuses the loaded data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [route.view, 'workspace' in route ? route.workspace : '', 'agent' in route ? route.agent : ''],
  )

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    // Settings holds form state and triggers writes; polling under the user's
    // fingers would clobber a half-typed field.
    if (!auto || route.view === 'settings' || route.view === 'gateway') return
    const t = setInterval(() => void load(true), REFRESH_MS)
    return () => clearInterval(t)
  }, [auto, load, route.view])

  const go = (r: Route) => {
    window.location.hash = hrefFor(r)
  }

  const section = route.view === 'workspace' ? WS_SECTIONS.find((x) => x.id === route.section) : null

  return (
    <div className="app">
      <div className="app-body">
      <Sidebar route={route} workspaces={names} status={sideStatus} version={version} open={drawer} onNavigate={() => setDrawer(false)} />
      {drawer && <div className="scrim" onClick={() => setDrawer(false)} />}

      <div className="content">
      <header className="topbar">
        <button className="btn sm menu-toggle" onClick={() => setDrawer((d) => !d)} aria-label="Menu">
          ☰
        </button>
        <nav className="crumbs">
          <button onClick={() => go({ view: 'overview' })}>fleet</button>
          {(route.view === 'settings' || route.view === 'gateway') && (
            <>
              <span>/</span>
              <span>
                {route.view === 'gateway' ? 'mesh' : route.section === 'fleet' ? 'settings' : `settings / ${route.section}`}
              </span>
            </>
          )}
          {(route.view === 'workspace' || route.view === 'agent') && (
            <>
              <span>/</span>
              <button onClick={() => go({ view: 'workspace', workspace: route.workspace, section: 'overview' })}>
                {route.workspace}
              </button>
            </>
          )}
          {section && section.id !== 'overview' && (
            <>
              <span>/</span>
              <span>{section.label.toLowerCase()}</span>
            </>
          )}
          {route.view === 'agent' && (
            <>
              <span>/</span>
              <span>{route.agent}</span>
            </>
          )}
        </nav>

        <div className="topbar-spacer" />

        <div className="row">
          {loading && <span className="spinner" />}
          {lastLoad && (
            <span className="muted" style={{ fontSize: 12 }}>
              updated {lastLoad.toLocaleTimeString()}
            </span>
          )}
          <label className="row muted" style={{ fontSize: 12, gap: 5 }}>
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            auto ({REFRESH_MS / 1000}s)
          </label>
          <button className="btn sm" onClick={() => (loadNames(), void load())} disabled={loading}>
            Refresh
          </button>
        </div>
      </header>

      <main className="main">
        {error && <Banner kind="error">{error}</Banner>}

        {route.view === 'overview' && overview && (
          <OverviewView data={overview} onOpen={(w) => go({ view: 'workspace', workspace: w, section: 'overview' })} />
        )}

        {route.view === 'settings' && <SettingsView overview={overview} section={route.section} />}

        {route.view === 'gateway' && <GatewayView />}

        {route.view === 'workspace' && workspace && workspace.name === route.workspace && (
          <WorkspaceView
            data={workspace}
            section={route.section}
            onOpenAgent={(a) => go({ view: 'agent', workspace: route.workspace, agent: a })}
            onChanged={() => void load(true)}
          />
        )}

        {route.view === 'agent' && agent && agent.workspace === route.workspace && (
          <AgentView data={agent} onChanged={() => void load(true)} />
        )}

        {!error && loading && !overview && !workspace && !agent && (
          route.view === 'overview' ? <OverviewSkeleton names={names} /> : <div className="empty">Loading…</div>
        )}
      </main>
      </div>
      </div>
      <footer className="footer">
        <span>🌿 BWOC Fleet Manager{version && ` · ${version}`}</span>
        <span className="footer-spacer" />
        <span>
          {names.length} workspace{names.length === 1 ? '' : 's'}
          {lastLoad && ` · updated ${lastLoad.toLocaleTimeString()}`}
        </span>
        <span>tailnet only</span>
      </footer>
      <ConfirmHost />
    </div>
  )
}
