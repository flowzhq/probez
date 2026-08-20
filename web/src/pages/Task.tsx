import { useCallback, useEffect, useState } from 'react'

import { api } from '../api'
import { Chrome, Facts, Loading, Problem } from '../components/Chrome'
import type { Fact } from '../components/Chrome'
import { Inspector } from '../components/Inspector'
import { InTokens, Lines, Reused } from '../components/Tokens'
import { Trace } from '../components/Trace'
import { TrailPanel } from '../components/TrailPanel'
import { WorkBars } from '../components/WorkBars'
import { duration, money, percent, shortCommit, shortId, tokens, when } from '../format'
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
  // The walk being read, by its `ref`. Held here rather than in the trace because the panel under
  // the trace and the lane inside it are two views of one choice.
  const [trailRef, setTrailRef] = useState<string | null>(null)
  const trail = (data?.trails ?? []).find((one) => one.ref === trailRef) ?? null

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

  // A walk belongs to the task it was found in, so moving to another task drops it rather than
  // leaving a panel describing rounds that are no longer on the page.
  useEffect(() => setTrailRef(null), [slug, session, task])

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
                ...(data.task.commit === null
                  ? []
                  : [
                      [
                        // Facts read value-then-label, so this is "a938f1f started", the way
                        // "2.6m elapsed" and "94% reused" beside it read.
                        'started',
                        shortCommit(data.task.commit),
                        "The commit this checkout was on when the task was asked — where the work started, not what it ended up as. Read from git's HEAD reflog when the project was collected.",
                      ] as Fact,
                    ]),
                ['working', duration(data.task.gen_ms)],
                ['elapsed', duration(data.task.elapsed_ms)],
                ...(data.task.wait_ms > 0
                  ? [['waiting on you', duration(data.task.wait_ms)] as Fact]
                  : []),
                ['in', <InTokens of={data.task} />],
                ['reused', <Reused of={data.task} />, "Share of this task's input tokens that were served from the prompt cache rather than processed fresh. Agents resend the whole conversation every round, so almost all of it is a repeat — and a cache read is billed at about a tenth of the input rate, which is why a huge 'in' figure can still be cheap."],
                ['out', tokens(data.task.out_tokens)],
                ['cost', money(data.task.cost), "What this cost at the rates under Settings, worked out per round from its own model's prices and summed. Rounds whose model has no rate are left out."],
                ...(data.task.added + data.task.removed > 0
                  ? [
                      [
                        'lines',
                        <Lines added={data.task.added} removed={data.task.removed} />,
                      ] as Fact,
                    ]
                  : []),
                ...(data.task.errors > 0 ? [['failed', data.task.errors] as Fact] : []),
              ]}
            />

            <section>
              <h2>Where this task went</h2>
              <WorkBars analysis={data.analysis} />
            </section>

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
                trails={data.trails}
                selected={round}
                selectedTrail={trailRef}
                onSelect={(picked) => select(picked.round)}
                onSelectTrail={(picked) => setTrailRef(picked === null ? null : picked.ref)}
              />
              {trail === null ? null : (
                <TrailPanel
                  trail={trail}
                  selected={round}
                  onSelect={select}
                  onClose={() => setTrailRef(null)}
                />
              )}
              {round === null ? null : (
                <Inspector slug={slug} session={session} round={round} onStep={step} />
              )}
            </section>
          </>
        )}
      </main>
    </>
  )
}
