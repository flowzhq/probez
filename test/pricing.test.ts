import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  costOf,
  defaultPricing,
  PRICING_VERSION,
  pricingFile,
  readPricing,
  writePricing,
} from '../src/pricing.js'
import { ROUND_DEFAULTS } from './support.js'

function store(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'probez-pricing-')))
}

test('the published rates derive the cache prices from the input price', () => {
  const opus = defaultPricing().models['claude-opus-5']!
  assert.equal(opus.in, 5)
  assert.equal(opus.out, 25)
  // A 5-minute entry is 1.25x input, a 1-hour entry 2x, and a read a tenth.
  assert.equal(opus.cache_write_5m, 6.25)
  assert.equal(opus.cache_write_1h, 10)
  assert.equal(opus.cache_read, 0.5)
})

test('a round is charged each class of token at its own rate', () => {
  const pricing = {
    schema_version: 1,
    models: {
      m: { in: 10, cache_write_5m: 12.5, cache_write_1h: 20, cache_read: 1, out: 50 },
    },
  }
  const round = {
    ...ROUND_DEFAULTS,
    model: 'm',
    in_uncached: 1_000_000,
    in_cache_write_5m: 1_000_000,
    in_cache_write_1h: 1_000_000,
    in_cache_read: 1_000_000,
    out_tokens: 1_000_000,
  }
  // A million of each, so the total is the rates added up.
  assert.equal(costOf(round, pricing), 10 + 12.5 + 20 + 1 + 50)
})

test('a model with no rate costs nothing knowable, which is not nothing', () => {
  const pricing = defaultPricing()
  const round = { ...ROUND_DEFAULTS, model: 'no-such-model', in_uncached: 1_000_000 }
  // Null rather than 0: a caller that adds this to a total would report a cost it does not know.
  assert.equal(costOf(round, pricing), null)
  assert.equal(costOf({ ...ROUND_DEFAULTS, model: null }, pricing), null)
})

test('with no file, the published rates apply', async () => {
  const dir = store()
  const pricing = await readPricing(dir)
  assert.deepEqual(pricing.models['claude-opus-5'], defaultPricing().models['claude-opus-5'])
})

test('a tombstone leaves a model unpriced on purpose, and survives a read', async () => {
  const dir = store()
  await writePricing(dir, {
    schema_version: PRICING_VERSION,
    models: {
      'claude-opus-5': { in: 1, cache_write_5m: 2, cache_write_1h: 3, cache_read: 4, out: 5 },
      'claude-fable-5': null,
    },
  })
  const pricing = await readPricing(dir)
  assert.equal(pricing.models['claude-opus-5']?.in, 1)
  // Blanking a row has to be spellable, or the settings screen offers a choice it cannot carry out.
  assert.equal(pricing.models['claude-fable-5'], null)
  assert.equal(costOf({ ...ROUND_DEFAULTS, model: 'claude-fable-5', in_uncached: 1e6 }, pricing), null)
})

test('a model the saved file never mentions is priced from the defaults', async () => {
  const dir = store()
  await writePricing(dir, {
    schema_version: PRICING_VERSION,
    models: { 'claude-opus-5': { in: 1, cache_write_5m: 2, cache_write_1h: 3, cache_read: 4, out: 5 } },
  })
  const pricing = await readPricing(dir)
  // The point of the merge: a model shipped by a later probez reaches a machine that has saved.
  assert.deepEqual(pricing.models['claude-sonnet-5'], defaultPricing().models['claude-sonnet-5'])
})

test('migrating a v1 file keeps the rows it blanked and takes the models it never saw', async () => {
  const dir = store()
  // What an older probez wrote: authoritative in full, so a model it omits *that v1 also offered*
  // was omitted on purpose. A model v1 never shipped cannot have been blanked on purpose, and must
  // arrive from the defaults — otherwise every model added since is dead the moment it ships.
  writeFileSync(
    pricingFile(dir),
    JSON.stringify({
      schema_version: 1,
      models: { 'claude-opus-5': { in: 1, cache_write_5m: 2, cache_write_1h: 3, cache_read: 4, out: 5 } },
    }),
  )
  const pricing = await readPricing(dir)
  assert.equal(pricing.models['claude-opus-5']?.in, 1)
  // v1 priced these and the file leaves them out, so they were blanked deliberately.
  assert.equal(pricing.models['claude-fable-5'], null)
  assert.equal(pricing.models['claude-sonnet-5'], null)
  // v1 never priced these, so their absence says nothing and the published rate applies.
  assert.deepEqual(pricing.models['gpt-5.6-terra'], defaultPricing().models['gpt-5.6-terra'])
  assert.deepEqual(pricing.models['claude-fable-5-1'], defaultPricing().models['claude-fable-5-1'])
})

test('rates are written owner-only, like everything else in the store', async () => {
  const dir = store()
  await writePricing(dir, defaultPricing())
  assert.equal(statSync(pricingFile(dir)).mode & 0o077, 0, 'no group or world access')
})

test('an unreadable or malformed file falls back rather than pricing everything at nothing', async () => {
  const dir = store()
  writeFileSync(pricingFile(dir), 'not json at all')
  assert.deepEqual((await readPricing(dir)).models, defaultPricing().models)

  writeFileSync(pricingFile(dir), JSON.stringify({ models: 'nope' }))
  assert.deepEqual((await readPricing(dir)).models, defaultPricing().models)
})

test('a rate that is not a usable number is dropped, not stored as one', async () => {
  const dir = store()
  writeFileSync(
    pricingFile(dir),
    JSON.stringify({
      models: {
        good: { in: 1, cache_write_5m: 2, cache_write_1h: 3, cache_read: 4, out: 5 },
        missing: { in: 1, out: 5 },
        negative: { in: -1, cache_write_5m: 2, cache_write_1h: 3, cache_read: 4, out: 5 },
        wrong: { in: '1', cache_write_5m: 2, cache_write_1h: 3, cache_read: 4, out: 5 },
      },
    }),
  )
  const pricing = await readPricing(dir)
  assert.equal(pricing.models['good']?.in, 1)
  // Dropped entirely rather than kept as a tombstone: nobody asked for these to be unpriced, they
  // just could not be read.
  for (const model of ['missing', 'negative', 'wrong']) {
    assert.equal(pricing.models[model], undefined, `${model} should not be stored`)
  }
})

test('what was written is what reads back', async () => {
  const dir = store()
  const m = { in: 1.5, cache_write_5m: 2.5, cache_write_1h: 3.5, cache_read: 0.15, out: 7.5 }
  await writePricing(dir, { schema_version: PRICING_VERSION, models: { m } })
  assert.deepEqual((await readPricing(dir)).models['m'], m)
  const raw = JSON.parse(readFileSync(pricingFile(dir), 'utf8')) as { schema_version: number }
  assert.equal(raw.schema_version, PRICING_VERSION)
})

test('a dated model id is priced at the rate of the model it names', () => {
  const pricing = defaultPricing()
  const base = { ...ROUND_DEFAULTS, model: 'claude-haiku-4-5', in_uncached: 1_000_000 }
  const dated = { ...base, model: 'claude-haiku-4-5-20251001' }
  // The store this was found in held 6,196 rounds under the dated spelling, all priced at nothing.
  assert.equal(costOf(dated, pricing), costOf(base, pricing))
  assert.equal(costOf({ ...base, model: 'claude-opus-4-5@20251101' }, pricing), costOf({ ...base, model: 'claude-opus-4-5' }, pricing))
})

test('a model nobody has priced stays unpriced, however familiar it looks', () => {
  const pricing = defaultPricing()
  const round = { ...ROUND_DEFAULTS, model: 'claude-opus-6-20270101', in_uncached: 1_000_000 }
  // No family fallback: charging a new Opus at the old Opus rate would report a number that is
  // wrong without anything saying so, which is worse than reporting nothing.
  assert.equal(costOf(round, pricing), null)
})

test('a rate typed for a model also prices the dated rounds of it', async () => {
  const dir = store()
  await writePricing(dir, {
    schema_version: PRICING_VERSION,
    models: { 'claude-haiku-4-5': { in: 2, cache_write_5m: 2, cache_write_1h: 2, cache_read: 2, out: 2 } },
  })
  const pricing = await readPricing(dir)
  const round = { ...ROUND_DEFAULTS, model: 'claude-haiku-4-5-20251001', in_uncached: 1_000_000 }
  assert.equal(costOf(round, pricing), 2)
})
