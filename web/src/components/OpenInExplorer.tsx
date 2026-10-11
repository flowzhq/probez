import type { ReactElement } from 'react'

import { handover } from '../explorer'
import { href, linkProps } from '../router'
import type { Entity } from '../router'
import type { Scope } from '../scope'

/**
 * The step from a list to the query language: this list's question, asked in Explorer.
 *
 * The title says the query it will run, so the button teaches the language as well as using it,
 * and says what the query could not carry when a filter has no field.
 */
export function OpenInExplorer({
  scope,
  entity,
  filters = {},
}: {
  scope: Scope
  entity: Entity
  filters?: Parameters<typeof handover>[1]
}): ReactElement {
  const { q, inexact } = handover(scope, filters)
  const title = [
    `Runs: ${q}`,
    ...(inexact.length === 0 ? [] : ['', 'The query language cannot say:', ...inexact.map((one) => `· ${one}`)]),
  ].join('\n')
  return (
    <a className="go" {...linkProps(href.search(q, { entity, slug: scope.project }))} title={title}>
      Open in Explorer{inexact.length === 0 ? null : <span className="muted"> ≈</span>}
    </a>
  )
}
