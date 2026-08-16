import { useState } from 'react'

import { api } from '../api'
import { Actions } from '../components/Actions'
import { Chrome, Facts, Loading, Problem } from '../components/Chrome'
import { InTokens } from '../components/Tokens'
import { MixBar } from '../components/WorkBars'
import { ago, count, percent, tokens } from '../format'
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

  return (
    <>
      <Chrome crumbs={[]} />
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
            </div>
            <Facts
              items={[
                ['projects', count(data.projects.length)],
                ['sessions', count(data.projects.reduce((n, p) => n + p.sessions, 0))],
                ['rounds', count(data.projects.reduce((n, p) => n + p.rounds, 0))],
              ]}
            />

            <section>
              <table>
                <thead>
                  <tr>
                    <th>Project</th>
                    <th style={{ width: '22%' }}>Work</th>
                    <th className="r">Sessions</th>
                    <th className="r">Tasks</th>
                    <th className="r">Rounds</th>
                    <th className="r">In</th>
                    <th className="r">Out</th>
                    <th className="r">Last</th>
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
                      <td className="r num dim">
                        <InTokens of={project} />
                      </td>
                      <td className="r num dim">{tokens(project.out_tokens)}</td>
                      <td className="r muted nowrap">{ago(project.last_ts)}</td>
                      <td className="r">
                        <Actions slug={project.slug} compact onSynced={() => setRead(read + 1)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.projects.length === 0 ? (
                <p className="note" style={{ marginTop: 16 }}>
                  Nothing collected yet. Run <span className="mono">probez collect</span> in a
                  project you work in, then reload.
                </p>
              ) : null}
            </section>
          </div>
        )}
      </main>
    </>
  )
}
