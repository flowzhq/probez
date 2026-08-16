import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { costOf, defaultPricing, pricingFile, readPricing, writePricing } from '../src/pricing.js'
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

test('a saved file is the whole truth, so a model can be left unpriced on purpose', async () => {
  const dir = store()
  await writePricing(dir, {
    schema_version: 1,
    models: { 'claude-opus-5': { in: 1, cache_write_5m: 2, cache_write_1h: 3, cache_read: 4, out: 5 } },
  })
  const pricing = await readPricing(dir)
  assert.equal(pricing.models['claude-opus-5']?.in, 1)
  // Merging the defaults back in would make blanking a row impossible: the row would return.
  assert.equal(pricing.models['claude-fable-5'], undefined)
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
  assert.deepEqual(Object.keys(pricing.models), ['good'])
})

test('what was written is what reads back', async () => {
  const dir = store()
  const models = { m: { in: 1.5, cache_write_5m: 2.5, cache_write_1h: 3.5, cache_read: 0.15, out: 7.5 } }
  await writePricing(dir, { schema_version: 1, models })
  assert.deepEqual((await readPricing(dir)).models, models)
  const raw = JSON.parse(readFileSync(pricingFile(dir), 'utf8')) as { schema_version: number }
  assert.equal(raw.schema_version, 1)
})
