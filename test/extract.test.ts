import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { extractSession, truncateInput } from '../src/extract.js'
import type { Round } from '../src/types.js'

// Compiled output lives at dist/test/, so the fixture is two levels up from here.
const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, '..', '..', 'test', 'fixtures', 'session.jsonl')

const rounds = await extractSession(FIXTURE, 'demo')
const byId = new Map(rounds.map((r) => [r.id, r]))
const round = (id: string): Round => {
  const found = byId.get(id)
  assert.ok(found, `no round ${id}`)
  return found
}

test('one round per assistant message id, in order', () => {
  assert.deepEqual(
    rounds.map((r) => r.id),
    ['msg_a', 'msg_b', 'msg_c', 'msg_c2', 'msg_d'],
  )
  assert.deepEqual(
    rounds.map((r) => r.round),
    [0, 1, 2, 3, 4],
  )
  assert.ok(rounds.every((r) => r.session === 'demo'))
})

test('records sharing a message id merge into one round', () => {
  const r = round('msg_a')
  assert.equal(r.text, 'Let me look.')
  assert.equal(r.thinking_chars, 5)
  assert.equal(r.tools.length, 1)
  // First record 00:00:01, second 00:00:03.
  assert.equal(r.ts, '2026-01-01T00:00:01.000Z')
  assert.equal(r.ms, 2000)
})

test('the most complete usage snapshot wins, not the last seen', () => {
  // Both msg_a records report the same input; the first carries a 10-token placeholder.
  const r = round('msg_a')
  assert.equal(r.in_tokens, 105)
  assert.equal(r.out_tokens, 40)
})

test('input tokens sum the uncached and cached halves', () => {
  const r = round('msg_b')
  assert.equal(r.in_tokens, 202)
  assert.equal(r.out_tokens, 20)
})

test('user text attaches to the round it prompted', () => {
  assert.equal(round('msg_a').user_text, 'add retries to the fetch loop')
  // Driven by a tool result, not a user turn.
  assert.equal(round('msg_b').user_text, '')
  assert.equal(round('msg_d').user_text, '')
})

test('a caveat and the prompt it introduces are one task', () => {
  assert.deepEqual(
    rounds.map((r) => r.task),
    [1, 1, 2, 2, 2],
  )
  assert.equal(round('msg_c').user_text, '<local-command-caveat>please note</local-command-caveat>\nnow run the tests')
})

test('subagent rounds are labelled and never start a task', () => {
  assert.equal(round('msg_c2').agent, 'sub')
  assert.equal(round('msg_c2').task, 2)
  assert.ok(rounds.filter((r) => r.id !== 'msg_c2').every((r) => r.agent === 'main'))
})

test('tool results pair with their call, including across rounds', () => {
  const read = round('msg_a').tools[0]!
  assert.equal(read.name, 'Read')
  assert.equal(read.result_chars, 30)
  assert.equal(read.is_error, false)
  assert.equal(read.ms, 1000)

  // tu_3 is called in msg_c and only answered after msg_c2.
  const bash = round('msg_c').tools[0]!
  assert.equal(bash.name, 'Bash')
  assert.equal(bash.result_chars, 2)
  assert.equal(bash.ms, 5000)
})

test('failed tools are marked', () => {
  const edit = round('msg_b').tools[0]!
  assert.equal(edit.name, 'Edit')
  assert.equal(edit.is_error, true)
  assert.equal(edit.result_chars, 4)
})

test('long tool inputs are truncated but paths survive', () => {
  const input = round('msg_b').tools[0]!.input as Record<string, string>
  assert.equal(input.file_path, '/tmp/demo/loop.ts')
  assert.equal(input.new_string, 'z')
  assert.equal(input.old_string, `${'y'.repeat(200)}…(2500 chars)`)
})

test('truncateInput leaves short values alone and recurses', () => {
  assert.deepEqual(truncateInput({ a: 'short', b: [{ c: 1 }] }), { a: 'short', b: [{ c: 1 }] })
  const long = truncateInput({ a: 'q'.repeat(2001) }) as { a: string }
  assert.equal(long.a, `${'q'.repeat(200)}…(2001 chars)`)
})
