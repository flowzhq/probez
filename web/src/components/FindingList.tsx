import type { ReactElement } from 'react'

import type { Finding } from '../api'
import { money, percent } from '../format'
import { href, linkProps } from '../router'
import { scoped } from '../scope'
import type { Scope } from '../scope'

/**
 * What a finding says, in one line.
 *
 * Each names the line it was drawn at when it has one, so a threshold changed in Settings shows up
 * here in the sentence and not only on the settings page.
 */
export function findingTitle(finding: Finding): string {
  const n = `${finding.count.toLocaleString('en-US')} ${finding.unit}`
  const line = finding.threshold === null ? '' : percent(finding.threshold)
  switch (finding.id) {
    case 'reconstruction':
      return `${n} spent over ${line} of their cost on Reconstruction`
    case 'context':
      return `${n} ran their context above ${line}`
    case 'reasked':
      return `${n} asked again after being answered`
    case 'abandoned':
      return `${n} changed nothing`
    case 'errors':
      return `${n} failed`
    case 'unpriced':
      return `${n} ${finding.count === 1 ? 'has' : 'have'} no price`
  }
}

/** Where Investigate goes: the list the finding was counted from, filtered to it. */
export function findingLink(finding: Finding, scope: Scope): { to: string; label: string } {
  switch (finding.id) {
    case 'reconstruction':
      return { to: scoped('/sessions', scope, { finding: 'reconstruction' }), label: 'Investigate' }
    case 'context':
      return { to: scoped('/context', scope), label: 'Investigate' }
    case 'reasked':
      return { to: scoped('/questions', scope, { reasked: '1' }), label: 'Investigate' }
    case 'abandoned':
      return { to: scoped('/trails', scope, { outcome: 'abandoned' }), label: 'Investigate' }
    case 'errors':
      return { to: scoped('/sessions', scope, { errors: '1' }), label: 'Investigate' }
    case 'unpriced':
      return { to: href.settings('pricing'), label: 'Set a rate' }
  }
}

const SEVERITY_LABEL: Record<Finding['severity'], string> = {
  high: 'High',
  med: 'Med',
  low: 'Low',
  info: 'Info',
}

const SEVERITY_TITLE: Record<Finding['severity'], string> = {
  high: 'Five percent or more of the spend in scope',
  med: 'Between one and five percent of the spend in scope',
  low: 'Under one percent of the spend in scope',
  info: 'A hole in what can be measured, rather than a cost',
}

/**
 * Findings as a queue, costliest first.
 *
 * Ranked by dollars because that is what the person reading it is trying to reduce; the count sits
 * beside it so a finding that is expensive because it is rare and huge reads differently from one
 * that is expensive because it is everywhere.
 */
export function FindingList({
  findings,
  scope,
  limit,
}: {
  findings: Finding[]
  scope: Scope
  limit?: number
}): ReactElement {
  const shown = limit === undefined ? findings : findings.slice(0, limit)
  return (
    <div className="findings" role="table" aria-label="Findings">
      <div className="finding head" role="row">
        <span role="columnheader">Severity</span>
        <span role="columnheader">Finding</span>
        <span role="columnheader" className="r">
          Cost
        </span>
        <span role="columnheader" className="r">
          Scope
        </span>
        <span role="columnheader" aria-label="Action" />
      </div>
      {shown.map((finding) => {
        const link = findingLink(finding, scope)
        return (
          <div key={finding.id} className="finding" role="row">
            <span role="cell">
              <span className={`sev sev-${finding.severity}`} title={SEVERITY_TITLE[finding.severity]}>
                {SEVERITY_LABEL[finding.severity]}
              </span>
            </span>
            <span role="cell" className="finding-what">
              <strong>{findingTitle(finding)}</strong>
              {finding.detail === '' ? null : <span className="muted">{finding.detail}</span>}
            </span>
            <span role="cell" className="r num">
              {finding.cost === null ? <span className="muted">—</span> : money(finding.cost)}
            </span>
            <span role="cell" className="r num muted">
              {finding.sessions.toLocaleString('en-US')} {finding.sessions === 1 ? 'session' : 'sessions'}
            </span>
            <span role="cell" className="r">
              <a className="go" {...linkProps(link.to)}>
                {link.label}
              </a>
            </span>
          </div>
        )
      })}
    </div>
  )
}
