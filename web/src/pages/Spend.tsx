import type { ReactElement } from 'react'

import { api } from '../api'
import type { SplitBy, SplitRow } from '../api'
import { Chrome, Loading, Problem } from '../components/Chrome'
import { categorySeries, Legend, OTHER, rankedSeries, StackedDays } from '../components/Charts'
import type { Series } from '../components/Charts'
import { naturalFor, ordered, SortHead, useSort } from '../components/SortHead'
import { count, money, percent, shortModel, tokens } from '../format'
import { go, linkProps } from '../router'
import { changeFilters, RANGE_PHRASE, scoped, useFilter, useScope } from '../scope'
import type { Scope } from '../scope'
import { SOURCE_CHOICES } from '../source'
import type { SourceChoice } from '../source'
import { useData } from '../useData'
import { EmptyRange, projectNameOf, scopeLine } from './Overview'

const SPLITS: Array<{ by: SplitBy; label: string; noun: string }> = [
  { by: 'project', label: 'Project', noun: 'project' },
  { by: 'model', label: 'Model', noun: 'model' },
  { by: 'source', label: 'Agent', noun: 'agent' },
  { by: 'category', label: 'Work', noun: 'kind of work' },
]

function asSplit(value: string | null): SplitBy {
  return SPLITS.some((one) => one.by === value) ? (value as SplitBy) : 'project'
}

/**
 * The Sessions list a split row stands for.
 *
 * A project or an agent is part of the scope, so choosing one moves the scope; a model or a kind of
 * work is a filter on the list, so it travels beside it.
 */
export function sessionsFor(by: SplitBy, key: string, scope: Scope, extra: Record<string, string> = {}): string {
  if (by === 'project') return scoped('/sessions', { ...scope, project: key }, extra)
  if (by === 'source' && (SOURCE_CHOICES as readonly string[]).includes(key)) {
    return scoped('/sessions', { ...scope, source: key as SourceChoice }, extra)
  }
  if (by === 'model') return scoped('/sessions', scope, { ...extra, model: key })
  if (by === 'category') return scoped('/sessions', scope, { ...extra, category: key })
  return scoped('/sessions', scope, extra)
}

type SplitSort = 'name' | 'cost' | 'share' | 'rounds' | 'sessions' | 'input' | 'cache' | 'output'

const splitNatural = naturalFor<SplitSort>('name')

function splitValue(row: SplitRow, key: SplitSort): number | string | null {
  switch (key) {
    case 'name':
      return row.label
    case 'cost':
    case 'share':
      return row.cost
    case 'rounds':
      return row.rounds
    case 'sessions':
      return row.sessions
    case 'input':
      return row.in_tokens
    case 'cache':
      return row.in_tokens > 0 ? row.in_cache_read / row.in_tokens : null
    case 'output':
      return row.out_tokens
  }
}

/**
 * Insights › Spend: which project, model, agent or kind of work the money went to.
 *
 * One "split by" control decides both the chart and the table under it, so the bar a colour names
 * and the row that colour labels are the same figure. Every bar and every row opens Sessions
 * filtered to it.
 */
export function Spend(): ReactElement {
  const scope = useScope()
  const by = asSplit(useFilter('by'))
  const { data, error, loading } = useData(() => api.insights(scope), [scope.range, scope.source, scope.project])
  const [sorted, sortBy] = useSort<SplitSort>(splitNatural, { key: 'cost', dir: 'desc' })

  const split = SPLITS.find((one) => one.by === by)!
  const rows = data?.splits[by] ?? []
  const total = rows.reduce((sum, row) => sum + row.cost, 0)
  const series: Series[] =
    by === 'category' ? categorySeries(rows) : rankedSeries(rows.map((row) => ({ ...row, label: by === 'model' ? shortModel(row.key) : row.label })))

  return (
    <>
      <Chrome crumbs={[{ label: 'Insights' }, { label: 'Spend' }]} scope="store" search={{ slug: scope.project }} />
      <main className="page">
        {error !== null && data === null ? (
          <Problem message={error} />
        ) : data === null ? (
          <Loading what="the spend" />
        ) : (
          <div className={loading ? 'rereading' : undefined}>
            <div className="head">
              <h1>Spend</h1>
              <span className="muted">{scopeLine(scope, projectNameOf(data, scope))}</span>
              <span className="spacer" style={{ flex: 1 }} />
              <div className="toggle" role="group" aria-label="Split by">
                <span className="muted" style={{ marginRight: 6 }}>
                  Split by
                </span>
                {SPLITS.map((one) => (
                  <button
                    key={one.by}
                    type="button"
                    aria-pressed={by === one.by}
                    onClick={() => changeFilters({ by: one.by === 'project' ? null : one.by })}
                  >
                    {one.label}
                  </button>
                ))}
              </div>
            </div>
            {data.totals.rounds === 0 ? (
              <EmptyRange scope={scope} latest={data.latest} />
            ) : (
              <>
                <div className="card" style={{ marginTop: 16 }}>
                  <div className="card-head">
                    <h3>Daily spend</h3>
                    <span className="muted">
                      {money(data.totals.cost)} · stacked by {split.noun}
                    </span>
                  </div>
                  <StackedDays
                    days={data.days.map((day) => ({ day: day.day, values: day.by[by] }))}
                    series={series}
                    label={`Daily spend, ${RANGE_PHRASE[scope.range]}, stacked by ${split.noun}`}
                    onPick={(day, key) => go(key === OTHER ? scoped('/sessions', scope, { day }) : sessionsFor(by, key, scope, { day }))}
                  />
                  <Legend series={series} onPick={(key) => go(sessionsFor(by, key, scope))} />
                </div>

                <section>
                  <table>
                    <thead>
                      <tr>
                        <SortHead label={split.label} head="name" sorted={sorted} onSort={sortBy} />
                        <SortHead label="Cost" head="cost" sorted={sorted} onSort={sortBy} className="r" />
                        <SortHead label="Share" head="share" sorted={sorted} onSort={sortBy} className="r" title="Share of the spend in scope" />
                        <SortHead label="Rounds" head="rounds" sorted={sorted} onSort={sortBy} className="r" />
                        <SortHead label="Sessions" head="sessions" sorted={sorted} onSort={sortBy} className="r" />
                        <SortHead label="Input" head="input" sorted={sorted} onSort={sortBy} className="r" title="All input tokens, cached and not" />
                        <SortHead label="Cache" head="cache" sorted={sorted} onSort={sortBy} className="r" title="Share of input served from the cache" />
                        <SortHead label="Output" head="output" sorted={sorted} onSort={sortBy} className="r" />
                      </tr>
                    </thead>
                    <tbody>
                      {ordered(rows, sorted, splitValue).map((row) => (
                        <tr key={row.key} className="row" onClick={() => go(sessionsFor(by, row.key, scope))}>
                          <td className={by === 'model' ? 'mono' : undefined}>
                            <a {...linkProps(sessionsFor(by, row.key, scope))}>
                              {by === 'model' ? shortModel(row.key) : row.label}
                            </a>
                          </td>
                          <td className="r num">
                            <strong>{money(row.cost)}</strong>
                          </td>
                          <td className="r num dim">{total > 0 ? percent(row.cost / total, 1) : '—'}</td>
                          <td className="r num">{count(Math.round(row.rounds))}</td>
                          <td className="r num">{count(row.sessions)}</td>
                          <td className="r num dim">{tokens(row.in_tokens)}</td>
                          <td className="r num dim">
                            {row.in_tokens > 0 ? percent(row.in_cache_read / row.in_tokens) : '—'}
                          </td>
                          <td className="r num dim">{tokens(row.out_tokens)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="note" style={{ marginTop: 12 }}>
                    {by === 'category'
                      ? 'A round that made several calls is divided among the kinds of work they were, so rounds here can be fractions and sessions can count under more than one row. Prose only is the rounds that called no tool.'
                      : `Each round is counted under the one ${split.noun} it ran in.`}{' '}
                    {data.totals.unpriced > 0
                      ? `${count(data.totals.unpriced)} rounds have no rate for their model and add nothing to Cost.`
                      : null}
                  </p>
                </section>
              </>
            )}
          </div>
        )}
      </main>
    </>
  )
}
