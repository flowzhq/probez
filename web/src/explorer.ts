import { href } from './router'
import type { Entity } from './router'
import type { Scope } from './scope'

/**
 * A filtered list, as the query that asks Explorer the same thing.
 *
 * The lists and Explorer are two views of one store, so a list should be able to hand its question
 * over: the scope becomes `since:`, `source:` and the project Explorer is scoped to, and each filter
 * becomes its field. Two filters have no field — a share of a session's cost and a share of a
 * model's window are properties of a whole session, and a query matches rounds — so they hand over
 * the nearest thing the language can say, and `inexact` names what was left behind so the button
 * can say so.
 */
export interface Handover {
  q: string
  /** What the query could not carry, for the button's title. Empty when it carries everything. */
  inexact: string[]
}

/** The first day of a range, as the date the scope bar's range starts on. */
export function rangeStart(scope: Scope, now = Date.now()): string | null {
  if (scope.range === 'all') return null
  const days = Number(scope.range.slice(0, -1))
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`)
  return new Date(today - (days - 1) * 86_400_000).toISOString().slice(0, 10)
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10)
}

/** A value as a query term: quoted when it would not survive as one word. */
function term(key: string, value: string): string {
  return /[\s"]/.test(value) ? `${key}:"${value.replaceAll('"', '\\"')}"` : `${key}:${value}`
}

export function handover(
  scope: Scope,
  filters: {
    model?: string | null
    category?: string | null
    errors?: string | null
    day?: string | null
    finding?: string | null
    reasked?: string | null
    outcome?: string | null
  } = {},
): Handover {
  const parts: string[] = []
  const inexact: string[] = []
  const start = rangeStart(scope)
  if (start !== null) parts.push(`since:${start}`)
  if (scope.source !== null) parts.push(`source:${scope.source}`)
  if (filters.day !== undefined && filters.day !== null) {
    parts.push(`since:${filters.day}`, `before:${nextDay(filters.day)}`)
  }
  if (filters.model !== undefined && filters.model !== null) parts.push(term('model', filters.model))
  if (filters.category !== undefined && filters.category !== null) {
    // Prose is the rounds that called nothing, which is a fact about the round and not a category.
    parts.push(filters.category === 'prose' ? '-has:tools' : `category:${filters.category}`)
  }
  if (filters.errors !== undefined && filters.errors !== null) parts.push('is:error')
  if (filters.finding === 'reconstruction') {
    parts.push('category:reconstruction')
    inexact.push("the share of each session's cost, so every session with any reconstruction matches")
  }
  if (filters.finding === 'context') {
    inexact.push("how full each round's context was, which no field holds")
  }
  if (filters.reasked !== undefined && filters.reasked !== null) {
    inexact.push('whether a question was asked again, which is counted after the rounds are matched')
  }
  if (filters.outcome !== undefined && filters.outcome !== null) {
    inexact.push('how a trail ended, which is worked out after the rounds are matched')
  }
  // A list with nothing to narrow it is every round, and the language says that as a round
  // number every round has, so Explorer answers rather than showing its help page.
  return { q: parts.length === 0 ? 'round:>=0' : parts.join(' '), inexact }
}

/** Where Open in Explorer goes: the query, counted as the list was, in the list's project. */
export function explorerHref(scope: Scope, entity: Entity, filters: Parameters<typeof handover>[1] = {}): string {
  return href.search(handover(scope, filters).q, { entity, slug: scope.project })
}
