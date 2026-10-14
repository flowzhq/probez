import type { ReactElement } from 'react'

import { api } from '../api'
import { Chrome, Loading, Problem } from '../components/Chrome'
import { FindingList } from '../components/FindingList'
import { money, percent } from '../format'
import { href, linkProps } from '../router'
import { useScope } from '../scope'
import { useData } from '../useData'
import { scopeLine } from './Overview'

/**
 * Investigate › Findings: where spend went nowhere, ranked by what it cost.
 *
 * Every row is a signal probez already measures somewhere else — a tool error, a question asked
 * twice, a trail that ended without acting — counted across the scope and priced at the rounds it
 * covers. Investigate opens the list it was counted from, filtered to it.
 */
export function Findings(): ReactElement {
  const scope = useScope()
  const { data, error, loading } = useData(() => api.findings(scope), [scope.range, scope.source, scope.project, scope.committer])

  return (
    <>
      <Chrome crumbs={[{ label: 'Investigate' }, { label: 'Findings' }]} scope="store" search={{ slug: scope.project }} />
      <main className="page">
        {error !== null && data === null ? (
          <Problem message={error} />
        ) : data === null ? (
          <Loading what="the findings" />
        ) : (
          <div className={loading ? 'rereading' : undefined}>
            <div className="head">
              <h1>Findings</h1>
              <span className="muted">
                {data.findings.length} open · ranked by the cost of the rounds involved · {scopeLine(scope)}
              </span>
            </div>
            <section style={{ marginTop: 16 }}>
              {data.findings.length === 0 ? (
                <div className="placeholder">
                  <h4>Nothing crossed a line</h4>
                  <p>
                    No session in scope spent over {percent(data.thresholds.reconstruction)} of its cost on
                    reconstruction, no task ran its context above {percent(data.thresholds.context)}, and nothing
                    failed, repeated itself or went unpriced.
                  </p>
                </div>
              ) : (
                <FindingList findings={data.findings} scope={scope} />
              )}
            </section>
            <p className="note" style={{ marginTop: 12 }}>
              Severity is a finding&apos;s cost as a share of the {money(data.total)} spent in scope: high at 5% or
              more, medium from 1%. Each cost is the part of the rounds the finding covers — the reconstruction
              share of a session, a failed call&apos;s share of its round — so findings can overlap and need not
              add up. Thresholds: Reconstruction &gt; {percent(data.thresholds.reconstruction)}, context &gt;{' '}
              {percent(data.thresholds.context)} · <a {...linkProps(href.settings('findings'))}>change in Settings</a>
            </p>
          </div>
        )}
      </main>
    </>
  )
}
