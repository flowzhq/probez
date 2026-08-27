import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { classifyCall } from '../src/classify.js'
import { extractCodexSession } from '../src/extract-codex.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, '..', '..', 'test', 'fixtures', 'codex-session.jsonl')
const SUB = join(here, '..', '..', 'test', 'fixtures', 'codex-subagent.jsonl')

const sessionId = '2026/01/06/rollout-2026-01-06T00-00-00-cccc3333-0000-0000-0000-000000000000'
const rounds = await extractCodexSession(FIXTURE, sessionId)
const sub = await extractCodexSession(SUB, '2026/01/06/rollout-sub-dddd4444')

test('one round per model burst, in file order', () => {
  assert.equal(rounds.length, 5)
  assert.deepEqual(
    rounds.map((r) => r.id),
    [
      `${sessionId}#r0`,
      `${sessionId}#r1`,
      `${sessionId}#r2`,
      `${sessionId}#r3`,
      `${sessionId}#r4`,
    ],
  )
  assert.deepEqual(
    rounds.map((r) => r.round),
    [0, 1, 2, 3, 4],
  )
})

test('a user_message starts a task, and a later one starts another', () => {
  assert.deepEqual(
    rounds.map((r) => r.task),
    [1, 1, 1, 2, 2],
  )
  assert.equal(rounds[0]!.user_text, 'add retries to the fetch loop')
  assert.equal(rounds[1]!.user_text, '')
  assert.equal(rounds[3]!.user_text, 'run the tests')
})

test('the environment-wrapped copy of a user message is not a second task', () => {
  assert.equal(rounds.filter((r) => r.user_text === 'add retries to the fetch loop').length, 1)
})

test('model comes from turn_context, usage from the token_count that followed the round', () => {
  for (const round of rounds.slice(0, 4)) {
    assert.equal(round.model, 'gpt-5')
    assert.notEqual(round.in_tokens, null)
    assert.notEqual(round.out_tokens, null)
  }
  assert.equal(rounds[0]!.in_uncached, 400)
  assert.equal(rounds[0]!.in_cache_read, 800)
  assert.equal(rounds[0]!.out_tokens, 90)
  // The last prose round has no token_count after it, so usage stays unmeasured.
  assert.equal(rounds[4]!.in_tokens, null)
  assert.equal(rounds[4]!.out_tokens, null)
})

test('shell argv is joined, and bash -lc keeps the script', () => {
  const read = rounds[0]!.tools[0]!
  assert.equal(read.name, 'shell')
  assert.equal(read.id, 'call_read')
  assert.equal((read.input as { command: string }).command, 'sed -n 1,40p loop.ts')
  assert.equal(read.result_chars, 'export async function fetchAll() {\n  return fetch(url)\n}\n'.length)

  const testCall = rounds[3]!.tools[0]!
  assert.equal((testCall.input as { command: string }).command, 'npm test')
  const labels = classifyCall(testCall)
  assert.equal(labels[0]!.category, 'testing')
})

test('apply_patch names the file inside the patch and classifies as a write', () => {
  const patch = rounds[1]!.tools[0]!
  assert.equal(patch.name, 'apply_patch')
  assert.equal((patch.input as { path: string }).path, 'loop.ts')
  assert.notEqual(patch.patch, null)
  assert.equal(patch.patch!.added, 1)
  assert.equal(patch.patch!.removed, 1)
  const labels = classifyCall(patch)
  assert.equal(labels[0]!.category, 'implementation')
  assert.equal(labels[0]!.sub, 'modify')
})

test('a rollout whose session_meta names a subagent is agent sub', () => {
  assert.equal(sub.length, 1)
  assert.equal(sub[0]!.agent, 'sub')
  assert.equal(sub[0]!.user_text, 'Explore /tmp/demo for the fetch loop.')
})

test('a parent rollout is agent main', () => {
  assert.ok(rounds.every((r) => r.agent === 'main'))
})
