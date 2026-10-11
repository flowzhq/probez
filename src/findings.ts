/**
 * Where a finding starts: the two lines the Findings page draws, and the file that moves them.
 *
 * Every other signal a finding reports is a count of something that either happened or did not — a
 * call failed, a question was asked again, a trail ended without acting. Two are a matter of degree,
 * and a degree needs a line: how much of a session's money went on reconstruction before that is
 * worth looking at, and how full a context got before it is a problem. Those lines are a judgement
 * about someone's own work, so they live beside the rates and the reader as a setting, and the page
 * names the one it used on every finding it draws from it.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Thresholds {
  /** Share of a session's cost spent on reconstruction, from 0 to 1, above which it is a finding. */
  reconstruction: number
  /** Share of the model's input window a round filled, from 0 to 1, above which it is a finding. */
  context: number
}

export const FINDINGS_VERSION = 1

export const DEFAULT_THRESHOLDS: Thresholds = { reconstruction: 0.4, context: 0.8 }

/** Beside `pricing.json` and `reader.json`: a setting, not a project. */
export function findingsFile(dataDir: string): string {
  return join(dataDir, 'findings.json')
}

/** A share a person could mean: above nothing and below everything. */
function asShare(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1 ? value : null
}

/**
 * The lines in force: the saved ones, and the default for any the file does not hold.
 *
 * A file that is missing or does not parse is the defaults, not an error — probez ships without one
 * — and one bad value falls back on its own rather than taking the other with it.
 */
export async function readThresholds(dataDir: string): Promise<Thresholds> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(findingsFile(dataDir), 'utf8'))
  } catch {
    return { ...DEFAULT_THRESHOLDS }
  }
  const body = (raw ?? {}) as Partial<Record<keyof Thresholds, unknown>>
  return {
    reconstruction: asShare(body.reconstruction) ?? DEFAULT_THRESHOLDS.reconstruction,
    context: asShare(body.context) ?? DEFAULT_THRESHOLDS.context,
  }
}

/**
 * The lines as a request sent them, or a reason they cannot be saved.
 *
 * Refused rather than clamped: a threshold of 140% is a typo, and quietly saving 99% instead would
 * draw a page that looks configured and is not what anyone asked for.
 */
export function thresholdsFrom(body: unknown): Thresholds | string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'expected { reconstruction, context }'
  }
  const sent = body as Partial<Record<keyof Thresholds, unknown>>
  const reconstruction = asShare(sent.reconstruction)
  const context = asShare(sent.context)
  if (reconstruction === null) return 'reconstruction must be a share between 0 and 1, such as 0.4'
  if (context === null) return 'context must be a share between 0 and 1, such as 0.8'
  return { reconstruction, context }
}

/** Written owner-only, like every other file in the store. */
export async function writeThresholds(dataDir: string, thresholds: Thresholds): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const body = { schema_version: FINDINGS_VERSION, ...thresholds }
  await writeFile(findingsFile(dataDir), JSON.stringify(body, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  })
}
