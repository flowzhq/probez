import { useCallback, useState } from 'react'
import type { ReactElement } from 'react'

import { api } from '../api'
import type { StoreSession, Thresholds } from '../api'
import { styleOf } from '../categories'
import { Chrome, Loading, Problem } from '../components/Chrome'
import { ShareStack } from '../components/Charts'
import { Drawer, DrawerFacts } from '../components/Drawer'
import { OpenInExplorer } from '../components/OpenInExplorer'
import { instant, naturalFor, ordered, SortHead, useSort } from '../components/SortHead'
import { SourceTag } from '../components/SourceMarks'
import { TOKEN_COLUMNS } from '../components/Tokens'
import { count, duration, money, percent, shortId, shortModel, tokens, when } from '../format'
import { go, href, linkProps } from '../router'
import { changeFilters, changeScope, scoped, useFilter, useScope } from '../scope'
import type { Scope } from '../scope'
import { useData } from '../useData'
import { scopeLine } from './Overview'

type Preset = 'cost' | 'tokens'

type SessionSort =
  | 'session'
  | 'project'
  | 'started'
  | 'cost'
  | 'share'
  | 'rounds'
  | 'cache'
  | 'work'
  | 'errors'
  | 'in_uncached'
  | 'in_cache_write_5m'
  | 'in_cache_write_1h'
  | 'in_cache_read'
  | 'out_tokens'
  | 'peak'

const sessionNatural = naturalFor<SessionSort>('session', 'project', 'work')

function sessionValue(session: StoreSession, key: SessionSort): number | string | null {
  switch (key) {
    case 'session':
      return session.session
    case 'project':
      return session.project
    case 'started':
      return instant(session.first_ts)
    case 'cost':
    case 'share':
      return session.unpriced === session.rounds ? null : session.cost
    case 'rounds':
      return session.rounds
    case 'cache':
      return session.cache_share
    case 'work':
      return session.work?.short ?? null
    case 'errors':
      return session.errors
    case 'peak':
      return session.peak_in_tokens
    default:
      return session[key]
  }
}

/** A kind of work's share of a session's cost, or null for a session with no cost to divide. */
function costShare(session: StoreSession, category: string): number | null {
  if (session.cost <= 0) return null
  return (session.cost_by_category[category] ?? 0) / session.cost
}

function peakShare(session: StoreSession): number | null {
  if (session.peak_in_tokens === null || session.peak_context_window === null || session.peak_context_window <= 0) {
    return null
  }
  return session.peak_in_tokens / session.peak_context_window
}

interface Filters {
  model: string | null
  category: string | null
  finding: string | null
  errors: string | null
  day: string | null
}

/** Whether a session passes every list filter in the address. */
function passes(session: StoreSession, filters: Filters, thresholds: Thresholds): boolean {
  if (filters.model !== null && session.model !== filters.model) return false
  if (filters.category !== null && (session.cost_by_category[filters.category] ?? 0) <= 0) return false
  if (filters.errors !== null && session.errors === 0) return false
  if (filters.day !== null) {
    const start = Date.parse(`${filters.day}T00:00:00.000Z`)
    const end = start + 86_400_000
    const first = instant(session.first_ts)
    const last = instant(session.last_ts) ?? first
    if (first === null || last === null || first >= end || last < start) return false
  }
  if (filters.finding === 'reconstruction') {
    const share = costShare(session, 'reconstruction')
    if (share === null || share <= thresholds.reconstruction) return false
  }
  if (filters.finding === 'context') {
    const share = peakShare(session)
    if (share === null || share <= thresholds.context) return false
  }
  return true
}

function keyOf(session: StoreSession): string {
  return `${session.slug}\u0000${session.session}`
}

/**
 * Investigate › Sessions: every session in the scope, across every project, costliest first.
 *
 * The project page's sessions table lifted to the whole store, with cost moved to the front and
 * the five token columns behind a "token detail" preset. A row opens a drawer to look inside the
 * session before leaving the list; the id, or *Open trace* in the drawer, is the step that leaves.
 */
export function Sessions(): ReactElement {
  const scope = useScope()
  const filters: Filters = {
    model: useFilter('model'),
    category: useFilter('category'),
    finding: useFilter('finding'),
    errors: useFilter('errors'),
    day: useFilter('day'),
  }
  const { data, error, loading } = useData(() => api.sessions(scope), [scope.range, scope.source, scope.project])
  const [sorted, sortBy] = useSort<SessionSort>(sessionNatural, { key: 'cost', dir: 'desc' })
  const [preset, setPreset] = useState<Preset>(() => {
    try {
      return window.localStorage.getItem('probez.columns') === 'tokens' ? 'tokens' : 'cost'
    } catch {
      return 'cost'
    }
  })
  const choose = (next: Preset): void => {
    setPreset(next)
    try {
      window.localStorage.setItem('probez.columns', next)
    } catch {
      // Remembering the preset is a convenience; without storage it lasts the page.
    }
  }
  const [selected, setSelected] = useState<string | null>(null)
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())

  const all = data?.sessions ?? []
  const shown = data === null ? [] : all.filter((session) => passes(session, filters, data.thresholds))
  const total = shown.reduce((sum, session) => sum + session.cost, 0)

  // A subagent sits under the session that handed it off, closed until asked for, as it does on the
  // project page. One whose parent is filtered out stays at the top level, where it can be found.
  const listed = new Set(shown.map(keyOf))
  const children = new Map<string, StoreSession[]>()
  const top: StoreSession[] = []
  for (const session of shown) {
    const parent = session.parent === null ? null : `${session.slug}\u0000${session.parent}`
    if (parent === null || !listed.has(parent)) {
      top.push(session)
      continue
    }
    const siblings = children.get(parent)
    if (siblings === undefined) children.set(parent, [session])
    else siblings.push(session)
  }
  const rows = ordered(top, sorted, sessionValue).flatMap((session) => {
    const subs = children.get(keyOf(session)) ?? []
    const open = opened.has(keyOf(session))
    return [
      { session, depth: 0, subs, open },
      ...(open ? ordered(subs, sorted, sessionValue) : []).map((sub) => ({ session: sub, depth: 1, subs: [], open: false })),
    ]
  })
  const toggle = (key: string): void =>
    setOpened((was) => {
      const next = new Set(was)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const chosen = selected === null ? null : (all.find((session) => keyOf(session) === selected) ?? null)
  const close = useCallback(() => setSelected(null), [])
  const models = [...new Set(all.map((session) => session.model).filter((model): model is string => model !== null))].sort()

  const chips: Array<{ label: string; clear: Record<string, null> }> = []
  if (filters.model !== null) chips.push({ label: `model: ${shortModel(filters.model)}`, clear: { model: null } })
  if (filters.category !== null) {
    chips.push({ label: `work: ${styleOf(filters.category).label}`, clear: { category: null } })
  }
  if (filters.finding === 'reconstruction' && data !== null) {
    chips.push({
      label: `reconstruction > ${percent(data.thresholds.reconstruction)} of cost`,
      clear: { finding: null },
    })
  }
  if (filters.finding === 'context' && data !== null) {
    chips.push({ label: `context > ${percent(data.thresholds.context)}`, clear: { finding: null } })
  }
  if (filters.errors !== null) chips.push({ label: 'has failed calls', clear: { errors: null } })
  if (filters.day !== null) chips.push({ label: `active ${when(`${filters.day}T12:00:00Z`, false)}`, clear: { day: null } })

  return (
    <>
      <Chrome crumbs={[{ label: 'Investigate' }, { label: 'Sessions' }]} scope="store" search={{ slug: scope.project }} />
      <main className="page wide">
        {error !== null && data === null ? (
          <Problem message={error} />
        ) : data === null ? (
          <Loading what="the sessions" />
        ) : (
          <div className={loading ? 'rereading' : undefined}>
            <div className="split-list">
              <div className="head">
                <h1>Sessions</h1>
                <span className="muted">
                  {count(shown.length)} {chips.length === 0 ? '' : `of ${count(all.length)} `}across{' '}
                  {count(new Set(shown.map((session) => session.slug)).size)} projects · {scopeLine(scope)}
                </span>
              </div>

              <div className="fbar">
                <label className="chip scope-chip">
                  <span>Project</span>
                  <select
                    aria-label="Project"
                    value={scope.project ?? ''}
                    onChange={(event) => changeScope({ project: event.target.value === '' ? null : event.target.value })}
                  >
                    <option value="">Any</option>
                    {data.projects.map((project) => (
                      <option key={project.slug} value={project.slug}>
                        {project.project}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="chip scope-chip">
                  <span>Model</span>
                  <select
                    aria-label="Model"
                    value={filters.model ?? ''}
                    onChange={(event) => changeFilters({ model: event.target.value })}
                  >
                    <option value="">Any</option>
                    {models.map((model) => (
                      <option key={model} value={model}>
                        {shortModel(model)}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="chip"
                  aria-pressed={filters.errors !== null}
                  onClick={() => changeFilters({ errors: filters.errors === null ? '1' : null })}
                >
                  Has errors
                </button>
                {chips.map((chip) => (
                  <button
                    key={chip.label}
                    type="button"
                    className="chip filter"
                    onClick={() => changeFilters(chip.clear)}
                    title="Remove this filter"
                  >
                    {chip.label} <span aria-hidden>✕</span>
                  </button>
                ))}
                <span className="spacer" />
                <OpenInExplorer scope={scope} entity="sessions" filters={filters} />
                <div className="toggle" role="group" aria-label="Columns">
                  <span className="muted" style={{ marginRight: 6 }}>
                    Columns
                  </span>
                  <button type="button" aria-pressed={preset === 'cost'} onClick={() => choose('cost')}>
                    Cost
                  </button>
                  <button type="button" aria-pressed={preset === 'tokens'} onClick={() => choose('tokens')}>
                    Token detail
                  </button>
                </div>
              </div>

              {shown.length === 0 ? (
                <p className="note">
                  {all.length === 0
                    ? 'No session ran in this scope.'
                    : 'No session in this scope passes these filters. Remove one above to widen the list.'}
                </p>
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <SortHead label="Session" head="session" sorted={sorted} onSort={sortBy} />
                        <SortHead label="Project" head="project" sorted={sorted} onSort={sortBy} />
                        <SortHead label="Started" head="started" sorted={sorted} onSort={sortBy} />
                        <SortHead
                          label="Cost"
                          head="cost"
                          sorted={sorted}
                          onSort={sortBy}
                          className="r"
                          title="What the session cost at the rates in Settings, within the time range"
                        />
                        {preset === 'cost' ? (
                          <>
                            <SortHead label="Share" head="share" sorted={sorted} onSort={sortBy} className="r" title="Share of the cost of every session listed" />
                            <SortHead label="Rounds" head="rounds" sorted={sorted} onSort={sortBy} className="r" />
                            <SortHead label="Cache" head="cache" sorted={sorted} onSort={sortBy} className="r" title="Share of input served from the cache" />
                            <SortHead label="Work mix" head="work" sorted={sorted} onSort={sortBy} title="Share of cost by kind of work. Sorts by the kind it mostly was." />
                            <SortHead label="Errors" head="errors" sorted={sorted} onSort={sortBy} className="r" />
                          </>
                        ) : (
                          <>
                            {TOKEN_COLUMNS.map((column) => (
                              <SortHead
                                key={column.key}
                                label={column.label}
                                head={column.key}
                                sorted={sorted}
                                onSort={sortBy}
                                className="r"
                                title={column.full}
                              />
                            ))}
                            <SortHead label="Peak context" head="peak" sorted={sorted} onSort={sortBy} className="r" title="Largest input context any round in this session recorded" />
                          </>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(({ session, depth, subs, open }) => {
                        const key = keyOf(session)
                        const priced = session.unpriced < session.rounds
                        return (
                          <tr
                            key={key}
                            tabIndex={0}
                            className={`row${depth > 0 ? ' child' : ''}${selected === key ? ' sel' : ''}`}
                            aria-selected={selected === key}
                            onClick={() => setSelected(key)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                setSelected(key)
                              }
                            }}
                          >
                            <td className="mono nowrap">
                              {subs.length > 0 ? (
                                <button
                                  type="button"
                                  className="expander"
                                  aria-expanded={open}
                                  title={`${open ? 'Hide' : 'Show'} the ${subs.length === 1 ? 'subagent' : `${subs.length} subagents`} this session handed work to`}
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    toggle(key)
                                  }}
                                >
                                  <span className="chevron" aria-hidden="true" />
                                  {subs.length}
                                </button>
                              ) : (
                                <span className="expander-gap" aria-hidden="true" />
                              )}
                              <a {...linkProps(href.session(session.slug, session.session))} title={session.session}>
                                {depth > 0 ? shortId(session.session).split('/').at(-1) : shortId(session.session)}
                              </a>
                              {session.agent === 'sub' ? <> <span className="tag">sub</span></> : null}
                            </td>
                            <td className="nowrap">
                              {session.project} <SourceTag source={session.source} />
                            </td>
                            <td className="muted nowrap">{when(session.first_ts)}</td>
                            <td className="r num">
                              {priced ? (
                                <strong>
                                  {money(session.cost)}
                                  {session.unpriced > 0 ? <span className="muted">+</span> : null}
                                </strong>
                              ) : (
                                <span className="muted" title="No round in this session has a rate for its model">
                                  —
                                </span>
                              )}
                            </td>
                            {preset === 'cost' ? (
                              <>
                                <td className="r num dim">{priced && total > 0 ? percent(session.cost / total, 1) : '—'}</td>
                                <td className="r num">{count(session.rounds)}</td>
                                <td className="r num dim">{session.cache_share === null ? '—' : percent(session.cache_share)}</td>
                                <td style={{ width: 150 }}>
                                  {session.cost > 0 ? (
                                    <ShareStack
                                      height={10}
                                      parts={Object.entries(session.cost_by_category).map(([category, cost]) => ({
                                        key: category,
                                        label: styleOf(category).label,
                                        share: cost / session.cost,
                                      }))}
                                    />
                                  ) : (
                                    <span className="muted">—</span>
                                  )}
                                </td>
                                <td className={`r num ${session.errors > 0 ? 'bad' : 'muted'}`}>
                                  {session.errors > 0 ? session.errors : '·'}
                                </td>
                              </>
                            ) : (
                              <>
                                {TOKEN_COLUMNS.map((column) => (
                                  <td key={column.key} className="r num dim">
                                    {tokens(session[column.key])}
                                  </td>
                                ))}
                                <td className="r num dim">
                                  {session.peak_in_tokens === null ? '—' : tokens(session.peak_in_tokens)}
                                  {peakShare(session) === null ? null : ` (${percent(peakShare(session)!)})`}
                                </td>
                              </>
                            )}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <SessionDrawer session={chosen} scope={scope} onClose={close} />
          </div>
        )}
      </main>
    </>
  )
}

/**
 * A look inside one session without leaving the list.
 *
 * The facts come with the row; the trace thumbnail and the costliest questions are read when the
 * row is chosen, from the same payload the session page opens with.
 */
function SessionDrawer({
  session,
  scope,
  onClose,
}: {
  session: StoreSession | null
  scope: Scope
  onClose: () => void
}): ReactElement | null {
  const slug = session?.slug ?? null
  const id = session?.session ?? null
  const { data } = useData(
    () => (slug === null || id === null ? Promise.resolve(null) : api.session(slug, id)),
    [slug, id],
  )

  if (session === null) return null

  const trace = data?.session.session === session.session ? data.trace : null
  const questions = data?.session.session === session.session ? data.questions : null
  const peak = trace === null ? 0 : Math.max(1, ...trace.rounds.map((round) => round.context_tokens ?? round.in_tokens ?? 0))
  const mix = Object.entries(session.cost_by_category)
    .filter(([, cost]) => cost > 0)
    .map(([category, cost]) => ({ key: category, label: styleOf(category).label, share: session.cost > 0 ? cost / session.cost : 0 }))

  return (
    <Drawer
      label={`Session ${shortId(session.session)}`}
      title={shortId(session.session)}
      mono
      subtitle={`${session.project} · ${shortModel(session.model)} · ${when(session.first_ts)}`}
      onClose={onClose}
    >
      <DrawerFacts
        items={[
          ['Cost', session.unpriced === session.rounds ? '—' : money(session.cost)],
          ['Rounds', `${count(session.rounds)} · ${session.tasks} ${session.tasks === 1 ? 'task' : 'tasks'}`],
          ['Served from cache', session.cache_share === null ? '—' : percent(session.cache_share)],
          ['Failed calls', `${session.errors} of ${count(session.tool_calls)}`, session.errors > 0],
          ['Working', duration(session.active_ms)],
          ['Elapsed', duration(session.elapsed_ms)],
        ]}
      />

      <div className="drawer-sec">
        <h4>Trace</h4>
        {trace === null ? (
          <div className="thumb" aria-hidden />
        ) : (
          <div className="thumb" role="img" aria-label={`${trace.rounds.length} rounds, coloured by the kind of work each was`}>
            {trace.rounds.map((round) => {
              const style = styleOf(round.dominant?.category)
              const size = round.context_tokens ?? round.in_tokens ?? 0
              return (
                <i
                  key={`${round.session}/${round.round}`}
                  className={style.hatched === true ? 'hatch' : undefined}
                  style={{
                    height: `${Math.max(8, (size / peak) * 100)}%`,
                    background: style.hatched === true ? undefined : style.fill,
                  }}
                />
              )
            })}
          </div>
        )}
      </div>

      <div className="drawer-sec">
        <h4>Work mix · share of cost</h4>
        {mix.length === 0 ? (
          <p className="note">No priced round in this session called a tool.</p>
        ) : (
          <>
            <ShareStack parts={mix} to={(key) => scoped('/sessions', scope, { category: key })} />
            <div className="chart-legend">
              {mix
                .filter((part) => part.share >= 0.1)
                .sort((a, b) => b.share - a.share)
                .map((part) => (
                  <span key={part.key}>
                    {part.label} {percent(part.share)}
                  </span>
                ))}
            </div>
          </>
        )}
      </div>

      <div className="drawer-sec">
        <h4>Costliest questions</h4>
        {questions === null ? (
          <p className="note">Reading…</p>
        ) : questions.length === 0 ? (
          <p className="note">This session asked nothing of the code.</p>
        ) : (
          questions.map((question) => (
            <a
              key={`${question.task}/${question.at}`}
              className="qrow"
              {...linkProps(href.task(session.slug, session.session, question.task, undefined, null, question.at))}
            >
              <span>
                {question.repeats > 0 ? <span className="bad">↺ ×{question.repeats} </span> : null}
                {question.terms.length === 0 ? <span className="muted">{question.ref}</span> : question.terms.join(' ')}
              </span>
              <strong className="num">{money(question.cost)}</strong>
            </a>
          ))
        )}
      </div>

      <button type="button" className="primary" onClick={() => go(href.session(session.slug, session.session))}>
        Open trace →
      </button>
    </Drawer>
  )
}
