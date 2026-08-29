import { scaleLinear } from '@visx/scale'
import { Bar } from '@visx/shape'
import { useState } from 'react'

import type { Analysis, CategoryRow } from '../api'
import { fillOf, orderOf, shadeOf, styleOf } from '../categories'
import { duration, money, percent, tokens } from '../format'
import { href, linkProps } from '../router'
import { Tip, useTip } from './Tip'
import { TokenCells, TokenHeaders } from './Tokens'
import type { ReactElement } from 'react'

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
  onPick,
}: {
  analysis: Analysis
  onPick?: (category: string) => void
}): ReactElement {
  const { tip, show, hide } = useTip()
  const [open, setOpen] = useState<string | null>(null)
  // Shares are of money. `classified` is still the round count the bars are drawn from, because a
  // bar is a picture of how much work a category was, not of how much it cost.
  const total = analysis.coverage.classified
  const spent = analysis.coverage.cost

  if (total === 0) {
    return <p className="note">No round in this span called a tool, so there is no work to divide.</p>
  }

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
    return (
      <svg width="100%" height={sub ? 8 : 12} style={{ display: 'block' }} aria-hidden>
        <Bar
          x={0}
          y={0}
          width={`${scale(row.rounds)}%`}
          height={sub ? 8 : 12}
          rx={3}
          fill={fillOf(style)}
          opacity={sub ? shadeOf(parent, row.name) : 1}
        />
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
            <th className="r" style={{ width: 66 }} title="Share of what the classified rounds cost, at the rates in Settings.">
              Share
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
                      {percent(spent === 0 ? 0 : row.cost / spent, 1)} of the {money(spent)} the
                      classified rounds cost
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
                <td className="r num">{percent(spent === 0 ? 0 : row.cost / spent, 1)}</td>
                <td className="r num dim">{row.rounds.toFixed(1)}</td>
                <td className="r num dim">{duration(row.ms)}</td>
                <TokenCells of={row} />
                <td className="r num dim">{money(row.cost)}</td>
                <td className={`r num ${row.errors > 0 ? 'bad' : 'muted'}`}>
                  {row.errors > 0 ? row.errors : '·'}
                </td>
              </tr>,
              ...(expanded
                ? (row.sub ?? []).map((child) => (
                    <tr key={`${row.name}/${child.name}`}>
                      <td className="dim" style={{ paddingLeft: 28 }}>
                        {child.label}
                      </td>
                      <td>{bar(child, row.name)}</td>
                      <td className="r num dim">
                        {percent(spent === 0 ? 0 : child.cost / spent, 1)}
                      </td>
                      <td className="r num muted">{child.rounds.toFixed(1)}</td>
                      <td className="r num muted">{duration(child.ms)}</td>
                      <TokenCells of={child} dim="muted" />
                      <td className="r num muted">{money(child.cost)}</td>
                      <td className="r num muted">{child.errors > 0 ? child.errors : '·'}</td>
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
  const { rounds, classified, toolless, weight, unclassified, targeted, cost, unpriced } =
    analysis.coverage
  const unknown = analysis.unknown
    .slice(0, 3)
    .map((row) => row.name)
    .join(', ')
  return (
    <p className="note" style={{ marginTop: 12 }}>
      {Math.round(classified)} of {rounds} rounds did something a tool can see.{' '}
      {cost > 0 ? (
        <>Shares are of the {money(cost)} they cost.</>
      ) : (
        <>None of them has a priced model, so there is no cost to divide.</>
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
          {unpriced} {unpriced === 1 ? 'round is' : 'rounds are'} outside that: no rate for{' '}
          {analysis.unpriced.slice(0, 3).map((row) => row.model).join(', ')}.{' '}
          <a {...linkProps(href.settings())}>Set one</a>.
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
