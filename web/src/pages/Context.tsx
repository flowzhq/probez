import type { ReactElement } from 'react'

import { api } from '../api'
import { Chrome, Info, Loading, Problem } from '../components/Chrome'
import { contextBand } from '../components/Inspector'
import { PeakOccupancyTrend } from '../components/PeakOccupancyTrend'
import { naturalFor, ordered, SortHead, useSort, instant } from '../components/SortHead'
import { count, money, percent, shortId, shortModel, tokens, when } from '../format'
import { go, href, linkProps } from '../router'
import { useScope } from '../scope'
import { useData } from '../useData'
import type { ContextTask } from '../api'
import { EmptyRange, projectNameOf, scopeLine } from './Overview'

type TaskSort = 'project' | 'session' | 'started' | 'model' | 'peak' | 'share' | 'compactions' | 'cost'

const taskNatural = naturalFor<TaskSort>('project', 'session', 'model')

function taskValue(task: ContextTask, key: TaskSort): number | string | null {
  switch (key) {
    case 'project':
      return task.project
    case 'session':
      return task.session
    case 'started':
      return instant(task.first_ts)
    case 'model':
      return task.model
    case 'peak':
      return task.peak_tokens
    case 'share':
      return task.share
    case 'compactions':
      return task.compactions
    case 'cost':
      return task.cost
  }
}

/**
 * Insights › Context: are contexts filling up, and where did the harness compact them.
 *
 * The daily chart is the project page's, over the whole scope. Under it, every task whose fullest
 * round went over the line in Settings › Findings, fullest first, each opening its trace on that
 * round; then the compactions themselves.
 */
export function Context(): ReactElement {
  const scope = useScope()
  const { data, error, loading } = useData(() => api.insights(scope), [scope.range, scope.source, scope.project, scope.committer])
  const [sorted, sortBy] = useSort<TaskSort>(taskNatural, { key: 'share', dir: 'desc' })

  return (
    <>
      <Chrome crumbs={[{ label: 'Insights' }, { label: 'Context' }]} scope="store" search={{ slug: scope.project }} />
      <main className="page">
        {error !== null && data === null ? (
          <Problem message={error} />
        ) : data === null ? (
          <Loading what="the context" />
        ) : (
          <div className={loading ? 'rereading' : undefined}>
            <div className="head">
              <h1>Context</h1>
              <span className="muted">{scopeLine(scope, projectNameOf(data, scope))}</span>
            </div>
            {data.totals.rounds === 0 ? (
              <EmptyRange scope={scope} latest={data.latest} />
            ) : (
              <>
                <section style={{ marginTop: 16 }}>
                  <h2>Peak context, by day</h2>
                  <PeakOccupancyTrend days={data.context.days} />
                </section>

                <section>
                  <h2>
                    Tasks over {percent(data.context.threshold)}{' '}
                    <Info
                      says={`Tasks whose fullest round used more than ${percent(data.context.threshold)} of its model's input window. The line is set in Settings › Findings. A row opens the task on that round.`}
                    />
                  </h2>
                  {data.context.over.length === 0 ? (
                    <p className="note">
                      {data.context.measured === 0
                        ? 'No task in scope recorded both its input and a model with a known window, so there is no occupancy to measure.'
                        : `None of the ${count(data.context.measured)} tasks with a known window went over ${percent(data.context.threshold)}.`}
                    </p>
                  ) : (
                    <>
                      <table>
                        <thead>
                          <tr>
                            <SortHead label="Project" head="project" sorted={sorted} onSort={sortBy} />
                            <SortHead label="Task" head="session" sorted={sorted} onSort={sortBy} />
                            <SortHead label="Started" head="started" sorted={sorted} onSort={sortBy} />
                            <SortHead label="Model" head="model" sorted={sorted} onSort={sortBy} />
                            <SortHead label="Peak" head="peak" sorted={sorted} onSort={sortBy} className="r" />
                            <SortHead label="Of window" head="share" sorted={sorted} onSort={sortBy} className="r" />
                            <SortHead label="Compactions" head="compactions" sorted={sorted} onSort={sortBy} className="r" />
                            <SortHead label="Cost" head="cost" sorted={sorted} onSort={sortBy} className="r" />
                          </tr>
                        </thead>
                        <tbody>
                          {ordered(data.context.over, sorted, taskValue).map((task) => {
                            const to = href.task(task.slug, task.session, task.task, task.round)
                            return (
                              <tr key={`${task.slug}/${task.session}/${task.task}`} className="row" onClick={() => go(to)}>
                                <td>{task.project}</td>
                                <td className="mono">
                                  <a {...linkProps(to)}>
                                    {shortId(task.session)} · {task.task}
                                  </a>
                                </td>
                                <td className="muted">{when(task.first_ts)}</td>
                                <td className="dim">{shortModel(task.model)}</td>
                                <td className="r num">{tokens(task.peak_tokens)}</td>
                                <td className={`r num ${contextBand(task.share)}`}>{percent(task.share)}</td>
                                <td className="r num dim">{task.compactions === 0 ? '·' : task.compactions}</td>
                                <td className="r num">{money(task.cost)}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                      <p className="note" style={{ marginTop: 12 }}>
                        {count(data.context.over.length)} of {count(data.context.measured)} tasks with a known window went
                        over. Cost is the whole task&apos;s.
                      </p>
                    </>
                  )}
                </section>

                <section>
                  <h2>Compactions</h2>
                  {data.context.compactions.length === 0 ? (
                    <p className="note">The harness compacted nothing in scope.</p>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>Project</th>
                          <th>Task</th>
                          <th>When</th>
                          <th>Trigger</th>
                          <th className="r">Before</th>
                          <th className="r">After</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.context.compactions.slice(0, 100).map((row) => {
                          const to = href.task(row.slug, row.session, row.task, row.round)
                          return (
                            <tr key={`${row.slug}/${row.session}/${row.round}`} className="row" onClick={() => go(to)}>
                              <td>{row.project}</td>
                              <td className="mono">
                                <a {...linkProps(to)}>
                                  {shortId(row.session)} · {row.task}
                                </a>
                              </td>
                              <td className="muted">{when(row.ts)}</td>
                              <td className="dim">{row.trigger ?? '—'}</td>
                              <td className="r num dim">{tokens(row.pre_tokens)}</td>
                              <td className="r num dim">{tokens(row.post_tokens)}</td>
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
