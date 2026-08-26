import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Round } from './types.js'

/**
 * What a model charges, in dollars per million tokens.
 *
 * Five rates rather than four, because a cache write has two prices: the 5-minute entry costs 1.25×
 * the input rate and the 1-hour entry 2×. That is not a rounding difference — on a store where
 * almost every write is the 1-hour kind, pricing them all at 1.25× understates the cache-write bill
 * by more than a third.
 */
export interface Rates {
  in: number
  cache_write_5m: number
  cache_write_1h: number
  cache_read: number
  out: number
}

export interface Pricing {
  schema_version: number
  /** Keyed by the model id exactly as the agent recorded it. */
  models: Record<string, Rates>
}

export const PRICING_VERSION = 1

/** The file rates live in, beside the projects rather than inside any one of them. */
export function pricingFile(dataDir: string): string {
  return join(dataDir, 'pricing.json')
}

/**
 * List prices as published, in dollars per million tokens.
 *
 * The two cache rates are derived from the input rate at the documented multipliers rather than
 * written out, so a corrected input price stays consistent with the cache prices beside it.
 *
 * Claude Sonnet 5 carries an introductory rate of $2 / $10 through 2026-08-31. The durable list
 * price is what ships here: a single rate per model cannot be right for both halves of a price
 * change, and the settings screen exists precisely so a rate that is wrong for you can be fixed.
 */
function rates(input: number, output: number): Rates {
  // Rounded because these are prices, and a price is a decimal figure: `3 * 0.1` is
  // 0.30000000000000004 in binary floating point, which is not a rate anyone published and reads
  // as a bug the moment it is shown in a text box.
  const at = (multiplier: number): number => Math.round(input * multiplier * 1e6) / 1e6
  return {
    in: input,
    cache_write_5m: at(1.25),
    cache_write_1h: at(2),
    cache_read: at(0.1),
    out: output,
  }
}

/** Every model whose price is published. Anything else is unpriced until someone says otherwise. */
export function defaultPricing(): Pricing {
  return {
    schema_version: PRICING_VERSION,
    models: {
      'claude-fable-5': rates(10, 50),
      'claude-mythos-5': rates(10, 50),
      'claude-opus-5': rates(5, 25),
      'claude-opus-4-8': rates(5, 25),
      'claude-opus-4-7': rates(5, 25),
      'claude-opus-4-6': rates(5, 25),
      'claude-sonnet-5': rates(3, 15),
      'claude-sonnet-4-6': rates(3, 15),
      'claude-haiku-4-5': rates(1, 5),
    },
  }
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Accept a rate table only if every field of it is a usable number. */
function asRates(value: unknown): Rates | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  const fields = ['in', 'cache_write_5m', 'cache_write_1h', 'cache_read', 'out'] as const
  for (const field of fields) if (!isFinitePositive(r[field])) return null
  return {
    in: r.in as number,
    cache_write_5m: r.cache_write_5m as number,
    cache_write_1h: r.cache_write_1h as number,
    cache_read: r.cache_read as number,
    out: r.out as number,
  }
}

/**
 * Read the rates. With no file, the published ones.
 *
 * The file is authoritative in full rather than merged over the defaults, so that a model can be
 * left *unpriced* on purpose. Merging would make that impossible: blanking a row would write a file
 * that omits the model, and the default would come straight back — the settings screen would offer
 * a choice it could not carry out.
 *
 * The cost is that a model added to the defaults by a later probez does not appear automatically
 * once anything has been saved. It is not silent: the model shows up in Settings with an empty row
 * and its published rate one click away, and until then its rounds are reported as outside the
 * shares rather than counted as free.
 */
export async function readPricing(dataDir: string): Promise<Pricing> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(pricingFile(dataDir), 'utf8'))
  } catch {
    return defaultPricing()
  }
  const models = (raw as { models?: unknown } | null)?.models
  if (!models || typeof models !== 'object') return defaultPricing()

  const pricing: Pricing = { schema_version: PRICING_VERSION, models: {} }
  for (const [model, value] of Object.entries(models as Record<string, unknown>)) {
    const parsed = asRates(value)
    if (parsed !== null) pricing.models[model] = parsed
  }
  return pricing
}

/** Write the rates owner-only, the same way everything else under the data directory is written. */
export async function writePricing(dataDir: string, pricing: Pricing): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const body = { schema_version: PRICING_VERSION, models: pricing.models }
  await writeFile(pricingFile(dataDir), JSON.stringify(body, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  })
}

/**
 * What one round cost, in dollars.
 *
 * Null when the model has no rate, which is not the same as free: a round that cost something
 * unknown must not be counted as a round that cost nothing, or every share around it is wrong by
 * however much it actually was.
 */
export function costOf(round: Round, pricing: Pricing): number | null {
  return priceOf(pricing, round.model, {
    uncached: round.in_uncached,
    write_5m: round.in_cache_write_5m,
    write_1h: round.in_cache_write_1h,
    cache_read: round.in_cache_read,
    out: round.out_tokens,
  })
}

/** The five counts a price is worked out from. Nulls are zero here; an absent *rate* is not. */
export interface Charged {
  uncached: number | null
  write_5m: number | null
  write_1h: number | null
  cache_read: number | null
  out: number | null
}

/**
 * The same arithmetic as `costOf`, over the counts rather than over a round.
 *
 * The search index holds those counts in columns and never builds a round, so without this it
 * would have to either carry a copy of this formula or store a price — and a stored price goes
 * silently wrong the moment somebody corrects a rate. One formula, two callers.
 */
export function priceOf(pricing: Pricing, model: string | null, charged: Charged): number | null {
  if (model === null) return null
  const rate = pricing.models[model]
  if (rate === undefined) return null
  return (
    ((charged.uncached || 0) * rate.in +
      (charged.write_5m || 0) * rate.cache_write_5m +
      (charged.write_1h || 0) * rate.cache_write_1h +
      (charged.cache_read || 0) * rate.cache_read +
      (charged.out || 0) * rate.out) /
    1_000_000
  )
}
