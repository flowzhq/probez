import { useState } from 'react'

import { api } from '../api'
import type { Question, ToolRow, Trail } from '../api'
import { Actions } from '../components/Actions'
import { Chrome, Facts, Info, Loading, Problem } from '../components/Chrome'
import { InTokens, Reused, TokenCells, TokenHeaders } from '../components/Tokens'
import { MixBar, WorkBars } from '../components/WorkBars'
import { QUESTIONS_ARIA, QuestionsTable, questionsExplained } from '../components/QuestionPanel'
import { TRAILS_ARIA, trailsExplained } from '../components/TrailPanel'
import { ago, count, duration, money, percent, shortId, shortModel, tokens, when } from '../format'
import { go, href, linkProps } from '../router'
import { useData } from '../useData'
import type { ReactElement } from 'react'

/**
 * One project: what its work was, and which sessions it was done in.
 *
 * The distribution comes first because it is the answer to the question the project is here to
 * ask. The session list is how you get from that answer to the work it describes.
 */
export function Project({ slug }: { slug: string }): ReactElement {
  // Bumped after a sync, which is what makes every table on this page re-read the store.
  const [read, setRead] = useState(0)
  const { data, error, loading } = useData(() => api.project(slug), [slug, read])
  const [tab, setTab] = useState<'work' | 'tools'>('work')
  const [list, setList] = useState<'sessions' | 'trails' | 'questions'>('sessions')

  return (
    <>
      <Chrome crumbs={[{ label: data?.project.project ?? slug }]} />
      <main className="page">
        {error !== null && data === null ? (
          <Problem message={error} />
        ) : data === null ? (
          <Loading what="the project" />
        ) : (
          <div className={loading ? 'rereading' : undefined}>
            <div className="head">
              <h1>{data.project.project}</h1>
              {data.project.imported_at === null ? null : (
                <span className="mark" title="Arrived as a file someone exported">
                  imported
                </span>
              )}
              {(data.project.sources ?? []).includes('cursor') ? (
                <span
                  className="mark"
                  title="Includes Cursor sessions. Cursor transcripts do not record token usage or cost."
                >
                  cursor
                </span>
              ) : null}
              <span className="muted mono clip">{data.project.path ?? data.project.key}</span>
              <span className="spacer" style={{ flex: 1 }} />
              {/*
                Two dates, named apart. The projects list has a "last activity" column, and this page
                used to answer it with when probez last *read* the sessions — a different number
                about a different thing, under a name close enough to read as the same one. So the
                work's own date leads, under the name the list gives it, and when probez went looking
                follows it as the separate fact it is. An import was never collected here, and saying
                so would misplace where it came from.
              */}
              <span className="muted nowrap">
                Last activity {ago(data.project.last_ts)} ·{' '}
                {data.project.imported_at === null
                  ? `collected ${ago(data.project.collected_at)}`
                  : `imported ${ago(data.project.imported_at)}`}
              </span>
              <Actions
                slug={slug}
                project={data.project.project}
                renamed={data.project.renamed}
                rounds={data.project.rounds}
                onSynced={() => setRead(read + 1)}
                onRenamed={() => setRead(read + 1)}
                // The page is about a project that no longer exists; the list is where to be next.
                onRemoved={() => go(href.projects())}
              />
            </div>
            <Facts
              items={[
                ['sessions', data.project.sessions],
                ['tasks', data.project.tasks],
                ['rounds', count(data.project.rounds)],
                ['tool calls', count(data.tool_calls)],
                ['in', <InTokens of={data.project} />],
                ['reused', <Reused of={data.project} />, "Share of this project's input tokens that were served from the prompt cache rather than processed fresh. Agents resend the whole conversation every round, so almost all of it is a repeat — and a cache read is billed at about a tenth of the input rate, which is why a huge 'read' figure can still be cheap."],
                ['out', tokens(data.project.out_tokens)],
                ['cost', money(data.cost), "What this cost at the rates under Settings, worked out per round from its own model's prices and summed. Rounds whose model has no rate are left out."],
              ]}
            />
            {(data.project.sources ?? []).includes('cursor') ? (
              <p className="note">
                Cursor transcripts do not record token usage or model names, so those rounds have no
                cost. Shares are of the Claude rounds that do.
              </p>
            ) : null}

            <section>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <h2 style={{ margin: 0 }}>
                  {tab === 'work' ? 'Where agent work goes' : 'What it called'}
                </h2>
                <span className="spacer" style={{ flex: 1 }} />
                <div className="toggle">
                  <button aria-pressed={tab === 'work'} onClick={() => setTab('work')}>
                    work
                  </button>
                  <button aria-pressed={tab === 'tools'} onClick={() => setTab('tools')}>
                    tools
                  </button>
                </div>
              </div>
              {tab === 'work' ? <WorkBars analysis={data.analysis} /> : <Tools slug={slug} read={read} />}
            </section>

            <section>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <h2 style={{ margin: 0 }}>
                  {list === 'sessions' ? 'Sessions' : list === 'trails' ? 'Trails' : 'Questions'}
                  {/* The columns are four one-word names for things nobody should be expected to
                      infer, and the concept behind them is not one either. The mark says an
                      explanation exists; the note under the table repeats the concept for anyone
                      who scrolls past it. */}
                  {list === 'trails' ? (
                    <Info says={trailsExplained()} aria={TRAILS_ARIA} />
                  ) : list === 'questions' ? (
                    <Info says={questionsExplained()} aria={QUESTIONS_ARIA} />
                  ) : null}
                </h2>
                <span className="spacer" style={{ flex: 1 }} />
                <div className="toggle">
                  <button aria-pressed={list === 'sessions'} onClick={() => setList('sessions')}>
                    sessions
                  </button>
                  <button aria-pressed={list === 'trails'} onClick={() => setList('trails')}>
                    trails
                  </button>
                  <button aria-pressed={list === 'questions'} onClick={() => setList('questions')}>
                    questions
                  </button>
                </div>
              </div>
              {list === 'questions' ? <Questions slug={slug} read={read} /> : list === 'trails' ? <Trails slug={slug} read={read} /> : (
              <table>
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Started</th>
                    <th>Model</th>
                    <th className="r">Tasks</th>
                    <th className="r">Rounds</th>
                    <th className="r">Tools</th>
                    <th>Work</th>
                    <TokenHeaders />
                    <th className="r">Working</th>
                    <th className="r">Elapsed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sessions.map((session) => (
                    <tr
                      key={session.session}
                      className="row"
                      onClick={() => go(href.session(slug, session.session))}
                    >
                      <td className="mono">
                        <a {...linkProps(href.session(slug, session.session))}>
                          {shortId(session.session)}
                        </a>
                      </td>
                      <td className="muted">{when(session.first_ts)}</td>
                      <td className="dim">{shortModel(session.model)}</td>
                      <td className="r num">{session.tasks}</td>
                      <td className="r num">{session.rounds}</td>
                      <td className="r num">
                        {session.tool_calls}
                        {session.errors > 0 ? <span className="bad"> ✗{session.errors}</span> : null}
                      </td>
                      {/* The distribution rather than the name of its largest slice, which is what
                          the tasks table already does one level down. The widest band is the same
                          answer the text gave; the rest of the bar is what a single name threw
                          away. */}
                      <td>
                        {session.mix.length === 0 ? (
                          <span className="muted">—</span>
                        ) : (
                          /* Fixed, because the slices are flex-sized and give the column no width
                             of their own: left to size itself it shrinks to the header. */
                          <div
                            style={{ width: 110 }}
                            aria-label={
                              session.work === null
                                ? undefined
                                : `mostly ${session.work.short}, ${session.mix.length} kinds of work`
                            }
                          >
                            <MixBar mix={session.mix} />
                          </div>
                        )}
                      </td>
                      <TokenCells of={session} />
                      <td className="r num dim">{duration(session.active_ms)}</td>
                      <td className="r num dim">{duration(session.elapsed_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              )}
            </section>
          </div>
        )}
      </main>
    </>
  )
}

/**
 * Where a trail row goes: the task it happened in, with the trail open and its first round selected.
 *
 * Both halves are in the URL, so the row lands on the trail itself rather than on a round that
 * happens to start one — the page opens exactly as it would had you clicked the bracket there.
 */
function trailHref(slug: string, trail: Trail): string {
  return href.task(slug, trail.session, trail.task, trail.steps[0]?.round, trail.ref)
}

/**
 * Every trail in the project: runs of calls that followed one another into the repository.
 *
 * A row goes to the trail itself rather than to a page about it — clicking one opens the task it
 * happened in with the trail already open and its first round selected, exactly as clicking its
 * bracket on that trace would. There is no trail page, because a trail is a shape over rounds and
 * the trace is where rounds are shown.
 */
function Trails({ slug, read }: { slug: string; read: number }): ReactElement {
  const { data, error } = useData(() => api.trails(slug), [slug, read])

  if (error !== null && data === null) return <Problem message={error} />
  if (data === null) return <Loading what="the trails" />
  if (data.trails.length === 0) {
    return (
      <p className="note">
        No trails here: no run of calls in this project followed one into another. That is what an
        agent working in a repository it already knows looks like.
      </p>
    )
  }

  const landed = data.trails.filter((trail) => trail.outcome === 'edit').length
  return (
    <>
      <table>
        <thead>
          <tr>
            <th>Trail</th>
            <th className="r">Steps</th>
            <th className="r" title="How far the search went: the longest chain of hops.">
              Depth
            </th>
            <th className="r" title="How far it fanned from a single call. A listing feeding five reads is wide and shallow.">
              Wide
            </th>
            <th className="r">Paths</th>
            <th className="r" title="Paths it went back to after leaving them.">
              Back
            </th>
            <th>Started from</th>
            <th>Ended</th>
            <th className="r">In</th>
            <th className="r">Out</th>
            <th className="r">Time</th>
          </tr>
        </thead>
        <tbody>
          {data.trails.map((trail) => (
            <tr
              key={`${trail.session}-${trail.ref}`}
              className="row"
              onClick={() => go(trailHref(slug, trail))}
            >
              <td className="mono">
                <a {...linkProps(trailHref(slug, trail))}>
                  {shortId(trail.session)}#{trail.ref}
                </a>
              </td>
              <td className="r num">{trail.steps.length}</td>
              <td className="r num">{trail.depth}</td>
              <td className="r num">{trail.breadth}</td>
              <td className="r num">{trail.paths}</td>
              <td className={`r num ${trail.revisits > 0 ? '' : 'muted'}`}>
                {trail.revisits > 0 ? trail.revisits : '·'}
              </td>
              <td className="dim">{trail.root}</td>
              {/* One cell, and it has to hold a word and a path that can be sixty characters. The
                  word leads because it is the answer; the path is context and clips. */}
              <td className="nowrap">
                <span className={trail.outcome === 'edit' ? undefined : 'dim'}>
                  {trail.outcome}
                </span>
                {trail.ended_on === '' ? null : (
                  <span className="muted mono" title={trail.ended_on}>
                    {' '}
                    {trail.ended_on.split('/').slice(-2).join('/')}
                  </span>
                )}
              </td>
              <td className="r num dim">{tokens(trail.in_tokens)}</td>
              <td className="r num dim">{tokens(trail.out_tokens)}</td>
              <td className="r num dim">{duration(trail.ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note" style={{ marginTop: 12 }}>
        {data.trails.length} trails · {landed} ended in a change ·{' '}
        {percent(data.finding === 0 ? 0 : data.steps / data.finding)} of the calls that were finding
        something out happened inside one. An agent that does not know a repository finds its way
        around it: it lists the tree, opens what the listing named, greps for a word, reads the lines
        the grep hit. <em>Where this project's work goes</em> counts all of that as Reconstruction
        and cannot tell five hops of one search from five unrelated file opens. Hops are read out of
        the archived session results, so a trail is what the agent actually followed rather than what
        the calls happen to look like. A row opens the task it happened in, on the round it started
        at.
      </p>
    </>
  )
}

function questionHref(slug: string, question: Question): string {
  return href.task(
    slug,
    question.session,
    question.task,
    question.calls[0]?.round,
    null,
    question.at,
  )
}

/**
 * Every question in the project, costliest first.
 *
 * The tail is the reason to look, so the sort is by what each cost rather than by when it was
 * asked — and questions answered in a single call are folded into the note rather than filling
 * three hundred rows with the ones where nothing went wrong.
 *
 * A row goes to the question itself, the way a trail row does: the task it was asked in, with the
 * question open and its first call selected. There is no question page, for the same reason there
 * is no trail page — both are readings of rounds, and the trace is where rounds are shown.
 */
function Questions({ slug, read }: { slug: string; read: number }): ReactElement {
  const { data, error } = useData(() => api.questions(slug), [slug, read])

  if (error !== null && data === null) return <Problem message={error} />
  if (data === null) return <Loading what="the questions" />
  if (data.questions.length === 0) {
    return <p className="note">Nothing in this project went looking for anything.</p>
  }

  const once = data.questions.filter((one) => one.calls.length <= 1).length
  const per = data.calls / data.questions.length

  return (
    <QuestionsTable
      questions={data.questions}
      onOpen={(picked) => {
        if (picked !== null) go(questionHref(slug, picked))
      }}
      hrefFor={(one) => questionHref(slug, one)}
      note={
        <p className="note" style={{ marginTop: 12 }}>
          {data.questions.length} questions over {data.calls} calls that were finding something out
          — {per.toFixed(2)} calls per question, {data.reasked} of them taking more than one
          {once === 0 ? '' : `, and ${once} answered in a single call and not listed`}. A trail is a
          walk that went somewhere, and its hops exist only where a call narrowed; a call that asks
          the same thing over again narrows nothing and so appears in no trail at all. Here it does:{' '}
          {data.repeats} calls re-asked something already asked, {data.fetches} only turned a line
          number into a body, and {data.sweeps} named three or more different words at once. A row
          opens the task it was asked in, on the call it started with.
        </p>
      }
    />
  )
}

/** What Bash actually ran, which is the one tool whose name is not its operation. */
function Tools({ slug, read }: { slug: string; read: number }): ReactElement {
  const { data, error } = useData(() => api.tools(slug), [slug, read])
  const [by, setBy] = useState<'command' | 'kind'>('command')

  if (error !== null && data === null) return <Problem message={error} />
  if (data === null) return <Loading what="the tools" />

  const rows = by === 'command' ? data.tools : data.kinds
  const calls = data.tools.reduce((n, row) => n + row.calls, 0)
  const errors = data.tools.reduce((n, row) => n + row.errors, 0)
  const quiet = data.tools.reduce((n, row) => n + row.quiet, 0)

  return (
    <>
      <div className="toggle" style={{ marginBottom: 10 }}>
        <button aria-pressed={by === 'command'} onClick={() => setBy('command')}>
          by command
        </button>
        <button aria-pressed={by === 'kind'} onClick={() => setBy('kind')}>
          by kind
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Tool</th>
            <th className="r">Calls</th>
            <th className="r">Errors</th>
            <th className="r" title="Calls that wrote to stderr or were cut short while the harness reported no error.">
              Quiet
            </th>
            <th className="r">Result</th>
            <th className="r">Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => [
            <Row key={row.name} row={row} indent={0} />,
            ...(row.sub ?? [])
              .slice(0, 12)
              .map((child) => <Row key={`${row.name}/${child.name}`} row={child} indent={1} />),
          ])}
        </tbody>
      </table>
      <p className="note" style={{ marginTop: 12 }}>
        {rows.length} tools · {count(calls)} calls · {errors} errors · {quiet} quiet. A command is
        counted once per call it appears in, so <span className="mono">cd repo &amp;&amp; npm test</span>{' '}
        counts for both and the sub-rows add up to more than the row above them. Errors, result size
        and time belong to the call, which has one result and one duration, so every command in a
        multi-command call is charged the whole of it. <em>Errors</em> is the harness flag, which
        says the call was accepted rather than that it worked; <em>quiet</em> is the calls that
        wrote to stderr or were cut short without it noticing.
      </p>
    </>
  )
}

function quietTitle(row: ToolRow): string | undefined {
  if (row.quiet === 0) return undefined
  return `${row.quiet} of ${row.calls} calls wrote to stderr or were cut short, with no error reported`
}

function Row({ row, indent }: { row: ToolRow; indent: number }): ReactElement {
  return (
    <tr>
      <td
        className={indent > 0 ? 'dim mono' : undefined}
        style={{ paddingLeft: 10 + indent * 20, fontSize: indent > 0 ? 12 : undefined }}
      >
        {row.name}
        {row.kind === undefined ? null : <span className="muted"> {row.kind}</span>}
      </td>
      <td className="r num">{count(row.calls)}</td>
      <td className={`r num ${row.errors > 0 ? 'bad' : 'muted'}`}>
        {row.errors > 0 ? row.errors : '·'}
      </td>
      <td className={`r num ${row.quiet > 0 ? 'bad' : 'muted'}`} title={quietTitle(row)}>
        {row.quiet > 0 ? row.quiet : '·'}
      </td>
      <td className="r num dim">{tokens(row.result_chars)}</td>
      <td className="r num dim">{duration(row.ms)}</td>
    </tr>
  )
}
