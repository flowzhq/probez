import { AxisBottom } from '@visx/axis'
import { Brush } from '@visx/brush'
import { Group } from '@visx/group'
import { scaleLinear } from '@visx/scale'
import { Bar } from '@visx/shape'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { Question, Trace as TraceData, TraceRound, Trail } from '../api'
import { fillOf, orderOf, shadeOf, styleOf } from '../categories'
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
 * Between the two, when a task made any, is the bracket lane. It draws one of two readings of the
 * same calls, on a toggle: **trails**, runs of calls that followed one another into the repository —
 * a listing, then the files it named, then a grep, then the lines the grep hit — or **questions**,
 * one thing the agent needed to know and every call it spent finding out.
 *
 * The ribbon can show neither, because neither is a stretch of rounds. A trail is what the evidence
 * connects, so one interrupted by an edit and resumed four rounds later is still one trail; a
 * question is what chased one word, so a grep run for the sixth time is still that question.
 * Drawing them as brackets over the rounds they touched is the only way to see either.
 *
 * Past a few dozen rounds an overview lane appears with a brush on it, and the main rows draw only
 * the brushed range. That is the Performance-panel arrangement, for the same reason it exists
 * there: the whole span has to stay visible while you look closely at part of it.
 */

/** Rounds beyond which the main rows are worth zooming into. */
const OVERVIEW_AT = 60

const RIBBON_H = 18
/** One row of the bracket lane. Two spans that overlap in rounds get a row each, not a pile. */
const LANE_H = 15
/** Rows of brackets drawn before the rest are folded into the last one. */
const LANE_ROWS = 3
const STRIP_H = 54
const OVERVIEW_H = 22
const AXIS_H = 22
const GAP = 6
/** Room for the first and last axis labels, and for the ring around a selected end round. */
const PAD = 18

export type Axis = 'round' | 'time'

export function Trace({
  trace,
  trails,
  selected,
  selectedTrail,
  questions,
  selectedQuestion,
  matched,
  onSelect,
  onSelectTrail,
  onSelectQuestion,
  onOpenTask,
}: {
  trace: TraceData
  /** The trails over these rounds, when the payload carries any. */
  trails?: Trail[]
  selected: number | null
  /** The `ref` of the trail being looked at, which lifts its rounds out of the strip. */
  selectedTrail?: string | null
  /** The questions over these rounds, which is the other reading of the same calls. */
  questions?: Question[]
  /** The `at` of the question being looked at. See `Question.at`: a ref names two of them. */
  selectedQuestion?: number | null
  /**
   * Rounds a search matched, which are lit while the rest are dimmed.
   *
   * Null when no query is in play, which is the ordinary case. Every round is still drawn either
   * way: a trace with the unmatched rounds removed would be a different picture of a different
   * task, and the thing worth seeing is *where in the task* the matches fall.
   */
  matched?: Set<number> | null
  onSelect: (round: TraceRound) => void
  onSelectTrail?: (trail: Trail | null) => void
  onSelectQuestion?: (question: Question | null) => void
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
  /**
   * Questions that span more than one call, which are the only ones a bracket can draw.
   *
   * A question answered in a single call is a point, not a span. Most questions are — 780 of 1031
   * against probez's own store — so drawing them would fill the lane with slivers that say nothing
   * happened. They are counted under the trace instead, because a lane that drops three quarters of
   * its subject without saying so is worse than no lane.
   */
  const spans = useMemo(
    () => (questions ?? []).filter((question) => question.calls.length > 1),
    [questions],
  )
  const placedTrails = useMemo(
    () => packed(trails ?? [], (trail) => trail.steps.map((step) => step.round), all),
    [trails, all],
  )
  const placedQuestions = useMemo(
    () => packed(spans, (question) => question.calls.map((call) => call.round), all),
    [spans, all],
  )

  /**
   * Which reading the lane is drawing.
   *
   * One lane and not two. The brackets would overlap heavily — they are readings of the same calls,
   * so a trail and a question routinely cover the same rounds — and two near-identical bars over one
   * strip is a puzzle no legend solves. Selecting one already closes the other, and a toggle makes
   * that a choice rather than a surprise.
   */
  const [lane, setLane] = useState<'trails' | 'questions'>('trails')
  // Arriving with one already chosen — from a link, or from the table under the trace — shows the
  // lane it belongs to. Otherwise the bracket that is lit is one the lane is not drawing.
  useEffect(() => {
    if (selectedQuestion !== undefined && selectedQuestion !== null) setLane('questions')
    else if (selectedTrail !== undefined && selectedTrail !== null) setLane('trails')
  }, [selectedTrail, selectedQuestion])
  const showing = lane === 'questions' && placedQuestions.length > 0 ? 'questions' : 'trails'

  // Which rounds the chosen reading touched. Neither is a stretch of rounds, so this cannot be a
  // range: it is the set of calls that belong to it, and the ones in between do not.
  const inTrail = useMemo(() => {
    const asked = spans.find((question) => question.at === selectedQuestion)
    if (asked !== undefined) return new Set(asked.calls.map((call) => call.round))
    const chosen = (trails ?? []).find((trail) => trail.ref === selectedTrail)
    return chosen === undefined ? null : new Set(chosen.steps.map((step) => step.round))
  }, [trails, selectedTrail, spans, selectedQuestion])

  if (all.length === 0) {
    return <p className="note">Nothing to trace: this span has no rounds.</p>
  }

  const drawn = showing === 'questions' ? placedQuestions : placedTrails
  const once = (questions ?? []).length - spans.length
  // Whether the reading on show has one picked out, which is what sends the rest of the lane back.
  // Asked of the reading being drawn and not of trails alone, or choosing a question would leave
  // every other question at full strength while the strip below it had already faded.
  const chosen =
    showing === 'questions'
      ? selectedQuestion !== null && selectedQuestion !== undefined
      : selectedTrail !== null && selectedTrail !== undefined
  const laneRows = drawn.length === 0 ? 0 : Math.max(...drawn.map((one) => one.row)) + 1
  const laneH = laneRows === 0 ? 0 : laneRows * LANE_H + GAP
  const height =
    RIBBON_H + GAP + laneH + STRIP_H + AXIS_H + (zoomable ? OVERVIEW_H + GAP * 2 : 0)
  const laneY = RIBBON_H + GAP
  const stripY = laneY + laneH
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
        {/* Only offered when there is something to switch between. A toggle with one live side is
            a control that says the other reading exists and then refuses to show it. */}
        {placedTrails.length > 0 && placedQuestions.length > 0 ? (
          <div className="toggle" role="group" aria-label="What the lane draws">
            <button aria-pressed={showing === 'trails'} onClick={() => setLane('trails')}>
              trails
            </button>
            <button aria-pressed={showing === 'questions'} onClick={() => setLane('questions')}>
              questions
            </button>
          </div>
        ) : null}
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

            {/* Walks: what the agent followed into, over the rounds it took to do it. */}
            <Group top={laneY} left={PAD}>
              {drawn.map((one) => {
                if (one.to < lo || one.from > hi) return null
                const a = Math.max(one.from, lo) - lo
                const b = Math.min(one.to, hi) - lo
                const x = place.x(a)
                const w = Math.max(2, place.x(b) + place.w(b) - x)
                // The two readings differ in what a bracket says, not in how it is drawn, so the
                // difference is four values rather than a second copy of this block.
                const bar =
                  showing === 'questions'
                    ? questionBar(one.item as Question, selectedQuestion ?? null)
                    : trailBar(one.item as Trail, selectedTrail ?? null)
                return (
                  <Group
                    key={bar.key}
                    style={{ cursor: 'pointer' }}
                    onClick={() => {
                      // Clicking the chosen one again puts the strip back, so the lane is a filter
                      // you can turn off where you turned it on. Picking is the whole click: the
                      // round it starts at gets opened by whoever owns the selection, because both
                      // halves of that live in one place.
                      if (showing === 'questions') {
                        const asked = one.item as Question
                        onSelectQuestion?.(bar.selected ? null : asked)
                      } else {
                        const trail = one.item as Trail
                        onSelectTrail?.(bar.selected ? null : trail)
                      }
                    }}
                    onMouseMove={(event) => show(event, bar.tip)}
                    onMouseLeave={hide}
                  >
                    <Bar
                      x={x}
                      y={one.row * LANE_H}
                      width={w}
                      height={LANE_H - 4}
                      rx={2}
                      fill={bar.hatched ? 'url(#probez-hatch)' : 'var(--ink-3)'}
                      opacity={
                        !chosen ? (bar.strong ? 0.85 : 0.5) : bar.selected ? 1 : 0.18
                      }
                      stroke={bar.selected ? 'var(--ink)' : undefined}
                      strokeWidth={bar.selected ? 1 : undefined}
                    />
                    {w > 58 ? (
                      <text
                        x={x + 5}
                        y={one.row * LANE_H + LANE_H - 8}
                        fontSize={9}
                        fontWeight={600}
                        letterSpacing={0.3}
                        // On a hatched bar the label sits over the pattern rather than over ink,
                        // so it takes the page's own text colour. `--ink-3` was legible while
                        // hatching meant "abandoned" and was rare; a question is hatched whenever
                        // any of it was re-asking, which is most of the expensive ones.
                        fill={bar.hatched ? 'var(--ink)' : 'var(--surface)'}
                        style={{ pointerEvents: 'none' }}
                      >
                        {bar.label}
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
                  faded={
                    (inTrail !== null && !inTrail.has(round.round)) ||
                    (matched !== null && matched !== undefined && !matched.has(round.round))
                  }
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
        {drawn.length === 0
          ? ''
          : showing === 'questions'
            ? ` The ${drawn.length === 1 ? 'bracket' : 'brackets'} between them ${drawn.length === 1 ? 'is a question' : 'are questions'}: one thing the agent needed to know, and every call it spent finding out. Hatched means part of it was asking again what it had already asked. Click one to light up the rounds it touched and read every call it took.`
            : ` The ${drawn.length === 1 ? 'bracket' : 'brackets'} between them ${drawn.length === 1 ? 'is a trail' : 'are trails'}: a run of calls that followed one another into the repository. Hatched means it ended without changing anything it had been to. Click one to light up the rounds it touched and read it hop by hop.`}
        {/* A lane that quietly drops three quarters of its subject would read as "this task asked
            nine questions" when it asked nineteen. The ones it cannot draw are counted here. */}
        {showing === 'questions' && once > 0
          ? ` ${once} more ${once === 1 ? 'question was' : 'questions were'} answered in a single call, which is a point rather than a span, and ${once === 1 ? 'is' : 'are'} not drawn.`
          : ''}
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
  faded,
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
  /** True when a trail or a question is chosen and this round is not one of its calls. */
  faded?: boolean
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
      // Dimming the rest rather than outlining the members: a trail can touch six rounds out of a
      // hundred and twenty, and six outlines in a barcode are not findable. Turning the other
      // hundred and fourteen down leaves it as the only thing lit.
      style={{ cursor: 'pointer', opacity: faded === true ? 0.16 : 1 }}
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
            {round.in_tokens === null
              ? 'not recorded'
              : round.in_tokens === 0
              ? 'none'
              : `${percent(round.in_cache_read! / round.in_tokens, 0)} reused from cache`}
            <br />
            <span className="tip-key">tools </span>
            {round.tools === 0 ? 'none' : round.tools}
            {round.errors > 0 ? ` · ${round.errors} failed` : ''}
            {/* What the bands in this cell are. A shade is only readable if something says which
                sub it is, and the legend cannot: it names the eight colours, and a shade is a
                distinction inside one of them. */}
            {parts.length === 0 ? null : (
              <>
                <br />
                <span className="tip-key">counted as </span>
                {parts
                  .map((part) => `${part.sub} ${percent(part.weight / (total || 1), 0)}`)
                  .join(' · ')}
              </>
            )}
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
            key={`${part.category}/${part.sub}`}
            x={x}
            y={part.y}
            width={w}
            height={Math.max(0.5, part.h)}
            rx={w > 5 ? 2 : 0}
            fill={fillOf(styleOf(part.category))}
            // Shaded within the category's colour, the same way the work table shades a sub-row.
            // The strip is where you look to find *where in a task* something happened, and a
            // round that queried a code graph is otherwise the same orange as one that grepped.
            opacity={shadeOf(part.category, part.sub)}
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

/**
 * What one bracket says, for either reading.
 *
 * The lane draws trails and questions identically — a bar over the rounds it covers — and they
 * differ only in what the bar means. Naming that difference as four values keeps the drawing in one
 * place instead of two blocks that have to be kept looking alike.
 */
interface LaneBar {
  key: string
  label: string
  /** Went nowhere useful: a trail that changed nothing, a question part of which was re-asking. */
  hatched: boolean
  /** Worth the eye. A trail that landed a change; a question that cost more than a call or two. */
  strong: boolean
  selected: boolean
  tip: ReactElement
}

function trailBar(trail: Trail, selectedTrail: string | null): LaneBar {
  return {
    key: `${trail.session}-${trail.ref}`,
    label: `${trail.depth} hops`,
    hatched: trail.outcome === 'abandoned',
    strong: trail.outcome === 'edit',
    selected: trail.ref === selectedTrail,
    tip: (
      <>
        <strong className="mono">
          trail {trail.ref} → {trail.last}
        </strong>
        <br />
        <span className="tip-key">went </span>
        {trail.depth} hops from a {trail.root} · {trail.breadth} wide · {trail.paths} paths
        <br />
        <span className="tip-key">ended </span>
        {trail.outcome}
        {trail.ended_on === '' ? '' : ` ${trail.ended_on}`}
        <br />
        <span className="tip-key">cost </span>
        {duration(trail.ms)} · {tokens(trail.in_tokens)} in · {tokens(trail.out_tokens)} out
        <br />
        <span className="tip-key">hops </span>
        {trail.confidence === 'proven'
          ? 'read out of the results'
          : 'inferred from what the calls asked for'}
      </>
    ),
  }
}

function questionBar(question: Question, selectedQuestion: number | null): LaneBar {
  const waste = [
    question.repeats > 0 ? `${question.repeats} re-asked` : '',
    question.fetches > 0 ? `${question.fetches} fetched a body` : '',
    question.sweeps > 0 ? `${question.sweeps} guessed at words` : '',
  ].filter((part) => part !== '')
  return {
    key: `${question.session}-${question.at}`,
    label: `${question.calls.length} calls`,
    // Hatched means the same thing it does on a trail: part of this went nowhere. On a question
    // that is the re-asking, which is the one kind of waste a trail cannot show at all.
    hatched: question.repeats > 0,
    strong: question.calls.length > 3,
    selected: question.at === selectedQuestion,
    tip: (
      <>
        <strong className="mono">
          question {question.ref} → {question.last}
        </strong>
        <br />
        <span className="tip-key">wanted </span>
        {question.terms.length === 0 ? 'nothing by name' : question.terms.slice(0, 6).join(', ')}
        <br />
        <span className="tip-key">cost </span>
        {question.calls.length} calls ·{' '}
        {question.files.length === 0
          ? 'no place named'
          : `${question.files.length} place${question.files.length === 1 ? '' : 's'}`}{' '}
        · {question.kind}
        <br />
        {waste.length === 0 ? null : (
          <>
            <span className="tip-key">wasted </span>
            {waste.join(' · ')}
            <br />
          </>
        )}
        <span className="tip-key">spent </span>
        {duration(question.ms)} · {tokens(question.in_tokens)} in · {tokens(question.out_tokens)} out
      </>
    ),
  }
}

/** One reading placed over the rounds it touched, and which row of the lane it draws in. */
interface Placed<T> {
  item: T
  from: number
  to: number
  row: number
}

/**
 * Place each span over the rounds it touched, stacking the ones that overlap.
 *
 * Neither a trail nor a question is a stretch of rounds — a trail is what the evidence connects and a
 * question is what chased one word — so two of them can share rounds, and drawing both on one line
 * would put one on top of the other. Rows are assigned greedily, longest first so the span you
 * notice is the one that spans the most, and everything past the third row folds into it: a lane
 * taller than the strip below it would be a legend for a chart rather than part of one.
 *
 * Generic over what is being placed, because the two readings differ only in where their rounds
 * come from. One packer, so a question's lane cannot quietly stack differently from a trail's.
 */
function packed<T>(
  items: T[],
  roundsOf: (item: T) => number[],
  all: TraceRound[],
): Placed<T>[] {
  const at = new Map<number, number>()
  all.forEach((round, index) => at.set(round.round, index))

  const spans = items
    .map((item) => {
      const indices = roundsOf(item)
        .map((round) => at.get(round))
        .filter((i): i is number => i !== undefined)
      if (indices.length === 0) return null
      return { item, from: Math.min(...indices), to: Math.max(...indices) }
    })
    .filter((span): span is { item: T; from: number; to: number } => span !== null)
    .sort((a, b) => b.to - b.from - (a.to - a.from) || a.from - b.from)

  // The rightmost round each row has been filled to, which is all a greedy packer needs.
  const filled: number[] = []
  return spans.map((span) => {
    let row = filled.findIndex((end) => end < span.from)
    if (row === -1) {
      row = Math.min(filled.length, LANE_ROWS - 1)
      if (row === filled.length) filled.push(span.to)
    }
    filled[row] = Math.max(filled[row] ?? span.to, span.to)
    return { ...span, row }
  })
}
