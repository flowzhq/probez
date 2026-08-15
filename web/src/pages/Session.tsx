import { useState } from 'react'

import { api } from '../api'
import { Chrome, Facts, Loading, Problem } from '../components/Chrome'
import { Trace } from '../components/Trace'
import { WorkBars } from '../components/WorkBars'
import { clip, count, duration, percent, shortId, shortModel, tokens, when } from '../format'
import { go, href, linkProps } from '../router'
import { useData } from '../useData'
import type { ReactElement } from 'react'

/**
 * One session: the run, its shape, and the turns it was made of.
 *
 * The strip here spans the whole session rather than one task, which is the view you cannot get
 * from the CLI at all: where the tasks sit relative to each other, and which one swallowed the
 * afternoon. Double-clicking a round opens the task it belongs to.
 */
export function Session({ slug, session }: { slug: string; session: string }): ReactElement {
  const { data, error } = useData(() => api.session(slug, session), [slug, session])
  const [selected, setSelected] = useState<number | null>(null)

  return (
    <>
      <Chrome
        crumbs={[
          { label: data?.project.project ?? slug, to: href.project(slug) },
          { label: `Session ${shortId(session)}` },
        ]}
      />
      <main className="page">
        {error !== null && data === null ? (
          <Problem message={error} />
        ) : data === null ? (
          <Loading what="the session" />
        ) : (
          <>
            <div className="head">
              <h1 className="mono">{shortId(session)}</h1>
              <span className="tag">{shortModel(data.session.model)}</span>
              <span className="muted">{when(data.session.first_ts)}</span>
            </div>
            <Facts
              items={[
                ['tasks', data.session.tasks],
                ['rounds', data.session.rounds],
                ['tool calls', data.session.tool_calls],
                ['working', duration(data.session.active_ms)],
                ['elapsed', duration(data.session.elapsed_ms)],
                ['in', tokens(data.session.in_tokens)],
                ['out', tokens(data.session.out_tokens)],
              ]}
            />

            <section>
              <h2>The session, round by round</h2>
              <Trace
                trace={data.trace}
                selected={selected}
                onSelect={(round) => setSelected(round.round)}
                onOpenTask={(task) => go(href.task(slug, session, task))}
              />
            </section>

            <section>
              <h2>Work profile</h2>
              <WorkBars analysis={data.analysis} />
            </section>

            <section>
              <h2>Tasks</h2>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 34 }} />
                    <th>Asked</th>
                    <th className="r">Rounds</th>
                    <th className="r">Tools</th>
                    <th>Work</th>
                    <th className="r">Working</th>
                    <th className="r">Elapsed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.tasks.map((task) => (
                    <tr
                      key={task.task}
                      className="row"
                      onClick={() => go(href.task(slug, session, task.task))}
                    >
                      <td className="mono muted">{task.task}</td>
                      <td className="clip">
                        <a {...linkProps(href.task(slug, session, task.task))}>
                          {clip(task.asked, 110) || <span className="muted">(no prompt)</span>}
                        </a>
                      </td>
                      <td className="r num">{task.rounds}</td>
                      <td className="r num">
                        {task.tool_calls}
                        {task.errors > 0 ? <span className="bad"> ✗{task.errors}</span> : null}
                      </td>
                      <td className="dim nowrap">
                        {task.work === null ? '—' : `${task.work.short} ${percent(task.work.share)}`}
                      </td>
                      <td className="r num dim">{duration(task.ms)}</td>
                      <td className="r num dim">{duration(task.elapsed_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="note" style={{ marginTop: 12 }}>
                {count(data.tasks.length)} tasks. A task is one user turn and everything the agent
                did about it, subagents included. <em>Working</em> is the time the rounds took;{' '}
                <em>elapsed</em> includes every gap where it was your turn.
              </p>
            </section>
          </>
        )}
      </main>
    </>
  )
}
