import { useEffect, useState } from 'react'

import type { Range } from './api'
import { SOURCE_CHOICES } from './source'
import type { SourceChoice } from './source'

/**
 * The scope bar: a time range, an agent and a project, and nothing else.
 *
 * It lives in the URL rather than in state, which is the whole of the design: a link someone sends
 * opens on the same thirty days of the same agent they were looking at, and the back button undoes
 * a change of scope the way it undoes anything else. Every Insights chart and Investigate list
 * reads it from here, so two pages under one scope bar are always answering about the same rounds.
 *
 * `source` is the parameter the browse pages have always used for the agent, so the project,
 * session and task pages keep working under it unchanged.
 */
export interface Scope {
  range: Range
  source: SourceChoice | null
  project: string | null
  /** Whose work, by the name it was recorded under; null for everyone's. Offered once a merge brings a second name. */
  committer: string | null
}

export const RANGES: Range[] = ['7d', '30d', '90d', 'all']

export const RANGE_LABEL: Record<Range, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  all: 'All time',
}

/** What the range is called in a sentence: "in the last 30 days", "in all". */
export const RANGE_PHRASE: Record<Range, string> = {
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  '90d': 'last 90 days',
  all: 'all time',
}

const DEFAULT_RANGE: Range = '30d'

function asRange(value: string | null): Range {
  return value !== null && (RANGES as string[]).includes(value) ? (value as Range) : DEFAULT_RANGE
}

function asSource(value: string | null): SourceChoice | null {
  return value !== null && (SOURCE_CHOICES as readonly string[]).includes(value)
    ? (value as SourceChoice)
    : null
}

export function readScope(search: string = window.location.search): Scope {
  const query = new URLSearchParams(search)
  const project = query.get('project')
  const committer = query.get('committer')
  return {
    range: asRange(query.get('range')),
    source: asSource(query.get('source')),
    project: project === null || project === '' ? null : project,
    committer: committer === null || committer === '' ? null : committer,
  }
}

/** The scope's own parameters, written onto `query`. The default range is left out of the URL. */
function writeScope(query: URLSearchParams, scope: Scope): void {
  if (scope.range === DEFAULT_RANGE) query.delete('range')
  else query.set('range', scope.range)
  if (scope.source === null) query.delete('source')
  else query.set('source', scope.source)
  if (scope.project === null) query.delete('project')
  else query.set('project', scope.project)
  if (scope.committer === null) query.delete('committer')
  else query.set('committer', scope.committer)
}

/**
 * A path under a scope, with any list filters beside it.
 *
 * Filters are separate from the scope on purpose: moving from Sessions to Questions keeps the
 * thirty days and the agent, and drops the `model:` the Sessions list was narrowed to, which means
 * nothing to a list of questions.
 */
export function scoped(path: string, scope: Scope, filters: Record<string, string | null> = {}): string {
  const [base, search] = path.split('?') as [string, string | undefined]
  const query = new URLSearchParams(search ?? '')
  writeScope(query, scope)
  for (const [key, value] of Object.entries(filters)) {
    if (value === null || value === '') query.delete(key)
    else query.set(key, value)
  }
  const text = query.toString()
  return text === '' ? base : `${base}?${text}`
}

/** The current scope, re-read whenever the address changes. */
export function useScope(): Scope {
  const [scope, setScope] = useState<Scope>(() => readScope())
  useEffect(() => {
    const update = (): void => {
      setScope((was) => {
        const now = readScope()
        return was.range === now.range &&
          was.source === now.source &&
          was.project === now.project &&
          was.committer === now.committer
          ? was
          : now
      })
    }
    window.addEventListener('popstate', update)
    return () => window.removeEventListener('popstate', update)
  }, [])
  return scope
}

/**
 * Change the scope where you stand.
 *
 * Pushed rather than replaced: a scope is something you look at and then back out of, and the
 * back button is how. The page and its filters stay.
 */
export function changeScope(change: Partial<Scope>): void {
  const next = { ...readScope(), ...change }
  const query = new URLSearchParams(window.location.search)
  writeScope(query, next)
  const text = query.toString()
  window.history.pushState(null, '', `${window.location.pathname}${text === '' ? '' : `?${text}`}`)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/** One list filter from the address, or null. */
export function useFilter(name: string): string | null {
  const read = (): string | null => {
    const value = new URLSearchParams(window.location.search).get(name)
    return value === null || value === '' ? null : value
  }
  const [value, setValue] = useState<string | null>(read)
  useEffect(() => {
    const update = (): void => setValue(read())
    window.addEventListener('popstate', update)
    return () => window.removeEventListener('popstate', update)
    // `read` closes over nothing but `name`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])
  return value
}

/** Set or drop list filters on the current page, keeping the scope. */
export function changeFilters(filters: Record<string, string | null>): void {
  const query = new URLSearchParams(window.location.search)
  for (const [key, value] of Object.entries(filters)) {
    if (value === null || value === '') query.delete(key)
    else query.set(key, value)
  }
  const text = query.toString()
  window.history.pushState(null, '', `${window.location.pathname}${text === '' ? '' : `?${text}`}`)
  window.dispatchEvent(new PopStateEvent('popstate'))
}
