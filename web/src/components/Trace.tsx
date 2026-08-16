import { AxisBottom } from '@visx/axis'
import { Brush } from '@visx/brush'
import { Group } from '@visx/group'
import { scaleLinear } from '@visx/scale'
import { Bar } from '@visx/shape'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { Trace as TraceData, TraceRound } from '../api'
import { fillOf, orderOf, styleOf } from '../categories'
import { duration, percent, tokens } from '../format'
import { Tip, useTip } from './Tip'
import type { ReactElement } from 'react'

/**
 * The trace: a span of rounds, left to right, in two registered rows.
 *
 * The **ribbon** on top is the phases — consecutive rounds that were mostly the same kind of work,
 * collapsed into a band. The **strip** below is the rounds themselves, one cell each, and each cell
 * is a stack rather than a block because a round's weight splits across the work it did: a round
 * that reads three files and edits one is three quarters reconstruction, and drawing it as solidly
 * one thing would be a rounding error with a colour.
 *
 * Two axes are offered and the default is round index, evenly spaced. Wall-clock time is the
 * truthful axis for cost and the useless one for reading: a session's slowest round can be four
 * minutes and its fastest four milliseconds, so on a time axis forty rounds collapse into a sliver
 * you cannot point at. Round index makes every round clickable and hides the gaps; the toggle says
 * which one you are looking at, and the header carries both totals either way.
 *
 * Past a few dozen rounds an overview lane appears with a brush on it, and the main rows draw only
 * the brushed range. That is the Performance-panel arrangement, for the same reason it exists
 * there: the whole span has to stay visible while you look closely at part of it.
 */

/** Rounds beyond which the main rows are worth zooming into. */
const OVERVIEW_AT = 60

const RIBBON_H = 18
const STRIP_H = 54
const OVERVIEW_H = 22
const AXIS_H = 22
const GAP = 6
/** Room for the first and last axis labels, and for the ring around a selected end round. */
const PAD = 18

export type Axis = 'round' | 'time'

export function Trace({
  trace,
  selected,
  onSelect,
  onOpenTask,
}: {
  trace: TraceData
  selected: number | null
  onSelect: (round: TraceRound) => void
  /** Set on a session trace, where a round names a task you can open. */
  onOpenTask?: (task: number) => void
}): ReactElement {
  const [axis, setAxis] = useState<Axis>('round')
  const [range, setRange] = useState<[number, number] | null>(null)
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

  const all = trace.rounds
  const zoomable = all.length > OVERVIEW_AT
  const [lo, hi] = range ?? [0, Math.max(0, all.length - 1)]
  const visible = all.slice(lo, hi + 1)

  // The whole span is always reachable, so a brush that drifted past the data resets rather than
  // showing an empty chart.
  useEffect(() => {
    if (range !== null && (range[0] < 0 || range[1] > all.length - 1)) setRange(null)
  }, [all.length, range])

  const inner = Math.max(0, width - PAD * 2)
  const place = useMemo(
    () => positions(visible, axis, inner),
    [visible, axis, inner],
  )

  if (all.length === 0) {
    return <p className="note">Nothing to trace: this span has no rounds.</p>
  }

  const height =
    RIBBON_H + GAP + STRIP_H + AXIS_H + (zoomable ? OVERVIEW_H + GAP * 2 : 0)
  const stripY = RIBBON_H + GAP
  const axisY = stripY + STRIP_H
  const overviewY = axisY + AXIS_H + GAP

  const ticks = scaleLinear({
    domain: axis === 'round' ? [visible[0]!.round, visible[visible.length - 1]!.round] : place.domain,
    range: [0, inner],
  })

  return (
    <div className="trace">
      <div className="trace-bar">
        <div className="toggle" role="group" aria-label="Timeline axis">
          <button aria-pressed={axis === 'round'} onClick={() => setAxis('round')}>
            by round
          </button>
          <button aria-pressed={axis === 'time'} onClick={() => setAxis('time')}>
            by time
          </button>
        </div>
        <span>
          {all.length} rounds · {duration(trace.span.active_ms)} working ·{' '}
          {duration(trace.span.elapsed_ms)} elapsed
        </span>
        <span className="spacer" />
        {range === null || visible.length === 0 ? null : (
          // Named by the rounds themselves, not by where they sit in the array, so this agrees
          // with the axis under it and with what `probez round` would take.
          <button className="tag" onClick={() => setRange(null)}>
            rounds {visible[0]!.round}–{visible[visible.length - 1]!.round} · reset
          </button>
        )}
      </div>

      <div ref={box}>
        {inner < 40 ? null : (
          <svg width={width} height={height} role="img" aria-label="Timeline of rounds">
            {/* Phases: the smoothed story, wide enough to name. */}
            <Group top={0} left={PAD}>
              {runsIn(trace, lo, hi).map((run) => {
                const from = place.x(run.from - lo)
                const to = place.x(run.to - lo) + place.w(run.to - lo)
                const style = styleOf(run.category)
                const w = Math.max(1, to - from)
                return (
                  <Group key={`${run.from}-${run.to}`}>
                    <Bar
                      x={from}
                      y={0}
                      width={Math.max(1, w - 2)}
                      height={RIBBON_H}
                      rx={3}
                      fill={fillOf(style)}
                      opacity={0.85}
                    />
                    {w > 46 ? (
                      <text
                        x={from + 6}
                        y={RIBBON_H / 2 + 4}
                        fontSize={10}
                        fontWeight={600}
                        letterSpacing={0.4}
                        fill="var(--surface)"
                        style={{ pointerEvents: 'none', textTransform: 'uppercase' }}
                      >
                        {run.short}
                      </text>
                    ) : null}
                  </Group>
                )
              })}
            </Group>

            {/* Rounds: what actually happened, unsmoothed. */}
            <Group top={stripY} left={PAD}>
              {visible.map((round, at) => (
                <RoundCell
                  key={`${round.session}-${round.round}`}
                  round={round}
                  x={place.x(at)}
                  width={place.w(at)}
                  height={STRIP_H}
                  selected={selected === round.round}
                  onSelect={onSelect}
                  onOpenTask={onOpenTask}
                  show={show}
                  hide={hide}
                />
              ))}
            </Group>

            <Group top={axisY} left={PAD}>
              <AxisBottom
                scale={ticks}
                top={0}
                numTicks={Math.max(2, Math.min(10, Math.floor(inner / 110)))}
                stroke="var(--axis)"
                tickStroke="var(--axis)"
                tickFormat={(value) =>
                  axis === 'round'
                    ? String(Math.round(Number(value)))
                    : duration(Number(value) - place.domain[0])
                }
                tickLabelProps={() => ({
                  fill: 'var(--ink-3)',
                  fontSize: 10,
                  textAnchor: 'middle',
                  dy: '0.25em',
                })}
              />
            </Group>

            {zoomable ? (
              <Group top={overviewY} left={PAD}>
                <Overview
                  trace={trace}
                  width={inner}
                  height={OVERVIEW_H}
                  onChange={setRange}
                  range={range}
                />
              </Group>
            ) : null}
          </svg>
        )}
      </div>

      <Legend trace={trace} />

      <p className="note" style={{ margin: '2px 0 10px' }}>
        Phases are the dominant category over {trace.window} rounds, which is a choice and not a
        measurement; each cell below shows what its own round actually was.
        {zoomable ? ' Drag the lane at the bottom to look closer.' : ''}
      </p>
      <Tip tip={tip} />
    </div>
  )
}

/**
 * What the colours mean, for the categories actually on screen.
 *
 * The ribbon names its wider bands but the strip names nothing, so without this the cells are a row
 * of unexplained hues. Only what is present is listed — a legend for work this span did not do would
 * be a key to an empty room.
 */
function Legend({ trace }: { trace: TraceData }): ReactElement | null {
  const present = new Set<string | null>()
  for (const round of trace.rounds) {
    if (round.weights.length === 0) present.add(null)
    for (const part of round.weights) present.add(part.category)
  }
  if (present.size === 0) return null

  const shown = [...present].sort(
    (a, b) => orderOf(a ?? 'prose') - orderOf(b ?? 'prose'),
  )
  return (
    <div className="legend">
      {shown.map((id) => {
        const style = styleOf(id)
        return (
          <span key={id ?? 'prose'} style={{ display: 'flex', alignItems: 'center' }}>
            <span
              className={`swatch${style.hatched === true ? ' hatch' : ''}`}
              style={{ background: style.hatched === true ? undefined : style.fill }}
            />
            {style.label}
          </span>
        )
      })}
    </div>
  )
}

function RoundCell({
  round,
  x,
  width,
  height,
  selected,
  onSelect,
  onOpenTask,
  show,
  hide,
}: {
  round: TraceRound
  x: number
  width: number
  height: number
  selected: boolean
  onSelect: (round: TraceRound) => void
  onOpenTask?: (task: number) => void
  show: (event: { clientX: number; clientY: number }, body: ReactElement) => void
  hide: () => void
}): ReactElement {
  // A 2px surface gap keeps adjacent fills from reading as one mark, once there is room for it.
  const w = Math.max(1.5, width - (width > 4 ? 2 : 0))
  const stack = [...round.weights].sort((a, b) => orderOf(a.category) - orderOf(b.category))
  const total = stack.reduce((sum, part) => sum + part.weight, 0)

  let y = height
  const parts = stack.map((part) => {
    const h = total === 0 ? 0 : (part.weight / total) * height
    y -= h
    return { ...part, y, h }
  })

  return (
    <Group
      style={{ cursor: 'pointer' }}
      onClick={() => onSelect(round)}
      onDoubleClick={() => onOpenTask?.(round.task)}
      onMouseMove={(event) =>
        show(
          event,
          <>
            <strong className="mono">
              {round.ref} · {round.agent}
            </strong>
            <br />
            <span className="tip-key">work </span>
            {round.dominant === null
              ? 'prose only, no tool call'
              : `${round.dominant.short} ${percent(round.dominant.share)}`}
            <br />
            <span className="tip-key">cost </span>
            {duration(workOf(round))} · {tokens(round.in_tokens)} in · {tokens(round.out_tokens)} out
            <br />
            <span className="tip-key">of that input </span>
            {round.in_tokens === 0
              ? 'none'
              : `${percent(round.in_cache_read / round.in_tokens, 0)} reused from cache`}
            <br />
            <span className="tip-key">tools </span>
            {round.tools === 0 ? 'none' : round.tools}
            {round.errors > 0 ? ` · ${round.errors} failed` : ''}
            {onOpenTask === undefined ? null : (
              <>
                <br />
                <span className="tip-key">task {round.task} · double-click to open</span>
              </>
            )}
          </>,
        )
      }
      onMouseLeave={hide}
    >
      {parts.length === 0 ? (
        <Bar x={x} y={0} width={w} height={height} rx={2} fill="url(#probez-hatch)" opacity={0.5} />
      ) : (
        parts.map((part) => (
          <Bar
            key={part.category}
            x={x}
            y={part.y}
            width={w}
            height={Math.max(0.5, part.h)}
            rx={w > 5 ? 2 : 0}
            fill={fillOf(styleOf(part.category))}
          />
        ))
      )}
      {round.errors > 0 ? (
        <Bar x={x} y={-1} width={w} height={2.5} fill="var(--bad)" />
      ) : null}
      {selected ? (
        <Bar
          x={x - 1.5}
          y={-4}
          width={w + 3}
          height={height + 8}
          rx={3}
          fill="none"
          stroke="var(--ink)"
          strokeWidth={1.5}
        />
      ) : null}
    </Group>
  )
}

/** The whole span, always, with a brush over it. */
function Overview({
  trace,
  width,
  height,
  range,
  onChange,
}: {
  trace: TraceData
  width: number
  height: number
  range: [number, number] | null
  onChange: (range: [number, number] | null) => void
}): ReactElement {
  const all = trace.rounds
  const x = scaleLinear({ domain: [0, all.length], range: [0, width] })
  const y = scaleLinear({ domain: [0, 1], range: [height, 0] })
  const cell = width / all.length

  return (
    <>
      {/* A recessed lane, so it reads as a control rather than as a washed-out copy of the strip. */}
      <Bar x={0} y={0} width={width} height={height} rx={3} fill="var(--plane)" />
      {all.map((round, at) => (
        <Bar
          key={`${round.session}-${round.round}`}
          x={at * cell}
          y={0}
          width={Math.max(0.5, cell)}
          height={height}
          fill={fillOf(styleOf(round.phase?.category ?? null))}
          opacity={0.8}
        />
      ))}
      <Bar
        x={0}
        y={0}
        width={width}
        height={height}
        rx={3}
        fill="none"
        stroke="var(--axis)"
        strokeWidth={1}
      />
      <Brush
        xScale={x}
        yScale={y}
        width={width}
        height={height}
        margin={{ top: 0, left: 0, right: 0, bottom: 0 }}
        brushDirection="horizontal"
        resizeTriggerAreas={['left', 'right']}
        initialBrushPosition={
          range === null ? undefined : { start: { x: x(range[0]) }, end: { x: x(range[1] + 1) } }
        }
        selectedBoxStyle={{
          fill: 'var(--ink)',
          fillOpacity: 0.08,
          stroke: 'var(--ink)',
          strokeWidth: 1,
        }}
        useWindowMoveEvents
        onChange={(domain) => {
          if (domain === null) {
            onChange(null)
            return
          }
          const from = Math.max(0, Math.floor(domain.x0))
          const to = Math.min(all.length - 1, Math.ceil(domain.x1) - 1)
          // A brush narrower than a couple of rounds is a stray click, not a range.
          onChange(to - from < 2 ? null : [from, to])
        }}
      />
    </>
  )
}

/** Where each visible round sits, and how wide it is, under whichever axis is showing. */
function positions(
  visible: TraceRound[],
  axis: Axis,
  width: number,
): { x: (at: number) => number; w: (at: number) => number; domain: [number, number] } {
  if (visible.length === 0 || width <= 0) {
    return { x: () => 0, w: () => 0, domain: [0, 1] }
  }

  if (axis === 'round') {
    const cell = width / visible.length
    return { x: (at) => at * cell, w: () => cell, domain: [0, visible.length] }
  }

  // A round runs from the input that prompted it to its last output. `ts` is the first record it
  // wrote, and `ms` spans only those records, so the prompt sits `gen_ms - ms` *before* `ts`. Laying
  // the bar out from there is what makes these widths add up to the working time printed above them.
  const starts = visible.map((round) =>
    round.ts === null ? NaN : Date.parse(round.ts) + (round.ms ?? 0) - workOf(round),
  )
  const first = Math.min(...starts.filter((value) => !Number.isNaN(value)))
  const lastAt = starts.length - 1
  const last = Math.max(
    ...starts.map((value, at) => (Number.isNaN(value) ? -Infinity : value + workOf(visible[at]!))),
  )
  const span = Math.max(1, last - first)
  const scale = scaleLinear({ domain: [first, last], range: [0, width] })
  return {
    x: (at) => {
      const start = starts[at]
      return Number.isNaN(start ?? NaN) ? (at / (lastAt + 1)) * width : scale(start!)
    },
    w: (at) => {
      const start = starts[at]
      if (Number.isNaN(start ?? NaN)) return 2
      return Math.max(2, scale(start! + workOf(visible[at]!)) - scale(start!))
    },
    domain: [first, first + span],
  }
}

/**
 * How long a round worked: the model's own time, falling back to the span of its records when the
 * round had no input event to measure from. This is the same number `span.active_ms` totals.
 */
function workOf(round: TraceRound): number {
  return round.gen_ms ?? round.ms ?? 0
}

/** The runs overlapping a visible range, clipped to it. */
function runsIn(trace: TraceData, lo: number, hi: number): TraceData['runs'] {
  return trace.runs
    .filter((run) => run.to >= lo && run.from <= hi)
    .map((run) => ({
      ...run,
      from: Math.max(run.from, lo),
      to: Math.min(run.to, hi),
    }))
}
