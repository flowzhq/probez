import { useState } from 'react'

import type { PeakContextDay, ReusedFreshDay } from '../api'
import { PeakOccupancyTrend } from './PeakOccupancyTrend'
import { ReusedFreshTrend } from './ReusedFreshTrend'
import type { ReactElement } from 'react'

/**
 * Project Trends panel: shared time range, then Peak context and Reused vs Fresh charts.
 *
 * The range ends at the latest task day present in either series (same `first_ts` day those charts
 * already use), not at today's calendar date.
 */

type RangeDays = 7 | 30 | 90

const RANGES: RangeDays[] = [7, 30, 90]

export function ProjectTrends({
  peak,
  reusedFresh,
}: {
  peak: PeakContextDay[]
  reusedFresh: ReusedFreshDay[]
}): ReactElement {
  const [range, setRange] = useState<RangeDays>(7)
  const end = latestDay([...peak.map((day) => day.day), ...reusedFresh.map((day) => day.day)])
  const peakInRange = end === null ? [] : daysInRange(peak, end, range)
  const reusedInRange = end === null ? [] : daysInRange(reusedFresh, end, range)

  return (
    <div>
      <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14 }}>
        Time range
        <select
          value={range}
          onChange={(event) => setRange(Number(event.target.value) as RangeDays)}
          aria-label="Trends time range"
        >
          {RANGES.map((days) => (
            <option key={days} value={days}>
              {days} days
            </option>
          ))}
        </select>
      </label>

      <div style={{ marginBottom: 28 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 600 }}>Peak context</h3>
        <p className="note" style={{ marginTop: 0 }}>
          Daily average of each task&apos;s peak context (
          <span className="mono">max(in_tokens)</span>). Occupancy % needs a published window; Peak
          Tokens does not. Days without a value are skipped rather than drawn as zero.
        </p>
        <PeakOccupancyTrend days={peakInRange} />
      </div>

      <div>
        <h3 style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 600 }}>
          Reused vs Fresh Input Tokens
        </h3>
        <p className="note" style={{ marginTop: 0 }}>
          Daily input tokens served from cached context (Reused) versus input that was not a cache
          read (Fresh). Summed per task-day — not an average.
        </p>
        <ReusedFreshTrend days={reusedInRange} />
      </div>
    </div>
  )
}

function latestDay(days: string[]): string | null {
  if (days.length === 0) return null
  return days.reduce((best, day) => (day > best ? day : best))
}

function daysInRange<T extends { day: string }>(
  days: T[],
  end: string,
  range: RangeDays,
): T[] {
  const start = shiftDay(end, -(range - 1))
  return days.filter((day) => day.day >= start && day.day <= end)
}

function shiftDay(day: string, delta: number): string {
  const at = Date.parse(`${day}T00:00:00.000Z`)
  if (Number.isNaN(at)) return day
  return new Date(at + delta * 86_400_000).toISOString().slice(0, 10)
}
