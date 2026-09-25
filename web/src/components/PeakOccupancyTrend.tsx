import { AxisBottom, AxisLeft } from '@visx/axis'
import { Group } from '@visx/group'
import { scaleLinear } from '@visx/scale'
import { Circle, LinePath } from '@visx/shape'
import { useLayoutEffect, useRef, useState } from 'react'

import type { PeakContextDay } from '../api'
import { percent, tokens } from '../format'
import { Tip, useTip } from './Tip'
import type { ReactElement } from 'react'

/**
 * Peak context chart for the Trends tab (range is owned by the parent Trends panel).
 *
 * Occupancy % needs a published window; Peak Tokens needs only `in_tokens`. Days without a value
 * for the selected metric are omitted rather than drawn as zero.
 */

type Metric = 'occupancy' | 'tokens'

const H = 180
const PAD = { top: 14, right: 16, bottom: 28, left: 56 }

export function PeakOccupancyTrend({ days }: { days: PeakContextDay[] }): ReactElement {
  const [metric, setMetric] = useState<Metric>('occupancy')

  const hasOccupancy = days.some((day) => day.with_window > 0)
  const hasTokens = days.some((day) => day.with_tokens > 0)

  return (
    <div>
      <div className="toggle" role="group" aria-label="Peak context metric" style={{ marginBottom: 10 }}>
        <button
          type="button"
          aria-pressed={metric === 'occupancy'}
          onClick={() => setMetric('occupancy')}
        >
          Occupancy %
        </button>
        <button
          type="button"
          aria-pressed={metric === 'tokens'}
          onClick={() => setMetric('tokens')}
        >
          Peak Tokens
        </button>
      </div>

      {metric === 'occupancy' ? (
        <OccupancyBody days={days} hasOccupancy={hasOccupancy} hasTokens={hasTokens} />
      ) : (
        <TokensBody days={days} hasTokens={hasTokens} />
      )}
    </div>
  )
}

function OccupancyBody({
  days,
  hasOccupancy,
  hasTokens,
}: {
  days: PeakContextDay[]
  hasOccupancy: boolean
  hasTokens: boolean
}): ReactElement {
  const plotted = days.filter(
    (day): day is PeakContextDay & { average_occupancy: number; max_occupancy: number } =>
      day.average_occupancy !== null && day.max_occupancy !== null,
  )

  if (!hasOccupancy || plotted.length === 0) {
    return (
      <p className="note">
        <strong>Occupancy data unavailable.</strong> Context window data is not available for the
        selected tasks.
        {hasTokens ? ' Try Peak Tokens instead.' : null}
      </p>
    )
  }

  return (
    <TrendChart
      points={plotted.map((day) => ({
        day: day.day,
        value: day.average_occupancy,
        tip: <OccupancyTip day={day} />,
      }))}
      yDomain={[0, 1]}
      yTicks={[0, 0.25, 0.5, 0.75, 1]}
      formatY={(value) => percent(value)}
      aria="Daily average peak context occupancy"
    />
  )
}

function TokensBody({
  days,
  hasTokens,
}: {
  days: PeakContextDay[]
  hasTokens: boolean
}): ReactElement {
  const plotted = days.filter(
    (day): day is PeakContextDay & { average_peak_tokens: number; max_peak_tokens: number } =>
      day.average_peak_tokens !== null && day.max_peak_tokens !== null,
  )

  if (!hasTokens || plotted.length === 0) {
    return (
      <p className="note">
        <strong>Peak token data unavailable.</strong> No input token data is available for the
        selected tasks.
      </p>
    )
  }

  const dataMax = Math.max(...plotted.map((day) => day.average_peak_tokens), 1)
  const { domainMax, ticks } = tokenAxis(dataMax)
  return (
    <TrendChart
      points={plotted.map((day) => ({
        day: day.day,
        value: day.average_peak_tokens,
        tip: <TokensTip day={day} />,
      }))}
      yDomain={[0, domainMax]}
      yTicks={ticks}
      formatY={(value) => tokens(value)}
      aria="Daily average peak input tokens"
    />
  )
}

function OccupancyTip({
  day,
}: {
  day: PeakContextDay & { average_occupancy: number; max_occupancy: number }
}): ReactElement {
  return (
    <div>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{longDay(day.day)}</div>
      <div>Average peak: {percent(day.average_occupancy)}</div>
      <div>Max peak: {percent(day.max_occupancy)}</div>
      <div>Tasks: {day.tasks}</div>
      <div>With known context window: {day.with_window}</div>
    </div>
  )
}

function TokensTip({
  day,
}: {
  day: PeakContextDay & { average_peak_tokens: number; max_peak_tokens: number }
}): ReactElement {
  return (
    <div>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{longDay(day.day)}</div>
      <div>Average peak: {tokens(day.average_peak_tokens)}</div>
      <div>Max peak: {tokens(day.max_peak_tokens)}</div>
      <div>Tasks: {day.tasks}</div>
      <div>With tokens: {day.with_tokens}</div>
    </div>
  )
}

function TrendChart({
  points,
  yDomain,
  yTicks,
  formatY,
  aria,
}: {
  points: Array<{ day: string; value: number; tip: ReactElement }>
  yDomain: [number, number]
  yTicks: number[]
  formatY: (value: number) => string
  aria: string
}): ReactElement {
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
  const markR = points.length > 60 ? 2.5 : points.length > 30 ? 3 : 4
  const edge = markR + 12
  const x = scaleLinear({
    domain: [0, Math.max(points.length - 1, 1)],
    range: [edge, Math.max(edge, innerW - edge)],
  })
  const y = scaleLinear({ domain: yDomain, range: [innerH, 0] })

  return (
    <div ref={box}>
      {innerW < 40 ? null : (
        <svg width={width} height={H} role="img" aria-label={aria} onMouseLeave={hide}>
          <Group top={PAD.top} left={PAD.left}>
            <LinePath
              data={points}
              x={(_, at) => x(at)}
              y={(d) => y(d.value)}
              stroke="var(--accent)"
              strokeWidth={1.5}
              fill="none"
            />
            {points.map((point, at) => (
              <Circle
                key={point.day}
                cx={x(at)}
                cy={y(point.value)}
                r={markR}
                fill="var(--accent)"
                stroke="var(--surface)"
                strokeWidth={1}
                style={{ cursor: 'default' }}
                onMouseMove={(event) => show(event, point.tip)}
                onMouseLeave={hide}
              />
            ))}
            <AxisLeft
              scale={y}
              stroke="var(--axis)"
              tickStroke="var(--axis)"
              tickValues={yTicks}
              tickFormat={(value) => formatY(Number(value))}
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
              tickValues={dayTicks(points.length)}
              tickFormat={(value) => {
                const at = Math.round(Number(value))
                const point = points[at]
                return point === undefined ? '' : shortDay(point.day)
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
