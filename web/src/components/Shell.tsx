import { useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { api } from '../api'
import { ago } from '../format'
import { href, linkProps } from '../router'
import type { Route } from '../router'
import { scoped, useScope } from '../scope'
import type { Scope } from '../scope'
import { useBusy } from '../pending'
import { useData } from '../useData'
import { useDebug } from '../meta'

/**
 * The frame every page sits in: a menu down the left, the page to its right.
 *
 * People open probez for one of two reasons — where did the money go, and why did this one cost so
 * much — so the menu is those two sections, Insights and Investigate, and every item under them is
 * a page that answers one question across the whole store. The project, session and task pages are
 * still here, as the places a list leads to; on the two deepest the menu folds to its icons, since
 * a trace wants the width more than it wants the labels.
 */
export function Shell({ route, children }: { route: Route; children: ReactNode }): ReactElement {
  const deep = route.name === 'session' || route.name === 'task'
  const [folded, setFolded] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('probez.menu') === 'folded'
    } catch {
      return false
    }
  })
  // On a trace the menu folds whatever was chosen elsewhere; unfolding it there lasts until you
  // leave, rather than becoming the preference for every page.
  const [openHere, setOpenHere] = useState(false)
  useEffect(() => setOpenHere(false), [deep])
  const narrow = deep ? !openHere : folded

  const toggle = (): void => {
    if (deep) {
      setOpenHere((was) => !was)
      return
    }
    setFolded((was) => {
      try {
        window.localStorage.setItem('probez.menu', was ? 'open' : 'folded')
      } catch {
        // A private window can refuse storage; the menu still folds for this page.
      }
      return !was
    })
  }

  const busy = useBusy()

  return (
    <div className={narrow ? 'app narrow' : 'app'}>
      {busy ? <div className="loadbar" role="progressbar" aria-label="Reading" /> : null}
      <Rail route={route} narrow={narrow} onToggle={toggle} />
      <div className="col">{children}</div>
    </div>
  )
}

/** Where a menu item goes, and which routes light it up. */
interface Item {
  label: string
  icon: ReactElement
  to: (scope: Scope) => string
  on: (route: Route) => boolean
  badge?: number | null
}

function Rail({
  route,
  narrow,
  onToggle,
}: {
  route: Route
  narrow: boolean
  onToggle: () => void
}): ReactElement {
  const scope = useScope()
  const debug = useDebug()
  const { data: findings } = useData(
    () => api.findings(scope),
    [scope.range, scope.source, scope.project, scope.committer],
  )

  const insights: Item[] = [
    { label: 'Overview', icon: ICONS.home, to: (s) => scoped('/', s), on: (r) => r.name === 'overview' },
    { label: 'Spend', icon: ICONS.spend, to: (s) => scoped('/spend', s), on: (r) => r.name === 'spend' },
    {
      label: 'Tokens & cache',
      icon: ICONS.cache,
      to: (s) => scoped('/cache', s),
      on: (r) => r.name === 'cache',
    },
    { label: 'Context', icon: ICONS.context, to: (s) => scoped('/context', s), on: (r) => r.name === 'context' },
  ]
  const investigate: Item[] = [
    {
      label: 'Findings',
      icon: ICONS.findings,
      to: (s) => scoped('/findings', s),
      on: (r) => r.name === 'findings',
      badge: findings === null ? null : findings.findings.length,
    },
    {
      label: 'Projects',
      icon: ICONS.projects,
      to: (s) => scoped('/projects', s),
      on: (r) => r.name === 'projects' || r.name === 'project',
    },
    {
      label: 'Sessions',
      icon: ICONS.sessions,
      to: (s) => scoped('/sessions', s),
      on: (r) => r.name === 'sessions' || r.name === 'session' || r.name === 'task',
    },
    // Under `probez view --debug` only: both are slow to read on a large store. See src/debug.ts.
    ...(debug
      ? [
          { label: 'Questions', icon: ICONS.questions, to: (s: Scope) => scoped('/questions', s), on: (r: Route) => r.name === 'questions' },
          { label: 'Trails', icon: ICONS.trails, to: (s: Scope) => scoped('/trails', s), on: (r: Route) => r.name === 'trails' },
        ]
      : []),
    {
      label: 'Explorer',
      icon: ICONS.explorer,
      to: (s) => (s.project === null ? '/explorer' : `/explorer?project=${encodeURIComponent(s.project)}`),
      on: (r) => r.name === 'search',
    },
  ]

  const link = (item: Item): ReactElement => {
    const on = item.on(route)
    return (
      <a
        key={item.label}
        className={on ? 'rail-item on' : 'rail-item'}
        aria-current={on ? 'page' : undefined}
        title={narrow ? item.label : undefined}
        {...linkProps(item.to(scope))}
      >
        {item.icon}
        <span className="rail-text">{item.label}</span>
        {item.badge === undefined || item.badge === null || item.badge === 0 ? null : (
          <span className="rail-badge" aria-label={`${item.badge} findings`}>
            {item.badge}
          </span>
        )}
      </a>
    )
  }

  const synced = findings?.synced_at ?? null
  // A day is the line: a store last read yesterday is still yesterday's work, and that is worth a
  // different colour from one read this morning.
  const fresh = synced !== null && Date.now() - Date.parse(synced) < 86_400_000

  return (
    <nav className="rail" aria-label="probez menu">
      <a className="rail-logo" {...linkProps(scoped('/', scope))} aria-label="probez — overview">
        {/* Both are in the markup and CSS picks one, so the right logo is painted on the first
            frame rather than after a script has worked out the theme. */}
        <img className="logo logo-light" src="/logo-light.png" alt="probez" width={409} height={96} />
        <img className="logo logo-dark" src="/logo-dark.png" alt="" aria-hidden width={409} height={96} />
        <img className="logo-mark" src="/icon.png" alt="" aria-hidden width={22} height={22} />
      </a>

      <div className="rail-group">Insights</div>
      {insights.map(link)}
      <div className="rail-group">Investigate</div>
      {investigate.map(link)}

      <div className="rail-foot">
        <a
          className="rail-sync"
          {...linkProps(href.projects(scope.source))}
          title={
            synced === null
              ? 'Nothing has been collected yet'
              : `probez last read a project here ${ago(synced)}. Sync a project from Projects.`
          }
        >
          <i className={fresh ? 'dot good' : 'dot'} aria-hidden />
          <span className="rail-text">{synced === null ? 'Not synced yet' : `Synced ${ago(synced)}`}</span>
        </a>
        {link({
          label: 'Import',
          icon: ICONS.import,
          to: () => '/import',
          on: (r) => r.name === 'import',
        })}
        {link({
          label: 'Settings',
          icon: ICONS.settings,
          to: () => href.settings(),
          on: (r) => r.name === 'settings',
        })}
        <button
          type="button"
          className="rail-item rail-fold"
          onClick={onToggle}
          aria-expanded={!narrow}
          title={narrow ? 'Show the menu' : 'Fold the menu to icons'}
        >
          <svg viewBox="0 0 16 16" aria-hidden>
            <path
              d={narrow ? 'M6 4l4 4-4 4' : 'M10 4 6 8l4 4'}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="rail-text">Fold menu</span>
        </button>
      </div>
    </nav>
  )
}

/** The menu's icons, drawn on a 16-pixel grid in the stroke weight the rest of the chrome uses. */
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.3,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

const ICONS = {
  home: (
    <svg viewBox="0 0 16 16" aria-hidden>
      <path d="M2.5 7 8 2.5 13.5 7v6.5h-4v-4h-3v4h-4z" {...stroke} />
    </svg>
  ),
  spend: (
    <svg viewBox="0 0 16 16" aria-hidden>
      <path d="M2.5 13.5h11M4 11V8M7 11V5M10 11V7M13 11V3" {...stroke} strokeWidth={1.4} />
    </svg>
  ),
  cache: (
    <svg viewBox="0 0 16 16" aria-hidden>
      <ellipse cx="8" cy="4" rx="5" ry="1.8" {...stroke} />
      <path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8" {...stroke} />
    </svg>
  ),
  context: (
    <svg viewBox="0 0 16 16" aria-hidden>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" {...stroke} />
      <rect x="4.5" y="8" width="7" height="3" fill="currentColor" />
    </svg>
  ),
  findings: (
    <svg viewBox="0 0 16 16" aria-hidden>
      <path d="M8 2.2 14 13H2z" {...stroke} />
      <path d="M8 6.5v3M8 11.2v.3" {...stroke} strokeWidth={1.4} />
    </svg>
  ),
  projects: (
    <svg viewBox="0 0 16 16" aria-hidden>
      <path d="M2.5 4.5h4l1.2 1.5h5.8v6.5h-11z" {...stroke} />
    </svg>
  ),
  sessions: (
    <svg viewBox="0 0 16 16" aria-hidden>
      <path d="M3 4h10M3 8h10M3 12h6" {...stroke} strokeWidth={1.4} />
    </svg>
  ),
  questions: (
    <svg viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="5.5" {...stroke} />
      <path d="M6.4 6.4a1.7 1.7 0 1 1 2.3 1.6c-.5.2-.7.6-.7 1.1M8 11v.2" {...stroke} />
    </svg>
  ),
  trails: (
    <svg viewBox="0 0 16 16" aria-hidden>
      <circle cx="3.5" cy="12" r="1.5" fill="currentColor" />
      <circle cx="12.5" cy="4" r="1.5" fill="currentColor" />
      <path d="M4.5 11c2-1 1-4 4-4.5 2-.3 2.5-1 3-1.8" {...stroke} strokeDasharray="2 1.6" />
    </svg>
  ),
  explorer: (
    <svg viewBox="0 0 16 16" aria-hidden>
      <circle cx="7" cy="7" r="4.2" {...stroke} />
      <path d="m10.2 10.2 3.3 3.3" {...stroke} strokeWidth={1.4} />
    </svg>
  ),
  import: (
    <svg viewBox="0 0 16 16" aria-hidden>
      <path d="M8 2.5v7M5 6.8 8 9.8l3-3M3 11v2.5h10V11" {...stroke} />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="2" {...stroke} />
      <path
        d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6 5 5M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4"
        {...stroke}
      />
    </svg>
  ),
}
