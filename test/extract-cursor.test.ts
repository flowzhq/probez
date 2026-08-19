import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { pathFromCursorSlug, safeSessionFilename, sessionIdFromFilename } from '../src/agents/paths.js'
import { classifyCall } from '../src/classify.js'
import { extractCursorSession } from '../src/extract-cursor.js'
import { costOf, defaultPricing } from '../src/pricing.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, '..', '..', 'test', 'fixtures', 'cursor-session.jsonl')
const SUB = join(here, '..', '..', 'test', 'fixtures', 'cursor-subagent.jsonl')

const rounds = await extractCursorSession(FIXTURE, 'aaaa1111-0000-0000-0000-000000000000')
const sub = await extractCursorSession(SUB, 'aaaa1111-0000-0000-0000-000000000000/subagents/bbbb2222')

test('one round per assistant row, in file order', () => {
  assert.equal(rounds.length, 3)
  assert.deepEqual(
    rounds.map((r) => r.id),
    [
      'aaaa1111-0000-0000-0000-000000000000#r0',
      'aaaa1111-0000-0000-0000-000000000000#r1',
      'aaaa1111-0000-0000-0000-000000000000#r2',
    ],
  )
  assert.deepEqual(
    rounds.map((r) => r.round),
    [0, 1, 2],
  )
})

test('a user_query starts a task, and later queries start another', () => {
  assert.equal(rounds[0]!.task, 1)
  assert.equal(rounds[1]!.task, 1)
  assert.equal(rounds[2]!.task, 2)
  assert.equal(rounds[0]!.user_text, 'add retries to the fetch loop')
  assert.equal(rounds[1]!.user_text, '')
  assert.equal(rounds[2]!.user_text, 'run the tests')
})

test('timestamps come from the user_query wrapper, not a row field', () => {
  assert.equal(rounds[0]!.ts, '2026-01-06T00:00:00.000Z')
  assert.equal(rounds[2]!.ts, '2026-01-06T00:01:00.000Z')
})

test('usage and model stay null rather than being guessed at', () => {
  const pricing = defaultPricing()
  for (const round of rounds) {
    assert.equal(round.model, null)
    assert.equal(round.in_tokens, null)
    assert.equal(round.in_uncached, null)
    assert.equal(round.in_cache_write, null)
    assert.equal(round.in_cache_read, null)
    assert.equal(round.out_tokens, null)
    assert.equal(costOf(round, pricing), null)
  }
})

test('tool calls keep their input and get a synthetic id', () => {
  const read = rounds[0]!.tools
  assert.equal(read.length, 1)
  assert.equal(read[0]!.name, 'Read')
  assert.equal(read[0]!.id, 'aaaa1111-0000-0000-0000-000000000000#r0#t0')
  assert.equal((read[0]!.input as { path: string }).path, '/tmp/demo/loop.ts')
  assert.equal(read[0]!.result_chars, null)
  assert.equal(read[0]!.is_error, null)
  assert.equal(read[0]!.ms, null)

  const edit = rounds[1]!.tools[0]!
  assert.equal(edit.name, 'StrReplace')
  const labels = classifyCall(edit)
  assert.equal(labels[0]!.category, 'implementation')
  assert.equal(labels[0]!.sub, 'modify')
})

test('turn_ended rows are skipped', () => {
  assert.equal(rounds.every((r) => r.id.includes('#r')), true)
})

test('a transcript under subagents/ is agent sub', () => {
  assert.equal(sub.length, 1)
  assert.equal(sub[0]!.agent, 'sub')
  assert.equal(sub[0]!.session, 'aaaa1111-0000-0000-0000-000000000000/subagents/bbbb2222')
  assert.equal(sub[0]!.user_text, 'Explore /tmp/demo for the fetch loop.')
})

test('a parent transcript is agent main', () => {
  assert.ok(rounds.every((r) => r.agent === 'main'))
})

test('safeSessionFilename flattens nested Cursor ids', () => {
  assert.equal(
    safeSessionFilename('aaaa1111-0000-0000-0000-000000000000/subagents/bbbb2222'),
    'aaaa1111-0000-0000-0000-000000000000__subagents__bbbb2222.jsonl',
  )
  assert.equal(
    sessionIdFromFilename('aaaa1111-0000-0000-0000-000000000000__subagents__bbbb2222.jsonl'),
    'aaaa1111-0000-0000-0000-000000000000/subagents/bbbb2222',
  )
})

test('a Cursor slug infers a path, lossily', () => {
  assert.equal(
    pathFromCursorSlug('Users-me-Dev-workspace-probez'),
    '/Users/me/Dev/workspace/probez',
  )
})

test('a Cursor slug prefers the path that still exists when a name contains dashes', () => {
  const root = realpathSync(mkdtempSync(join('/tmp', 'probezwork')))
  const project = join(root, 'flowz-agentic-sdlc')
  mkdirSync(project)
  const slug = project.replaceAll('/', '-').replace(/^-/, '')
  assert.equal(pathFromCursorSlug(slug), project)
})
