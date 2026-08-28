import { useCallback, useEffect, useState } from 'react'
import type { MouseEvent } from 'react'

/**
 * The four levels, as four routes.
 *
 * A round is a query parameter rather than a path segment because it is a *selection* inside a
 * task, not a place: clicking through rounds in the inspector should not fill the back button with
 * one entry per round. Selecting replaces; navigating pushes.
 *
 * `source` on browse routes is a page filter, not a search: the layout stays, the rounds change.
 * The search route keeps `source:` inside `q`.
 */
export type SourceChoice = 'claude' | 'cursor' | 'codex'

export type Route =
  | { name: 'projects'; source: SourceChoice | null }
  | { name: 'settings' }
  /**
   * A query, and what it is counted as.
   *
   * A page rather than a selection, because a search is a place you can be sent to: the query is
   * in the URL, so a result is a link. `slug` scopes it to one project and is dropped to widen it
   * to the whole store.
   */
  | {
      name: 'search'
      q: string
      /** What to count, when the URL says. Null leaves it to the query's own `in:`. */
      entity: Entity | null
      slug: string | null
      /**
       * The sentence this query was read from, when one was.
       *
       * Only ever a caption. The query is what ran and what a link carries, so a result compiled
       * from a sentence is re-runnable by anyone, with or without a reader configured.
       */
      from: string | null
    }
  | { name: 'project'; slug: string; source: SourceChoice | null }
  | { name: 'session'; slug: string; session: string; source: SourceChoice | null }
  | {
      name: 'task'
      slug: string
      session: string
      task: number
      round: number | null
      /** The trail being read, by its `ref`. A selection inside the task, like `round`. */
      trail: string | null
      /**
       * The question being read, by its `at` — the position of its first call in the task.
       *
       * A number rather than the `ref` a person reads, because a round can start two questions and
       * then the ref names both. The trail above has no such trouble: two trails do not begin at one
       * call.
       */
      question: number | null
      /**
       * A query whose matching rounds are lit in the trace.
       *
       * A selection like `round`, not a filter: every round of the task is still drawn, and the
       * ones the query did not match are dimmed. A trace with rounds missing from it would be a
       * different and much less useful picture than a trace with rounds greyed out.
       */
      q: string | null
      /**
       * Page filter carried from the project, so crumbs and the Source control stay on that agent.
       * Does not hide rounds in the trace — a session is one source.
       */
      source: SourceChoice | null
    }
  | { name: 'missing'; path: string }

/** One path segment as it was written, or as-is when it is not valid percent-encoding. */
function decodeSegment(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

/** What a search counts. Mirrors `Entity` in `src/query.ts`; the server refuses anything else. */
export type Entity = 'rounds' | 'tasks' | 'sessions' | 'projects' | 'questions' | 'trails'

const ENTITIES: Entity[] = ['rounds', 'tasks', 'sessions', 'projects', 'questions', 'trails']

/**
 * The entity the URL names, or null when it names none.
 *
 * Null rather than defaulting to `rounds`, because a query can carry its own `in:` and a default
 * here would silently override it — which is exactly what happened to the first query a sentence
 * ever compiled to. Absent means "whatever the query says", and the tabs write it explicitly.
 */
function asEntity(value: string | null): Entity | null {
  return value !== null && (ENTITIES as string[]).includes(value) ? (value as Entity) : null
}

function asSource(value: string | null): SourceChoice | null {
  return value === 'claude' || value === 'cursor' || value === 'codex' ? value : null
}

/** Carry a page-filter `source` on a path that may already have a query. */
export function withSource(path: string, source?: string | null): string {
  if (source === undefined || source === null || source === '') return path
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}source=${encodeURIComponent(source)}`
}

export function parse(pathname: string, search: string): Route {
  const parts = pathname.split('/').filter((part) => part !== '')
  if (parts.length === 0) {
    return { name: 'projects', source: asSource(new URLSearchParams(search).get('source')) }
  }
  if (parts.length === 1 && parts[0] === 'settings') return { name: 'settings' }
  if (parts.length === 1 && parts[0] === 'search') {
    const query = new URLSearchParams(search)
    const from = query.get('from')
    return {
      name: 'search',
      q: query.get('q') ?? '',
      entity: asEntity(query.get('in')),
      slug: query.get('project'),
      from: from === null || from === '' ? null : from,
    }
  }

  const [p, slug, s, encoded, t, task] = parts
  // A subagent's session id is a path, so it travels percent-encoded in a single segment.
  const session = encoded === undefined ? undefined : decodeSegment(encoded)
  if (p !== 'p' || slug === undefined) return { name: 'missing', path: pathname }
  const source = asSource(new URLSearchParams(search).get('source'))
  if (s === undefined) return { name: 'project', slug, source }
  if (s !== 's' || session === undefined) return { name: 'missing', path: pathname }
  if (t === undefined) return { name: 'session', slug, session, source }
  if (t !== 't' || task === undefined) return { name: 'missing', path: pathname }

  const number = Number(task)
  if (!Number.isInteger(number)) return { name: 'missing', path: pathname }
  const query = new URLSearchParams(search)
  const selected = query.get('r')
  const round = selected === null || selected === '' ? null : Number(selected)
  const trail = query.get('trail')
  const asked = query.get('question')
  const question = asked === null || asked === '' ? null : Number(asked)
  const lit = query.get('q')
  return {
    name: 'task',
    slug,
    session,
    task: number,
    round: round === null || Number.isNaN(round) ? null : round,
    trail: trail === null || trail === '' ? null : trail,
    question: question === null || Number.isNaN(question) ? null : question,
    q: lit === null || lit === '' ? null : lit,
    source,
  }
}

export const href = {
  projects: (source?: string | null) => withSource('/', source),
  settings: () => '/settings',
  search: (
    q: string,
    options: { entity?: Entity | null; slug?: string | null; from?: string | null } = {},
  ) => {
    const query = new URLSearchParams({ q })
    if (options.entity !== undefined && options.entity !== null) query.set('in', options.entity)
    if (options.slug !== undefined && options.slug !== null) query.set('project', options.slug)
    if (options.from !== undefined && options.from !== null) query.set('from', options.from)
    return `/search?${query.toString()}`
  },
  project: (slug: string, source?: string | null) => withSource(`/p/${slug}`, source),
  session: (slug: string, session: string, source?: string | null) =>
    withSource(`/p/${slug}/s/${encodeURIComponent(session)}`, source),
  task: (
    slug: string,
    session: string,
    task: number,
    round?: number,
    trail?: string | null,
    question?: number | null,
    q?: string | null,
    source?: string | null,
  ) => {
    const query = new URLSearchParams()
    if (round !== undefined) query.set('r', String(round))
    if (trail !== undefined && trail !== null) query.set('trail', trail)
    if (question !== undefined && question !== null) query.set('question', String(question))
    if (q !== undefined && q !== null && q !== '') query.set('q', q)
    const search = query.toString()
    return withSource(
      `/p/${slug}/s/${encodeURIComponent(session)}/t/${task}${search === '' ? '' : `?${search}`}`,
      source,
    )
  },
}

export function go(to: string, replace = false): void {
  if (replace) window.history.replaceState(null, '', to)
  else window.history.pushState(null, '', to)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function useRoute(): Route {
  const read = useCallback(
    () => parse(window.location.pathname, window.location.search),
    [],
  )
  const [route, setRoute] = useState<Route>(read)
  useEffect(() => {
    const update = (): void => setRoute(read())
    window.addEventListener('popstate', update)
    return () => window.removeEventListener('popstate', update)
  }, [read])
  return route
}

/** A link that navigates in-page, while still being a real link you can middle-click or copy. */
export function linkProps(to: string): {
  href: string
  onClick: (event: MouseEvent) => void
} {
  return {
    href: to,
    onClick: (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) return
      if (event.button !== 0) return
      event.preventDefault()
      // The row around it navigates too; letting both fire would push two history entries.
      event.stopPropagation()
      go(to)
    },
  }
}
