import type { ReactElement } from 'react'

import { go, href } from '../router'
import type { Entity, SourceChoice } from '../router'
import { SOURCE_CHOICES, setSourceQuery, sourceQueryOf } from '../source'

/**
 * Pins the page to one agent, or writes `source:` into a search.
 *
 * On a browse page the control is a display filter: it stays on this layout and only the rounds
 * change. On the search page it still rewrites the `source:` token in the query, which is how
 * typing `source:cursor` in the bar and picking Cursor from the dropdown stay the same language.
 * Sync still collects every agent.
 */
export function SourceFilter({
  slug,
  initial,
  entity,
  source,
  mode = 'page',
}: {
  slug?: string | null
  initial?: string
  entity?: Entity | null
  source?: SourceChoice | null
  mode?: 'page' | 'search'
}): ReactElement {
  const current =
    mode === 'search' ? (sourceQueryOf(initial ?? '') ?? '') : (source ?? '')

  const apply = (alias: string): void => {
    if (mode === 'search') {
      const next = setSourceQuery(initial ?? '', alias === '' ? null : alias)
      if (next === '') {
        go(slug ? href.project(slug) : href.projects())
        return
      }
      go(href.search(next, { slug: slug ?? null, entity: entity ?? null }))
      return
    }
    go(slug ? href.project(slug, alias || null) : href.projects(alias || null))
  }

  return (
    <label className="source-filter">
      <span className="muted">Source</span>
      <select
        aria-label="Filter by agent source"
        value={SOURCE_CHOICES.includes(current as (typeof SOURCE_CHOICES)[number]) ? current : ''}
        onChange={(event) => apply(event.target.value)}
      >
        <option value="">All</option>
        <option value="claude">Claude</option>
        <option value="cursor">Cursor</option>
        <option value="codex">Codex</option>
      </select>
    </label>
  )
}
