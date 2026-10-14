import type { ReactElement } from 'react'

import { api } from '../api'
import type { ProjectsPayload, Range } from '../api'
import { changeScope, RANGE_LABEL, RANGES, useScope } from '../scope'
import { SOURCE_CHOICES, SOURCE_LABEL } from '../source'
import type { SourceChoice } from '../source'
import { useData } from '../useData'
import { useIdentity } from '../meta'

/**
 * The project names the Project chip offers, read once a page load.
 *
 * The list is the store's, and changes only when a project is collected, imported or deleted — all
 * of which happen on the Projects page, which re-reads it there. A chip that re-fetched the whole
 * projects payload on every navigation would pay for a labelling pass to fill a dropdown.
 */
let projectList: Promise<ProjectsPayload> | null = null

function projects(): Promise<ProjectsPayload> {
  projectList ??= api.projects().catch((error: unknown) => {
    projectList = null
    throw error
  })
  return projectList
}

/** Forget the cached list, after something added or removed a project. */
export function forgetProjectList(): void {
  projectList = null
}

/**
 * Time, agent and project — and whose work, once there is more than one person's — as chips that are each a real `<select>`.
 *
 * A native select, styled to sit in the bar, rather than a menu of our own: it is keyboard and
 * screen-reader complete for free, and on a phone it opens the platform's own picker.
 */
export function ScopeBar({ only }: { only?: 'agent' }): ReactElement {
  const scope = useScope()
  const { data } = useData(() => (only === 'agent' ? Promise.resolve(null) : projects()), [only])
  const identity = useIdentity()

  return (
    <div className="scope-bar" role="group" aria-label="Scope">
      {only === 'agent' ? null : (
        <label className="chip scope-chip">
          <span>Time</span>
          <select
            aria-label="Time range"
            value={scope.range}
            onChange={(event) => changeScope({ range: event.target.value as Range })}
          >
            {RANGES.map((range) => (
              <option key={range} value={range}>
                {RANGE_LABEL[range]}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="chip scope-chip">
        <span>Agent</span>
        <select
          aria-label="Agent"
          value={scope.source ?? ''}
          onChange={(event) =>
            changeScope({ source: event.target.value === '' ? null : (event.target.value as SourceChoice) })
          }
        >
          <option value="">All</option>
          {SOURCE_CHOICES.map((source) => (
            <option key={source} value={source}>
              {SOURCE_LABEL[source]}
            </option>
          ))}
        </select>
      </label>
      {only === 'agent' ? null : (
        <label className="chip scope-chip">
          <span>Project</span>
          <select
            aria-label="Project"
            value={scope.project ?? ''}
            onChange={(event) => changeScope({ project: event.target.value === '' ? null : event.target.value })}
          >
            <option value="">All</option>
            {/* A project named in the address but not (yet) in the list is still shown as chosen,
                rather than the chip quietly reading All while the page is filtered. */}
            {scope.project !== null && data !== null && !data.projects.some((one) => one.slug === scope.project) ? (
              <option value={scope.project}>{scope.project}</option>
            ) : null}
            {(data?.projects ?? []).map((project) => (
              <option key={project.slug} value={project.slug}>
                {project.project}
              </option>
            ))}
          </select>
        </label>
      )}
      {/* Only once the store holds more than one person's work: a merge from another machine is
          what brings a second name, and before that the chip would offer a choice of one. */}
      {only === 'agent' || identity === null || (identity.committers.length < 2 && scope.committer === null) ? null : (
        <label className="chip scope-chip">
          <span>Committer</span>
          <select
            aria-label="Committer"
            value={scope.committer ?? ''}
            onChange={(event) => changeScope({ committer: event.target.value === '' ? null : event.target.value })}
          >
            <option value="">Everyone</option>
            {scope.committer !== null && !identity.committers.includes(scope.committer) ? (
              <option value={scope.committer}>{scope.committer}</option>
            ) : null}
            {identity.committers.map((name) => (
              <option key={name} value={name}>
                {name === identity.committer ? `${name} (you)` : name}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}
