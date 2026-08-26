import { Fragment, useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { linkProps } from '../router'
import { SearchBar } from './SearchBar'
import { Tip, useTip } from './Tip'

export interface Crumb {
  label: string
  to?: string
}

/**
 * The header, on every page.
 *
 * The query bar sits in it rather than on a page of its own, because a search is something you do
 * *from* wherever you are: on a project it starts scoped to that project, and the chip on the
 * results page is what widens it to the whole store.
 */
export function Chrome({
  crumbs,
  right,
  search,
}: {
  crumbs: Crumb[]
  right?: ReactNode
  /** Present on every page that knows what it would be searching. Omit only where nothing is. */
  search?: { slug?: string | null; initial?: string }
}): ReactElement {
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
        {search === undefined ? null : (
          <SearchBar slug={search.slug} initial={search.initial} />
        )}
        <a
          className="gear"
          {...linkProps('/settings')}
          aria-label="Settings — token pricing"
          title="Settings — token pricing"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
            aria-hidden
          >
            {/* Eight square teeth on a ring, with the hole through the middle. Deliberately not the
                rays-from-a-dot shape the light theme uses, which sits two controls away. */}
            <path d="M6.75 2.80 L6.37 1.19 L9.63 1.19 L9.25 2.80 L10.80 3.44 L11.66 2.03 L13.97 4.34 L12.56 5.20 L13.20 6.75 L14.81 6.37 L14.81 9.63 L13.20 9.25 L12.56 10.80 L13.97 11.66 L11.66 13.97 L10.80 12.56 L9.25 13.20 L9.63 14.81 L6.37 14.81 L6.75 13.20 L5.20 12.56 L4.34 13.97 L2.03 11.66 L3.44 10.80 L2.80 9.25 L1.19 9.63 L1.19 6.37 L2.80 6.75 L3.44 5.20 L2.03 4.34 L4.34 2.03 L5.20 3.44 Z" />
            <circle cx="8" cy="8" r="2.35" />
          </svg>
        </a>
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

/**
 * A word that needs a sentence.
 *
 * Some of these labels are jargon the page invented — "reused" is a share of prompt-cache reads,
 * which nobody should be expected to infer from four letters. The mark says an explanation exists;
 * without it the tooltip is undiscoverable, because nothing tells you to hover a number.
 */
export function Info({ says, aria }: { says: ReactNode; aria?: string }): ReactElement {
  const { tip, show, hide } = useTip()
  // The browser's own `title` was the obvious thing and the wrong one: it waits about a second,
  // renders as a bare `?` cursor until then, and never appears at all for a keyboard user. This is
  // the same tooltip the charts use, so it shows at once and on focus as well as on hover.
  return (
    <>
      <span
        className="info"
        tabIndex={0}
        role="note"
        // A glossary is worth laying out, so `says` may be markup. Anything that reads the page
        // aloud still needs a sentence, and markup is not one, so those pass `aria` as well.
        aria-label={aria ?? (typeof says === 'string' ? says : undefined)}
        onMouseEnter={(event) => show(event, says)}
        onMouseMove={(event) => show(event, says)}
        onMouseLeave={hide}
        onFocus={(event) => {
          const at = event.currentTarget.getBoundingClientRect()
          show({ clientX: at.left, clientY: at.bottom }, says)
        }}
        onBlur={hide}
        onKeyDown={(event) => {
          if (event.key === 'Escape') hide()
        }}
      >
        i
      </span>
      <Tip tip={tip} />
    </>
  )
}

/** One number with its name, and optionally what the name means, for the row under a page title. */
export type Fact = [label: string, value: ReactNode, says?: string]

export function Facts({ items }: { items: Fact[] }): ReactElement {
  // A fact with nothing to report drops out entirely rather than printing a bare label: a project
  // with no input has no reused share, and "· reused" with a blank in front of it reads as a bug.
  const shown = items.filter(([, value]) => value !== null && value !== undefined && value !== '')
  return (
    <div className="facts">
      {shown.map(([label, value, says], at) => (
        <Fragment key={label}>
          {at === 0 ? null : <span className="sep">·</span>}
          <span>
            <span className="num">{value}</span>{' '}
            <span className="muted">
              {label}
              {says === undefined ? null : <Info says={says} />}
            </span>
          </span>
        </Fragment>
      ))}
    </div>
  )
}
