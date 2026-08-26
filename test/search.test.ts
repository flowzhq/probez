import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parse } from '../src/query.js'
import { fromRounds, search } from '../src/search.js'
import type { RoundHit, SessionHit, Source, TaskHit } from '../src/search.js'
import type { Round, ToolCall } from '../src/types.js'
import { PRICING, ROUND_DEFAULTS, TOOL_DEFAULTS } from './support.js'

function tool(name: string | null, extra: Partial<ToolCall> = {}): ToolCall {
  return { ...TOOL_DEFAULTS, name, result_chars: 100, is_error: false, ms: 10, ...extra }
}

function round(partial: Partial<Round> & { session: string; round: number }): Round {
  return {
    ...ROUND_DEFAULTS,
    id: `msg_${partial.session}_${partial.round}`,
    model: 'claude-opus-5',
    ts: `2026-08-2${(partial.round % 9) + 1}T10:00:00.000Z`,
    ...partial,
  }
}

/** Nine rounds: three that edit, six that read, across two sessions and three tasks. */
const ROUNDS: Round[] = (() => {
  const rounds: Round[] = []
  for (let at = 0; at < 3; at += 1) {
    rounds.push(
      round({
        session: 'aaaa1111',
        round: at,
        task: 1,
        out_tokens: 1000,
        tools: [tool('Edit', { patch: { files: 1, added: 10, removed: 2 } })],
      }),
    )
  }
  for (let at = 3; at < 9; at += 1) {
    rounds.push(
      round({
        session: at < 6 ? 'aaaa1111' : 'bbbb2222',
        round: at,
        task: at < 6 ? 2 : 1,
        out_tokens: 100,
        tools: [tool('Read')],
      }),
    )
  }
  return rounds
})()

function corpus(): Source {
  return fromRounds('demo', ROUNDS, { slug: 'demo-1234', root: '/repo' })
}

test('a result says what the matched slice is a share of', async () => {
  const result = await search([corpus()], parse('tool:Edit'), { pricing: PRICING })
  assert.equal(result.totals.rounds, 3)
  assert.equal(result.scope.rounds, 9)
  assert.equal(result.share.rounds, 3 / 9)
  // Every edit round produced ten times the output of a read round, so its share of the cost is
  // larger than its share of the round count — which is the entire reason both are reported.
  assert.ok(result.share.cost > result.share.rounds)
})

test('nothing matched is a zero share rather than a division by nothing', async () => {
  const result = await search([corpus()], parse('tool:Glob'), { pricing: PRICING })
  assert.equal(result.totals.rounds, 0)
  assert.equal(result.share.rounds, 0)
  assert.equal(result.share.cost, 0)
  assert.deepEqual(result.hits, [])
})

test('the categories are of the matched rounds alone, and top is the biggest of them', async () => {
  const result = await search([corpus()], parse('tool:Edit'), { pricing: PRICING })
  assert.equal(result.top?.name, 'implementation')
  // Canonical order, not size order, since that is what a bar is drawn in.
  assert.deepEqual(result.categories.map((row) => row.name), ['implementation'])
})

test('sessions are always reported, whatever is being counted', async () => {
  const result = await search([corpus()], parse('tool:Read'), { pricing: PRICING })
  assert.equal(result.entity, 'rounds')
  assert.deepEqual(result.sessions.map((row) => row.session).sort(), ['aaaa1111', 'bbbb2222'])
})

test('a group row describes the matched rounds, with the whole group beside it', async () => {
  const result = await search([corpus()], parse('tool:Edit in:sessions'), { pricing: PRICING })
  const hit = result.hits[0] as SessionHit
  assert.equal(hit.session, 'aaaa1111')
  assert.equal(hit.rounds, 3)
  // Six rounds of that session are in the scope and did not match. Reporting the session's whole
  // cost against a query it barely matched would read as a much larger finding than it is.
  assert.equal(hit.of, 6)
})

test('tasks are keyed by session as well as by number', async () => {
  const result = await search([corpus()], parse('tool:Read in:tasks'), { pricing: PRICING })
  const hits = result.hits as TaskHit[]
  // Task 1 of bbbb2222 and task 2 of aaaa1111 are different work; task numbers restart per session.
  assert.equal(hits.length, 2)
  assert.deepEqual(
    hits.map((hit) => `${hit.session}#${hit.task}`).sort(),
    ['aaaa1111#2', 'bbbb2222#1'],
  )
})

test('a task row is named by the task, not by the part of it that matched', async () => {
  const rounds = [
    round({
      session: 'aaaa1111',
      round: 0,
      task: 1,
      user_text: 'make the suite green',
      commit: 'deadbeefdeadbeef',
      tools: [tool('Read')],
    }),
    round({ session: 'aaaa1111', round: 1, task: 1, tools: [tool('Edit')] }),
  ]
  const result = await search([fromRounds('demo', rounds)], parse('tool:Edit in:tasks'), {
    pricing: PRICING,
  })
  const hit = result.hits[0] as TaskHit
  // The round that opened the task did not match. Its prompt is still what the task is called.
  assert.equal(hit.asked, 'make the suite green')
  assert.equal(hit.commit, 'deadbeefdeadbeef')
  assert.equal(hit.rounds, 1)
  assert.equal(hit.of, 2)
})

test('projects count as one row each, with what did not match beside it', async () => {
  const result = await search([corpus()], parse('tool:Edit in:projects'), { pricing: PRICING })
  assert.equal(result.hits.length, 1)
  assert.deepEqual(
    result.hits[0],
    {
      project: 'demo',
      slug: 'demo-1234',
      rounds: 3,
      of: 9,
      sessions: 1,
      tasks: 1,
      cost: (result.hits[0] as { cost: number }).cost,
      unpriced: 0,
      ms: 0,
      first_ts: (result.hits[0] as { first_ts: string }).first_ts,
      last_ts: (result.hits[0] as { last_ts: string }).last_ts,
    },
  )
})

test('rounds come back newest first, and sort puts the big end first instead', async () => {
  const newest = await search([corpus()], parse('tool:Read'), { pricing: PRICING })
  const times = (newest.hits as RoundHit[]).map((hit) => Date.parse(hit.ts ?? ''))
  assert.deepEqual(times, [...times].sort((a, b) => b - a))

  const dear = await search([corpus()], parse('sort:output'), { pricing: PRICING })
  const outputs = (dear.hits as RoundHit[]).map((hit) => hit.out_tokens ?? 0)
  assert.deepEqual(outputs, [...outputs].sort((a, b) => b - a))
})

test('limit withholds rows without changing what was found', async () => {
  const result = await search([corpus()], parse('tool:Read'), { pricing: PRICING, limit: 2 })
  assert.equal(result.hits.length, 2)
  assert.equal(result.found, 6)
  assert.equal(result.totals.rounds, 6)
})

test('a limit written into the query outranks the one passed in', async () => {
  const result = await search([corpus()], parse('tool:Read limit:1'), { pricing: PRICING, limit: 5 })
  assert.equal(result.hits.length, 1)
})

test('several projects are matched separately and reported as one', async () => {
  const other = fromRounds('other', ROUNDS, { slug: 'other-9999', root: '/repo' })
  const result = await search([corpus(), other], parse('tool:Edit'), { pricing: PRICING })
  assert.equal(result.totals.projects, 2)
  assert.equal(result.totals.rounds, 6)
  // Two projects can hold a session of the same name without being the same session.
  assert.equal(result.totals.sessions, 2)
})

test('project: addresses the corpus a round came from', async () => {
  const other = fromRounds('other', ROUNDS, { slug: 'other-9999', root: '/repo' })
  const result = await search([corpus(), other], parse('project:other tool:Edit'), { pricing: PRICING })
  assert.equal(result.totals.projects, 1)
  assert.equal((result.hits[0] as RoundHit).project, 'other')
})

test('a round with no rate is counted as unpriced rather than as free', async () => {
  const cheap = fromRounds(
    'demo',
    ROUNDS.map((one) => ({ ...one, model: 'some-model-nobody-priced' })),
  )
  const result = await search([cheap], parse('tool:Edit'), { pricing: PRICING })
  assert.equal(result.totals.cost, 0)
  assert.equal(result.totals.unpriced, 3)
})

test('the diagnostics survive into the result, so a caller can show them beside the rows', async () => {
  const result = await search([corpus()], parse('categoy:test'), { pricing: PRICING })
  assert.equal(result.diagnostics.length, 1)
  assert.equal(result.query, 'categoy:test')
})

test('questions are read over the whole corpus and then kept by what matched', async () => {
  const rounds: Round[] = []
  for (let at = 0; at < 6; at += 1) {
    rounds.push(
      round({
        session: 'aaaa1111',
        round: at,
        task: 1,
        tools: [tool('Grep', { input: { pattern: 'out_tokens', path: 'src' } })],
      }),
    )
  }
  const one = fromRounds('demo', rounds, { root: '/repo' })
  const all = await search([one], parse('tool:Grep in:questions'), { pricing: PRICING })
  // Six greps for one word are one question that cost six calls, not six questions — which only
  // holds because the run is read over the corpus rather than over the matches.
  assert.equal(all.hits.length, 1)
  assert.equal((all.hits[0] as { calls: number }).calls, 6)
})
