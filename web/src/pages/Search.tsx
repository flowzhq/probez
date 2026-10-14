import { api } from '../api'
import type { SearchHit, SearchPayload } from '../api'
import { styleOf } from '../categories'
import { Chrome, Facts, Info, Loading, Problem } from '../components/Chrome'
import { ENTITY_LABEL } from '../components/SearchBar'
import { SourceTag } from '../components/SourceMarks'
import { instant, naturalFor, ordered, SortHead, useSort } from '../components/SortHead'
import { MixBar } from '../components/WorkBars'
import { ago, clip, count, duration, money, percent, shortId, when } from '../format'
import { go, href, linkProps } from '../router'
import type { Entity } from '../router'
import { useData } from '../useData'
import { useDebug } from '../meta'
import { useEffect } from 'react'
import type { KeyboardEvent, ReactElement, ReactNode } from 'react'

/**
 * Queries worth running before you know the language, each one a link. Reading an example and
 * retyping it is a step a search page has no reason to make you take.
 */
const EXAMPLES: Array<[query: string, says: string]> = [
  ['is:error since:7d', 'rounds with a failed tool call this week'],
  ['sort:cost since:7d', 'the most expensive rounds this week'],
  ['category:reconstruction cost:>0.50 -tool:Read', 'costly re-reading that was not a file read'],
  ['(tool:Edit OR tool:Write) added:>200 in:tasks', 'tasks that wrote a lot of code'],
]

/**
 * A table row that goes somewhere, reachable by keyboard as well as by mouse.
 *
 * The row is the target rather than a link inside one cell, so the whole width stays clickable;
 * that leaves it to the row to take focus and answer Enter, or a keyboard has no way into a result.
 */
function rowTo(to: string | null): {
  className?: string
  tabIndex?: number
  onClick?: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLTableRowElement>) => void
} {
  if (to === null) return {}
  return {
    className: 'row',
    tabIndex: 0,
    onClick: () => go(to),
    onKeyDown: (event) => {
      if (event.key === 'Enter' && event.target === event.currentTarget) {
        event.preventDefault()
        go(to)
      }
    },
  }
}

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
}: {
  q: string
  /** What to count, when the URL says so. Null leaves it to the query's own `in:`. */
  entity: Entity | null
  slug: string | null
}): ReactElement {
  const { data, error, loading } = useData(
    // `entity` is only sent when the URL named one. Sending a default would override an `in:` the
    // query itself carries, which is how a linked query would lose its own grouping.
    // An empty box is the page explaining itself, which is where the menu's Explorer lands; there
    // is nothing to ask the server for, and it would refuse an empty query anyway.
    () =>
      q.trim() === ''
        ? Promise.resolve(null)
        : api.search(q, { slug, ...(entity === null ? {} : { entity }), limit: 200 }),
    [q, entity, slug],
  )

  // The query names the tab and the history entry, so a list of searches in either is readable.
  useEffect(() => {
    const was = document.title
    document.title = q.trim() === '' ? 'Search · probez' : `${q.trim()} · probez`
    return () => {
      document.title = was
    }
  }, [q])

  const status =
    q.trim() === ''
      ? ''
      : data === null
        ? error === null
          ? 'Searching'
          : ''
        : loading
          ? 'Searching'
          : data.totals.rounds === 0
            ? 'Nothing matched'
            : `${count(data.found)} ${data.entity.replace(/s$/, '')}${data.found === 1 ? '' : 's'} matched`

  const crumbs =
    slug === null
      ? [{ label: 'Investigate' }, { label: 'Explorer' }]
      : [
          { label: 'Investigate' },
          { label: data?.hits[0]?.project ?? slug, to: href.project(slug) },
          { label: 'Explorer' },
        ]

  return (
    <>
      <Chrome crumbs={crumbs} search={{ slug, initial: q, entity, mode: 'search' }} />
      <main className="page">
        {/* The page swaps under a screen reader without saying so; this is what says so. */}
        <p className="sr-only" role="status" aria-live="polite">
          {status}
        </p>
        {q.trim() === '' ? (
          <Empty slug={slug} />
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

            <Diagnostics data={data} />

            {data.totals.rounds === 0 ? (
              <div className="note">
                <p>
                  Nothing matched. A word on its own matches a word or the start of one, so{' '}
                  <code className="mono">tok</code> finds <code className="mono">tokens</code> but{' '}
                  <code className="mono">oken</code> does not. Click into the search box with it
                  empty to see every field a query can name, or{' '}
                  <code className="mono">probez --help</code> for the full list.
                </p>
                {slug === null ? null : (
                  <p>
                    <a {...linkProps(href.search(q, { entity }))}>Try every project instead</a>
                  </p>
                )}
              </div>
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

function Empty({ slug }: { slug: string | null }): ReactElement {
  return (
    <div className="note" style={{ maxWidth: '60ch' }}>
      <p>
        One query over everything collected. A word on its own searches the prompts, the prose, the
        commands and the paths; <code className="mono">key:value</code> filters;{' '}
        <code className="mono">-</code> negates; one after another means and;{' '}
        <code className="mono">OR</code> and brackets regroup. Press <kbd className="find-key">/</kbd>{' '}
        to start typing, or try one of these:
      </p>
      <ul className="find-try">
        {EXAMPLES.map(([query, says]) => (
          <li key={query}>
            <a {...linkProps(href.search(query, { slug }))} title={says}>
              {query}
            </a>
          </li>
        ))}
      </ul>
    </div>
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
  // Questions and trails are counted under `probez view --debug` only. See src/debug.ts.
  const debug = useDebug()
  const shown: Entity[] = debug ? ['rounds', 'tasks', 'sessions', 'questions', 'trails'] : ['rounds', 'tasks', 'sessions']
  const all = data.totals.projects > 1 || entity === 'projects' ? [...shown, 'projects' as Entity] : shown
  // Arrow keys move between tabs, as they do in any tablist; only the selected tab is in the Tab
  // order, so getting past the row takes one keystroke rather than six.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const next = all[(all.indexOf(entity) + step + all.length) % all.length]!
    const tabs = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    tabs[all.indexOf(next)]?.focus()
    go(href.search(q, { entity: next, slug }))
  }
  return (
    <div className="toggle find-tabs" role="tablist" aria-label="Count matches as" onKeyDown={onKeyDown}>
      {all.map((one) => (
        <button
          key={one}
          type="button"
          role="tab"
          aria-selected={one === entity}
          tabIndex={one === entity ? 0 : -1}
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

/** Every column any results table has. Each table sorts by the ones it shows. */
type HitSort =
  | 'project'
  | 'id'
  | 'work'
  | 'cost'
  | 'time'
  | 'when'
  | 'says'
  | 'matched'
  | 'of'
  | 'last'
  | 'asked'
  | 'sessions'
  | 'kind'
  | 'calls'
  | 'again'
  | 'about'
  | 'depth'
  | 'wide'
  | 'steps'
  | 'outcome'

const hitNatural = naturalFor<HitSort>('project', 'id', 'work', 'says', 'asked', 'kind', 'about', 'outcome')

/**
 * What a results column sorts by: the figure the cell shows. A cell showing a dash is null, so it
 * sorts after every measured row whichever way the arrow points.
 */
function hitValue(hit: SearchHit, key: HitSort): number | string | null {
  switch (key) {
    case 'project':
      return hit.project
    case 'id':
      return `${hit.session ?? ''}#${hit.task ?? ''}.${hit.round ?? hit.ref ?? ''}`
    case 'work':
      return hit.category === null || hit.category === undefined ? null : styleOf(hit.category).label
    case 'cost':
      return hit.cost === null || hit.cost === undefined || hit.unpriced === hit.rounds ? null : hit.cost
    case 'time':
      return hit.ms ?? null
    case 'when':
      return instant(hit.ts)
    case 'says':
      return hit.says === '' || hit.says === undefined ? (hit.tools ?? null) : hit.says
    case 'matched':
      return hit.rounds ?? 0
    case 'of':
      return hit.of ?? hit.rounds ?? 0
    case 'last':
      return instant(hit.last_ts)
    case 'asked':
      return hit.asked === '' ? null : (hit.asked ?? null)
    case 'sessions':
      return hit.sessions ?? 0
    case 'kind':
      return hit.kind ?? null
    case 'calls':
      return hit.calls ?? 0
    case 'again':
      return hit.repeats ?? 0
    case 'about':
      return (hit.terms ?? []).length === 0 ? null : (hit.terms ?? []).join(' ')
    case 'depth':
      return hit.depth ?? null
    case 'wide':
      return hit.breadth ?? null
    case 'steps':
      return hit.steps ?? null
    case 'outcome':
      return hit.outcome ?? null
  }
}

/**
 * The hits in the order a heading says, and the headings that say it.
 *
 * Sorting a page of results reorders that page, not the query: what was found, and which of it is
 * shown when there is more than fits, is still the query's to decide — `sort:` in the bar is how
 * to ask for it.
 */
function useHitSort(hits: SearchHit[]): {
  rows: SearchHit[]
  head: (label: string, key: HitSort, className?: string, after?: ReactNode) => ReactElement
} {
  const [sorted, sortBy] = useSort<HitSort>(hitNatural)
  return {
    rows: ordered(hits, sorted, hitValue),
    head: (label, key, className, after) => (
      <SortHead label={label} head={key} sorted={sorted} onSort={sortBy} className={className} after={after} />
    ),
  }
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
  const { rows, head } = useHitSort(hits)
  return (
    <table>
      <thead>
        <tr>
          {many ? head('Project', 'project') : null}
          {head('Round', 'id')}
          {head('Work', 'work')}
          {head('Cost', 'cost', 'r')}
          {head('Time', 'time', 'r')}
          {head('When', 'when', 'r find-when')}
          {head('Says', 'says')}
        </tr>
      </thead>
      <tbody>
        {rows.map((hit, at) => {
          const to = toTask(hit, q)
          return (
            <tr key={at} {...rowTo(to)}>
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
  const { rows, head } = useHitSort(hits)
  return (
    <table>
      <thead>
        <tr>
          {many ? head('Project', 'project') : null}
          {head('Session', 'id')}
          {head('Matched', 'matched', 'r')}
          {head('Of', 'of', 'r', <Info says={OF} />)}
          {head('Cost', 'cost', 'r')}
          {head('Last', 'last', 'r')}
        </tr>
      </thead>
      <tbody>
        {rows.map((hit, at) => {
          const to =
            hit.slug === undefined || hit.session === undefined
              ? null
              : href.session(hit.slug, hit.session)
          return (
            <tr key={at} {...rowTo(to)}>
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
  const { rows, head } = useHitSort(hits)
  return (
    <table>
      <thead>
        <tr>
          {many ? head('Project', 'project') : null}
          {head('Task', 'id')}
          {head('Matched', 'matched', 'r')}
          {head('Of', 'of', 'r', <Info says={OF} />)}
          {head('Cost', 'cost', 'r')}
          {head('Asked', 'asked')}
        </tr>
      </thead>
      <tbody>
        {rows.map((hit, at) => {
          const to = toTask(hit, q)
          return (
            <tr key={at} {...rowTo(to)}>
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
  const { rows, head } = useHitSort(hits)
  return (
    <table>
      <thead>
        <tr>
          {head('Project', 'project')}
          {head('Matched', 'matched', 'r')}
          {head('Of', 'of', 'r', <Info says={OF} />)}
          {head('Sessions', 'sessions', 'r')}
          {head('Cost', 'cost', 'r')}
          {head('Last', 'last', 'r')}
        </tr>
      </thead>
      <tbody>
        {rows.map((hit, at) => (
          <tr key={at} {...rowTo(hit.slug === undefined ? null : href.project(hit.slug))}>
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
  const { rows, head } = useHitSort(hits)
  return (
    <table>
      <thead>
        <tr>
          {many ? head('Project', 'project') : null}
          {head('Question', 'id')}
          {head('Kind', 'kind')}
          {head('Calls', 'calls', 'r')}
          {head('Again', 'again', 'r')}
          {head('Asked about', 'about')}
        </tr>
      </thead>
      <tbody>
        {rows.map((hit, at) => {
          const to =
            hit.slug === undefined || hit.session === undefined || hit.task === undefined
              ? null
              : href.task(hit.slug, hit.session, hit.task, undefined, null, hit.at ?? null)
          return (
            <tr key={at} {...rowTo(to)}>
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
  const { rows, head } = useHitSort(hits)
  return (
    <table>
      <thead>
        <tr>
          {many ? head('Project', 'project') : null}
          {head('Trail', 'id')}
          {head('Depth', 'depth', 'r')}
          {head('Wide', 'wide', 'r')}
          {head('Steps', 'steps', 'r')}
          {head('Outcome', 'outcome')}
          {head('Time', 'time', 'r')}
        </tr>
      </thead>
      <tbody>
        {rows.map((hit, at) => {
          const to =
            hit.slug === undefined || hit.session === undefined || hit.task === undefined
              ? null
              : href.task(hit.slug, hit.session, hit.task, undefined, hit.ref ?? null)
          return (
            <tr key={at} {...rowTo(to)}>
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
