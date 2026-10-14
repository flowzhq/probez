import { useCallback, useState } from 'react'

import { api } from '../api'
import { Actions } from '../components/Actions'
import { Chrome, Facts, Info, Loading, Problem } from '../components/Chrome'
import { instant, naturalFor, ordered, SortHead, useSort } from '../components/SortHead'
import { OpenInExplorer } from '../components/OpenInExplorer'
import { ProjectDrawer } from '../components/ProjectDrawer'
import { forgetProjectList } from '../components/ScopeBar'
import { SourceMarks } from '../components/SourceMarks'
import { TokenCells, TokenHeaders } from '../components/Tokens'
import type { TokenSplit } from '../components/Tokens'
import { MixBar, mostlyUnpriced, UnpricedMark } from '../components/WorkBars'
import { ago, count, money, percent, tokens } from '../format'
import { href, linkProps } from '../router'
import type { SourceChoice } from '../router'
import { SOURCE_LABEL } from '../source'
import { useData } from '../useData'
import type { ProjectsPayload, StoredProject } from '../api'
import type { ReactElement } from 'react'

/** What the projects table can be ordered by, which is every column it has. */
type SortKey =
  | 'name'
  | 'cost'
  | 'share'
  | 'input'
  | 'cache'
  | 'work'
  | 'sessions'
  | 'tasks'
  | 'rounds'
  | keyof TokenSplit
  | 'activity'
  | 'updated'

const projectNatural = naturalFor<SortKey>('name', 'work')

/**
 * When probez last read this project, which is a different fact from when the work happened.
 *
 * An imported project was measured on somebody else's machine and never collected on this one, so
 * the date that means "when this row last changed" is the import rather than a collection that
 * never happened. Same rule the project page states under the title.
 */
function updatedAt(project: StoredProject): string | null {
  return project.imported_at ?? project.collected_at
}

/**
 * What a column sorts by. A project with no date sorts last whichever way the column points: an
 * unknown date is not an old one. Work sorts by the kind of work the project mostly was.
 */
function projectValue(project: ProjectsPayload['projects'][number], key: SortKey): number | string | null {
  switch (key) {
    case 'name':
      return project.project
    case 'cost':
    case 'share':
      return project.unpriced === project.rounds ? null : project.cost
    case 'input':
      return project.in_tokens
    case 'cache':
      return project.in_tokens > 0 ? project.in_cache_read / project.in_tokens : null
    case 'work':
      return project.work?.short ?? null
    case 'sessions':
      return project.sessions
    case 'tasks':
      return project.tasks
    case 'rounds':
      return project.rounds
    case 'activity':
      return instant(project.last_ts)
    case 'updated':
      return instant(updatedAt(project))
    default:
      return project[key]
  }
}

/**
 * Every project in the store.
 *
 * These come from the store's own manifests rather than from the agent's session directory, so a
 * project stays readable after the sessions it was collected from are gone. What is recorded is
 * recorded.
 */
export function Projects({ source = null }: { source?: SourceChoice | null }): ReactElement {
  const [read, setRead] = useState(0)
  const { data, error, loading } = useData(() => api.projects(source), [read, source])
  // Syncing, renaming, deleting and importing all change what this list is. One list, one re-read.
  const reread = (): void => setRead(read + 1)

  // Newest activity first, which is the order the store already hands them over in — so the first
  // paint is the same list it has always been, and sorting is something you go and ask for.
  const [sorted, orderBy] = useSort<SortKey>(projectNatural, { key: 'activity', dir: 'desc' })
  // The same two column sets the Sessions list offers, and the same remembered choice.
  const [preset, setPreset] = useState<'cost' | 'tokens'>(() => {
    try {
      return window.localStorage.getItem('probez.columns') === 'tokens' ? 'tokens' : 'cost'
    } catch {
      return 'cost'
    }
  })
  const choose = (next: 'cost' | 'tokens'): void => {
    setPreset(next)
    try {
      window.localStorage.setItem('probez.columns', next)
    } catch {
      // Remembering is a convenience; without storage the choice lasts the page.
    }
  }
  const spent = data === null ? 0 : data.projects.reduce((sum, project) => sum + project.cost, 0)
  // A row opens the drawer; the project's name is the link that leaves the list.
  const [selected, setSelected] = useState<string | null>(null)
  const close = useCallback(() => setSelected(null), [])
  const chosen = selected === null ? null : (data?.projects.find((project) => project.slug === selected) ?? null)

  return (
    <>
      <Chrome crumbs={[{ label: 'Investigate' }, { label: 'Projects' }]} search={{ source }} scope="agent" />
      <main className="page">
        {error !== null && data === null ? (
          <Problem message={error} />
        ) : data === null ? (
          <Loading what="the store" />
        ) : (
          <div className={loading ? 'rereading' : undefined}>
            <div className="head">
              <h1>Projects</h1>
              <span className="muted mono clip">{data.data_dir}</span>
            </div>
            <div className="fbar" style={{ justifyContent: 'space-between' }}>
              <OpenInExplorer scope={{ range: 'all', source, project: null, committer: null }} entity="projects" />
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
            <Facts
              items={[
                ['spent', money(spent) === '·' ? '$0' : money(spent)],
                ['projects', count(data.projects.length)],
                ['sessions', count(data.projects.reduce((n, p) => n + p.sessions, 0))],
                ['rounds', count(data.projects.reduce((n, p) => n + p.rounds, 0))],
              ]}
            />

            <section>
              {/* Column headings over nothing describe a table that is not there. */}
              {data.projects.length === 0 ? null : (
                <table>
                  <thead>
                    <tr>
                      <SortHead label="Project" head="name" sorted={sorted} onSort={orderBy} style={{ minWidth: 200 }} />
                      <SortHead
                        label="Cost"
                        head="cost"
                        sorted={sorted}
                        onSort={orderBy}
                        className="r"
                        title="What every round of the project cost, at the rates in Settings"
                      />
                      {preset === 'cost' ? (
                        <>
                          <SortHead label="Share" head="share" sorted={sorted} onSort={orderBy} className="r" title="Share of the spend across every project listed" />
                          <SortHead label="Sessions" head="sessions" sorted={sorted} onSort={orderBy} className="r" />
                          <SortHead label="Rounds" head="rounds" sorted={sorted} onSort={orderBy} className="r" />
                          <SortHead label="Input" head="input" sorted={sorted} onSort={orderBy} className="r" title="All input tokens, cached and not" />
                          <SortHead label="Cache" head="cache" sorted={sorted} onSort={orderBy} className="r" title="Share of input served from the cache" />
                          <SortHead label="Output" head="out_tokens" sorted={sorted} onSort={orderBy} className="r" />
                        </>
                      ) : (
                        <TokenHeaders sorted={sorted} onSort={orderBy} />
                      )}
                      <SortHead
                        label="Work"
                        head="work"
                        sorted={sorted}
                        onSort={orderBy}
                        style={{ width: '22%' }}
                        title="Sorts by the kind of work the project mostly was"
                        after={
                          <>
                            {' '}
                            <Info says="The bar is the mix of work by rounds. Under it is the largest of those, and what it cost: the share the project page shows in its Share column, at the rates in Settings." />
                          </>
                        }
                      />
                      {/* Two dates, and they answer different questions. One is when the work
                          happened; the other is when probez last went and looked, which is a fact
                          about probez rather than about the work. Both are here because "which of
                          these have I not synced lately" is a question about the second one, and it
                          could not be asked of a column that was not on the page. */}
                      <SortHead
                        label="Last activity"
                        head="activity"
                        sorted={sorted}
                        onSort={orderBy}
                        className="r"
                        title="When the most recent round in this project ran"
                      />
                      <SortHead
                        label="Updated"
                        head="updated"
                        sorted={sorted}
                        onSort={orderBy}
                        className="r"
                        title="When probez last read this project: collected here, or imported from a file"
                      />
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {ordered(data.projects, sorted, projectValue).map((project) => (
                      <tr
                        key={project.slug}
                        tabIndex={0}
                        className={selected === project.slug ? 'row sel' : 'row'}
                        aria-selected={selected === project.slug}
                        onClick={() => setSelected(project.slug)}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget) return
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            setSelected(project.slug)
                          }
                        }}
                      >
                        <td>
                          <a {...linkProps(href.project(project.slug, source))}>
                            <strong>{project.project}</strong>
                          </a>
                          {/* An import was measured on somebody else's machine. The row carries its
                              numbers with no other sign of that, so the row says it. */}
                          {project.imported_at === null ? null : (
                            <span className="mark" title="Arrived as a file someone exported">
                              imported
                            </span>
                          )}
                          {project.darkened_at === null ? null : (
                            <span
                              className="mark"
                              title="It was darkened on the way out of the store it came from: these figures are real, the words behind them were replaced"
                            >
                              darkened
                            </span>
                          )}
                          {/* Work merged in from another machine sits in these numbers beside this
                              machine's own, so the row names whose it is. */}
                          {(project.committers ?? []).length === 0 ? null : (
                            <span
                              className="mark"
                              title={`Holds work merged in from another computer: ${(project.committers ?? []).join(', ')}. Filter to one person's with the Committer chip.`}
                            >
                              + {(project.committers ?? []).join(', ')}
                            </span>
                          )}
                          <SourceMarks sources={project.sources} />
                          <div className="muted mono clip" style={{ fontSize: 11, maxWidth: 320 }}>
                            {project.path ?? project.key}
                          </div>
                        </td>
                        <td
                          className="r num"
                          title={
                            project.unpriced === 0
                              ? undefined
                              : `${count(project.unpriced)} of ${count(project.rounds)} rounds have no rate for their model and are outside this`
                          }
                        >
                          {project.unpriced === project.rounds ? (
                            <span className="muted">—</span>
                          ) : (
                            <strong>
                              {money(project.cost)}
                              {project.unpriced > 0 ? <span className="muted">+</span> : null}
                            </strong>
                          )}
                        </td>
                        {preset === 'cost' ? (
                          <>
                            <td className="r num dim">{spent > 0 && project.cost > 0 ? percent(project.cost / spent, 1) : '—'}</td>
                            <td className="r num">{project.sessions}</td>
                            <td className="r num">{count(project.rounds)}</td>
                            <td className="r num dim">{tokens(project.in_tokens)}</td>
                            <td className="r num dim">
                              {project.in_tokens > 0 ? percent(project.in_cache_read / project.in_tokens) : '—'}
                            </td>
                            <td className="r num dim">{tokens(project.out_tokens)}</td>
                          </>
                        ) : (
                          <TokenCells of={project} />
                        )}
                        <td>
                          <MixBar mix={project.mix} />
                          {/* The bar is the mix by rounds and the share under it is of money, the
                              same split the project page draws — so the number here is the one the
                              Share column there will show, to the same decimal. Two marks, in the
                              order the page's own header uses them: a project nothing prices has no
                              money to divide and its share is of the rounds, and one where the
                              money covers less than half the work says how much it covers. Either
                              way the row says what its percentage is a percentage of, because the
                              row above and below it may be answering a different question. */}
                          <div className="muted nowrap" style={{ fontSize: 11, marginTop: 3 }}>
                            {project.work === null ? (
                              'no tool calls'
                            ) : (
                              <>
                                {project.work.short} {percent(project.work.share, 1)}
                                {project.work.basis === 'rounds' ? (
                                  <>
                                    {' '}
                                    <Info
                                      // "here" rather than "in this project", because a source
                                      // filter is in force half the time and the rounds it left
                                      // out may well be priced.
                                      says="No round here has a priced model, so there is no cost to divide. This is a share of the classified rounds instead — of how much work the category was, not of what it cost. Set a rate under Settings to get a share of money."
                                      aria="Share of rounds, not of cost: no round here has a priced model."
                                    />
                                  </>
                                ) : mostlyUnpriced(project.work.unpriced, project.work.classified) ? (
                                  <>
                                    {' '}
                                    <UnpricedMark
                                      unpriced={project.work.unpriced}
                                      classified={project.work.classified}
                                    />
                                  </>
                                ) : null}
                              </>
                            )}
                          </div>
                        </td>
                        <td className="r muted nowrap">{ago(project.last_ts)}</td>
                        <td className="r muted nowrap" title={updatedAt(project) ?? undefined}>
                          {ago(updatedAt(project))}
                        </td>
                        <td className="r">
                          <Actions
                            slug={project.slug}
                            project={project.project}
                            renamed={project.renamed}
                            rounds={source === null ? project.rounds : null}
                            compact
                            onSynced={reread}
                            onRenamed={reread}
                            onRemoved={() => {
                              forgetProjectList()
                              reread()
                            }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {data.projects.length === 0 ? (
                <p className="note" style={{ marginTop: 16 }}>
                  {source === null ? (
                    <>
                      Nothing here yet. Run <span className="mono">probez collect</span> in a project
                      you work in, then reload — or <a {...linkProps('/import')}>import</a> a project someone sent you.
                    </>
                  ) : (
                    <>
                      No project in this store has{' '}
                      {SOURCE_LABEL[source]}{' '}
                      sessions.
                    </>
                  )}
                </p>
              ) : null}
            </section>
            {chosen === null ? null : (
              <ProjectDrawer key={chosen.slug} project={chosen} spent={spent} source={source} onClose={close} />
            )}
          </div>
        )}
      </main>
    </>
  )
}
