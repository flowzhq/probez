import type { ReactElement } from 'react'

import { api } from '../api'
import type { ProjectsPayload } from '../api'
import { money, percent, shortId, shortModel, ago, count, when } from '../format'
import { go, href, linkProps } from '../router'
import { scoped } from '../scope'
import type { Scope } from '../scope'
import type { SourceChoice } from '../source'
import { useData } from '../useData'
import { HBars, ShareStack } from './Charts'
import { Drawer, DrawerFacts } from './Drawer'
import { OpenInExplorer } from './OpenInExplorer'

type Row = ProjectsPayload['projects'][number]

/**
 * A look inside one project without leaving the projects list.
 *
 * The row already has the totals; what the drawer adds is the shape of them — the days the money
 * went on, the work it bought, the models that charged it, and the sessions that cost the most —
 * read from the same store-wide payloads the Insights pages draw, scoped to this one project.
 */
export function ProjectDrawer({
  project,
  spent,
  source,
  onClose,
}: {
  project: Row
  /** Spend across every project listed, which the share is of. */
  spent: number
  source: SourceChoice | null
  onClose: () => void
}): ReactElement {
  // The projects list is all time, so its drawer is too.
  const scope: Scope = { range: 'all', source, project: project.slug }
  const insights = useData(() => api.insights(scope), [project.slug, source])
  const sessions = useData(() => api.sessions(scope), [project.slug, source])
  const data = insights.data?.scope.project === project.slug ? insights.data : null
  const top = sessions.data?.scope.project === project.slug ? sessions.data.sessions.slice(0, 5) : null

  const days = data?.days ?? []
  const peak = Math.max(0, ...days.map((day) => day.cost))
  const categories = data?.splits.category ?? []
  const workCost = categories.reduce((sum, row) => sum + row.cost, 0)
  const priced = project.unpriced < project.rounds

  return (
    <Drawer
      label={`Project ${project.project}`}
      title={project.project}
      subtitle={
        <span className="mono clip" style={{ display: 'block', fontSize: 11, maxWidth: 'none' }} title={project.path ?? project.key}>
          {project.path ?? project.key}
        </span>
      }
      onClose={onClose}
    >
      <DrawerFacts
        items={[
          ['Cost', priced ? `${money(project.cost)}${project.unpriced > 0 ? '+' : ''}` : '—'],
          ['Share of spend', priced && spent > 0 ? percent(project.cost / spent, 1) : '—'],
          ['Sessions', `${count(project.sessions)} · ${count(project.tasks)} tasks`],
          ['Rounds', count(project.rounds)],
          ['Served from cache', project.in_tokens > 0 ? percent(project.in_cache_read / project.in_tokens) : '—'],
          ['Last activity', ago(project.last_ts)],
        ]}
      />

      <div className="drawer-sec">
        <h4>Spend by day</h4>
        {data === null ? (
          <div className="thumb" aria-hidden />
        ) : peak <= 0 ? (
          <p className="note">Nothing here is priced, so there are no dollars to draw.</p>
        ) : (
          <>
            <div
              className="thumb"
              role="img"
              aria-label={`Spend on each of ${days.length} days, ${data.scope.from ?? ''} to ${data.scope.to ?? ''}`}
            >
              {days.map((day) => (
                <i
                  key={day.day}
                  title={`${when(`${day.day}T12:00:00Z`, false)}: ${money(day.cost)}`}
                  style={{ height: `${day.cost > 0 ? Math.max(6, (day.cost / peak) * 100) : 0}%`, background: 'var(--series-1)' }}
                />
              ))}
            </div>
            <span className="muted" style={{ fontSize: 11 }}>
              {when(`${data.scope.from}T12:00:00Z`, false)} – {when(`${data.scope.to}T12:00:00Z`, false)}
            </span>
          </>
        )}
      </div>

      <div className="drawer-sec">
        <h4>Work mix · share of cost</h4>
        {data === null ? (
          <p className="note">Reading…</p>
        ) : workCost <= 0 ? (
          <p className="note">No priced round here, so there is no cost to divide.</p>
        ) : (
          <>
            <ShareStack
              parts={categories.map((row) => ({ key: row.key, label: row.label, share: row.cost / workCost }))}
              to={(key) => scoped('/sessions', scope, { category: key })}
            />
            <div className="chart-legend">
              {categories
                .filter((row) => row.cost / workCost >= 0.1)
                .map((row) => (
                  <span key={row.key}>
                    {row.label} {percent(row.cost / workCost)}
                  </span>
                ))}
            </div>
          </>
        )}
      </div>

      {data === null || data.splits.model.length === 0 ? null : (
        <div className="drawer-sec">
          <h4>By model</h4>
          <HBars
            mono
            rows={data.splits.model.slice(0, 3).map((row) => ({
              key: row.key,
              label: shortModel(row.key),
              value: row.cost,
              title: `${row.key}: ${money(row.cost)} over ${count(row.rounds)} rounds`,
              to: scoped('/sessions', scope, { model: row.key }),
            }))}
          />
        </div>
      )}

      <div className="drawer-sec">
        <h4>Costliest sessions</h4>
        {top === null ? (
          <p className="note">Reading…</p>
        ) : top.length === 0 ? (
          <p className="note">No session here.</p>
        ) : (
          top.map((session) => (
            <a key={session.session} className="qrow" {...linkProps(href.session(project.slug, session.session, source))}>
              <span>
                <span className="mono">{shortId(session.session)}</span>{' '}
                <span className="muted">{when(session.first_ts)}</span>
              </span>
              <strong className="num">{session.unpriced === session.rounds ? '—' : money(session.cost)}</strong>
            </a>
          ))
        )}
      </div>

      <div className="drawer-links">
        <a className="go" {...linkProps(scoped('/sessions', scope))}>
          All its sessions
        </a>
        <OpenInExplorer scope={scope} entity="sessions" />
      </div>
      <button type="button" className="primary" onClick={() => go(href.project(project.slug, source))}>
        Open project →
      </button>
    </Drawer>
  )
}
