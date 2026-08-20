import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CONTEXT_WINDOWS, contextShare, contextWindow } from '../src/models.js'
import { ROUND_DEFAULTS } from './support.js'

test('a share is the round\'s input over its model\'s window', () => {
  const round = { ...ROUND_DEFAULTS, model: 'claude-opus-5', in_tokens: 250_000 }
  assert.equal(contextShare(round), 0.25)
})

test('a smaller window makes the same round a larger share', () => {
  const round = { ...ROUND_DEFAULTS, model: 'claude-haiku-4-5', in_tokens: 100_000 }
  assert.equal(contextShare(round), 0.5)
})

test('an unknown model has no share rather than a full one', () => {
  assert.equal(contextWindow('claude-from-the-future'), null)
  assert.equal(contextShare({ ...ROUND_DEFAULTS, model: 'claude-from-the-future', in_tokens: 9 }), null)
  assert.equal(contextShare({ ...ROUND_DEFAULTS, model: null, in_tokens: 9 }), null)
})

test('a session that recorded no usage has no share', () => {
  // Cursor transcripts carry no token counts, and a missing measurement is not a measured zero.
  assert.equal(contextShare({ ...ROUND_DEFAULTS, model: 'claude-opus-5', in_tokens: null }), null)
})

test('a round from a store written before the field existed has no share', () => {
  // The store is read back as a raw cast, so an older round simply lacks the key.
  const older = { ...ROUND_DEFAULTS, model: 'claude-opus-5' } as Record<string, unknown>
  delete older.in_tokens
  assert.equal(contextShare(older as unknown as Parameters<typeof contextShare>[0]), null)
})

test('every priced model has a window', async () => {
  const { defaultPricing } = await import('../src/pricing.js')
  for (const model of Object.keys(defaultPricing().models)) {
    assert.ok(CONTEXT_WINDOWS[model] !== undefined, `${model} has a rate but no window`)
  }
})
