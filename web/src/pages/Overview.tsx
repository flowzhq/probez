import type { ReactElement } from 'react'

import { api } from '../api'
import type { InsightsPayload } from '../api'
import { Chrome, Loading, Problem } from '../components/Chrome'
import { changeOf, HBars, Kpi, Legend, OTHER, rankedSeries, ShareStack, StackedDays } from '../components/Charts'
import { FindingList } from '../components/FindingList'
import { count, money, percent, shortModel, tokens, when } from '../format'
import { go, href, linkProps } from '../router'
import { changeScope, RANGE_PHRASE, scoped, useScope } from '../scope'
import type { Scope } from '../scope'
import { SOURCE_LABEL } from '../source'
import { useData } from '../useData'

/** What the page is over, in the words a heading uses: "All projects · last 30 days". */
export function scopeLine(scope: Scope, projectName?: string | null): string {
  const project = scope.project === null ? 'All projects' : (projectName ?? scope.project)
  const agent = scope.source === null ? '' : ` · ${SOURCE_LABEL[scope.source]}`
  return `${project}${agent} · ${RANGE_PHRASE[scope.range]}`
}

/** The name of the scoped project, if the payload can tell us it. */
export function projectNameOf(data: InsightsPayload | null, scope: Scope): string | null {
  if (data === null || scope.project === null) return null
  return data.splits.project.find((row) => row.key === scope.project)?.label ?? null
}

/**
 * Nothing ran in the range, which is a different thing from a store with nothing in it.
 *
 * Says when the last thing did run, and offers the range that would show it, because the commonest
 * way to land here is opening the app a few weeks after the last time.
 */
export function EmptyRange({ scope, latest }: { scope: Scope; latest: string | null }): ReactElement {
  return (
    <div className="placeholder">
      <h4>Nothing ran in the {RANGE_PHRASE[scope.range]}</h4>
      {latest === null ? (
        <p>
          This store holds no rounds yet. Run <span className="mono">probez collect</span> in a project you
          work in, or <a {...linkProps('/import')}>import</a> one someone sent you.
        </p>
      ) : (
        <p>
          The latest round here ran {when(latest)}.{' '}
          {scope.range === 'all' ? null : (
            <button type="button" className="linkish" onClick={() => changeScope({ range: 'all' })}>
              Show all time
            </button>
          )}
        </p>
      )}
    </div>
  )
}

/**
 * Insights › Overview: what agents cost in the scope, whether it is rising, and what drove it.
 *
 * Four figures with how they moved, the days they were spent on, who spent them, and the two or
 * three findings worth a look. Every mark opens the Sessions list filtered to it.
 */
export function Overview(): ReactElement {
  const scope = useScope()
  const { data, error, loading } = useData(() => api.insights(scope), [scope.range, scope.source, scope.project, scope.committer])
  const findings = useData(() => api.findings(scope), [scope.range, scope.source, scope.project, scope.committer])

  return (
    <>
      <Chrome crumbs={[{ label: 'Insights' }, { label: 'Overview' }]} scope="store" search={{ slug: scope.project }} />
      <main className="page">
        {error !== null && data === null ? (
          <Problem message={error} />
        ) : data === null ? (
          <Loading what="the store" />
        ) : (
          <div className={loading ? 'rereading' : undefined}>
            <div className="head">
              <h1>Overview</h1>
              <span className="muted">{scopeLine(scope, projectNameOf(data, scope))}</span>
            </div>
            {data.totals.rounds === 0 ? (
              <EmptyRange scope={scope} latest={data.latest} />
            ) : (
              <OverviewBody data={data} scope={scope} findings={findings.data?.findings ?? null} />
            )}
          </div>
        )}
      </main>
    </>
  )
}

function OverviewBody({
  data,
  scope,
  findings,
}: {
  data: InsightsPayload
  scope: Scope
  findings: Parameters<typeof FindingList>[0]['findings'] | null
}): ReactElement {
  const { totals, previous } = data
  const cached = totals.in_tokens > 0 ? totals.in_cache_read / totals.in_tokens : null
  const cachedBefore = previous !== null && previous.in_tokens > 0 ? previous.in_cache_read / previous.in_tokens : null
  const perTask = totals.tasks > 0 ? totals.cost / totals.tasks : null
  const perTaskBefore = previous !== null && previous.tasks > 0 ? previous.cost / previous.tasks : null

  const projects = rankedSeries(data.splits.project, 6)
  const days = data.days.map((day) => ({ day: day.day, values: day.by.project }))
  const models = data.splits.model.slice(0, 5)
  const spent = data.splits.category.reduce((sum, row) => sum + row.cost, 0)

  return (
    <>
      <div className="kpis">
        <Kpi
          label="Spend"
          value={money(totals.cost) === '·' ? '$0' : money(totals.cost)}
          delta={previous === null ? null : { change: changeOf(totals.cost, previous.cost), upIsBad: true }}
          note={previous === null ? `${count(totals.sessions)} sessions` : undefined}
        />
        <Kpi
          label="Input tokens"
          value={tokens(totals.in_tokens)}
          delta={previous === null ? null : { change: changeOf(totals.in_tokens, previous.in_tokens), upIsBad: true }}
          note={previous === null ? `${tokens(totals.out_tokens)} out` : undefined}
        />
        <Kpi
          label="Served from cache"
          value={cached === null ? '—' : percent(cached, 1)}
          delta={
            previous === null || cached === null
              ? null
              : { change: cachedBefore === null ? null : cached - cachedBefore, upIsBad: false }
          }
          note={previous === null ? `${tokens(totals.fresh)} fresh` : undefined}
        />
        <Kpi
          label="Cost per task"
          value={perTask === null ? '—' : money(perTask)}
          delta={
            previous === null || perTask === null
              ? null
              : { change: changeOf(perTask, perTaskBefore), upIsBad: true }
          }
          note={previous === null ? `${count(totals.tasks)} tasks` : undefined}
        />
      </div>
      {totals.unpriced === 0 ? null : (
        <p className="note" style={{ marginTop: 8 }}>
          {count(totals.unpriced)} of {count(totals.rounds)} rounds ran on a model with no rate, and are outside
          these dollar figures. <a {...linkProps(href.settings('pricing'))}>Set a rate</a>.
        </p>
      )}

      <div className="cards">
        <div className="card">
          <div className="card-head">
            <h3>Daily spend</h3>
            <span className="muted">stacked by project</span>
            <a {...linkProps(scoped('/spend', scope))}>Open Spend →</a>
          </div>
          <StackedDays
            days={days}
            series={projects}
            label={`Daily spend, ${RANGE_PHRASE[scope.range]}, stacked by project`}
            onPick={(day, key) =>
              go(scoped('/sessions', key === OTHER ? scope : { ...scope, project: key }, { day }))
            }
          />
          <Legend series={projects} onPick={(key) => go(scoped('/sessions', { ...scope, project: key }))} />
        </div>
        <div className="card">
          <div className="card-head">
            <h3>Spend by model</h3>
            <span className="muted">click to list sessions</span>
          </div>
          <HBars
            mono
            rows={models.map((row) => ({
              key: row.key,
              label: shortModel(row.key),
              value: row.cost,
              title: `${row.key}: ${money(row.cost)} over ${count(row.rounds)} rounds`,
              to: scoped('/sessions', scope, { model: row.key }),
            }))}
          />
          <div className="card-head" style={{ marginTop: 10 }}>
            <h3>Where the work went</h3>
            <span className="muted">share of cost</span>
          </div>
          {spent <= 0 ? (
            <p className="note">Nothing here is priced, so there is no cost to divide.</p>
          ) : (
            <>
              <ShareStack
                parts={data.splits.category.map((row) => ({ key: row.key, label: row.label, share: row.cost / spent }))}
                to={(key) => scoped('/sessions', scope, { category: key })}
              />
              <div className="chart-legend">
                {data.splits.category
                  .filter((row) => row.cost / spent >= 0.02)
                  .map((row) => (
                    <a key={row.key} {...linkProps(scoped('/sessions', scope, { category: row.key }))}>
                      {row.label} {percent(row.cost / spent)}
                    </a>
                  ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-head">
          <h3>Top findings</h3>
          <span className="muted">where spend went nowhere</span>
          {findings === null || findings.length === 0 ? null : (
            <a {...linkProps(scoped('/findings', scope))}>
              All {findings.length} {findings.length === 1 ? 'finding' : 'findings'} →
            </a>
          )}
        </div>
        {findings === null ? (
          <p className="note">Reading the findings…</p>
        ) : findings.length === 0 ? (
          <p className="note">Nothing in this scope crossed a line. That is what a quiet month looks like.</p>
        ) : (
          <FindingList findings={findings} scope={scope} limit={3} />
        )}
      </div>
    </>
  )
}
