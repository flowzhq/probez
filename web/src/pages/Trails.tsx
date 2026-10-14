import type { ReactElement } from 'react'

import { api } from '../api'
import type { StoreTrail } from '../api'
import { Chrome, Loading, Problem } from '../components/Chrome'
import { OpenInExplorer } from '../components/OpenInExplorer'
import { naturalFor, ordered, SortHead, useSort } from '../components/SortHead'
import { count, duration, money, shortId } from '../format'
import { go, href, linkProps } from '../router'
import { changeFilters, useFilter, useScope } from '../scope'
import { useData } from '../useData'
import { scopeLine } from './Overview'

type TrailSort = 'trail' | 'project' | 'steps' | 'depth' | 'paths' | 'outcome' | 'cost' | 'time'

const trailNatural = naturalFor<TrailSort>('trail', 'project', 'outcome')

const OUTCOME_LABEL: Record<StoreTrail['outcome'], string> = {
  edit: 'edited',
  test: 'tested',
  abandoned: 'changed nothing',
}

function trailValue(trail: StoreTrail, key: TrailSort): number | string | null {
  switch (key) {
    case 'trail':
      return trail.ended_on === '' ? trail.root : trail.ended_on
    case 'project':
      return trail.project
    case 'steps':
      return trail.steps.length
    case 'depth':
      return trail.depth
    case 'paths':
      return trail.paths
    case 'outcome':
      return trail.outcome
    case 'cost':
      return trail.cost
    case 'time':
      return trail.ms
  }
}

/**
 * Investigate › Trails: how agents found their way around, across the store, costliest first.
 *
 * "Changed nothing" is one click, because that is the trail a cost-conscious reader is looking
 * for: a walk through the repository that ended without an edit or a test following from it.
 */
export function Trails(): ReactElement {
  const scope = useScope()
  const outcome = useFilter('outcome')
  const { data, error, loading } = useData(() => api.storeTrails(scope), [scope.range, scope.source, scope.project, scope.committer])
  const [sorted, sortBy] = useSort<TrailSort>(trailNatural, { key: 'cost', dir: 'desc' })

  const shown = (data?.trails ?? []).filter((trail) => outcome === null || trail.outcome === outcome)

  return (
    <>
      <Chrome crumbs={[{ label: 'Investigate' }, { label: 'Trails' }]} scope="store" search={{ slug: scope.project }} />
      <main className="page">
        {error !== null && data === null ? (
          <Problem message={error} />
        ) : data === null ? (
          <Loading what="the trails" />
        ) : (
          <div className={loading ? 'rereading' : undefined}>
            <div className="head">
              <h1>Trails</h1>
              <span className="muted">
                {count(data.total)} walks · {count(data.abandoned)} changed nothing · {scopeLine(scope)}
              </span>
            </div>
            <div className="fbar">
              {(['abandoned', 'edit', 'test'] as const).map((one) => (
                <button
                  key={one}
                  type="button"
                  className={outcome === one ? 'chip filter' : 'chip'}
                  aria-pressed={outcome === one}
                  onClick={() => changeFilters({ outcome: outcome === one ? null : one })}
                >
                  {OUTCOME_LABEL[one]}
                  {outcome === one ? <span aria-hidden> ✕</span> : null}
                </button>
              ))}
              <span className="spacer" />
              <OpenInExplorer scope={scope} entity="trails" filters={{ outcome }} />
            </div>
            {shown.length === 0 ? (
              <p className="note">
                {data.total === 0
                  ? 'No run of calls in this scope was a walk: something found, then followed, at least two hops deep.'
                  : 'No trail here ended that way.'}
              </p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <SortHead label="Ended on" head="trail" sorted={sorted} onSort={sortBy} />
                    <SortHead label="Project" head="project" sorted={sorted} onSort={sortBy} />
                    <SortHead label="Steps" head="steps" sorted={sorted} onSort={sortBy} className="r" />
                    <SortHead label="Depth" head="depth" sorted={sorted} onSort={sortBy} className="r" />
                    <SortHead label="Paths" head="paths" sorted={sorted} onSort={sortBy} className="r" />
                    <SortHead label="Outcome" head="outcome" sorted={sorted} onSort={sortBy} />
                    <SortHead label="Cost" head="cost" sorted={sorted} onSort={sortBy} className="r" />
                    <SortHead label="Time" head="time" sorted={sorted} onSort={sortBy} className="r" />
                  </tr>
                </thead>
                <tbody>
                  {ordered(shown, sorted, trailValue).map((trail) => {
                    const to = href.task(trail.slug, trail.session, trail.task, trail.steps[0]?.round, trail.ref)
                    return (
                      <tr key={`${trail.slug}/${trail.session}/${trail.ref}`} className="row" onClick={() => go(to)}>
                        <td className="mono clip" style={{ maxWidth: 320 }}>
                          <a {...linkProps(to)} title={`${shortId(trail.session)} · ${trail.ref}`}>
                            {trail.ended_on === '' ? <span className="muted">from a {trail.root}</span> : trail.ended_on}
                          </a>
                        </td>
                        <td className="dim nowrap">{trail.project}</td>
                        <td className="r num">{trail.steps.length}</td>
                        <td className="r num dim">{trail.depth}</td>
                        <td className="r num dim">{trail.paths}</td>
                        <td className={trail.outcome === 'abandoned' ? 'bad nowrap' : 'dim nowrap'}>{OUTCOME_LABEL[trail.outcome]}</td>
                        <td className="r num">
                          <strong>{money(trail.cost)}</strong>
                        </td>
                        <td className="r num dim">{duration(trail.ms)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            {data.total > data.trails.length ? (
              <p className="note" style={{ marginTop: 12 }}>
                The {count(data.trails.length)} costliest of {count(data.total)} trails are listed; narrow the scope to
                see the rest.
              </p>
            ) : null}
          </div>
        )}
      </main>
    </>
  )
}
