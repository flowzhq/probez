import { useState } from 'react'

import { api } from '../api'
import type { Question, ToolRow, Trail, ViewSession } from '../api'
import { Actions } from '../components/Actions'
import { Chrome, Facts, Info, Loading, Problem } from '../components/Chrome'
import { instant, naturalFor, ordered, SortHead, useSort } from '../components/SortHead'
import { SourceMarks, SourceTag } from '../components/SourceMarks'
import { InTokens, Reused, TokenCells, TokenHeaders } from '../components/Tokens'
import type { TokenSplit } from '../components/Tokens'
import { MixBar, WorkBars, ErrorsSearchLink } from '../components/WorkBars'
import { ProjectTrends } from '../components/ProjectTrends'
import { QUESTIONS_ARIA, QuestionsTable, questionsExplained } from '../components/QuestionPanel'
import { TRAILS_ARIA, trailsExplained } from '../components/TrailPanel'
import { ago, count, duration, money, percent, shortId, shortModel, tokens, when } from '../format'
import { go, href, linkProps, withSource } from '../router'
import type { SourceChoice } from '../router'
import { SOURCE_LABEL } from '../source'
import { useData } from '../useData'
import type { ReactElement } from 'react'

/** Every column of the sessions table, each of which sorts. */
type SessionSort =
  | 'session'
  | 'started'
  | 'model'
  | 'tasks'
  | 'rounds'
  | 'tools'
  | 'work'
  | keyof TokenSplit
  | 'peak'
  | 'cost'
  | 'working'
  | 'elapsed'

const sessionNatural = naturalFor<SessionSort>('session', 'model', 'work')

/**
 * What a column sorts by: the figure the cell shows, not the text it shows it as.
 *
 * Blank is null wherever the cell shows a dash, so an unmeasured session sorts after every measured
 * one rather than as though it had cost or held nothing. Work sorts by the kind of work the session
 * mostly was, which is the widest band of its bar.
 */
function sessionValue(session: ViewSession, key: SessionSort): number | string | null {
  switch (key) {
    case 'session':
      return session.session
    case 'started':
      return instant(session.first_ts)
    case 'model':
      return session.model === null ? null : shortModel(session.model)
    case 'tasks':
      return session.tasks
    case 'rounds':
      return session.rounds
    case 'tools':
      return session.tool_calls
    case 'work':
      return session.work?.short ?? null
    case 'peak':
      return session.peak_in_tokens
    case 'cost':
      return session.unpriced === session.rounds ? null : session.cost
    case 'working':
      return session.active_ms
    case 'elapsed':
      return session.elapsed_ms
    default:
      return session[key]
  }
}

/**
 * One project: what its work was, and which sessions it was done in.
 *
 * The distribution comes first because it is the answer to the question the project is here to
 * ask. The session list is how you get from that answer to the work it describes.
 */
export function Project({
  slug,
  source = null,
}: {
  slug: string
  source?: SourceChoice | null
}): ReactElement {
  // Bumped after a sync, which is what makes every table on this page re-read the store.
  const [read, setRead] = useState(0)
  const { data, error, loading } = useData(() => api.project(slug, source), [slug, read, source])
  const [tab, setTab] = useState<'work' | 'tools' | 'trends'>('work')
  const [list, setList] = useState<'sessions' | 'trails' | 'questions'>('sessions')
  const [sorted, sortBy] = useSort<SessionSort>(sessionNatural)
  // A subagent sits under the session that handed it off, closed until asked for, so the list
  // reads as the sessions someone opened. One whose parent is not listed here stays at the top
  // level, where it can still be found.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
  const listed = new Set(data?.sessions.map((session) => session.session) ?? [])
  const children = new Map<string, ViewSession[]>()
  for (const session of data?.sessions ?? []) {
    if (session.parent === null || !listed.has(session.parent)) continue
    const siblings = children.get(session.parent)
    if (siblings === undefined) children.set(session.parent, [session])
    else siblings.push(session)
  }
  const sessions = ordered(
    (data?.sessions ?? []).filter((session) => session.parent === null || !listed.has(session.parent)),
    sorted,
    sessionValue,
  )
  const toggle = (session: string): void =>
    setOpened((was) => {
      const next = new Set(was)
      if (!next.delete(session)) next.add(session)
      return next
    })

  return (
    <>
      <Chrome
        crumbs={[{ label: 'Projects', to: href.projects(source) }, { label: data?.project.project ?? slug }]}
        search={{ slug, source }}
      />
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
              {data.project.darkened_at === null ? null : (
                <span
                  className="mark"
                  title="It was darkened on the way out of the store it came from: these figures are real, the words behind them were replaced"
                >
                  darkened
                </span>
              )}
              <SourceMarks sources={data.project.sources} />
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
                rounds={source === null ? data.project.rounds : null}
                onSynced={() => setRead(read + 1)}
                onRenamed={() => setRead(read + 1)}
                // The page is about a project that no longer exists; the list is where to be next.
                onRemoved={() => go(href.projects(source))}
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
                ['cost', `${money(data.cost)}${data.unpriced > 0 ? '+' : ''}`, "What this cost at the rates under Settings, worked out per round from its own model's prices and summed. Rounds whose model has no rate are left out, and the figure is marked +."],
              ]}
            />
            {data.unpriced > 0 || (data.project.sources ?? []).includes('cursor') ? (
              <p className="note">
                Cost and token totals only include rounds whose model has a rate. Cursor usage
                needs <span className="mono">probez hook --install</span>; transcripts alone have
                none, and the hook is not retroactive — only turns after install get Tokens and
                Cost. A + on a cost means some rounds in the total could not be priced. Filtering by
                source (the Source control, or <span className="mono">source:</span> in the query
                bar) does not change what Sync collects. The control filters this page; typing{' '}
                <span className="mono">source:</span> in the bar is still a search.
              </p>
            ) : null}

            <section>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <h2 style={{ margin: 0 }}>
                  {tab === 'work'
                    ? 'Where agent work goes'
                    : tab === 'tools'
                      ? 'What it called'
                      : 'Trends'}
                </h2>
                <span className="spacer" style={{ flex: 1 }} />
                <div className="toggle">
                  <button aria-pressed={tab === 'work'} onClick={() => setTab('work')}>
                    work
                  </button>
                  <button aria-pressed={tab === 'tools'} onClick={() => setTab('tools')}>
                    tools
                  </button>
                  <button aria-pressed={tab === 'trends'} onClick={() => setTab('trends')}>
                    trends
                  </button>
                </div>
              </div>
              {tab === 'work' ? (
                <WorkBars analysis={data.analysis} slug={slug} source={source} />
              ) : tab === 'tools' ? (
                <Tools slug={slug} read={read} source={source} />
              ) : (
                <ProjectTrends
                  peak={data.trends.peak_context_occupancy}
                  reusedFresh={data.trends.reused_vs_fresh}
                />
              )}
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
              {list === 'questions' ? (
                <Questions slug={slug} read={read} source={source} />
              ) : list === 'trails' ? (
                <Trails slug={slug} read={read} source={source} />
              ) : data.sessions.length === 0 ? (
                <p className="note">
                  {source === null
                    ? 'No sessions in this project.'
                    : `No ${SOURCE_LABEL[source]} sessions in this project.`}
                </p>
              ) : (
              <table>
                <thead>
                  <tr>
                    <SortHead label="Session" head="session" sorted={sorted} onSort={sortBy} />
                    <SortHead label="Started" head="started" sorted={sorted} onSort={sortBy} />
                    <SortHead label="Model" head="model" sorted={sorted} onSort={sortBy} />
                    <SortHead label="Tasks" head="tasks" sorted={sorted} onSort={sortBy} className="r" />
                    <SortHead label="Rounds" head="rounds" sorted={sorted} onSort={sortBy} className="r" />
                    <SortHead label="Tools" head="tools" sorted={sorted} onSort={sortBy} className="r" />
                    <SortHead
                      label="Work"
                      head="work"
                      sorted={sorted}
                      onSort={sortBy}
                      title="Sorts by the kind of work the session mostly was"
                    />
                    <TokenHeaders sorted={sorted} onSort={sortBy} />
                    <SortHead
                      label="Peak context"
                      head="peak"
                      sorted={sorted}
                      onSort={sortBy}
                      className="r"
                      title="Largest input context any round in this session recorded (max in_tokens). When the model has a published window, the share of that window is shown too. Not the sum of input tokens."
                    />
                    <SortHead
                      label="Cost"
                      head="cost"
                      sorted={sorted}
                      onSort={sortBy}
                      className="r"
                      title="What this session cost at the rates under Settings, worked out per round from its own model's prices and summed. Rounds whose model has no rate are left out, and the row is marked."
                    />
                    <SortHead label="Working" head="working" sorted={sorted} onSort={sortBy} className="r" />
                    <SortHead label="Elapsed" head="elapsed" sorted={sorted} onSort={sortBy} className="r" />
                  </tr>
                </thead>
                <tbody>
                  {sessions
                    .flatMap((session) => {
                      const subs = children.get(session.session) ?? []
                      const open = opened.has(session.session)
                      return [
                        { session, depth: 0, subs, open },
                        ...(open ? ordered(subs, sorted, sessionValue) : []).map((sub) => ({
                          session: sub,
                          depth: 1,
                          subs: [] as ViewSession[],
                          open: false,
                        })),
                      ]
                    })
                    .map(({ session, depth, subs, open }) => (
                    <tr
                      key={session.session}
                      className={depth > 0 ? 'row child' : 'row'}
                      onClick={() => go(href.session(slug, session.session, source))}
                    >
                      <td className="mono">
                        {subs.length > 0 ? (
                          <button
                            type="button"
                            className="expander"
                            aria-expanded={open}
                            title={`${open ? 'Hide' : 'Show'} the ${subs.length === 1 ? 'subagent' : `${subs.length} subagents`} this session handed work to`}
                            onClick={(event) => {
                              event.stopPropagation()
                              toggle(session.session)
                            }}
                          >
                            <span className="chevron" aria-hidden="true" />
                            {subs.length}
                          </button>
                        ) : (
                          <span className="expander-gap" aria-hidden="true" />
                        )}
                        <a
                          {...linkProps(href.session(slug, session.session, source))}
                          title={depth > 0 ? session.session : undefined}
                        >
                          {/* Under its parent, the parent's half of the id says nothing the row
                              above does not. */}
                          {depth > 0 ? shortId(session.session).split('/').at(-1) : shortId(session.session)}
                        </a>
                        {/* The id already carries the session it ran under, but says so only to
                            someone who knows the shape. The tag is what makes the row readable
                            at a glance as work the agent handed off. */}
                        {session.agent === 'sub' ? <> <span className="tag">sub</span></> : null}
                        {' '}
                        <SourceTag source={session.source} />
                      </td>
                      <td className="muted">{when(session.first_ts)}</td>
                      <td className="dim">{shortModel(session.model)}</td>
                      <td className="r num">{session.tasks}</td>
                      <td className="r num">{session.rounds}</td>
                      <td className="r num">
                        {session.tool_calls}
                        {session.errors > 0 ? (
                          <>
                            {' '}
                            <ErrorsSearchLink
                              count={session.errors}
                              slug={slug}
                              rounds={session.error_rounds}
                              source={source}
                              title="Search rounds with tool errors"
                            >
                              ✗{session.errors}
                            </ErrorsSearchLink>
                          </>
                        ) : null}
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
                      <td
                        className="r num"
                        title={
                          session.peak_in_tokens === null
                            ? 'No round in this session recorded input tokens'
                            : session.peak_context_window === null
                              ? 'Largest input context any round recorded. No published window for that model, so no share.'
                              : `Largest input context any round recorded — ${percent(session.peak_in_tokens / session.peak_context_window, 0)} of the model's ${tokens(session.peak_context_window)} input room`
                        }
                      >
                        {session.peak_in_tokens === null ? (
                          <span className="muted">—</span>
                        ) : (
                          <>
                            {tokens(session.peak_in_tokens)}
                            {session.peak_context_window !== null && session.peak_context_window > 0
                              ? ` (${percent(session.peak_in_tokens / session.peak_context_window, 0)})`
                              : null}
                          </>
                        )}
                      </td>
                      {/* What is shown is what could be priced. Some rounds unpriced marks the
                          figure `+`, since it is real but short; none priced shows the same dash
                          every unmeasured value does, rather than a total that would read as free. */}
                      <td
                        className="r num"
                        title={
                          session.unpriced === 0
                            ? undefined
                            : `${session.unpriced} of ${session.rounds} rounds have no rate for their model and are outside this`
                        }
                      >
                        {session.unpriced === session.rounds ? (
                          <span className="muted">—</span>
                        ) : (
                          <>
                            {money(session.cost)}
                            {session.unpriced > 0 ? <span className="muted">+</span> : null}
                          </>
                        )}
                      </td>
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
function trailHref(slug: string, trail: Trail, source?: string | null): string {
  return withSource(href.task(slug, trail.session, trail.task, trail.steps[0]?.round, trail.ref), source)
}

type TrailSort =
  | 'trail'
  | 'steps'
  | 'depth'
  | 'wide'
  | 'paths'
  | 'back'
  | 'root'
  | 'ended'
  | 'in'
  | 'out'
  | 'time'

const trailNatural = naturalFor<TrailSort>('trail', 'root', 'ended')

function trailValue(trail: Trail, key: TrailSort): number | string {
  switch (key) {
    case 'trail':
      return `${trail.session}#${trail.ref}`
    case 'steps':
      return trail.steps.length
    case 'depth':
      return trail.depth
    case 'wide':
      return trail.breadth
    case 'paths':
      return trail.paths
    case 'back':
      return trail.revisits
    case 'root':
      return trail.root
    case 'ended':
      return trail.outcome
    case 'in':
      return trail.in_tokens
    case 'out':
      return trail.out_tokens
    case 'time':
      return trail.ms
  }
}

/**
 * Every trail in the project: runs of calls that followed one another into the repository.
 *
 * A row goes to the trail itself rather than to a page about it — clicking one opens the task it
 * happened in with the trail already open and its first round selected, exactly as clicking its
 * bracket on that trace would. There is no trail page, because a trail is a shape over rounds and
 * the trace is where rounds are shown.
 */
function Trails({
  slug,
  read,
  source,
}: {
  slug: string
  read: number
  source?: SourceChoice | null
}): ReactElement {
  const { data, error } = useData(() => api.trails(slug, source), [slug, read, source])
  const [sorted, sortBy] = useSort<TrailSort>(trailNatural)

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
            <SortHead label="Trail" head="trail" sorted={sorted} onSort={sortBy} />
            <SortHead label="Steps" head="steps" sorted={sorted} onSort={sortBy} className="r" />
            <SortHead
              label="Depth"
              head="depth"
              sorted={sorted}
              onSort={sortBy}
              className="r"
              title="How far the search went: the longest chain of hops."
            />
            <SortHead
              label="Wide"
              head="wide"
              sorted={sorted}
              onSort={sortBy}
              className="r"
              title="How far it fanned from a single call. A listing feeding five reads is wide and shallow."
            />
            <SortHead label="Paths" head="paths" sorted={sorted} onSort={sortBy} className="r" />
            <SortHead
              label="Back"
              head="back"
              sorted={sorted}
              onSort={sortBy}
              className="r"
              title="Paths it went back to after leaving them."
            />
            <SortHead label="Started from" head="root" sorted={sorted} onSort={sortBy} />
            <SortHead label="Ended" head="ended" sorted={sorted} onSort={sortBy} />
            <SortHead label="In" head="in" sorted={sorted} onSort={sortBy} className="r" />
            <SortHead label="Out" head="out" sorted={sorted} onSort={sortBy} className="r" />
            <SortHead label="Time" head="time" sorted={sorted} onSort={sortBy} className="r" />
          </tr>
        </thead>
        <tbody>
          {ordered(data.trails, sorted, trailValue).map((trail) => (
            <tr
              key={`${trail.session}-${trail.ref}`}
              className="row"
              onClick={() => go(trailHref(slug, trail, source))}
            >
              <td className="mono">
                <a {...linkProps(trailHref(slug, trail, source))}>
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

function questionHref(slug: string, question: Question, source?: string | null): string {
  return withSource(
    href.task(
      slug,
      question.session,
      question.task,
      question.calls[0]?.round,
      null,
      question.at,
    ),
    source,
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
function Questions({
  slug,
  read,
  source,
}: {
  slug: string
  read: number
  source?: SourceChoice | null
}): ReactElement {
  const { data, error } = useData(() => api.questions(slug, source), [slug, read, source])

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
      readings={data.readings}
      onOpen={(picked) => {
        if (picked !== null) go(questionHref(slug, picked, source))
      }}
      hrefFor={(one) => questionHref(slug, one, source)}
      note={
        <p className="note" style={{ marginTop: 12 }}>
          {data.questions.length} questions over {data.calls} calls that were finding something out
          — {per.toFixed(2)} calls per question, {data.reasked} of them taking more than one
          {once === 0 ? '' : `, and ${once} answered in a single call and not listed`}. A trail is a
          walk that went somewhere, and its hops exist only where a call narrowed; a call that asks
          the same thing over again narrows nothing and so appears in no trail at all. Here it does:{' '}
          {data.repeats} calls re-asked something already asked, {data.fetches} only turned a line
          number into a body, and {data.sweeps} named three or more different words at once. A row
          opens the task it was asked in, on the call it started with — and that is where{' '}
          <em>explain</em> is, which asks your own LLM what one of them was after.
        </p>
      }
    />
  )
}

/** What Bash actually ran, which is the one tool whose name is not its operation. */
function Tools({
  slug,
  read,
  source,
}: {
  slug: string
  read: number
  source?: SourceChoice | null
}): ReactElement {
  const { data, error } = useData(() => api.tools(slug, source), [slug, read, source])
  const [by, setBy] = useState<'command' | 'kind'>('command')
  const [sorted, sortBy] = useSort<ToolSort>(toolNatural)

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
            <SortHead label="Tool" head="tool" sorted={sorted} onSort={sortBy} />
            <SortHead label="Calls" head="calls" sorted={sorted} onSort={sortBy} className="r" />
            <SortHead label="Errors" head="errors" sorted={sorted} onSort={sortBy} className="r" />
            <SortHead
              label="Quiet"
              head="quiet"
              sorted={sorted}
              onSort={sortBy}
              className="r"
              title="Calls that wrote to stderr or were cut short while the harness reported no error."
            />
            <SortHead label="Result" head="result" sorted={sorted} onSort={sortBy} className="r" />
            <SortHead label="Time" head="time" sorted={sorted} onSort={sortBy} className="r" />
          </tr>
        </thead>
        <tbody>
          {/* A command stays under the tool it belongs to and sorts among its siblings by the same
              column, so the twelve shown under a tool are its top twelve by it. */}
          {ordered(rows, sorted, toolValue).map((row) => [
            <Row key={row.name} row={row} indent={0} />,
            ...ordered(row.sub ?? [], sorted, toolValue)
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

type ToolSort = 'tool' | 'calls' | 'errors' | 'quiet' | 'result' | 'time'

const toolNatural = naturalFor<ToolSort>('tool')

function toolValue(row: ToolRow, key: ToolSort): number | string {
  switch (key) {
    case 'tool':
      return row.name
    case 'calls':
      return row.calls
    case 'errors':
      return row.errors
    case 'quiet':
      return row.quiet
    case 'result':
      return row.result_chars
    case 'time':
      return row.ms
  }
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
