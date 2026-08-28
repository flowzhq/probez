import { api } from '../api'
import type { SearchHit, SearchPayload } from '../api'
import { styleOf } from '../categories'
import { Chrome, Facts, Info, Loading, Problem } from '../components/Chrome'
import { ENTITY_LABEL } from '../components/SearchBar'
import { SourceTag } from '../components/SourceMarks'
import { MixBar } from '../components/WorkBars'
import { ago, clip, count, duration, money, percent, shortId, when } from '../format'
import { go, href, linkProps } from '../router'
import type { Entity } from '../router'
import { useData } from '../useData'
import type { ReactElement } from 'react'

/**
 * What a query came to.
 *
 * The strip above the table is the page. A search that answers with rows is a text box; the share
 * is what makes it a reading of the profile — four rounds is a count, 2.8% of what this project
 * cost is a finding. So the totals, the concentration and the distribution come first, and the
 * rows are what you look at once you know how much of anything you are looking at.
 *
 * Every row goes somewhere: a round to its task with itself selected, a session to its page, a
 * question or a trail to the panel that reads it. A result you cannot get out of is a dead end.
 */
export function Search({
  q,
  entity,
  slug,
  from,
}: {
  q: string
  /** What to count, when the URL says so. Null leaves it to the query's own `in:`. */
  entity: Entity | null
  slug: string | null
  /** The sentence this query was read from, when one was. A caption; the query is what ran. */
  from: string | null
}): ReactElement {
  const { data, error, loading } = useData(
    // `entity` is only sent when the URL named one. Sending a default would override an `in:` the
    // query itself carries, which is how a compiled query loses its own grouping.
    () => api.search(q, { slug, ...(entity === null ? {} : { entity }), limit: 200 }),
    [q, entity, slug],
  )

  const crumbs =
    slug === null
      ? [{ label: 'Search' }]
      : [{ label: data?.hits[0]?.project ?? slug, to: href.project(slug) }, { label: 'Search' }]

  return (
    <>
      <Chrome crumbs={crumbs} search={{ slug, initial: q, entity, mode: 'search' }} />
      <main className="page">
        {q.trim() === '' ? (
          <Empty />
        ) : error !== null && data === null ? (
          <Problem message={error} />
        ) : data === null ? (
          <Loading what="the store" />
        ) : (
          <div className={loading ? 'rereading' : undefined}>
            <div className="head">
              <h1 className="mono find-said">{data.query}</h1>
              {slug === null ? null : (
                <a className="chip" {...linkProps(href.search(q, { entity }))} title="Search every project instead">
                  in {data.hits[0]?.project ?? slug} ✕
                </a>
              )}
            </div>

            {from === null ? null : <ReadFrom from={from} q={q} slug={slug} />}
            <Diagnostics data={data} />

            {data.totals.rounds === 0 ? (
              <p className="note">
                Nothing matched. <code className="mono">probez --help</code> lists every field a
                query can name; a word on its own searches the prompts, the prose, the commands and
                the paths.
              </p>
            ) : (
              <>
                <Found data={data} />
                {/* Which tab is on comes from what actually ran, not from what the URL asked for:
                    a query carrying its own `in:` is grouped that way whether or not the URL says. */}
                <Tabs q={q} entity={data.entity} slug={slug} data={data} />
                <Rows data={data} />
                <Footer data={data} />
              </>
            )}
          </div>
        )}
      </main>
    </>
  )
}

function Empty(): ReactElement {
  return (
    <div className="note" style={{ maxWidth: '60ch' }}>
      <p>
        One query over everything collected. A word on its own searches the prompts, the prose, the
        commands and the paths; <code className="mono">key:value</code> filters;{' '}
        <code className="mono">-</code> negates; one after another means and.
      </p>
      <p className="mono" style={{ color: 'var(--ink-2)' }}>
        category:reconstruction cost:&gt;0.50 -tool:Read since:7d
      </p>
    </div>
  )
}

/**
 * The sentence a query was read from.
 *
 * A caption over the query, not a replacement for it. What ran is the query above — visible,
 * editable in the bar, and in the URL — so this result is re-runnable by anyone whether or not they
 * have a reader configured, and every number under it stays derived from the rounds. Which is the
 * whole reason the model is asked for a query rather than for an answer.
 */
function ReadFrom({ from, q, slug }: { from: string; q: string; slug: string | null }): ReactElement {
  return (
    <p className="read-from">
      <span className="read-mark" aria-hidden>
        ?
      </span>
      Read from “{from}”. The query above is what ran, and you can edit it.{' '}
      <a {...linkProps(href.search(q, { slug }))}>Drop the question</a>
    </p>
  )
}

/**
 * What could not be read, under the part of the query it is about.
 *
 * The spans point into the query as it was typed, so the query has to be on screen for the marks to
 * mean anything. None of this stops the rest of the query running.
 */
function Diagnostics({ data }: { data: SearchPayload }): ReactElement | null {
  if (data.diagnostics.length === 0) return null
  return (
    <div className="find-said-wrong">
      {data.diagnostics.map((problem, at) => (
        <p key={at}>
          <code className="mono">
            {data.query.slice(problem.at.from, problem.at.to) || data.query}
          </code>{' '}
          {problem.message}
          {problem.hint === undefined ? null : <span className="muted"> — {problem.hint}</span>}
        </p>
      ))}
    </div>
  )
}

/** The share, which is the answer. Everything under it is where the answer came from. */
function Found({ data }: { data: SearchPayload }): ReactElement {
  const { totals, scope, share } = data
  return (
    <>
      <Facts
        items={[
          ['rounds', count(totals.rounds)],
          [
            'of rounds',
            scope.rounds > totals.rounds ? percent(share.rounds, 1) : null,
            'How much of the searched projects these rounds are.',
          ],
          ['cost', totals.unpriced === totals.rounds ? null : money(totals.cost)],
          [
            'of cost',
            scope.cost > 0 && scope.rounds > totals.rounds ? percent(share.cost, 1) : null,
            'How much of what the searched projects cost this slice of them came to. It is not the same as the share of rounds, which is the point.',
          ],
          ['sessions', count(totals.sessions)],
          ['projects', totals.projects > 1 ? count(totals.projects) : null],
          ['tool errors', totals.errors > 0 ? count(totals.errors) : null],
          ['span', when(totals.first_ts, false) === '—' ? null : `${when(totals.first_ts, false)} – ${when(totals.last_ts, false)}`],
        ]}
      />
      {data.mix.length === 0 ? null : (
        <div className="find-mix">
          <MixBar mix={data.mix} />
          <span className="muted">
            {data.top === null ? null : (
              <>
                mostly {data.top.label.toLowerCase()} · {percent(data.top.share)}
              </>
            )}
          </span>
        </div>
      )}
    </>
  )
}

/** What the matched rounds are counted as. A session matches when a round inside it does. */
function Tabs({
  q,
  entity,
  slug,
  data,
}: {
  q: string
  entity: Entity
  slug: string | null
  data: SearchPayload
}): ReactElement {
  const shown: Entity[] = ['rounds', 'tasks', 'sessions', 'questions', 'trails']
  const all = data.totals.projects > 1 || entity === 'projects' ? [...shown, 'projects' as Entity] : shown
  return (
    <div className="toggle find-tabs" role="tablist">
      {all.map((one) => (
        <button
          key={one}
          role="tab"
          aria-pressed={one === entity}
          aria-selected={one === entity}
          onClick={() => go(href.search(q, { entity: one, slug }))}
        >
          {ENTITY_LABEL[one]}
        </button>
      ))}
    </div>
  )
}

function Rows({ data }: { data: SearchPayload }): ReactElement {
  const many = data.totals.projects > 1
  switch (data.entity) {
    case 'sessions':
      return <Sessions hits={data.hits} many={many} />
    case 'tasks':
      return <Tasks hits={data.hits} many={many} q={data.query} />
    case 'projects':
      return <Projects hits={data.hits} />
    case 'questions':
      return <Questions hits={data.hits} many={many} />
    case 'trails':
      return <Trails hits={data.hits} many={many} />
    default:
      return <Rounds hits={data.hits} many={many} q={data.query} />
  }
}

/**
 * Where a hit lives, when it has a slug to be addressed by. A hit without one is not a link.
 *
 * The query travels with the link, so the trace on the other side opens with the rounds it matched
 * lit and the rest of the task still drawn around them. Landing on a round with no idea which of
 * its neighbours also matched is most of the way to no answer at all.
 */
function toTask(hit: SearchHit, q: string): string | null {
  if (hit.slug === undefined || hit.session === undefined || hit.task === undefined) return null
  return href.task(hit.slug, hit.session, hit.task, hit.round, null, null, q)
}

function Project({ hit, many }: { hit: SearchHit; many: boolean }): ReactElement | null {
  if (!many) return null
  return (
    <td className="muted">
      {hit.slug === undefined ? hit.project : (
        <a {...linkProps(href.project(hit.slug))}>{hit.project}</a>
      )}
    </td>
  )
}

function Rounds({ hits, many, q }: { hits: SearchHit[]; many: boolean; q: string }): ReactElement {
  return (
    <table>
      <thead>
        <tr>
          {many ? <th>Project</th> : null}
          <th>Round</th>
          <th>Work</th>
          <th className="r">Cost</th>
          <th className="r">Time</th>
          <th className="r find-when">When</th>
          <th>Says</th>
        </tr>
      </thead>
      <tbody>
        {hits.map((hit, at) => {
          const to = toTask(hit, q)
          return (
            <tr
              key={at}
              className={to === null ? undefined : 'row'}
              onClick={to === null ? undefined : () => go(to)}
            >
              <Project hit={hit} many={many} />
              <td className="mono">
                {shortId(hit.session ?? '')}#{hit.task}.{hit.round}
              </td>
              <td>{hit.category === null || hit.category === undefined ? '·' : <Work id={hit.category} />}</td>
              <td className="r">{hit.cost === null || hit.cost === undefined ? '—' : money(hit.cost)}</td>
              <td className="r muted">{duration(hit.ms ?? null)}</td>
              <td className="r muted find-when">{ago(hit.ts ?? null)}</td>
              <td className="clip">
                {hit.says === '' || hit.says === undefined ? (
                  <span className="muted mono">{hit.tools}</span>
                ) : (
                  clip(hit.says, 90)
                )}
                {hit.errors !== undefined && hit.errors > 0 ? (
                  <span className="bad"> ✗{hit.errors}</span>
                ) : null}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/**
 * A category, drawn the way it is drawn everywhere else.
 *
 * The swatch is the point: the colour a category has in the bar above the table is the colour it
 * has in this column, so the two read as the same fact rather than as two lists that happen to
 * share words. `styleOf` is the one table both go through.
 */
function Work({ id }: { id: string }): ReactElement {
  const style = styleOf(id)
  return (
    <span className="work-of">
      <span
        className={style.hatched === true ? 'swatch hatch' : 'swatch'}
        style={style.hatched === true ? undefined : { background: style.fill }}
        aria-hidden
      />
      {style.label}
    </span>
  )
}

/**
 * A grouped row says what matched, with the size of the whole group beside it.
 *
 * `Of` is the column that keeps the number honest: six rounds of a seventy-one-round task is a
 * different finding from a seventy-one-round task, and a table that printed the whole task's cost
 * against a query it barely matched would read as the larger of the two.
 */
function Matched({ hit }: { hit: SearchHit }): ReactElement {
  return (
    <>
      <td className="r">{count(hit.rounds ?? 0)}</td>
      <td className="r muted">{count(hit.of ?? hit.rounds ?? 0)}</td>
    </>
  )
}

const OF = 'Rounds in the whole thing, of which the column to the left matched.'

function Sessions({ hits, many }: { hits: SearchHit[]; many: boolean }): ReactElement {
  return (
    <table>
      <thead>
        <tr>
          {many ? <th>Project</th> : null}
          <th>Session</th>
          <th className="r">Matched</th>
          <th className="r">
            Of<Info says={OF} />
          </th>
          <th className="r">Cost</th>
          <th className="r">Last</th>
        </tr>
      </thead>
      <tbody>
        {hits.map((hit, at) => {
          const to =
            hit.slug === undefined || hit.session === undefined
              ? null
              : href.session(hit.slug, hit.session)
          return (
            <tr key={at} className={to === null ? undefined : 'row'} onClick={to === null ? undefined : () => go(to)}>
              <Project hit={hit} many={many} />
              <td className="mono">
                {shortId(hit.session ?? '')}
                {hit.source !== undefined ? (
                  <>
                    {' '}
                    <SourceTag source={hit.source} />
                  </>
                ) : null}
              </td>
              <Matched hit={hit} />
              <td className="r">{hit.unpriced === hit.rounds ? '—' : money(hit.cost ?? 0)}</td>
              <td className="r muted">{ago(hit.last_ts ?? null)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function Tasks({ hits, many, q }: { hits: SearchHit[]; many: boolean; q: string }): ReactElement {
  return (
    <table>
      <thead>
        <tr>
          {many ? <th>Project</th> : null}
          <th>Task</th>
          <th className="r">Matched</th>
          <th className="r">
            Of<Info says={OF} />
          </th>
          <th className="r">Cost</th>
          <th>Asked</th>
        </tr>
      </thead>
      <tbody>
        {hits.map((hit, at) => {
          const to = toTask(hit, q)
          return (
            <tr key={at} className={to === null ? undefined : 'row'} onClick={to === null ? undefined : () => go(to)}>
              <Project hit={hit} many={many} />
              <td className="mono">
                {shortId(hit.session ?? '')}#{hit.task}
              </td>
              <Matched hit={hit} />
              <td className="r">{money(hit.cost ?? 0)}</td>
              <td className="clip">{clip(hit.asked ?? '', 90)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function Projects({ hits }: { hits: SearchHit[] }): ReactElement {
  return (
    <table>
      <thead>
        <tr>
          <th>Project</th>
          <th className="r">Matched</th>
          <th className="r">
            Of<Info says={OF} />
          </th>
          <th className="r">Sessions</th>
          <th className="r">Cost</th>
          <th className="r">Last</th>
        </tr>
      </thead>
      <tbody>
        {hits.map((hit, at) => (
          <tr
            key={at}
            className={hit.slug === undefined ? undefined : 'row'}
            onClick={hit.slug === undefined ? undefined : () => go(href.project(hit.slug!))}
          >
            <td>{hit.project}</td>
            <Matched hit={hit} />
            <td className="r">{count(hit.sessions ?? 0)}</td>
            <td className="r">{hit.unpriced === hit.rounds ? '—' : money(hit.cost ?? 0)}</td>
            <td className="r muted">{ago(hit.last_ts ?? null)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Questions({ hits, many }: { hits: SearchHit[]; many: boolean }): ReactElement {
  return (
    <table>
      <thead>
        <tr>
          {many ? <th>Project</th> : null}
          <th>Question</th>
          <th>Kind</th>
          <th className="r">Calls</th>
          <th className="r">Again</th>
          <th>Asked about</th>
        </tr>
      </thead>
      <tbody>
        {hits.map((hit, at) => {
          const to =
            hit.slug === undefined || hit.session === undefined || hit.task === undefined
              ? null
              : href.task(hit.slug, hit.session, hit.task, undefined, null, hit.at ?? null)
          return (
            <tr key={at} className={to === null ? undefined : 'row'} onClick={to === null ? undefined : () => go(to)}>
              <Project hit={hit} many={many} />
              <td className="mono">
                {shortId(hit.session ?? '')}#{hit.ref}
              </td>
              <td>{hit.kind}</td>
              <td className="r">{count(hit.calls ?? 0)}</td>
              <td className="r muted">{count(hit.repeats ?? 0)}</td>
              <td className="clip mono">{clip((hit.terms ?? []).join(' '), 60)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function Trails({ hits, many }: { hits: SearchHit[]; many: boolean }): ReactElement {
  return (
    <table>
      <thead>
        <tr>
          {many ? <th>Project</th> : null}
          <th>Trail</th>
          <th className="r">Depth</th>
          <th className="r">Wide</th>
          <th className="r">Steps</th>
          <th>Outcome</th>
          <th className="r">Time</th>
        </tr>
      </thead>
      <tbody>
        {hits.map((hit, at) => {
          const to =
            hit.slug === undefined || hit.session === undefined || hit.task === undefined
              ? null
              : href.task(hit.slug, hit.session, hit.task, undefined, hit.ref ?? null)
          return (
            <tr key={at} className={to === null ? undefined : 'row'} onClick={to === null ? undefined : () => go(to)}>
              <Project hit={hit} many={many} />
              <td className="mono">
                {shortId(hit.session ?? '')}#{hit.ref}
              </td>
              <td className="r">{hit.depth}</td>
              <td className="r">{hit.breadth}</td>
              <td className="r">{hit.steps}</td>
              <td>{hit.outcome}</td>
              <td className="r muted">{duration(hit.ms ?? null)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/**
 * What was withheld, and how the answer was arrived at.
 *
 * The second half is not housekeeping: the same query is an order of magnitude quicker against a
 * project with a current index, and being told is the only way to know which you got.
 */
function Footer({ data }: { data: SearchPayload }): ReactElement {
  const noun = data.entity.replace(/s$/, '')
  return (
    <p className="note">
      {data.hits.length < data.found
        ? `Showing ${count(data.hits.length)} of ${count(data.found)} ${noun}s.`
        : `${count(data.found)} ${noun}${data.found === 1 ? '' : 's'}.`}
      {data.totals.unpriced > 0 ? (
        <>
          {' '}
          {count(data.totals.unpriced)} round{data.totals.unpriced === 1 ? '' : 's'} have no rate for
          their model and are outside Cost.
        </>
      ) : null}
      {data.scanned.read > 0 ? (
        <>
          {' '}
          {count(data.scanned.read)} project{data.scanned.read === 1 ? ' was' : 's were'} read in
          full for want of a current search index; Sync builds one.
        </>
      ) : null}
    </p>
  )
}
