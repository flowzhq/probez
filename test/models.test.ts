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

test('the two tables name the same models, in both directions', async () => {
  const { defaultPricing } = await import('../src/pricing.js')
  const priced = Object.keys(defaultPricing().models)
  // Nothing compiles against these two tables together, so pricing a model and forgetting its
  // window — or the reverse — is a silent half-edit. This is the only thing that catches it.
  for (const model of priced) {
    assert.ok(CONTEXT_WINDOWS[model] !== undefined, `${model} has a rate but no window`)
  }
  for (const model of Object.keys(CONTEXT_WINDOWS)) {
    assert.ok(priced.includes(model), `${model} has a window but no rate`)
  }
})

test('a dated model id reports the window of the model it names', () => {
  assert.equal(contextWindow('claude-haiku-4-5-20251001'), contextWindow('claude-haiku-4-5'))
  assert.equal(contextWindow('claude-opus-4-5@20251101'), contextWindow('claude-opus-4-5'))
  assert.equal(contextWindow('claude-opus-6-20270101'), null)
})

test('a GPT window is the room for input, not the headline number', () => {
  // gpt-5.3-codex advertises 400,000 and admits 272,000 of input. Taking the headline would report
  // every session as filling less of its window than it did, by 47%.
  assert.equal(contextWindow('gpt-5.3-codex'), 272_000)
  assert.equal(contextWindow('gpt-5.6-terra'), 922_000)
})
