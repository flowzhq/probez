import { useCallback, useEffect } from 'react'

import { api } from '../api'
import { Chrome, Facts, Loading, Problem } from '../components/Chrome'
import { Inspector } from '../components/Inspector'
import { Trace } from '../components/Trace'
import { WorkBars } from '../components/WorkBars'
import { duration, percent, shortId, tokens, when } from '../format'
import { go, href } from '../router'
import { useData } from '../useData'
import type { ReactElement } from 'react'

/**
 * One task: what was asked, and every round it took.
 *
 * This is the page the rest of the view exists to reach. The trace is the shape of the work and the
 * inspector under it is the evidence, and the two are one control: clicking a round fills the pane,
 * and the arrow keys walk it.
 *
 * The selected round lives in the URL as `?r=`, replacing rather than pushing, so stepping through
 * forty rounds leaves one entry in the back button instead of forty — and a link you send someone
 * still opens on the round you were looking at.
 */
export function Task({
  slug,
  session,
  task,
  round,
}: {
  slug: string
  session: string
  task: number
  round: number | null
}): ReactElement {
  const { data, error } = useData(() => api.task(slug, session, task), [slug, session, task])

  const select = useCallback(
    (index: number | null) => {
      go(
        index === null
          ? href.task(slug, session, task)
          : href.task(slug, session, task, index),
        true,
      )
    },
    [slug, session, task],
  )

  // Opening a task with no round named selects its first one, so the inspector is never an
  // empty panel asking to be clicked.
  const first = data?.trace.rounds[0]?.round ?? null
  useEffect(() => {
    if (round === null && first !== null) select(first)
  }, [round, first, select])

  const step = useCallback(
    (delta: number) => {
      const rounds = data?.trace.rounds ?? []
      const at = rounds.findIndex((item) => item.round === round)
      const next = rounds[Math.min(rounds.length - 1, Math.max(0, at + delta))]
      if (next !== undefined) select(next.round)
    },
    [data, round, select],
  )

  return (
    <>
      <Chrome
        crumbs={[
          { label: data?.project.project ?? slug, to: href.project(slug) },
          { label: `Session ${shortId(session)}`, to: href.session(slug, session) },
          { label: `Task ${task}` },
        ]}
      />
      <main className="page">
        {error !== null && data === null ? (
          <Problem message={error} />
        ) : data === null ? (
          <Loading what="the task" />
        ) : (
          <>
            <div className="head">
              <h1>Task {task}</h1>
              <span className="muted">{when(data.task.first_ts)}</span>
              {data.task.work === null ? null : (
                <span className="tag">
                  {data.task.work.short} {percent(data.task.work.share)}
                </span>
              )}
            </div>
            <Facts
              items={[
                ['rounds', data.task.rounds],
                ['tool calls', data.task.tool_calls],
                ['working', duration(data.task.ms)],
                ['elapsed', duration(data.task.elapsed_ms)],
                ['in', tokens(data.task.in_tokens)],
                ['out', tokens(data.task.out_tokens)],
                ...(data.task.errors > 0
                  ? ([['failed', data.task.errors]] as Array<[string, number]>)
                  : []),
              ]}
            />

            <section>
              <h2>Asked</h2>
              <div className="asked">
                {data.task.asked.trim() === '' ? '(no prompt recorded)' : data.task.asked}
              </div>
            </section>

            <section>
              <h2>Trace</h2>
              <Trace
                trace={data.trace}
                selected={round}
                onSelect={(picked) => select(picked.round)}
              />
              {round === null ? null : (
                <Inspector slug={slug} session={session} round={round} onStep={step} />
              )}
            </section>

            <section>
              <h2>Where this task went</h2>
              <WorkBars analysis={data.analysis} />
            </section>
          </>
        )}
      </main>
    </>
  )
}
