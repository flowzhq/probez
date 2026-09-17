import { AxisBottom, AxisLeft } from '@visx/axis'
import { Group } from '@visx/group'
import { scaleLinear } from '@visx/scale'
import { Circle, Line, LinePath } from '@visx/shape'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { Trace as TraceData, TraceRound } from '../api'
import { percent, tokens } from '../format'
import { Facts } from './Chrome'
import { contextBand } from './Inspector'
import { Tip, useTip } from './Tip'
import type { ReactElement } from 'react'

/**
 * Context usage across a session: how full the model's input window was, round by round.
 *
 * `in_tokens` is that round's actual usage, never a running total, so a drop after compaction is
 * real. Coverage is often partial — a late Cursor hook, a model that never reports usage — so this
 * never fills, connects across, or estimates a round that recorded none. The chart is a sparkline
 * built only from the rounds that have data (no empty slot for the ones that don't), which is what
 * keeps it readable when coverage is thin; the peak / last / median summary above it carries the
 * "how full does this get" answer even when the chart itself has too few points to show a trend.
 * Collapsed by default so the session page stays quiet; nothing mounts until opened.
 */

type Axis = 'round' | 'time'

const H = 140
const PAD = { top: 10, right: 12, bottom: 24, left: 44 }

export function ContextUsage({ trace }: { trace: TraceData }): ReactElement {
  const [open, setOpen] = useState(false)
  const measured = trace.rounds.filter((round) => typeof round.in_tokens === 'number')
  const hasData = measured.length > 0

  return (
    <div className="context-usage">
      <button
        type="button"
        className="context-usage-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="context-usage-chevron" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        Context usage
        {!hasData ? <span className="muted"> · no data</span> : null}
      </button>
      {open ? (
        hasData ? (
          <ContextUsageBody total={trace.rounds.length} measured={measured} />
        ) : (
          <p className="note" style={{ margin: '8px 0 4px' }}>
            No context usage data available
          </p>
        )
      ) : null}
    </div>
  )
}

function ContextUsageBody({
  total,
  measured,
}: {
  total: number
  measured: TraceRound[]
}): ReactElement {
  const [axis, setAxis] = useState<Axis>('round')
  const windowLimit = sharedWindow(measured)

  return (
    <div className="context-usage-body">
      <ContextSummary measured={measured} windowLimit={windowLimit} />

      <div className="trace-bar" style={{ marginBottom: 6 }}>
        <div className="toggle" role="group" aria-label="Context usage axis">
          <button type="button" aria-pressed={axis === 'round'} onClick={() => setAxis('round')}>
            by round
          </button>
          <button type="button" aria-pressed={axis === 'time'} onClick={() => setAxis('time')}>
            by time
          </button>
        </div>
        <span>
          {measured.length} / {total} rounds have context data
        </span>
        <span className="spacer" />
        {windowLimit !== null ? <span>limit {tokens(windowLimit)}</span> : null}
      </div>

      <ContextSparkline measured={measured} axis={axis} windowLimit={windowLimit} />
    </div>
  )
}

function ContextSparkline({
  measured,
  axis,
  windowLimit,
}: {
  measured: TraceRound[]
  axis: Axis
  windowLimit: number | null
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

  const points = useMemo(() => placePoints(measured, axis), [measured, axis])
  const values = useMemo(() => measured.map((round) => round.in_tokens as number), [measured])
  const maxTokens = Math.max(...values, windowLimit ?? 0)
  const innerW = Math.max(0, width - PAD.left - PAD.right)
  const innerH = H - PAD.top - PAD.bottom
  const markR = measured.length > 120 ? 2 : measured.length > 60 ? 2.5 : 3.5

  const x = scaleLinear({ domain: points.domain, range: [0, innerW] })
  const y = scaleLinear({
    domain: [0, maxTokens > 0 ? maxTokens : 1],
    range: [innerH, 0],
    nice: true,
  })

  const series = measured.map((round, at) => ({
    round,
    at,
    x: points.x(at),
    tokens: values[at]!,
  }))

  return (
    <div ref={box}>
      {innerW < 40 ? null : (
        <svg
          width={width}
          height={H}
          role="img"
          aria-label="Context tokens for rounds with data"
          onMouseLeave={hide}
        >
          <Group top={PAD.top} left={PAD.left}>
            {windowLimit !== null ? (
              <Line
                from={{ x: 0, y: y(windowLimit) }}
                to={{ x: innerW, y: y(windowLimit) }}
                stroke="var(--ink-3)"
                strokeWidth={1}
                strokeDasharray="4 4"
                strokeOpacity={0.7}
              />
            ) : null}

            <LinePath
              data={series}
              x={(d) => x(d.x)}
              y={(d) => y(d.tokens)}
              stroke="var(--accent)"
              strokeWidth={1.5}
              fill="none"
            />

            {series.map((point) => (
              <Circle
                key={`${point.round.round}-${point.at}`}
                cx={x(point.x)}
                cy={y(point.tokens)}
                r={markR}
                fill="var(--accent)"
                stroke="var(--surface)"
                strokeWidth={1}
                style={{ cursor: 'default' }}
                onMouseMove={(event) =>
                  show(
                    event,
                    <ContextTip
                      round={point.round}
                      context={point.tokens}
                      window={point.round.context_window}
                      share={point.round.context_share}
                    />,
                  )
                }
                onMouseLeave={hide}
              />
            ))}

            <AxisLeft
              scale={y}
              stroke="var(--axis)"
              tickStroke="var(--axis)"
              tickFormat={(value) => tokens(Number(value))}
              tickLabelProps={() => ({
                fill: 'var(--ink-3)',
                fontSize: 10,
                textAnchor: 'end',
                dx: -4,
                dy: 3,
              })}
              numTicks={4}
              hideAxisLine
            />
            <AxisBottom
              top={innerH}
              scale={x}
              stroke="var(--axis)"
              tickStroke="var(--axis)"
              tickValues={axisTicks(measured, axis, points.domain)}
              tickFormat={(value) =>
                axis === 'round'
                  ? `R${measured[Math.round(Number(value))]?.round ?? ''}`
                  : formatTickTime(Number(value))
              }
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

function ContextTip({
  round,
  context,
  window: limit,
  share,
}: {
  round: TraceRound
  context: number
  window: number | null
  share: number | null
}): ReactElement {
  return (
    <div>
      <div>
        <strong>Round {round.round}</strong>
        {round.ref ? <span className="muted"> · {round.ref}</span> : null}
      </div>
      <div>
        Context: {tokens(context)}
        {limit !== null ? ` / ${tokens(limit)}` : ''}
      </div>
      {share !== null ? <div>Usage: {percent(share, 0)}</div> : null}
    </div>
  )
}

/** Peak, most-recent, median, and (when a window is known) peak-as-percent-of-window across every
 * measured round — the "how full does this session get" answer that a sparse or noisy chart can't
 * give at a glance. The window figure uses peak rather than last: it answers "how close did this
 * session come to running out of room," which is the number worth flagging. */
function ContextSummary({
  measured,
  windowLimit,
}: {
  measured: TraceRound[]
  windowLimit: number | null
}): ReactElement | null {
  if (measured.length === 0) return null
  const values = measured.map((round) => round.in_tokens as number)
  const peak = Math.max(...values)
  const last = values[values.length - 1]!
  const mid = median(values)
  const known = windowLimit !== null && windowLimit > 0

  const band = (value: number): string | undefined =>
    known ? contextBand(value / windowLimit!) : undefined

  return (
    <Facts
      items={[
        ['peak', <span className={band(peak)}>{tokens(peak)}</span>],
        ['last', <span className={band(last)}>{tokens(last)}</span>],
        ['median', <span className={band(mid)}>{tokens(mid)}</span>],
        [
          'of window',
          known ? <span className={band(peak)}>{percent(peak / windowLimit!, 0)}</span> : null,
        ],
      ]}
    />
  )
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

/** One input-room size when every measured round agrees; otherwise null (no invented limit). */
function sharedWindow(measured: TraceRound[]): number | null {
  const windows = new Set<number>()
  for (const round of measured) {
    if (round.context_window === null || round.context_window === undefined) return null
    windows.add(round.context_window)
  }
  return windows.size === 1 ? [...windows][0]! : null
}

/**
 * Place each measured round on X, in the order it occurred, with no slot for the rounds in
 * between that recorded nothing — that's what keeps the sparkline from stretching thin data
 * across the whole session. "By round" spaces points evenly, one per sample; "by time" spaces
 * them by real elapsed time between samples (falling back to even spacing when a timestamp is
 * missing), so a burst of rounds still reads as a burst.
 */
function placePoints(
  measured: TraceRound[],
  axis: Axis,
): { x: (at: number) => number; domain: [number, number] } {
  if (measured.length === 0) return { x: () => 0, domain: [0, 1] }

  if (axis === 'round') {
    return { x: (at) => at, domain: [0, Math.max(1, measured.length - 1)] }
  }

  const times = measured.map((round) => (round.ts === null ? NaN : Date.parse(round.ts)))
  const known = times.filter((value) => !Number.isNaN(value))
  if (known.length === 0) {
    return { x: (at) => at, domain: [0, Math.max(1, measured.length - 1)] }
  }
  const first = Math.min(...known)
  const last = Math.max(...known)
  return {
    x: (at) => {
      const value = times[at]!
      return Number.isNaN(value)
        ? first + (at / Math.max(1, measured.length - 1)) * (last - first)
        : value
    },
    domain: [first, last === first ? first + 1 : last],
  }
}

function axisTicks(measured: TraceRound[], axis: Axis, domain: [number, number]): number[] {
  if (axis === 'round') {
    if (measured.length <= 8) return measured.map((_, at) => at)
    const step = Math.ceil(measured.length / 7)
    const ticks: number[] = []
    for (let at = 0; at < measured.length; at += step) ticks.push(at)
    if (ticks[ticks.length - 1] !== measured.length - 1) ticks.push(measured.length - 1)
    return ticks
  }
  const [lo, hi] = domain
  const mid = lo + (hi - lo) / 2
  return [lo, mid, hi]
}

function formatTickTime(ms: number): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}
