import { useState } from 'react'

import { api } from '../api'
import { Actions } from '../components/Actions'
import { Chrome, Facts, Info, Loading, Problem } from '../components/Chrome'
import { Import } from '../components/Import'
import { SourceMarks } from '../components/SourceMarks'
import { TokenCells, TokenHeaders } from '../components/Tokens'
import { MixBar, mostlyUnpriced, UnpricedMark } from '../components/WorkBars'
import { ago, count, percent } from '../format'
import { go, href, linkProps } from '../router'
import type { SourceChoice } from '../router'
import { useData } from '../useData'
import type { StoredProject } from '../api'
import type { CSSProperties, ReactElement } from 'react'

/** What the projects table can be ordered by. */
type SortKey = 'name' | 'activity' | 'updated'

type Direction = 'asc' | 'desc'

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
 * The rows in the order the headings say.
 *
 * A project with no date sorts last whichever way the column points: an unknown date is not an old
 * one, and turning the arrow around should not march the blanks to the top. Ties fall back to the
 * name, so the same store lists in the same order on every render.
 */
function ordered<T extends StoredProject>(projects: T[], sort: SortKey, dir: Direction): T[] {
  const byName = (a: T, b: T): number =>
    a.project.localeCompare(b.project, undefined, { sensitivity: 'base', numeric: true })
  const dateOf = sort === 'activity' ? (one: T) => one.last_ts : updatedAt
  const flip = dir === 'asc' ? 1 : -1

  return [...projects].sort((a, b) => {
    if (sort === 'name') return flip * byName(a, b)
    const left = dateOf(a)
    const right = dateOf(b)
    if (left === null || right === null) {
      return left === right ? byName(a, b) : left === null ? 1 : -1
    }
    // ISO 8601 to the same precision, so comparing the text is comparing the instant — which is how
    // the store already orders these before it hands them over.
    return flip * left.localeCompare(right) || byName(a, b)
  })
}

/**
 * A column heading that sorts.
 *
 * The button *is* the heading rather than sitting beside it, so the target is the word a person is
 * already reading and the keyboard reaches it for free. `aria-sort` on the cell is what says which
 * column is in force and which way it points.
 */
function SortHead({
  label,
  head,
  sort,
  dir,
  onSort,
  className,
  style,
  title,
}: {
  label: string
  head: SortKey
  sort: SortKey
  dir: Direction
  onSort: (key: SortKey) => void
  className?: string
  style?: CSSProperties
  title?: string
}): ReactElement {
  const active = sort === head
  return (
    <th
      className={className}
      style={style}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button type="button" className="sort" onClick={() => onSort(head)} title={title}>
        {label}
        {/* Only the column actually in force carries a caret. Three greyed-out arrows read as three
            sorts at once, and the one that is doing the work stops standing out. */}
        <span className="caret" aria-hidden="true">
          {active ? (dir === 'asc' ? '▲' : '▼') : ''}
        </span>
      </button>
    </th>
  )
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
  const [sort, setSort] = useState<SortKey>('activity')
  const [dir, setDir] = useState<Direction>('desc')

  // A name reads A→Z and a date reads newest-first, so a column starts at whichever of those it is.
  // Picking the column already in force is the only thing that turns it around.
  const orderBy = (key: SortKey): void => {
    if (key === sort) setDir(dir === 'asc' ? 'desc' : 'asc')
    else {
      setSort(key)
      setDir(key === 'name' ? 'asc' : 'desc')
    }
  }

  return (
    <>
      <Chrome crumbs={[]} search={{ source }} />
      <main className="page">
        {error !== null && data === null ? (
          <Problem message={error} />
        ) : data === null ? (
          <Loading what="the store" />
        ) : (
          <div className={loading ? 'rereading' : undefined}>
            <div className="head">
              <h1>Projects</h1>
              <span className="muted mono">{data.data_dir}</span>
              <span className="spacer" style={{ flex: 1 }} />
              <Import onImported={reread} />
            </div>
            <Facts
              items={[
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
                      <SortHead label="Project" head="name" sort={sort} dir={dir} onSort={orderBy} />
                      <th style={{ width: '22%' }}>
                        Work{' '}
                        <Info says="The bar is the mix of work by rounds. Under it is the largest of those, and what it cost: the share the project page shows in its Share column, at the rates in Settings." />
                      </th>
                      <th className="r">Sessions</th>
                      <th className="r">Tasks</th>
                      <th className="r">Rounds</th>
                      <TokenHeaders />
                      {/* Two dates, and they answer different questions. One is when the work
                          happened; the other is when probez last went and looked, which is a fact
                          about probez rather than about the work. Both are here because "which of
                          these have I not synced lately" is a question about the second one, and it
                          could not be asked of a column that was not on the page. */}
                      <SortHead
                        label="Last activity"
                        head="activity"
                        sort={sort}
                        dir={dir}
                        onSort={orderBy}
                        className="r"
                        title="When the most recent round in this project ran"
                      />
                      <SortHead
                        label="Updated"
                        head="updated"
                        sort={sort}
                        dir={dir}
                        onSort={orderBy}
                        className="r"
                        title="When probez last read this project: collected here, or imported from a file"
                      />
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {ordered(data.projects, sort, dir).map((project) => (
                      <tr
                        key={project.slug}
                        className="row"
                        onClick={() => go(href.project(project.slug, source))}
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
                          <SourceMarks sources={project.sources} />
                          <div className="muted mono clip" style={{ fontSize: 11 }}>
                            {project.path ?? project.key}
                          </div>
                        </td>
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
                        <td className="r num">{project.sessions}</td>
                        <td className="r num">{project.tasks}</td>
                        <td className="r num">{count(project.rounds)}</td>
                        <TokenCells of={project} />
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
                            onRemoved={reread}
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
                      you work in, then reload — or <strong>Import</strong> a project someone sent you.
                    </>
                  ) : (
                    <>
                      No project in this store has{' '}
                      {source === 'claude' ? 'Claude' : source === 'cursor' ? 'Cursor' : 'Codex'}{' '}
                      sessions.
                    </>
                  )}
                </p>
              ) : null}
            </section>
          </div>
        )}
      </main>
    </>
  )
}
