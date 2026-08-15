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
  | { name: 'project'; slug: string }
  | { name: 'session'; slug: string; session: string }
  | { name: 'task'; slug: string; session: string; task: number; round: number | null }
  | { name: 'missing'; path: string }

export function parse(pathname: string, search: string): Route {
  const parts = pathname.split('/').filter((part) => part !== '')
  if (parts.length === 0) return { name: 'projects' }

  const [p, slug, s, session, t, task] = parts
  if (p !== 'p' || slug === undefined) return { name: 'missing', path: pathname }
  if (s === undefined) return { name: 'project', slug }
  if (s !== 's' || session === undefined) return { name: 'missing', path: pathname }
  if (t === undefined) return { name: 'session', slug, session }
  if (t !== 't' || task === undefined) return { name: 'missing', path: pathname }

  const number = Number(task)
  if (!Number.isInteger(number)) return { name: 'missing', path: pathname }
  const selected = new URLSearchParams(search).get('r')
  const round = selected === null || selected === '' ? null : Number(selected)
  return {
    name: 'task',
    slug,
    session,
    task: number,
    round: round === null || Number.isNaN(round) ? null : round,
  }
}

export const href = {
  projects: () => '/',
  project: (slug: string) => `/p/${slug}`,
  session: (slug: string, session: string) => `/p/${slug}/s/${session}`,
  task: (slug: string, session: string, task: number, round?: number) =>
    `/p/${slug}/s/${session}/t/${task}${round === undefined ? '' : `?r=${round}`}`,
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
