import { useCallback, useEffect, useState } from 'react'
import type { MouseEvent } from 'react'

/**
 * The four levels, as four routes.
 *
 * A round is a query parameter rather than a path segment because it is a *selection* inside a
 * task, not a place: clicking through rounds in the inspector should not fill the back button with
 * one entry per round. Selecting replaces; navigating pushes.
 */
export type Route =
  | { name: 'projects' }
  | { name: 'settings' }
  | { name: 'project'; slug: string }
  | { name: 'session'; slug: string; session: string }
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

export function parse(pathname: string, search: string): Route {
  const parts = pathname.split('/').filter((part) => part !== '')
  if (parts.length === 0) return { name: 'projects' }
  if (parts.length === 1 && parts[0] === 'settings') return { name: 'settings' }

  const [p, slug, s, encoded, t, task] = parts
  // A subagent's session id is a path, so it travels percent-encoded in a single segment.
  const session = encoded === undefined ? undefined : decodeSegment(encoded)
  if (p !== 'p' || slug === undefined) return { name: 'missing', path: pathname }
  if (s === undefined) return { name: 'project', slug }
  if (s !== 's' || session === undefined) return { name: 'missing', path: pathname }
  if (t === undefined) return { name: 'session', slug, session }
  if (t !== 't' || task === undefined) return { name: 'missing', path: pathname }

  const number = Number(task)
  if (!Number.isInteger(number)) return { name: 'missing', path: pathname }
  const query = new URLSearchParams(search)
  const selected = query.get('r')
  const round = selected === null || selected === '' ? null : Number(selected)
  const trail = query.get('trail')
  const asked = query.get('question')
  const question = asked === null || asked === '' ? null : Number(asked)
  return {
    name: 'task',
    slug,
    session,
    task: number,
    round: round === null || Number.isNaN(round) ? null : round,
    trail: trail === null || trail === '' ? null : trail,
    question: question === null || Number.isNaN(question) ? null : question,
  }
}

export const href = {
  projects: () => '/',
  settings: () => '/settings',
  project: (slug: string) => `/p/${slug}`,
  session: (slug: string, session: string) => `/p/${slug}/s/${encodeURIComponent(session)}`,
  task: (
    slug: string,
    session: string,
    task: number,
    round?: number,
    trail?: string | null,
    question?: number | null,
  ) => {
    const query = new URLSearchParams()
    if (round !== undefined) query.set('r', String(round))
    if (trail !== undefined && trail !== null) query.set('trail', trail)
    if (question !== undefined && question !== null) query.set('question', String(question))
    const search = query.toString()
    return `/p/${slug}/s/${encodeURIComponent(session)}/t/${task}${search === '' ? '' : `?${search}`}`
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
