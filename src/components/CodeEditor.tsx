import { useEffect, useRef } from 'react'
import { basicSetup } from 'codemirror'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'

// Languages load on demand so the dashboard bundle does not carry every
// grammar for a page most people never open.
const LANGS: Record<string, () => Promise<Extension>> = {
  js: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  mjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  cjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  ts: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  tsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true, jsx: true })),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  md: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  py: () => import('@codemirror/lang-python').then((m) => m.python()),
  rs: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  yml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
}

const extOf = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase()

const prefersDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false

/**
 * A CodeMirror 6 editor. `docKey` changing (a different file, or a reload)
 * replaces the document; typing only reports through `onChange`.
 */
export function CodeEditor({
  docKey,
  path,
  value,
  onChange,
  onSave,
}: {
  docKey: string
  path: string
  value: string
  onChange: (text: string) => void
  onSave: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const lang = useRef(new Compartment())
  const themeSlot = useRef(new Compartment()).current
  // Keep the latest callbacks without rebuilding the editor on every render.
  const cb = useRef({ onChange, onSave })
  cb.current = { onChange, onSave }

  useEffect(() => {
    if (!host.current) return
    let cancelled = false
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => (cb.current.onSave(), true) }]),
          basicSetup,
          lang.current.of([]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString())
          }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '13px' },
            '.cm-scroller': { fontFamily: 'var(--mono)' },
          }),
          themeSlot.of([]),
        ],
      }),
    })
    view.current = v
    if (prefersDark()) {
      void import('@codemirror/theme-one-dark').then((m) => {
        if (!cancelled) v.dispatch({ effects: themeSlot.reconfigure(m.oneDark) })
      })
    }
    const load = LANGS[extOf(path)]
    if (load) {
      void load().then((ext) => {
        if (!cancelled) v.dispatch({ effects: lang.current.reconfigure(ext) })
      })
    }
    return () => {
      cancelled = true
      v.destroy()
      view.current = null
    }
    // Rebuild only when a different document is loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey])

  return <div className="code-editor" ref={host} />
}
