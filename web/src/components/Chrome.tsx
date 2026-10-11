import { Fragment, useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { linkProps } from '../router'
import { ScopeBar } from './ScopeBar'
import type { Entity, SourceChoice } from '../router'
import { SearchBar } from './SearchBar'
import { SourceFilter } from './SourceFilter'
import { Tip, useTip } from './Tip'

export interface Crumb {
  label: string
  to?: string
}

/**
 * The bar across the top of every page: where you are, what you are looking at, and search.
 *
 * Where you are is the crumbs, since the menu on the left says which section and these say how far
 * into it. What you are looking at is the scope — a time range, an agent and a project on the
 * store-wide pages, just the agent on a project and below, where the page is already one project
 * and its own dates. The query bar is here rather than on a page of its own, because a search is
 * something you do *from* wherever you are.
 */
export function Chrome({
  crumbs,
  right,
  search,
  scope,
}: {
  crumbs: Crumb[]
  right?: ReactNode
  /** Present on every page that knows what it would be searching. Omit only where nothing is. */
  search?: {
    slug?: string | null
    initial?: string
    entity?: Entity | null
    source?: SourceChoice | null
    mode?: 'page' | 'search'
  }
  /**
   * Which scope chips to draw. `store` is all three, for the pages under the menu; `agent` is the
   * agent alone, for a project and the pages under it. Search writes its agent into the query.
   */
  scope?: 'store' | 'agent' | 'none'
}): ReactElement {
  const chips = scope ?? (search === undefined ? 'none' : search.mode === 'search' ? 'search' : 'agent')
  return (
    <header className="top">
      <div className="top-in">
        <nav className="crumbs" aria-label="Where you are">
          {crumbs.map((crumb, at) => (
            <Fragment key={at}>
              {at === 0 ? null : <span className="crumb-sep">/</span>}
              {crumb.to === undefined || at === crumbs.length - 1 ? (
                <span className={at === crumbs.length - 1 ? 'crumb here' : 'crumb'}>{crumb.label}</span>
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
        {chips === 'store' ? <ScopeBar /> : chips === 'agent' ? <ScopeBar only="agent" /> : null}
        {chips === 'search' && search !== undefined ? (
          <SourceFilter
            slug={search.slug}
            initial={search.initial}
            entity={search.entity}
            source={search.source}
            mode="search"
          />
        ) : null}
        {search === undefined ? null : (
          <SearchBar slug={search.slug} initial={search.initial} source={search.source} />
        )}
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
