import { scaleLinear } from '@visx/scale'
import { Bar } from '@visx/shape'
import { useState } from 'react'

import type { Analysis, CategoryRow } from '../api'
import { fillOf, orderOf, shadeOf, styleOf, texturedSub } from '../categories'
import { count, duration, money, percent, shortId, tokens } from '../format'
import { href, linkProps } from '../router'
import type { SourceChoice } from '../router'
import { Info } from './Chrome'
import { Tip, useTip } from './Tip'
import { TokenCells, TokenHeaders } from './Tokens'
import type { ReactElement, ReactNode } from 'react'

/** Query atoms for "rounds where a tool failed", optionally narrowed by category / round / task / source. */
export function errorSearchQuery(opts: {
  category?: string
  /** Round numbers to match (`round:n`, or OR-group when several). */
  rounds?: number[]
  session?: string
  task?: number
  source?: string | null
}): string {
  const parts = ['is:error']
  if (opts.category !== undefined && opts.category !== '') {
    parts.push(`category:${opts.category}`)
  }
  const roundNums = (opts.rounds ?? []).filter((n) => Number.isFinite(n))
  if (roundNums.length === 1) {
    parts.push(`round:${roundNums[0]}`)
  } else if (roundNums.length > 1) {
    parts.push(`(${roundNums.map((n) => `round:${n}`).join(' OR ')})`)
  }
  if (opts.session !== undefined && opts.session !== '') {
    parts.push(`session:${shortId(opts.session)}`)
  }
  if (opts.task !== undefined) {
    parts.push(`task:${opts.task}`)
  }
  if (opts.source !== undefined && opts.source !== null && opts.source !== '') {
    parts.push(`source:${opts.source}`)
  }
  return parts.join(' ')
}

/**
 * The Errors count as a real link to Search (`is:error` …).
 *
 * Only the number is clickable; row clicks stay with the parent. `linkProps` already stops
 * propagation so a surrounding row navigator does not fire.
 */
export function ErrorsSearchLink({
  count,
  slug,
  category,
  rounds,
  session,
  task,
  source = null,
  children,
  title,
}: {
  count: number
  slug: string
  category?: string
  rounds?: number[]
  session?: string
  task?: number
  source?: SourceChoice | null
  children?: ReactNode
  title?: string
}): ReactElement {
  if (!(count > 0)) return <span className="muted">·</span>
  const to = href.search(errorSearchQuery({ category, rounds, session, task, source }), {
    slug,
    entity: 'rounds',
  })
  return (
    <a
      className="bad errors-link"
      {...linkProps(to)}
      title={title ?? 'Rounds where a tool failed'}
    >
      {children ?? count}
    </a>
  )
}

/**
 * Most of the work here has no price on it.
 *
 * A share of money divides by the rounds that have a rate, and that can be a minority of them: one
 * store prices 41,100 of its 84,322 classified rounds, the rest recording no model at all. The
 * number is not wrong — it is a true share of what was actually billed — but a reader takes a
 * percentage for a statement about the work, and this one is a statement about half of it. Half is
 * where that stops being a footnote, so half is the line.
 *
 * Not the same condition as falling back to the rounds, which needs *nothing* priced. Between the
 * two a share of money is still the better answer; it just cannot be read as covering everything.
 */
export function mostlyUnpriced(unpriced: number, classified: number): boolean {
  return classified > 0 && unpriced * 2 > classified
}

/**
 * The mark that says so, wherever that share is standing.
 *
 * Both places it appears are tables, and a table has no room for the sentence — the project page
 * states it in prose under the bars, and the projects list has nothing under anything. So it is a
 * mark, and it carries the two counts rather than the word "some": a reader deciding whether to go
 * and set a rate needs to know if it is a tenth of the work missing or nine tenths.
 */
export function UnpricedMark({
  unpriced,
  classified,
}: {
  unpriced: number
  classified: number
}): ReactElement {
  const priced = classified - unpriced
  return (
    <Info
      says={`${count(unpriced)} of the ${count(classified)} rounds that called a tool have no rate for their model, so this is a share of what the other ${count(priced)} cost. Set a rate under Settings to bring the rest in.`}
      aria={`A share of what ${count(priced)} of ${count(classified)} rounds cost: the rest have no rate.`}
    />
  )
}

/**
 * Where the work went, one row per category.
 *
 * Every bar is directly labelled with its category and its share, which is not decoration: three of
 * the series colours sit below 3:1 contrast on the light surface, and a visible label is what
 * makes that legal rather than merely pretty. It also means the chart is readable with the colours
 * ignored entirely.
 *
 * The coverage line underneath is part of the chart, not a footnote. A share with no denominator
 * invites the reader to assume the denominator is everything, and here it is not: rounds that
 * called no tool are outside it, and some of what is inside it is work no table can name.
 */
export function WorkBars({
  analysis,
  slug,
  session,
  source = null,
  onPick,
}: {
  analysis: Analysis
  /** Project slug — required so Errors can open Search in this project. */
  slug: string
  /** When set, Errors also narrows with `session:`. */
  session?: string
  source?: SourceChoice | null
  onPick?: (category: string) => void
}): ReactElement {
  const { tip, show, hide } = useTip()
  const [open, setOpen] = useState<string | null>(null)
  // Shares are of money; Tokens of input+output. `classified` is still the round count the bars
  // are drawn from, because a bar is a picture of how much work a category was, not of how much
  // it cost or how many tokens it moved.
  const total = analysis.coverage.classified
  const spent = analysis.coverage.cost
  // Unless nothing here is priced at all — a Cursor project carries no token counts, so every
  // round costs nothing and every share came out `0.0%`, which reads as a measurement rather than
  // as a missing denominator. With no money to divide, the rounds are the honest denominator, and
  // the mark on the header says which one the reader is looking at.
  const byRounds = spent === 0
  // Priced, but most of it isn't. The share stays a share of money — see `mostlyUnpriced` — and
  // says what it left out.
  const thin = !byRounds && mostlyUnpriced(analysis.coverage.unpriced, total)
  const volume = analysis.coverage.tokens

  if (total === 0) {
    return <p className="note">No round in this span called a tool, so there is no work to divide.</p>
  }

  const share = (row: CategoryRow): number => (byRounds ? row.rounds / total : row.cost / spent)

  const rows = [...analysis.rows].sort((a, b) => orderOf(a.name) - orderOf(b.name))
  const widest = Math.max(...rows.map((row) => row.rounds))
  const scale = scaleLinear({ domain: [0, widest], range: [0, 100] })

  /**
   * One bar. A sub-row is drawn in its parent's hue rather than a flat neutral, so that two ways of
   * doing the same work — `locate` and `graph` are both Reconstruction — are told apart without
   * either of them looking like a different kind of work.
   */
  const bar = (row: CategoryRow, parent: string | null): ReactElement => {
    const sub = parent !== null
    const style = styleOf(sub ? parent : row.name)
    const height = sub ? 8 : 12
    return (
      <svg width="100%" height={height} style={{ display: 'block' }} aria-hidden>
        <Bar
          x={0}
          y={0}
          width={`${scale(row.rounds)}%`}
          height={height}
          rx={3}
          fill={fillOf(style)}
          opacity={sub ? shadeOf(parent, row.name) : 1}
        />
        {sub && texturedSub(parent, row.name) ? (
          <Bar x={0} y={0} width={`${scale(row.rounds)}%`} height={height} rx={3} fill="url(#probez-lines)" />
        ) : null}
      </svg>
    )
  }

  return (
    <>
      <table>
        <thead>
          <tr>
            <th style={{ width: 170 }}>Work</th>
            <th style={{ width: '18%' }} />
            <th
              className="r"
              // The `i` is 17px the header did not have room for, so the column widens to hold it
              // rather than wrapping "Share" onto two lines.
              style={{ width: byRounds || thin ? 84 : 66 }}
              title={
                byRounds
                  ? undefined
                  : 'Share of what the classified rounds cost, at the rates in Settings.'
              }
            >
              Share
              {byRounds ? (
                <Info
                  says="No round here has a priced model, so there is no cost to divide. These are shares of the classified rounds instead — of how much work a category was, not of what it cost. Set a rate under Settings to get shares of money."
                  aria="Shares of rounds, not of cost: no round here has a priced model."
                />
              ) : thin ? (
                <UnpricedMark unpriced={analysis.coverage.unpriced} classified={total} />
              ) : null}
            </th>
            <th
              className="r"
              style={{ width: 66 }}
              title="Share of input + output tokens across classified rounds that recorded usage. Cursor needs the stop hook (`probez hook`) for usage."
            >
              Tokens
            </th>
            <th className="r" style={{ width: 66 }}>
              Rounds
            </th>
            <th className="r" style={{ width: 66 }}>
              Time
            </th>
            <TokenHeaders />
            <th className="r" style={{ width: 72 }}>
              Cost
            </th>
            <th className="r" style={{ width: 56 }}>
              Errors
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const style = styleOf(row.name)
            const expanded = open === row.name
            return [
              <tr
                key={row.name}
                className="row"
                onClick={() => {
                  setOpen(expanded ? null : row.name)
                  onPick?.(row.name)
                }}
                onMouseMove={(event) =>
                  show(
                    event,
                    <>
                      <strong>{row.label}</strong>
                      <br />
                      <span className="tip-key">share </span>
                      {percent(share(row), 1)}
                      {byRounds ? (
                        <> of the classified rounds — nothing here is priced, so there is no cost to divide</>
                      ) : (
                        <> of the {money(spent)} the classified rounds cost</>
                      )}
                      <br />
                      <span className="tip-key">tokens </span>
                      {volume === 0
                        ? 'no usage recorded'
                        : `${percent((row.in_tokens + row.out_tokens) / volume, 1)} of the ${tokens(volume)} they moved`}
                      <br />
                      <span className="tip-key">weighted rounds </span>
                      {row.rounds.toFixed(1)} of {Math.round(total)}
                      <br />
                      <span className="tip-key">in </span>
                      {tokens(row.in_tokens)}
                      {row.in_tokens > 0 ? (
                        <>, {percent(row.in_cache_read / row.in_tokens, 0)} of it reused from cache</>
                      ) : null}
                    </>,
                  )
                }
                onMouseLeave={hide}
              >
                <td>
                  <span
                    className="swatch"
                    style={{ background: style.hatched === true ? 'var(--series-none)' : style.fill }}
                  />
                  {row.label}
                </td>
                <td>{bar(row, null)}</td>
                <td className="r num">{percent(share(row), 1)}</td>
                <td className="r num">
                  {volume === 0 ? (
                    <span className="muted">—</span>
                  ) : (
                    percent((row.in_tokens + row.out_tokens) / volume, 1)
                  )}
                </td>
                <td className="r num dim">{row.rounds.toFixed(1)}</td>
                <td className="r num dim">{duration(row.ms)}</td>
                <TokenCells of={row} />
                <td className="r num dim">{money(row.cost)}</td>
                <td className="r num">
                  <ErrorsSearchLink
                    count={row.errors}
                    slug={slug}
                    category={row.name}
                    session={session}
                    source={source}
                    title={`Search rounds with tool errors in ${row.label}`}
                  />
                </td>
              </tr>,
              ...(expanded
                ? (row.sub ?? []).map((child) => (
                    <tr key={`${row.name}/${child.name}`}>
                      <td className="dim" style={{ paddingLeft: 28 }}>
                        {child.label}
                      </td>
                      <td>{bar(child, row.name)}</td>
                      <td className="r num dim">{percent(share(child), 1)}</td>
                      <td className="r num muted">
                        {volume === 0
                          ? '—'
                          : percent((child.in_tokens + child.out_tokens) / volume, 1)}
                      </td>
                      <td className="r num muted">{child.rounds.toFixed(1)}</td>
                      <td className="r num muted">{duration(child.ms)}</td>
                      <TokenCells of={child} dim="muted" />
                      <td className="r num muted">{money(child.cost)}</td>
                      <td className="r num">
                        <ErrorsSearchLink
                          count={child.errors}
                          slug={slug}
                          category={row.name}
                          session={session}
                          source={source}
                          title={`Search rounds with tool errors in ${row.label}`}
                        />
                      </td>
                    </tr>
                  ))
                : []),
            ]
          })}
        </tbody>
      </table>
      <Coverage analysis={analysis} />
      <Tip tip={tip} />
    </>
  )
}

export function Coverage({ analysis }: { analysis: Analysis }): ReactElement {
  const {
    rounds,
    classified,
    toolless,
    weight,
    unclassified,
    targeted,
    cost,
    unpriced,
    tokens: volume,
    tokenless,
    outside_tokens,
  } = analysis.coverage
  const unknown = analysis.unknown
    .slice(0, 3)
    .map((row) => row.name)
    .join(', ')
  return (
    <p className="note" style={{ marginTop: 12 }}>
      {Math.round(classified)} of {rounds} rounds did something a tool can see.{' '}
      {cost > 0 ? (
        <>Share is of the {money(cost)} they cost.</>
      ) : (
        <>None of them has a priced model, so shares are of the rounds rather than of the cost.</>
      )}{' '}
      {volume > 0 ? (
        <>Tokens is of the {tokens(volume)} they moved.</>
      ) : (
        <>None of them recorded usage, so there are no tokens to divide.</>
      )}
      <br />
      {toolless} {toolless === 1 ? 'round' : 'rounds'} of prose only (
      {percent(rounds === 0 ? 0 : toolless / rounds, 1)}) ·{' '}
      {percent(weight === 0 ? 0 : unclassified / weight, 1)} unclassified ·{' '}
      {percent(weight === 0 ? 0 : targeted / weight, 1)} of work has a known target
      {unknown === '' ? null : (
        <>
          <br />
          Unclassified is mostly {unknown}.
        </>
      )}
      {unpriced === 0 ? null : (
        <>
          <br />
          {/* With every round unpriced there is nothing for them to be outside of — they are the
              shares. The line says why the denominator is the rounds rather than claiming an
              exclusion that did not happen. */}
          {cost === 0 ? (
            <>
              Nothing prices{' '}
              {analysis.unpriced.slice(0, 3).map((row) => row.model).join(', ')}.{' '}
              <a {...linkProps(href.settings())}>Set a rate</a> and shares become shares of money.
            </>
          ) : (
            <>
              {unpriced} {unpriced === 1 ? 'round is' : 'rounds are'} outside Share: no rate for{' '}
              {analysis.unpriced.slice(0, 3).map((row) => row.model).join(', ')}.{' '}
              <a {...linkProps(href.settings())}>Set one</a>.
            </>
          )}
        </>
      )}
      {tokenless === 0 ? null : (
        <>
          <br />
          {tokenless} {tokenless === 1 ? 'round is' : 'rounds are'} outside Tokens: no usage
          recorded (install `probez hook --install` for Cursor).
        </>
      )}
      {outside_tokens === 0 ? null : (
        <>
          <br />
          {tokens(Math.round(outside_tokens))} tokens sit outside Tokens on prose-only rounds.
        </>
      )}
    </p>
  )
}

/** The same distribution as one bar, for a table row that has no room for a stack of them. */
export function MixBar({
  mix,
}: {
  mix: Array<{ category: string; label: string; share: number }>
}): ReactElement {
  const ordered = [...mix].sort((a, b) => orderOf(a.category) - orderOf(b.category))
  return (
    <span style={{ display: 'flex', gap: 2, height: 8, alignItems: 'stretch' }}>
      {ordered.map((slice) => {
        const style = styleOf(slice.category)
        return (
          <span
            key={slice.category}
            className={style.hatched === true ? 'hatch' : undefined}
            title={`${slice.label} ${percent(slice.share)}`}
            style={{
              flex: `${Math.max(0.01, slice.share)} 1 0`,
              background: style.hatched === true ? undefined : style.fill,
              borderRadius: 2,
            }}
          />
        )
      })}
    </span>
  )
}
