import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveModel } from './models.js'
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
  /**
   * Keyed by the model id exactly as the agent recorded it. A `null` is a *tombstone*: a model
   * somebody deliberately left unpriced, which is a different thing from a model this file has
   * never heard of.
   */
  models: Record<string, Rates | null>
}

export const PRICING_VERSION = 2

/** The file rates live in, beside the projects rather than inside any one of them. */
export function pricingFile(dataDir: string): string {
  return join(dataDir, 'pricing.json')
}

/** How a model prices its cache, as multiples of its input rate. */
interface CacheMultipliers {
  cacheRead?: number
  cacheWrite5m?: number
  cacheWrite1h?: number
}

/**
 * List prices as published, in dollars per million tokens.
 *
 * The cache rates are derived from the input rate at the published multipliers rather than written
 * out, so a corrected input price stays consistent with the cache prices beside it. The defaults —
 * a 5-minute write at 1.25×, a 1-hour write at 2×, a read at a tenth — hold for almost every model
 * on both providers. The two that break them say so at the call site:
 *
 * - Claude Fable 5.1 and Mythos 5.1 read the cache at 0.025×, not 0.1×.
 * - The GPT-5 generation publishes no cache-write premium at all, because OpenAI bills a write at
 *   the plain input rate. Those pass 1× for both write tiers.
 */
function rates(input: number, output: number, cache: CacheMultipliers = {}): Rates {
  // Rounded because these are prices, and a price is a decimal figure: `3 * 0.1` is
  // 0.30000000000000004 in binary floating point, which is not a rate anyone published and reads
  // as a bug the moment it is shown in a text box.
  const at = (multiplier: number): number => Math.round(input * multiplier * 1e6) / 1e6
  return {
    in: input,
    cache_write_5m: at(cache.cacheWrite5m ?? 1.25),
    cache_write_1h: at(cache.cacheWrite1h ?? 2),
    cache_read: at(cache.cacheRead ?? 0.1),
    out: output,
  }
}

/** OpenAI bills a cache write at the plain input rate, so both write tiers sit at 1×. */
const NO_WRITE_PREMIUM: CacheMultipliers = { cacheWrite5m: 1, cacheWrite1h: 1 }

/**
 * Every model the v1 default table priced, frozen.
 *
 * A v1 file was the whole truth, but only ever *relative to the table that shipped beside it*. A
 * model missing from one of them is a deliberate blank when it was on offer at the time, and simply
 * a model that did not exist yet when it was not. Migration needs to tell those apart, and the file
 * does not record which probez wrote it — so the list it could have been blanking is written here.
 *
 * Without this the migration reads every model added since as blanked on purpose, which is the very
 * failure the tombstones exist to end: on the store this was built against, all nineteen models
 * added in this version would have arrived already dead.
 *
 * Never extend this. It describes what v1 shipped, which is a fact about the past.
 */
const V1_DEFAULTS = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]

/**
 * Every model whose price is published. Anything else is unpriced until someone says otherwise.
 *
 * Retired models are here on purpose. probez reads archives, not live traffic: a store with a year
 * of history holds rounds from models nobody can call any more, and those rounds still cost what
 * they cost. A rate is only dropped from this table when it was never published.
 *
 * Two figures are approximations, recorded rather than smoothed over:
 *
 * - The GPT models tier their rates by context length — `gpt-5.6-terra` is $2/$12 below a boundary
 *   and $4/$18 above it — and the boundary is not published. `Rates` holds one rate per model, so
 *   what ships is the short-context price, which is the common case for a CLI session.
 * - `cache_write_1h` is never charged for a Codex round whatever it holds: `extract-codex.ts` puts
 *   every cache write into the 5-minute bucket and writes a zero into the 1-hour one.
 *
 * Settings exists so a rate that is wrong for you can be made right.
 */
export function defaultPricing(): Pricing {
  return {
    schema_version: PRICING_VERSION,
    models: {
      // Claude. Cache reads on the 5.1 pair are 0.025× input, not the 0.1× every other model uses.
      'claude-fable-5-1': rates(10, 50, { cacheRead: 0.025 }),
      'claude-mythos-5-1': rates(10, 50, { cacheRead: 0.025 }),
      'claude-fable-5': rates(10, 50),
      'claude-mythos-5': rates(10, 50),
      'claude-opus-5': rates(5, 25),
      'claude-opus-4-8': rates(5, 25),
      'claude-opus-4-7': rates(5, 25),
      'claude-opus-4-6': rates(5, 25),
      'claude-opus-4-5': rates(5, 25),
      'claude-opus-4-1': rates(15, 75),
      // Two spellings of one model — see the same pair in `CONTEXT_WINDOWS`.
      'claude-opus-4-0': rates(15, 75),
      'claude-opus-4': rates(15, 75),
      // $2/$10 was announced as an introductory rate through 2026-08-31, and probez shipped $3/$15
      // on the reasoning that the durable price was the right one to hold. Anthropic then cancelled
      // that increase: $2/$10 is the standard price, and the scheduled rise will not happen.
      'claude-sonnet-5': rates(2, 10),
      'claude-sonnet-4-6': rates(3, 15),
      'claude-sonnet-4-5': rates(3, 15),
      'claude-sonnet-4-0': rates(3, 15),
      'claude-sonnet-4': rates(3, 15),
      'claude-haiku-4-5': rates(1, 5),
      'claude-3-5-haiku': rates(0.8, 4),

      // Codex. The current four publish a cache-write premium at the same 1.25× Anthropic uses.
      'gpt-6-astra': rates(10, 50),
      'gpt-5.6-sol': rates(4, 20),
      'gpt-5.6-terra': rates(2, 12),
      'gpt-5.6-luna': rates(0.2, 1.2),
      // The GPT-5 generation publishes no cache-write price at all.
      'gpt-5.5': rates(5, 30, NO_WRITE_PREMIUM),
      'gpt-5.4': rates(2.5, 15, NO_WRITE_PREMIUM),
      'gpt-5.4-mini': rates(0.75, 4.5, NO_WRITE_PREMIUM),
      'gpt-5.3-codex': rates(1.75, 14, NO_WRITE_PREMIUM),
      'gpt-5.2': rates(1.75, 14, NO_WRITE_PREMIUM),
      'gpt-5.1': rates(1.25, 10, NO_WRITE_PREMIUM),
      'gpt-5': rates(1.25, 10, NO_WRITE_PREMIUM),
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
 * Read the rates: the published ones, overlaid with whatever this machine saved.
 *
 * The file used to be authoritative in full, so that a model could be left *unpriced* on purpose —
 * blanking a row wrote a file that omitted the model, and merging the defaults back would have made
 * the row reappear. The cost of that was steep and invisible: absence meant two things at once, so
 * a model added to the defaults by a later probez could never reach anyone who had saved even once.
 *
 * A blank now has its own spelling. A tombstone — the model present with a `null` beside it — says
 * "deliberately unpriced", and absence goes back to meaning "never heard of it", which is the thing
 * a default is for. Reading a v1 file tombstones the models it omits *that v1 also offered*, so a
 * row somebody blanked stays blank while every model added since flows in. See `V1_DEFAULTS`.
 */
export async function readPricing(dataDir: string): Promise<Pricing> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(pricingFile(dataDir), 'utf8'))
  } catch {
    return defaultPricing()
  }
  const body = raw as { schema_version?: unknown; models?: unknown } | null
  const saved = body?.models
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return defaultPricing()
  const rows = saved as Record<string, unknown>

  const models: Record<string, Rates | null> = { ...defaultPricing().models }
  const version = typeof body?.schema_version === 'number' ? body.schema_version : 1
  if (version < 2) {
    for (const model of V1_DEFAULTS) {
      if (!Object.hasOwn(rows, model)) models[model] = null
    }
  }
  for (const [model, value] of Object.entries(rows)) {
    if (value === null) {
      models[model] = null
      continue
    }
    const parsed = asRates(value)
    if (parsed !== null) models[model] = parsed
  }
  return { schema_version: PRICING_VERSION, models }
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
 *
 * The lookup goes through `resolveModel`, so a rate set against `claude-haiku-4-5` also prices the
 * `claude-haiku-4-5-20251001` rounds Claude Code actually recorded — including a rate typed into
 * Settings, since what is asked is this table rather than the shipped one.
 */
export function priceOf(pricing: Pricing, model: string | null, charged: Charged): number | null {
  const id = resolveModel(model, (one) => pricing.models[one] != null)
  if (id === null) return null
  const rate = pricing.models[id]
  if (rate === undefined || rate === null) return null
  return (
    ((charged.uncached || 0) * rate.in +
      (charged.write_5m || 0) * rate.cache_write_5m +
      (charged.write_1h || 0) * rate.cache_write_1h +
      (charged.cache_read || 0) * rate.cache_read +
      (charged.out || 0) * rate.out) /
    1_000_000
  )
}
