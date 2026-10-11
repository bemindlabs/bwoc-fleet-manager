import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { ask } from './ConfirmDialog'
import { getFile, getProjects, getTree, saveFile } from '../api'
import type { ProjectFile, ProjectRow, TreeEntry } from '../types'
import { Banner, Card, Empty, Pill, age } from './ui'

// CodeMirror is only needed once a file is opened — keep it out of the main bundle.
const CodeEditor = lazy(() => import('./CodeEditor').then((m) => ({ default: m.CodeEditor })))

export function Projects({ workspace }: { workspace: string }) {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(() => {
    getProjects(workspace)
      .then((r) => {
        setProjects(r.projects)
        setError(null)
      })
      .catch((e) => setError((e as Error).message))
  }, [workspace])

  useEffect(load, [load])

  if (open) {
    return <Explorer workspace={workspace} project={open} onBack={() => (setOpen(null), load())} />
  }

  return (
    <Card title={`Projects${projects ? ` (${projects.length})` : ''}`} bodyless>
      {error && <Banner kind="error">{error}</Banner>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Branch</th>
              <th>Changes</th>
              <th>Last commit</th>
              <th className="num">Age</th>
            </tr>
          </thead>
          <tbody>
            {projects?.map((p) => (
              <tr key={p.name}>
                <td>
                  <button className="link-cell" onClick={() => setOpen(p.name)}>
                    {p.name}
                  </button>
                </td>
                <td className="mono">{p.git?.branch ?? <span className="muted">not a git repo</span>}</td>
                <td>
                  {p.git?.dirty == null ? (
                    <span className="muted">—</span>
                  ) : p.git.dirty > 0 ? (
                    <Pill status="warn">{p.git.dirty} changed</Pill>
                  ) : (
                    <Pill status="ok">clean</Pill>
                  )}
                </td>
                <td className="muted">
                  {p.git?.lastCommit ? (
                    <>
                      <span className="mono">{p.git.lastCommit.hash}</span> {p.git.lastCommit.subject}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="num muted">{age(p.git?.lastCommit?.date)}</td>
              </tr>
            ))}
            {projects?.length === 0 && (
              <tr>
                <td colSpan={5}>
                  <Empty>No projects/ in this workspace.</Empty>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

interface OpenFile extends ProjectFile {
  /** Bumped on every (re)load so the editor replaces its document. */
  loadId: number
  draft: string
}

function Explorer({ workspace, project, onBack }: { workspace: string; project: string; onBack: () => void }) {
  const [dirs, setDirs] = useState<Record<string, TreeEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']))
  const [file, setFile] = useState<OpenFile | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const dirty = file?.content != null && file.draft !== file.content

  const loadDir = useCallback(
    (path: string) =>
      getTree(workspace, project, path)
        .then((r) => setDirs((d) => ({ ...d, [path]: r.entries })))
        .catch((e) => setMsg({ kind: 'error', text: (e as Error).message })),
    [workspace, project],
  )

  useEffect(() => {
    void loadDir('')
  }, [loadDir])

  // Closing the tab with unsaved edits loses them — ask first.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const toggleDir = (path: string) => {
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else {
      next.add(path)
      if (!dirs[path]) void loadDir(path)
    }
    setExpanded(next)
  }

  async function openFile(path: string) {
    if (dirty && !(await ask(`Discard unsaved changes to ${file?.path}?`))) return
    setMsg(null)
    try {
      const f = await getFile(workspace, project, path)
      setFile({ ...f, loadId: Date.now(), draft: f.content ?? '' })
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message })
    }
  }

  async function save() {
    if (!file || file.content == null || saving) return
    setSaving(true)
    try {
      const r = await saveFile(workspace, project, file.path, file.draft, file.mtimeMs)
      // Keep the editor as-is (no reload) — only the baseline moves.
      setFile((f) => (f ? { ...f, content: f.draft, mtimeMs: r.mtimeMs, size: r.size } : f))
      setMsg({ kind: 'ok', text: `Saved ${file.path}` })
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const renderDir = (path: string, depth: number) =>
    dirs[path]?.map((e) => (
      <div key={e.path}>
        <button
          className={`tree-item${file?.path === e.path ? ' active' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => (e.type === 'dir' ? toggleDir(e.path) : void openFile(e.path))}
          title={e.path}
        >
          {e.type === 'dir' ? (expanded.has(e.path) ? '▾ ' : '▸ ') : '  '}
          {e.name}
        </button>
        {e.type === 'dir' && expanded.has(e.path) && renderDir(e.path, depth + 1)}
      </div>
    ))

  return (
    <Card
      title={
        <span className="row">
          <button className="btn sm" onClick={async () => (!dirty || (await ask('Discard unsaved changes?'))) && onBack()}>
            ← Projects
          </button>
          <span className="mono">{project}</span>
          {file && (
            <span className="mono muted">
              / {file.path}
              {dirty && ' •'}
            </span>
          )}
        </span>
      }
      actions={
        file?.content != null && (
          <div className="row">
            <button className="btn sm" disabled={saving} onClick={() => void openFile(file.path)} title="Reload from disk">
              Reload
            </button>
            <button className="btn sm primary" disabled={!dirty || saving} onClick={() => void save()} title="Ctrl/⌘+S">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )
      }
      bodyless
      fill
    >
      {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
      <div className="explorer">
        <nav className="tree">{renderDir('', 0)}</nav>
        <div className="editor-pane">
          {!file && <Empty>Pick a file. Secrets (.env, .secrets/, keys) and .git/ are hidden.</Empty>}
          {file?.binary && <Empty>Binary file — not shown.</Empty>}
          {file?.tooLarge && <Empty>File is over 1 MiB ({Math.round(file.size / 1024)} KiB) — not opened.</Empty>}
          {file?.content != null && (
            <Suspense fallback={<Empty>Loading editor…</Empty>}>
              <CodeEditor
                docKey={`${file.path}:${file.loadId}`}
                path={file.path}
                value={file.content}
                onChange={(draft) => setFile((f) => (f ? { ...f, draft } : f))}
                onSave={() => void save()}
              />
            </Suspense>
          )}
        </div>
      </div>
    </Card>
  )
}
