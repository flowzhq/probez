import { useCallback, useEffect, useState } from 'react'

import { api, readingKey } from '../api'
import { Chrome, Facts, Info, Loading, Problem } from '../components/Chrome'
import type { Fact } from '../components/Chrome'
import { Inspector } from '../components/Inspector'
import { InTokens, Lines, Reused } from '../components/Tokens'
import { Trace } from '../components/Trace'
import {
  QUESTIONS_ARIA,
  QuestionPanel,
  QuestionsTable,
  questionsExplained,
} from '../components/QuestionPanel'
import { TrailPanel } from '../components/TrailPanel'
import { WorkBars } from '../components/WorkBars'
import { duration, money, percent, shortCommit, shortId, tokens, when } from '../format'
import { go, href, linkProps } from '../router'
import { useData } from '../useData'
import type { Question, Reading } from '../api'
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
  trail: trailRef,
  question: questionRef,
  q,
}: {
  slug: string
  session: string
  task: number
  round: number | null
  /** The trail being read, by its `ref`, from the URL. */
  trail: string | null
  /** The question being read, by its `at`, from the URL. */
  question: number | null
  /** A query whose matching rounds are lit in the trace, when one brought you here. */
  q: string | null
}): ReactElement {
  const { data, error } = useData(() => api.task(slug, session, task), [slug, session, task])

  /**
   * The rounds of this task a query matched, for lighting the trace.
   *
   * Narrowed to this session and task in the query itself rather than fetched whole and filtered
   * here, so what comes back is the handful of rounds on this page instead of every round in the
   * project that matched. Only fetched at all when a query is in the URL.
   */
  const { data: lit } = useData(
    () =>
      q === null
        ? Promise.resolve(null)
        : api.search(`${q} session:${session} task:${task}`, { slug, limit: 0 }),
    [q, slug, session, task],
  )
  const matched =
    q === null || lit === null ? null : new Set(lit.hits.map((hit) => hit.round ?? -1))
  const trail = (data?.trails ?? []).find((one) => one.ref === trailRef) ?? null
  const question = (data?.questions ?? []).find((one) => one.at === questionRef) ?? null

  /**
   * Readings asked for since the page loaded, over the ones the payload arrived with.
   *
   * Kept here rather than refetching the task: explaining one question changes one sentence, and
   * re-reading a whole task's rounds to learn it would redraw the trace under the person's cursor.
   */
  const [fresh, setFresh] = useState<Record<string, Reading>>({})
  const [explaining, setExplaining] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const readings = { ...(data?.readings ?? {}), ...fresh }
  const explain = (one: Question, again: boolean): void => {
    setExplaining(true)
    setProblem(null)
    api
      .explain(slug, one.session, one.task, one.at, again)
      .then((got) => setFresh((held) => ({ ...held, [got.key]: got.reading })))
      .catch((failed: Error) => setProblem(failed.message))
      .finally(() => setExplaining(false))
  }


  /**
   * Both halves of the selection live in the URL, which is what makes a trail linkable: the trails
   * table on the project page points straight at one, and it opens the way clicking the bracket
   * does rather than merely landing on the round it starts at.
   */
  const select = useCallback(
    (
      index: number | null,
      ontoTrail: string | null = trailRef,
      ontoQuestion: number | null = questionRef,
    ) => {
      go(
        index === null
          ? href.task(slug, session, task, undefined, ontoTrail, ontoQuestion)
          : href.task(slug, session, task, index, ontoTrail, ontoQuestion),
        true,
      )
    },
    [slug, session, task, trailRef, questionRef],
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
        search={{ slug }}
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
              {/* A dimmed strip has to say why it is dimmed, or it reads as a rendering fault
                  rather than as an answer. It also has to be undoable from here: the query came
                  from somewhere else, and there is otherwise no way to put the trace back. */}
              {q === null ? null : (
                <p className="lit">
                  <span className="lit-mark" aria-hidden />
                  {matched === null
                    ? 'Finding the rounds that matched…'
                    : `${matched.size} of these rounds matched `}
                  <code className="mono">{q}</code>.{' '}
                  <a {...linkProps(href.task(slug, session, task, round ?? undefined, trailRef, questionRef))}>
                    Show the whole task
                  </a>
                  {' · '}
                  <a {...linkProps(href.search(q, { slug }))}>Back to the results</a>
                </p>
              )}
              <Trace
                trace={data.trace}
                trails={data.trails}
                selected={round}
                selectedTrail={trailRef}
                questions={data.questions}
                selectedQuestion={questionRef}
                matched={matched}
                onSelect={(picked) => select(picked.round)}
                onSelectTrail={(picked) =>
                  // Picking a trail also opens the round it starts at, the way the lane always has.
                  // It closes any question, because the two are readings of the same calls and
                  // showing both at once would leave the strip lit by one and explained by the other.
                  picked === null
                    ? select(round, null)
                    : select(picked.steps[0]?.round ?? round, picked.ref, null)
                }
                onSelectQuestion={(picked) =>
                  picked === null
                    ? select(round, trailRef, null)
                    : select(picked.calls[0]?.round ?? round, null, picked.at)
                }
              />
              {trail === null ? null : (
                <TrailPanel
                  trail={trail}
                  selected={round}
                  onSelect={(picked) => select(picked)}
                  onClose={() => select(round, null)}
                />
              )}
              {round === null ? null : (
                <Inspector slug={slug} session={session} round={round} onStep={step} />
              )}
            </section>

            <section>
              <div className="head">
                <h2>
                  What it needed to know
                  <Info
                    says={questionsExplained({
                      questions: data.questions.length,
                      calls: data.questions.reduce((sum, one) => sum + one.calls.length, 0),
                    })}
                    aria={QUESTIONS_ARIA}
                  />
                </h2>
              </div>
              <QuestionsTable
                questions={data.questions}
                readings={readings}
                selected={questionRef}
                onOpen={(picked) =>
                  // Opening a question closes any trail, for the reason the lane does the reverse:
                  // they are two readings of one set of calls, and the strip can only be lit by one.
                  picked === null
                    ? select(round, trailRef, null)
                    : select(picked.calls[0]?.round ?? round, null, picked.at)
                }
                note={onceNote(data.questions)}
              />
              {question === null ? null : (
                <QuestionPanel
                  key={question.at}
                  question={question}
                  reading={readings[readingKey(question.session, question.task, question.at)] ?? null}
                  reader={data.reader}
                  // A reading made since the page loaded is about the calls in front of us, so only
                  // the ones the payload arrived with can be stale.
                  stale={
                    fresh[readingKey(question.session, question.task, question.at)] === undefined &&
                    data.stale.includes(readingKey(question.session, question.task, question.at))
                  }
                  explaining={explaining}
                  problem={problem}
                  onExplain={(again) => explain(question, again)}
                  // Fetched when it is asked for rather than with the task: it is every call in
                  // the question spelled out, and most questions are never copied anywhere.
                  onPrompt={() =>
                    api
                      .prompt(slug, question.session, question.task, question.at)
                      .then((got) => got.prompt)
                  }
                  selected={round}
                  onSelect={(picked) => select(picked)}
                  onClose={() => select(round, trailRef, null)}
                />
              )}
            </section>
          </>
        )}
      </main>
    </>
  )
}

/** How many questions took a single call, said under the table rather than listed in it. */
function onceNote(questions: Question[]): ReactElement | undefined {
  const once = questions.filter((one) => one.calls.length <= 1).length
  if (once === 0) return undefined
  return (
    <p className="note">
      {once} more {once === 1 ? 'question was' : 'questions were'} answered in one call, and{' '}
      {once === 1 ? 'is' : 'are'} not listed.
    </p>
  )
}
