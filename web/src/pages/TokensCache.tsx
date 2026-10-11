import type { ReactElement } from 'react'

import { api } from '../api'
import { Chrome, Info, Loading, Problem } from '../components/Chrome'
import { Kpi } from '../components/Charts'
import { ReusedFreshTrend } from '../components/ReusedFreshTrend'
import { money, percent, tokens } from '../format'
import { go, linkProps } from '../router'
import { scoped, useScope } from '../scope'
import { useData } from '../useData'
import { EmptyRange, projectNameOf, scopeLine } from './Overview'

/**
 * Insights › Tokens & cache: how much input was new, and what that cost.
 *
 * The share served from cache is the headline every store gets wrong in its head — it is usually
 * over ninety percent, so input volume on its own says almost nothing about the bill. The figure
 * that does is the price of the input that was *not* a cache read, against what the same tokens
 * would have cost had they been: the gap is the most a better-kept cache could have saved.
 */
export function TokensCache(): ReactElement {
  const scope = useScope()
  const { data, error, loading } = useData(() => api.insights(scope), [scope.range, scope.source, scope.project])

  return (
    <>
      <Chrome crumbs={[{ label: 'Insights' }, { label: 'Tokens & cache' }]} scope="store" search={{ slug: scope.project }} />
      <main className="page">
        {error !== null && data === null ? (
          <Problem message={error} />
        ) : data === null ? (
          <Loading what="the tokens" />
        ) : (
          <div className={loading ? 'rereading' : undefined}>
            <div className="head">
              <h1>Tokens &amp; cache</h1>
              <span className="muted">{scopeLine(scope, projectNameOf(data, scope))}</span>
            </div>
            {data.totals.rounds === 0 ? (
              <EmptyRange scope={scope} latest={data.latest} />
            ) : (
              <>
                <div className="kpis">
                  <Kpi
                    label="Served from cache"
                    value={
                      data.cache.reused + data.cache.fresh > 0
                        ? percent(data.cache.reused / (data.cache.reused + data.cache.fresh), 1)
                        : '—'
                    }
                    note={`${tokens(data.cache.reused)} reused`}
                  />
                  <Kpi label="Fresh input" value={tokens(data.cache.fresh)} note="uncached, or written to cache" />
                  <Kpi
                    label="Fresh input cost"
                    value={money(data.cache.fresh_cost) === '·' ? '$0' : money(data.cache.fresh_cost)}
                    note={
                      data.totals.cost > 0 ? `${percent(data.cache.fresh_cost / data.totals.cost)} of all spend` : undefined
                    }
                  />
                  <Kpi
                    label="As cache reads"
                    value={money(data.cache.fresh_at_read) === '·' ? '$0' : money(data.cache.fresh_at_read)}
                    note={`${money(Math.max(0, data.cache.fresh_cost - data.cache.fresh_at_read))} more than that, at most`}
                  />
                </div>
                <p className="note" style={{ marginTop: 8 }}>
                  <em>As cache reads</em> is what the same fresh tokens would have cost billed at each
                  model&apos;s cache-read rate. Some fresh input is unavoidable — the first read of
                  anything is new — so the difference is a ceiling on what caching better could have
                  saved, not a saving anyone left on the table. Cache reads themselves cost{' '}
                  {money(data.cache.reused_cost)}.
                </p>

                <section>
                  <h2>Reused vs fresh, by day</h2>
                  <ReusedFreshTrend days={data.cache.days} />
                </section>

                <section>
                  <h2>
                    Projects by fresh input cost{' '}
                    <Info says="Ranked by what their input that was not a cache read cost. A row opens that project's sessions." />
                  </h2>
                  {data.cache.by_project.length === 0 ? (
                    <p className="note">No round in scope recorded its input split.</p>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>Project</th>
                          <th className="r">Fresh cost</th>
                          <th className="r">Fresh</th>
                          <th className="r">Reused</th>
                          <th className="r">Cache</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.cache.by_project.map((row) => {
                          const to = scoped('/sessions', { ...scope, project: row.slug })
                          return (
                            <tr key={row.slug} className="row" onClick={() => go(to)}>
                              <td>
                                <a {...linkProps(to)}>
                                  <strong>{row.project}</strong>
                                </a>
                              </td>
                              <td className="r num">
                                <strong>{money(row.fresh_cost)}</strong>
                              </td>
                              <td className="r num dim">{tokens(row.fresh)}</td>
                              <td className="r num dim">{tokens(row.reused)}</td>
                              <td className="r num dim">
                                {row.fresh + row.reused > 0 ? percent(row.reused / (row.fresh + row.reused)) : '—'}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  )}
                </section>
              </>
            )}
          </div>
        )}
      </main>
    </>
  )
}
