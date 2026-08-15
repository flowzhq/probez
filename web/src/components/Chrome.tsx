import { Fragment, useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { linkProps } from '../router'

export interface Crumb {
  label: string
  to?: string
}

export function Chrome({ crumbs, right }: { crumbs: Crumb[]; right?: ReactNode }): ReactElement {
  return (
    <header className="top">
      <div className="top-in">
        <a className="brand" {...linkProps('/')} aria-label="probez — all projects">
          {/* Both are in the markup and CSS picks one, so the right logo is painted on the first
              frame rather than after a script has worked out the theme. */}
          <img className="logo logo-light" src="/logo-light.png" alt="probez" width={409} height={96} />
          <img className="logo logo-dark" src="/logo-dark.png" alt="" aria-hidden width={409} height={96} />
        </a>
        <nav className="crumbs">
          {crumbs.map((crumb, at) => (
            <Fragment key={at}>
              <span className="crumb-sep">/</span>
              {crumb.to === undefined ? (
                <span className="crumb">{crumb.label}</span>
              ) : (
                <a className="crumb" {...linkProps(crumb.to)}>
                  {crumb.label}
                </a>
              )}
            </Fragment>
          ))}
        </nav>
        <span className="spacer" />
        {right}
        <Theme />
      </div>
    </header>
  )
}

/**
 * Light and dark, with "system" as the real default rather than a third state nobody picks.
 * The stamp on the root element is what the theme tokens key off.
 */
type Mode = 'light' | 'dark' | 'system'

/**
 * Three states shown as three controls rather than one that cycles.
 *
 * A single button has to be pressed to find out what it does, and with three states it takes two
 * presses to get back to where you were. Sun, moon and monitor is the arrangement people already
 * know, and it says which one is on without being clicked.
 */
const MODES: Array<{ id: Mode; label: string; icon: ReactElement }> = [
  {
    id: 'light',
    label: 'Light',
    icon: (
      <>
        <circle cx="8" cy="8" r="3.25" />
        <path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.95 3.05l-1.13 1.13M4.18 11.82l-1.13 1.13M12.95 12.95l-1.13-1.13M4.18 4.18L3.05 3.05" />
      </>
    ),
  },
  {
    id: 'dark',
    label: 'Dark',
    icon: <path d="M13.5 9.6A6 6 0 0 1 6.4 2.5a6 6 0 1 0 7.1 7.1z" />,
  },
  {
    id: 'system',
    label: 'System',
    icon: (
      <>
        <rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.25" />
        <path d="M5.75 14h4.5M8 11.25V14" />
      </>
    ),
  },
]

function Theme(): ReactElement {
  const [theme, setTheme] = useState<Mode>(
    () => (localStorage.getItem('probez.theme') as 'light' | 'dark' | null) ?? 'system',
  )

  useEffect(() => {
    if (theme === 'system') {
      document.documentElement.removeAttribute('data-theme')
      localStorage.removeItem('probez.theme')
    } else {
      document.documentElement.setAttribute('data-theme', theme)
      localStorage.setItem('probez.theme', theme)
    }
  }, [theme])

  return (
    <div className="theme" role="group" aria-label="Colour theme">
      {MODES.map((mode) => (
        <button
          key={mode.id}
          onClick={() => setTheme(mode.id)}
          aria-pressed={theme === mode.id}
          aria-label={mode.label}
          title={`${mode.label} theme`}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            {mode.icon}
          </svg>
        </button>
      ))}
    </div>
  )
}

export function Loading({ what }: { what: string }): ReactElement {
  return <div className="center">Reading {what}…</div>
}

export function Problem({ message }: { message: string }): ReactElement {
  return (
    <div className="error">
      <strong>probez view could not show that.</strong>
      <p className="note" style={{ marginBottom: 0 }}>
        {message}
      </p>
    </div>
  )
}

/** One number with its name, for the row under a page title. */
export function Facts({ items }: { items: Array<[string, ReactNode]> }): ReactElement {
  return (
    <div className="facts">
      {items.map(([label, value], at) => (
        <Fragment key={label}>
          {at === 0 ? null : <span className="sep">·</span>}
          <span>
            <span className="num">{value}</span> <span className="muted">{label}</span>
          </span>
        </Fragment>
      ))}
    </div>
  )
}
