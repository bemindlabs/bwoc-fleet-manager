import { useEffect, useRef, useState } from 'react'

// A promise-based stand-in for window.confirm(). The native dialog blocks the
// whole tab (and any automation driving it) and cannot be styled; this one
// is a <dialog> in the page. Call `ask(text)` anywhere; <ConfirmHost/>,
// mounted once in App, renders it.

interface Pending {
  text: string
  resolve: (ok: boolean) => void
}

let show: ((p: Pending) => void) | null = null

export function ask(text: string): Promise<boolean> {
  // Before the host mounts there is nothing to show — fall back rather than
  // silently approving or refusing.
  if (!show) return Promise.resolve(window.confirm(text))
  return new Promise((resolve) => show!({ text, resolve }))
}

// Irreversible or disruptive actions get a red confirm button.
const DANGER = /^(stop|retire|apply prune|discard)\b/i

export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null)
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    show = (p) => setPending(p)
    return () => {
      show = null
    }
  }, [])

  useEffect(() => {
    if (pending && ref.current && !ref.current.open) ref.current.showModal()
  }, [pending])

  const close = (ok: boolean) => {
    ref.current?.close()
    pending?.resolve(ok)
    setPending(null)
  }

  if (!pending) return null
  const [title, ...rest] = pending.text.split('\n\n')
  const danger = DANGER.test(pending.text)

  return (
    <dialog
      ref={ref}
      className="confirm"
      // Esc fires `cancel`; treat it as No.
      onCancel={(e) => (e.preventDefault(), close(false))}
      onClick={(e) => e.target === ref.current && close(false)}
    >
      {/* The inner box takes the padding, so a click on the dialog element
          itself can only be a click on the backdrop. */}
      <div className="confirm-body">
      <h3>{title}</h3>
      {rest.length > 0 && <p>{rest.join('\n\n')}</p>}
      <div className="row confirm-actions">
        {/* Enter lands on Cancel for dangerous actions, on Confirm otherwise. */}
        <button className="btn" onClick={() => close(false)} autoFocus={danger}>
          Cancel
        </button>
        <button className={`btn ${danger ? 'danger solid' : 'primary'}`} onClick={() => close(true)} autoFocus={!danger}>
          Confirm
        </button>
      </div>
      </div>
    </dialog>
  )
}
