import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { fillOf, orderOf, styleOf } from '../categories'
import { money, percent } from '../format'
import { go, linkProps } from '../router'
import { Tip, useTip } from './Tip'

/**
 * The few chart shapes the Insights pages are drawn from.
 *
 * Plain SVG over a measured width, like the trends charts beside them: the shapes are bars and
 * nothing else, and a bar is a rectangle. Every mark here can be clicked, because the rule the
 * Insights section is built on is that every number opens the list behind it.
 */

/** One series in a stacked chart: what it is called, and what to paint it. */
export interface Series {
  key: string
  label: string
  /** A colour, or `url(#probez-hatch)` for the neutral. */
  fill: string
}

const PALETTE = [
  'var(--series-1)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-7)',
  'var(--series-5)',
  'var(--series-2)',
  'var(--series-6)',
  'var(--series-8)',
]

export const OTHER = '__other'

/**
 * Series for a split that is not the work taxonomy — projects, models, agents — biggest first.
 *
 * Colours go by rank, so the largest is always the first slot, and anything past the seventh is
 * folded into one neutral "other" rather than spending the eighth hue on the long tail. Category
 * splits do not come through here: a category's colour is fixed by its place in the taxonomy.
 */
export function rankedSeries(rows: Array<{ key: string; label: string }>, keep = 7): Series[] {
  const shown = rows.slice(0, keep).map((row, at) => ({ key: row.key, label: row.label, fill: PALETTE[at]! }))
  if (rows.length > keep) {
    shown.push({ key: OTHER, label: `other ${rows.length - keep}`, fill: 'var(--series-none)' })
  }
  return shown
}

/** Series for the work taxonomy, in its own order and its own colours. */
export function categorySeries(rows: Array<{ key: string; label: string }>): Series[] {
  return [...rows]
    .sort((a, b) => orderOf(a.key) - orderOf(b.key))
    .map((row) => ({ key: row.key, label: row.label, fill: fillOf(styleOf(row.key)) }))
}

export interface StackDay {
  day: string
  /** Value per series key. A key missing from `series` is counted under `OTHER` when that exists. */
  values: Record<string, number>
}

const H = 190
const PAD = { top: 8, right: 8, bottom: 22, left: 46 }

function niceMax(value: number): number {
  if (value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * power) return step * power
  }
  return 10 * power
}

function dayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/**
 * Days as stacked bars, one stack per day, every day drawn whether anything happened or not.
 *
 * `onPick` gets the day and the series under the pointer, which is how a bar becomes a filtered
 * list. The tooltip says the day's total and the slice, both in dollars.
 */
export function StackedDays({
  days,
  series,
  format = money,
  onPick,
  label,
}: {
  days: StackDay[]
  series: Series[]
  format?: (value: number) => string
  onPick?: (day: string, key: string) => void
  /** What the chart is, for a screen reader. */
  label: string
}): ReactElement {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const { tip, show, hide } = useTip()

  useLayoutEffect(() => {
    const node = box.current
    if (node === null) return
    const measure = (): void => setWidth(node.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const known = new Set(series.map((one) => one.key))
  const folded = days.map((day) => {
    const values: Record<string, number> = {}
    for (const [key, value] of Object.entries(day.values)) {
      const into = known.has(key) ? key : known.has(OTHER) ? OTHER : null
      if (into === null) continue
      values[into] = (values[into] ?? 0) + value
    }
    return { day: day.day, values, total: Object.values(values).reduce((a, b) => a + b, 0) }
  })
  const max = niceMax(Math.max(0, ...folded.map((day) => day.total)))
  const innerW = Math.max(0, width - PAD.left - PAD.right)
  const innerH = H - PAD.top - PAD.bottom
  const step = folded.length === 0 ? 0 : innerW / folded.length
  const gap = step > 6 ? Math.min(3, step * 0.25) : 0.5
  const y = (value: number): number => PAD.top + innerH * (1 - value / max)
  // Five labels along the bottom at most, evenly spaced, always including the last day.
  const every = Math.max(1, Math.ceil(folded.length / 5))
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((share) => share * max)

  return (
    <div ref={box} style={{ position: 'relative' }}>
      {width === 0 ? (
        <div style={{ height: H }} />
      ) : (
        <svg width={width} height={H} role="img" aria-label={label} onMouseLeave={hide}>
          {ticks.map((value) => (
            <g key={value}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(value)} y2={y(value)} stroke="var(--rule)" />
              <text x={PAD.left - 6} y={y(value) + 3} textAnchor="end" className="axis-text">
                {format(value) === '·' ? '$0' : format(value)}
              </text>
            </g>
          ))}
          {folded.map((day, at) => {
            let acc = 0
            const x = PAD.left + at * step + gap / 2
            return (
              <g key={day.day}>
                {series.map((one) => {
                  const value = day.values[one.key] ?? 0
                  if (value <= 0) return null
                  const top = y(acc + value)
                  const bottom = y(acc)
                  acc += value
                  return (
                    <rect
                      key={one.key}
                      x={x}
                      y={top}
                      width={Math.max(0.5, step - gap)}
                      height={Math.max(0, bottom - top)}
                      fill={one.fill}
                      className={onPick === undefined ? undefined : 'pickable'}
                      onMouseMove={(event) =>
                        show(
                          event,
                          <div>
                            <div style={{ fontWeight: 600 }}>
                              {dayLabel(day.day)} · {format(day.total)}
                            </div>
                            <div>
                              {one.label}: {format(value)}
                              {day.total > 0 ? ` (${percent(value / day.total)})` : ''}
                            </div>
                            {onPick === undefined ? null : <div className="muted">Click to list sessions</div>}
                          </div>,
                        )
                      }
                      onClick={onPick === undefined ? undefined : () => onPick(day.day, one.key)}
                    />
                  )
                })}
                {/* An invisible column over the whole day, so an empty or tiny day still has a
                    target and a tooltip saying it was empty. */}
                {day.total > 0 ? null : (
                  <rect
                    x={x}
                    y={PAD.top}
                    width={Math.max(0.5, step - gap)}
                    height={innerH}
                    fill="transparent"
                    onMouseMove={(event) => show(event, <div>{dayLabel(day.day)} · nothing ran</div>)}
                  />
                )}
                {at % every === (folded.length - 1) % every ? (
                  <text
                    x={at === folded.length - 1 ? x + step - gap : x + (step - gap) / 2}
                    y={H - 6}
                    textAnchor={at === folded.length - 1 ? 'end' : 'middle'}
                    className="axis-text"
                  >
                    {dayLabel(day.day)}
                  </text>
                ) : null}
              </g>
            )
          })}
        </svg>
      )}
      <Tip tip={tip} />
    </div>
  )
}

export function Legend({ series, onPick }: { series: Series[]; onPick?: (key: string) => void }): ReactElement {
  return (
    <div className="chart-legend">
      {series.map((one) =>
        onPick === undefined || one.key === OTHER ? (
          <span key={one.key}>
            <Swatch fill={one.fill} />
            {one.label}
          </span>
        ) : (
          <button key={one.key} type="button" onClick={() => onPick(one.key)} title={`List sessions: ${one.label}`}>
            <Swatch fill={one.fill} />
            {one.label}
          </button>
        ),
      )}
    </div>
  )
}

function Swatch({ fill }: { fill: string }): ReactElement {
  return fill.startsWith('url(') ? (
    <span className="chart-swatch hatch" aria-hidden />
  ) : (
    <span className="chart-swatch" style={{ background: fill }} aria-hidden />
  )
}

/** A ranked list as bars against the largest, each a link to the list behind it. */
export function HBars({
  rows,
  format = money,
  mono = false,
}: {
  rows: Array<{ key: string; label: string; value: number; to?: string; title?: string }>
  format?: (value: number) => string
  mono?: boolean
}): ReactElement {
  const max = Math.max(0, ...rows.map((row) => row.value))
  return (
    <div className="hbars">
      {rows.map((row) => {
        const body = (
          <>
            <span className={mono ? 'hbar-label mono' : 'hbar-label'}>{row.label}</span>
            <span className="hbar-track">
              <i style={{ width: max > 0 ? `${(row.value / max) * 100}%` : 0 }} />
            </span>
            <span className="hbar-value num">{format(row.value)}</span>
          </>
        )
        return row.to === undefined ? (
          <div key={row.key} className="hbar" title={row.title}>
            {body}
          </div>
        ) : (
          <a key={row.key} className="hbar" title={row.title} {...linkProps(row.to)}>
            {body}
          </a>
        )
      })}
    </div>
  )
}

/** Shares of one whole as a single bar, each slice a link when `to` is given. */
export function ShareStack({
  parts,
  to,
  height = 14,
}: {
  parts: Array<{ key: string; label: string; share: number }>
  to?: (key: string) => string
  height?: number
}): ReactElement {
  const ordered = [...parts].filter((part) => part.share > 0).sort((a, b) => orderOf(a.key) - orderOf(b.key))
  return (
    <div className="share-stack" style={{ height }}>
      {ordered.map((part) => {
        const style = styleOf(part.key)
        return (
          <i
            key={part.key}
            className={style.hatched === true ? 'hatch' : to === undefined ? undefined : 'pickable'}
            title={`${part.label} ${percent(part.share, 1)}`}
            style={{ flex: `${part.share} 1 0`, background: style.hatched === true ? undefined : style.fill }}
            onClick={to === undefined ? undefined : () => go(to(part.key))}
          />
        )
      })}
    </div>
  )
}

/** One figure across the top of a page, with how it moved since the period before. */
export function Kpi({
  label,
  value,
  delta,
  note,
}: {
  label: string
  value: ReactNode
  /**
   * The change, as a ratio of now to before minus one, and whether up is the bad direction. Null
   * when there was nothing before to compare with.
   */
  delta?: { change: number | null; upIsBad: boolean } | null
  /** Said instead of a change, when the figure has no before. */
  note?: ReactNode
}): ReactElement {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value num">{value}</span>
      {delta === undefined || delta === null ? (
        <span className="kpi-note muted">{note ?? ' '}</span>
      ) : (
        <Delta change={delta.change} upIsBad={delta.upIsBad} />
      )}
    </div>
  )
}

function Delta({ change, upIsBad }: { change: number | null; upIsBad: boolean }): ReactElement {
  if (change === null || !Number.isFinite(change)) {
    return <span className="kpi-note muted">nothing before to compare</span>
  }
  // Under a percent either way is no movement worth an arrow.
  if (Math.abs(change) < 0.01) return <span className="kpi-note muted">● steady</span>
  const up = change > 0
  const bad = up === upIsBad
  return (
    <span className={`kpi-note num ${bad ? 'bad' : 'good'}`}>
      {up ? '▲' : '▼'} {percent(Math.abs(change))} vs previous period
    </span>
  )
}

/** Now against before, or null when before was nothing. */
export function changeOf(now: number, before: number | null | undefined): number | null {
  if (before === null || before === undefined || before === 0) return null
  return now / before - 1
}
