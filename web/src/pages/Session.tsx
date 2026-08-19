import { useState } from 'react'

import { api } from '../api'
import { Chrome, Facts, Loading, Problem } from '../components/Chrome'
import type { Fact } from '../components/Chrome'
import { InTokens, Lines, Reused, TokenCells, TokenHeaders } from '../components/Tokens'
import { Trace } from '../components/Trace'
import { MixBar, WorkBars } from '../components/WorkBars'
import { clip, count, duration, money, shortId, shortModel, tokens, when } from '../format'
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
                ...(data.session.wait_ms > 0
                  ? [['waiting on you', duration(data.session.wait_ms)] as Fact]
                  : []),
                ['in', <InTokens of={data.session} />],
                ['reused', <Reused of={data.session} />, "Share of this session's input tokens that were served from the prompt cache rather than processed fresh. Agents resend the whole conversation every round, so almost all of it is a repeat — and a cache read is billed at about a tenth of the input rate, which is why a huge 'in' figure can still be cheap."],
                ['out', tokens(data.session.out_tokens)],
                ['cost', money(data.session.cost), "What this cost at the rates under Settings, worked out per round from its own model's prices and summed. Rounds whose model has no rate are left out."],
                ...(data.session.added + data.session.removed > 0
                  ? [
                      [
                        'lines',
                        <Lines added={data.session.added} removed={data.session.removed} />,
                      ] as Fact,
                    ]
                  : []),
              ]}
            />

            <section>
              <h2>Work profile</h2>
              <WorkBars analysis={data.analysis} />
            </section>

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
              <h2>Tasks</h2>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 34 }} />
                    <th>Asked</th>
                    <th className="r">Rounds</th>
                    <th className="r">Tools</th>
                    <th>Work</th>
                    <TokenHeaders />
                    <th className="r">Lines</th>
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
                      {/* The distribution rather than the name of its largest slice: the widest
                          band is the same answer the name gave, and the rest of the bar is the part
                          a single category and a percentage threw away. */}
                      <td>
                        {task.mix.length === 0 ? (
                          <span className="muted">—</span>
                        ) : (
                          /* A fixed width, because the bar's slices are flex-sized and so have no
                             width of their own to give the column: left to size itself, the column
                             shrinks to the header and every minor category becomes a hairline. */
                          <div
                            style={{ width: 110 }}
                            /* The bar carries a title per slice, but nothing that reads the row
                               aloud gets the summary the old text gave for free. */
                            aria-label={
                              task.work === null
                                ? undefined
                                : `mostly ${task.work.short}, ${task.mix.length} kinds of work`
                            }
                          >
                            <MixBar mix={task.mix} />
                          </div>
                        )}
                      </td>
                      <TokenCells of={task} />
                      <td className="r num dim nowrap">
                        {task.added + task.removed > 0 ? (
                          <Lines added={task.added} removed={task.removed} />
                        ) : (
                          <span className="muted">·</span>
                        )}
                      </td>
                      <td className="r num dim">{duration(task.gen_ms)}</td>
                      <td className="r num dim">{duration(task.elapsed_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="note" style={{ marginTop: 12 }}>
                {count(data.tasks.length)} tasks. A task is one user turn and everything the agent
                did about it, subagents included. <em>Working</em> is the time the model spent
                generating; <em>elapsed</em> adds the tools it waited on and every gap where it was
                your turn. The five token columns are the five the Settings screen prices: on agent
                work <em>Read</em> is usually most of them, and it is billed at a tenth of the rest.
              </p>
            </section>
          </>
        )}
      </main>
    </>
  )
}
