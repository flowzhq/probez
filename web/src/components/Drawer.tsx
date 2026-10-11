import { useEffect } from 'react'
import type { ReactElement, ReactNode } from 'react'

/**
 * A look inside one row without leaving the list it is in.
 *
 * The frame every list's drawer shares: a heading, a way out, and Escape doing what it does
 * everywhere else. What goes inside is the list's own, since a project and a session have
 * different things worth seeing before you commit to opening them.
 */
export function Drawer({
  label,
  title,
  mono = false,
  subtitle,
  onClose,
  children,
}: {
  /** What a screen reader calls the panel. */
  label: string
  title: ReactNode
  mono?: boolean
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
}): ReactElement {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside className="drawer" aria-label={label}>
      <div className="drawer-head">
        <div style={{ minWidth: 0 }}>
          <h3 className={mono ? 'mono' : undefined}>{title}</h3>
          {subtitle === undefined ? null : <span className="muted">{subtitle}</span>}
        </div>
        <button type="button" className="drawer-close" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      {children}
    </aside>
  )
}

/** The pairs of figures at the top of a drawer. */
export function DrawerFacts({ items }: { items: Array<[label: string, value: ReactNode, bad?: boolean]> }): ReactElement {
  return (
    <dl className="drawer-facts">
      {items.map(([label, value, bad]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className={bad === true ? 'num bad' : 'num'}>{value}</dd>
        </div>
      ))}
    </dl>
  )
}
