import { useState } from 'react'

import { api } from '../api'
import { Actions } from '../components/Actions'
import { Chrome, Facts, Loading, Problem } from '../components/Chrome'
import { Import } from '../components/Import'
import { TokenCells, TokenHeaders } from '../components/Tokens'
import { MixBar } from '../components/WorkBars'
import { ago, count, percent } from '../format'
import { go, href, linkProps } from '../router'
import { useData } from '../useData'
import type { ReactElement } from 'react'

/**
 * Every project in the store.
 *
 * These come from the store's own manifests rather than from the agent's session directory, so a
 * project stays readable after the sessions it was collected from are gone. What is recorded is
 * recorded.
 */
export function Projects(): ReactElement {
  const [read, setRead] = useState(0)
  const { data, error, loading } = useData(() => api.projects(), [read])
  // Syncing, renaming, deleting and importing all change what this list is. One list, one re-read.
  const reread = (): void => setRead(read + 1)

  return (
    <>
      <Chrome crumbs={[]} search={{}} />
      <main className="page">
        {error !== null && data === null ? (
          <Problem message={error} />
        ) : data === null ? (
          <Loading what="the store" />
        ) : (
          <div className={loading ? 'rereading' : undefined}>
            <div className="head">
              <h1>Projects</h1>
              <span className="muted mono">{data.data_dir}</span>
              <span className="spacer" style={{ flex: 1 }} />
              <Import onImported={reread} />
            </div>
            <Facts
              items={[
                ['projects', count(data.projects.length)],
                ['sessions', count(data.projects.reduce((n, p) => n + p.sessions, 0))],
                ['rounds', count(data.projects.reduce((n, p) => n + p.rounds, 0))],
              ]}
            />

            <section>
              {/* Column headings over nothing describe a table that is not there. */}
              {data.projects.length === 0 ? null : (
                <table>
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th style={{ width: '22%' }}>Work</th>
                      <th className="r">Sessions</th>
                      <th className="r">Tasks</th>
                      <th className="r">Rounds</th>
                      <TokenHeaders />
                      {/* Named for what it is, because the project page states two dates about a
                          project and only one of them is this one. The other is when probez last
                          read the sessions, which is a fact about probez rather than about the
                          work — this column has always been the work. */}
                      <th className="r" title="When the most recent round in this project ran">
                        Last activity
                      </th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.projects.map((project) => (
                      <tr
                        key={project.slug}
                        className="row"
                        onClick={() => go(href.project(project.slug))}
                      >
                        <td>
                          <a {...linkProps(href.project(project.slug))}>
                            <strong>{project.project}</strong>
                          </a>
                          {/* An import was measured on somebody else's machine. The row carries its
                              numbers with no other sign of that, so the row says it. */}
                          {project.imported_at === null ? null : (
                            <span className="mark" title="Arrived as a file someone exported">
                              imported
                            </span>
                          )}
                          {(project.sources ?? []).includes('cursor') ? (
                            <span
                              className="mark"
                              title="Includes Cursor sessions. Cursor transcripts do not record token usage or cost."
                            >
                              cursor
                            </span>
                          ) : null}
                          {(project.sources ?? []).includes('codex') ? (
                            <span className="mark" title="Includes Codex CLI sessions">
                              codex
                            </span>
                          ) : null}
                          <div className="muted mono clip" style={{ fontSize: 11 }}>
                            {project.path ?? project.key}
                          </div>
                        </td>
                        <td>
                          <MixBar mix={project.mix} />
                          <div className="muted nowrap" style={{ fontSize: 11, marginTop: 3 }}>
                            {project.work === null
                              ? 'no tool calls'
                              : `${project.work.short} ${percent(project.work.share)}`}
                          </div>
                        </td>
                        <td className="r num">{project.sessions}</td>
                        <td className="r num">{project.tasks}</td>
                        <td className="r num">{count(project.rounds)}</td>
                        <TokenCells of={project} />
                        <td className="r muted nowrap">{ago(project.last_ts)}</td>
                        <td className="r">
                          <Actions
                            slug={project.slug}
                            project={project.project}
                            renamed={project.renamed}
                            rounds={project.rounds}
                            compact
                            onSynced={reread}
                            onRenamed={reread}
                            onRemoved={reread}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {data.projects.length === 0 ? (
                <p className="note" style={{ marginTop: 16 }}>
                  Nothing here yet. Run <span className="mono">probez collect</span> in a project
                  you work in, then reload — or <strong>Import</strong> a project someone sent you.
                </p>
              ) : null}
            </section>
          </div>
        )}
      </main>
    </>
  )
}
