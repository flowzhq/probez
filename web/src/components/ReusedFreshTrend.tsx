import { AxisBottom, AxisLeft } from '@visx/axis'
import { Group } from '@visx/group'
import { scaleLinear } from '@visx/scale'
import { Bar } from '@visx/shape'
import { useLayoutEffect, useRef, useState } from 'react'

import type { ReusedFreshDay } from '../api'
import { tokens } from '../format'
import { Info } from './Chrome'
import { Tip, useTip } from './Tip'
import type { ReactElement } from 'react'

/**
 * Daily reused vs fresh input volume for the Trends tab.
 *
 * Reused = `in_cache_read`. Fresh = `in_uncached + in_cache_write` (everything that was not a cache
 * read). Only known components are summed — null is never a fabricated zero. Stacked so the bar
 * height is the available input volume for that task-day.
 */

const H = 180
const PAD = { top: 14, right: 16, bottom: 28, left: 56 }
const REUSED = 'var(--good)'
const FRESH = 'var(--accent)'

export function ReusedFreshTrend({ days }: { days: ReusedFreshDay[] }): ReactElement {
  const plotted = days.filter((day) => (day.reused ?? 0) + (day.fresh ?? 0) > 0)

  if (plotted.length === 0) {
    return (
      <p className="note">
        <strong>Reused vs Fresh data unavailable.</strong> No cached or uncached input token data is
        available for the selected tasks.
      </p>
    )
  }

  return (
    <div>
      <div
        className="muted"
        style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 8, fontSize: 12 }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span
            aria-hidden
            style={{ width: 10, height: 10, borderRadius: 2, background: REUSED, display: 'inline-block' }}
          />
          Reused
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span
            aria-hidden
            style={{ width: 10, height: 10, borderRadius: 2, background: FRESH, display: 'inline-block' }}
          />
          Fresh
          <Info
            says={
              <div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Fresh</div>
                Input tokens that were not served from an existing cache read. Includes uncached
                input and input written to cache.
              </div>
            }
            aria="Fresh: input tokens that were not served from an existing cache read, including uncached input and input written to cache"
          />
        </span>
      </div>
      <StackedChart days={plotted} />
    </div>
  )
}

function StackedChart({ days }: { days: ReusedFreshDay[] }): ReactElement {
  const [width, setWidth] = useState(0)
  const box = useRef<HTMLDivElement>(null)
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

  const innerW = Math.max(0, width - PAD.left - PAD.right)
  const innerH = H - PAD.top - PAD.bottom
  const totals = days.map((day) => (day.reused ?? 0) + (day.fresh ?? 0))
  const dataMax = Math.max(...totals, 1)
  const { domainMax, ticks } = tokenAxis(dataMax)
  // Size bars from the full width first, then inset the scale so the first/last bar clears the
  // plot edges (half a bar used to hang over the Y-axis when the first day sat at x=0).
  const barW = Math.min(28, Math.max(6, (innerW / Math.max(days.length, 1)) * 0.55))
  const edge = barW / 2 + 12
  const x = scaleLinear({
    domain: [0, Math.max(days.length - 1, 1)],
    range: [edge, Math.max(edge, innerW - edge)],
  })
  const y = scaleLinear({ domain: [0, domainMax], range: [innerH, 0] })

  return (
    <div ref={box}>
      {innerW < 40 ? null : (
        <svg
          width={width}
          height={H}
          role="img"
          aria-label="Daily reused versus fresh input tokens"
          onMouseLeave={hide}
        >
          <Group top={PAD.top} left={PAD.left}>
            {days.map((day, at) => {
              const reused = day.reused ?? 0
              const fresh = day.fresh ?? 0
              const cx = x(at)
              const reusedH = reused > 0 ? innerH - y(reused) : 0
              const freshH = fresh > 0 ? innerH - y(fresh) : 0
              // Fresh at the bottom, Reused on top — reuse is usually the bulk of input.
              const freshY = y(fresh)
              const reusedY = y(fresh + reused)
              return (
                <Group key={day.day}>
                  {fresh > 0 ? (
                    <Bar
                      x={cx - barW / 2}
                      y={freshY}
                      width={barW}
                      height={freshH}
                      fill={FRESH}
                      rx={2}
                      style={{ cursor: 'default' }}
                      onMouseMove={(event) => show(event, <DayTip day={day} />)}
                      onMouseLeave={hide}
                    />
                  ) : null}
                  {reused > 0 ? (
                    <Bar
                      x={cx - barW / 2}
                      y={reusedY}
                      width={barW}
                      height={reusedH}
                      fill={REUSED}
                      rx={fresh > 0 ? 0 : 2}
                      style={{ cursor: 'default' }}
                      onMouseMove={(event) => show(event, <DayTip day={day} />)}
                      onMouseLeave={hide}
                    />
                  ) : null}
                </Group>
              )
            })}
            <AxisLeft
              scale={y}
              stroke="var(--axis)"
              tickStroke="var(--axis)"
              tickValues={ticks}
              tickFormat={(value) => tokens(Number(value))}
              tickLabelProps={() => ({
                fill: 'var(--ink-3)',
                fontSize: 10,
                textAnchor: 'end',
                dx: -4,
                dy: 3,
              })}
              hideAxisLine
            />
            <AxisBottom
              top={innerH}
              scale={x}
              stroke="var(--axis)"
              tickStroke="var(--axis)"
              tickValues={dayTicks(days.length)}
              tickFormat={(value) => {
                const at = Math.round(Number(value))
                const day = days[at]
                return day === undefined ? '' : shortDay(day.day)
              }}
              tickLabelProps={() => ({
                fill: 'var(--ink-3)',
                fontSize: 10,
                textAnchor: 'middle',
                dy: 4,
              })}
              hideAxisLine
            />
          </Group>
        </svg>
      )}
      <Tip tip={tip} />
    </div>
  )
}

function DayTip({ day }: { day: ReusedFreshDay }): ReactElement {
  const reused = day.reused
  const fresh = day.fresh
  const total =
    reused !== null || fresh !== null ? (reused ?? 0) + (fresh ?? 0) : null
  return (
    <div>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{longDay(day.day)}</div>
      <div>Reused {reused === null ? '—' : tokens(reused)}</div>
      <div>Fresh {fresh === null ? '—' : tokens(fresh)}</div>
      <div>Total {total === null ? '—' : tokens(total)}</div>
      <div>Tasks {day.tasks}</div>
      <div>
        Token data {day.with_split} / {day.tasks} tasks
      </div>
    </div>
  )
}

function shortDay(day: string): string {
  const at = Date.parse(`${day}T00:00:00.000Z`)
  if (Number.isNaN(at)) return day
  return new Date(at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

function longDay(day: string): string {
  const at = Date.parse(`${day}T00:00:00.000Z`)
  if (Number.isNaN(at)) return day
  return new Date(at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function dayTicks(length: number): number[] {
  if (length <= 1) return [0]
  if (length <= 8) return Array.from({ length }, (_, at) => at)
  const step = Math.ceil((length - 1) / 6)
  const ticks: number[] = []
  for (let at = 0; at < length; at += step) ticks.push(at)
  if (ticks[ticks.length - 1] !== length - 1) ticks.push(length - 1)
  return ticks
}

/** Even token ticks ending on a nice ceiling — never append the raw max (e.g. 316.1K over 300K). */
function tokenAxis(max: number): { domainMax: number; ticks: number[] } {
  if (max <= 0) return { domainMax: 1, ticks: [0] }
  const step = niceStep(max / 4)
  const steps = Math.max(1, Math.ceil(max / step))
  const domainMax = steps * step
  return {
    domainMax,
    ticks: Array.from({ length: steps + 1 }, (_, at) => at * step),
  }
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / power
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return nice * power
}
