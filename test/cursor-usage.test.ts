import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  appendCursorUsage,
  applyCursorUsage,
  applyUsageToRound,
  dedupeCursorUsage,
  distributeByWeight,
  installCursorHooks,
  matchCursorUsageTask,
  MAX_CURSOR_USAGE_TASK_DELTA_MS,
  parseCursorHookPayload,
  readCursorUsage,
  sessionMatchesConversation,
} from '../src/cursor-usage.js'
import { categoryTally } from '../src/inspect.js'
import { defaultPricing } from '../src/pricing.js'
import type { Round, ToolCall } from '../src/types.js'

function tool(name: string, input: Record<string, unknown> = {}): ToolCall {
  return {
    name,
    id: `${name}-1`,
    input,
    input_chars: 10,
    result_chars: 10,
    is_error: false,
    error_kind: null,
    stderr_chars: null,
    interrupted: null,
    patch: null,
    emitted_at: null,
    result_at: null,
    ms: null,
  }
}

function cursorRound(over: Partial<Round> & Pick<Round, 'session' | 'id' | 'task' | 'round'>): Round {
  return {
    agent: 'main',
    source: 'cursor',
    commit: null,
    ts: '2026-01-06T00:00:00.000Z',
    ms: null,
    gen_ms: null,
    wait_ms: null,
    first_input: 'user_message',
    model: null,
    in_tokens: null,
    in_uncached: null,
    in_cache_write: null,
    in_cache_write_5m: null,
    in_cache_write_1h: null,
    in_cache_read: null,
    out_tokens: null,
    compaction: null,
    mcp_server: null,
    mcp_tool: null,
    skill: null,
    user_text: '',
    text: '',
    thinking_chars: 0,
    tools: [],
    events: [],
    ...over,
  }
}

function event(
  over: Partial<{
    conversation_id: string
    generation_id: string
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    model: string | null
    recorded_at: string
  }> = {},
) {
  return {
    conversation_id: 'aaaa1111-0000-0000-0000-000000000000',
    generation_id: 'g1',
    model: 'default' as string | null,
    input_tokens: 1000,
    output_tokens: 100,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    recorded_at: '2026-01-06T00:00:01.000Z',
    hook_event_name: 'stop',
    transcript_path: null,
    ...over,
  }
}

test('parseCursorHookPayload reads stop token fields', () => {
  const parsed = parseCursorHookPayload({
    hook_event_name: 'stop',
    conversation_id: 'aaaa1111-0000-0000-0000-000000000000',
    generation_id: 'gen-1',
    model: 'cursor-grok-4.6-high-fast',
    input_tokens: 1180993,
    output_tokens: 8146,
    cache_read_tokens: 1007022,
    cache_write_tokens: 173957,
  })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.event.conversation_id, 'aaaa1111-0000-0000-0000-000000000000')
  assert.equal(parsed.event.input_tokens, 1180993)
  assert.equal(parsed.event.cache_read_tokens, 1007022)
})

test('parseCursorHookPayload refuses tool hooks and empty usage', () => {
  assert.equal(parseCursorHookPayload({ hook_event_name: 'preToolUse', conversation_id: 'x' }).ok, false)
  assert.equal(parseCursorHookPayload({ hook_event_name: 'stop', conversation_id: 'x' }).ok, false)
})

test('Cursor inclusive input is split without double-counting', () => {
  const round = cursorRound({
    session: 'aaaa1111-0000-0000-0000-000000000000',
    id: 'aaaa1111-0000-0000-0000-000000000000#r0',
    task: 1,
    round: 0,
  })
  applyUsageToRound(round, event({ input_tokens: 1000, cache_read_tokens: 700, cache_write_tokens: 200, output_tokens: 50 }))
  assert.equal(round.in_uncached, 100)
  assert.equal(round.in_cache_read, 700)
  assert.equal(round.in_cache_write, 200)
  assert.equal(round.in_tokens, 1000)
  assert.equal(round.out_tokens, 50)
})

test('distributeByWeight preserves the exact total', () => {
  const parts = distributeByWeight(100, [0.4, 0.45, 0.15])
  assert.equal(parts.reduce((a, b) => a + b, 0), 100)
  assert.deepEqual(parts, [40, 45, 15])
})

test('exact: a single tool round receives the full event', () => {
  const session = 'aaaa1111-0000-0000-0000-000000000000'
  const rounds = [
    cursorRound({
      session,
      id: `${session}#r0`,
      task: 1,
      round: 0,
      tools: [tool('Read', { path: '/tmp/a.ts' })],
    }),
    cursorRound({ session, id: `${session}#r1`, task: 1, round: 1, text: 'done' }),
  ]
  assert.equal(applyCursorUsage(rounds, [event()]), 1)
  assert.equal(rounds[0]!.in_tokens, 1000)
  assert.equal(rounds[0]!.out_tokens, 100)
  assert.equal(rounds[1]!.in_tokens, null)
})

test('prose-only last round does not absorb task usage', () => {
  const session = 'aaaa1111-0000-0000-0000-000000000000'
  const rounds = [
    cursorRound({
      session,
      id: `${session}#r0`,
      task: 1,
      round: 0,
      tools: [tool('Read', { path: '/tmp/a.ts' })],
    }),
    cursorRound({
      session,
      id: `${session}#r1`,
      task: 1,
      round: 1,
      tools: [tool('StrReplace', { path: '/tmp/a.ts' })],
    }),
    cursorRound({ session, id: `${session}#r2`, task: 1, round: 2, text: 'done' }),
  ]
  assert.equal(applyCursorUsage(rounds, [event({ input_tokens: 1000, output_tokens: 10 })]), 1)
  assert.equal(rounds[2]!.in_tokens, null)
  assert.equal((rounds[0]!.in_tokens ?? 0) + (rounds[1]!.in_tokens ?? 0), 1000)
  assert.equal((rounds[0]!.out_tokens ?? 0) + (rounds[1]!.out_tokens ?? 0), 10)
})

test('task-level split preserves totals across weighted rounds', () => {
  const session = 'aaaa1111-0000-0000-0000-000000000000'
  // Two Reads and one StrReplace → weights 1+1+1 when each is its own round.
  const rounds = [
    cursorRound({
      session,
      id: `${session}#r0`,
      task: 1,
      round: 0,
      tools: [tool('Read', { path: '/tmp/a.ts' })],
    }),
    cursorRound({
      session,
      id: `${session}#r1`,
      task: 1,
      round: 1,
      tools: [tool('Read', { path: '/tmp/b.ts' })],
    }),
    cursorRound({
      session,
      id: `${session}#r2`,
      task: 1,
      round: 2,
      tools: [tool('StrReplace', { path: '/tmp/a.ts' })],
    }),
    cursorRound({ session, id: `${session}#r3`, task: 1, round: 3 }),
  ]
  applyCursorUsage(rounds, [event({ input_tokens: 300, output_tokens: 30, model: 'default' })])
  const classified = rounds.slice(0, 3)
  assert.equal(
    classified.reduce((sum, round) => sum + (round.in_tokens ?? 0), 0),
    300,
  )
  assert.equal(
    classified.reduce((sum, round) => sum + (round.out_tokens ?? 0), 0),
    30,
  )
  assert.equal(rounds[3]!.in_tokens, null)

  const analysis = categoryTally(rounds, defaultPricing())
  assert.ok(analysis.coverage.tokens > 0)
  assert.equal(analysis.coverage.outside_tokens, 0)
  assert.equal(analysis.coverage.cost, 0)
  const tokenSum = analysis.rows.reduce((sum, row) => sum + row.in_tokens + row.out_tokens, 0)
  assert.equal(Math.round(tokenSum), analysis.coverage.tokens)
})

test('no matching task leaves candidates untouched', () => {
  const rounds = [
    cursorRound({
      session: 'bbbb2222-0000-0000-0000-000000000000',
      id: 'bbbb#r0',
      task: 1,
      round: 0,
      tools: [tool('Read', { path: '/tmp/a.ts' })],
    }),
  ]
  assert.equal(applyCursorUsage(rounds, [event()]), 0)
  assert.equal(rounds[0]!.in_tokens, null)
})

test('task with only prose parks usage as outside Tokens', () => {
  const session = 'aaaa1111-0000-0000-0000-000000000000'
  const rounds = [cursorRound({ session, id: `${session}#r0`, task: 1, round: 0, text: 'hi' })]
  assert.equal(applyCursorUsage(rounds, [event({ input_tokens: 50, output_tokens: 5 })]), 1)
  assert.equal(rounds[0]!.in_tokens, 50)
  const analysis = categoryTally(rounds, defaultPricing())
  assert.equal(analysis.coverage.tokens, 0)
  assert.equal(analysis.coverage.outside_tokens, 55)
})

test('Token Share works without a priced model', () => {
  const session = 'aaaa1111-0000-0000-0000-000000000000'
  const rounds = [
    cursorRound({
      session,
      id: `${session}#r0`,
      task: 1,
      round: 0,
      model: 'default',
      tools: [tool('Read', { path: '/tmp/a.ts' })],
      in_tokens: 400,
      in_uncached: 400,
      in_cache_read: 0,
      in_cache_write: 0,
      in_cache_write_5m: 0,
      in_cache_write_1h: 0,
      out_tokens: 40,
    }),
    cursorRound({
      session,
      id: `${session}#r1`,
      task: 1,
      round: 1,
      model: 'default',
      tools: [tool('StrReplace', { path: '/tmp/a.ts' })],
      in_tokens: 600,
      in_uncached: 600,
      in_cache_read: 0,
      in_cache_write: 0,
      in_cache_write_5m: 0,
      in_cache_write_1h: 0,
      out_tokens: 60,
    }),
  ]
  const analysis = categoryTally(rounds, defaultPricing())
  assert.equal(analysis.coverage.cost, 0)
  assert.equal(analysis.coverage.tokens, 1100)
  assert.ok(analysis.rows.some((row) => row.in_tokens + row.out_tokens > 0))
})

test('prior prose-only attribution is redistributed onto tool rounds', () => {
  const session = 'aaaa1111-0000-0000-0000-000000000000'
  const rounds = [
    cursorRound({
      session,
      id: `${session}#r0`,
      task: 1,
      round: 0,
      tools: [tool('Read', { path: '/tmp/a.ts' })],
    }),
    cursorRound({
      session,
      id: `${session}#r1`,
      task: 1,
      round: 1,
      in_tokens: 999,
      in_uncached: 999,
      in_cache_read: 0,
      in_cache_write: 0,
      in_cache_write_5m: 0,
      in_cache_write_1h: 0,
      out_tokens: 9,
      text: 'old wrong park',
    }),
  ]
  applyCursorUsage(rounds, [event({ input_tokens: 100, output_tokens: 10 })])
  assert.equal(rounds[1]!.in_tokens, null)
  assert.equal(rounds[0]!.in_tokens, 100)
})

test('applyCursorUsage ignores non-cursor sources even when tokenless', () => {
  const session = 'aaaa1111-0000-0000-0000-000000000000'
  const claude = cursorRound({
    session,
    id: `${session}#r0`,
    task: 1,
    round: 0,
    source: 'claude-code',
    tools: [tool('Read', { path: '/tmp/a.ts' })],
  })
  applyCursorUsage([claude], [event()])
  assert.equal(claude.in_tokens, null)
})

test('applyCursorUsage skips subagent sessions', () => {
  const parent = 'aaaa1111-0000-0000-0000-000000000000'
  const sub = `${parent}/subagents/bbbb2222`
  const rounds = [
    cursorRound({
      session: sub,
      id: `${sub}#r0`,
      task: 1,
      round: 0,
      agent: 'sub',
      tools: [tool('Read', { path: '/tmp/a.ts' })],
    }),
  ]
  assert.equal(applyCursorUsage(rounds, [event({ conversation_id: parent })]), 0)
  assert.equal(rounds[0]!.in_tokens, null)
})

test('dedupeCursorUsage keeps one event per generation_id', () => {
  const a = event({ generation_id: 'g', input_tokens: 1, recorded_at: '2026-01-06T00:00:01.000Z' })
  const b = event({
    generation_id: 'g',
    input_tokens: 2,
    recorded_at: '2026-01-06T00:00:02.000Z',
  })
  ;(a as { hook_event_name: string }).hook_event_name = 'afterAgentResponse'
  const deduped = dedupeCursorUsage([a, b])
  assert.equal(deduped.length, 1)
  assert.equal(deduped[0]!.input_tokens, 2)
})

test('sessionMatchesConversation accepts nested Cursor session ids', () => {
  const id = 'aaaa1111-0000-0000-0000-000000000000'
  assert.equal(sessionMatchesConversation(id, id), true)
  assert.equal(sessionMatchesConversation(`${id}/subagents/x`, id), true)
  assert.equal(sessionMatchesConversation('other', id), false)
})

test('appendCursorUsage and readCursorUsage round-trip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'probez-hook-'))
  const file = await appendCursorUsage(dir, event({ input_tokens: 10, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4 }))
  assert.equal(readFileSync(file, 'utf8').includes('"input_tokens":10'), true)
  const loaded = await readCursorUsage(dir)
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0]!.cache_write_tokens, 4)
})

test('installCursorHooks merges stop without dropping other hooks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'probez-hooks-'))
  const path = join(dir, 'hooks.json')
  writeFileSync(
    path,
    JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: './a.sh' }] } }) + '\n',
  )
  assert.equal(await installCursorHooks(path, 'probez hook'), 'updated')
  assert.equal(await installCursorHooks(path, 'probez hook'), 'unchanged')
  const body = JSON.parse(readFileSync(path, 'utf8')) as {
    hooks: { preToolUse: unknown[]; stop: Array<{ command: string }> }
  }
  assert.equal(body.hooks.preToolUse.length, 1)
  assert.equal(body.hooks.stop[0]!.command, 'probez hook')
})

/** Conversation id from the real evening session used to validate temporal join. */
const CONV_88 = '88e089be-4823-46b3-b391-2102bf9a68bb'

/** Minimal stand-in for tasks 1–2 (old) plus 65–71 (evening) from that session. */
function rounds88e089be(): Round[] {
  const s = CONV_88
  return [
    cursorRound({
      session: s,
      id: `${s}#r0`,
      task: 1,
      round: 0,
      ts: '2026-08-26T10:00:00.000Z',
      tools: [tool('Read', { path: '/tmp/a.ts' })],
    }),
    cursorRound({
      session: s,
      id: `${s}#r1`,
      task: 2,
      round: 1,
      ts: '2026-08-26T10:01:00.000Z',
      text: 'prose only forever',
    }),
    cursorRound({
      session: s,
      id: `${s}#r459`,
      task: 65,
      round: 459,
      ts: '2026-09-09T21:30:00.000Z',
      tools: [tool('Read', { path: '/tmp/a.ts' })],
    }),
    cursorRound({ session: s, id: `${s}#r460`, task: 65, round: 460, ts: '2026-09-09T21:30:00.000Z' }),
    cursorRound({
      session: s,
      id: `${s}#r461`,
      task: 66,
      round: 461,
      ts: '2026-09-09T21:31:00.000Z',
      tools: [tool('Grep', { pattern: 'x' })],
    }),
    cursorRound({ session: s, id: `${s}#r462`, task: 66, round: 462, ts: '2026-09-09T21:31:00.000Z' }),
    cursorRound({
      session: s,
      id: `${s}#r463`,
      task: 67,
      round: 463,
      ts: '2026-09-09T21:32:00.000Z',
      tools: [tool('Read', { path: '/tmp/b.ts' })],
    }),
    cursorRound({ session: s, id: `${s}#r464`, task: 67, round: 464, ts: '2026-09-09T21:32:00.000Z' }),
    cursorRound({
      session: s,
      id: `${s}#r465`,
      task: 68,
      round: 465,
      ts: '2026-09-09T21:32:00.000Z',
      text: 'prose-only evening turn',
    }),
    cursorRound({
      session: s,
      id: `${s}#r466`,
      task: 69,
      round: 466,
      ts: '2026-09-09T21:35:00.000Z',
      tools: [tool('Read', { path: '/tmp/c.ts' }), tool('StrReplace', { path: '/tmp/c.ts' })],
    }),
    cursorRound({ session: s, id: `${s}#r467`, task: 69, round: 467, ts: '2026-09-09T21:35:00.000Z' }),
    cursorRound({
      session: s,
      id: `${s}#r468`,
      task: 70,
      round: 468,
      ts: '2026-09-09T21:37:00.000Z',
      text: 'another prose turn',
    }),
    cursorRound({
      session: s,
      id: `${s}#r469`,
      task: 71,
      round: 469,
      ts: '2026-09-09T21:41:00.000Z',
      tools: [tool('Shell', { command: 'npm test' })],
    }),
    cursorRound({ session: s, id: `${s}#r482`, task: 71, round: 482, ts: '2026-09-09T21:41:00.000Z' }),
  ]
}

function eveningEvents88(): ReturnType<typeof event>[] {
  return [
    event({
      conversation_id: CONV_88,
      generation_id: 'f43d4014-9697-49f3-aa37-bdb434480bc3',
      input_tokens: 295328,
      output_tokens: 452,
      cache_read_tokens: 294400,
      cache_write_tokens: 0,
      recorded_at: '2026-09-09T21:30:40.315Z',
    }),
    event({
      conversation_id: CONV_88,
      generation_id: 'd1a61360-3510-4c91-960a-6e7df619cfc5',
      input_tokens: 295943,
      output_tokens: 342,
      cache_read_tokens: 149120,
      cache_write_tokens: 0,
      recorded_at: '2026-09-09T21:31:46.382Z',
    }),
    event({
      conversation_id: CONV_88,
      generation_id: 'a9dde6b9-98ce-47d9-868c-17e1e4f886c5',
      input_tokens: 150234,
      output_tokens: 217,
      cache_read_tokens: 149632,
      cache_write_tokens: 0,
      recorded_at: '2026-09-09T21:32:34.930Z',
    }),
    event({
      conversation_id: CONV_88,
      generation_id: '0ac88e5e-e3d3-4691-beae-67bf890a2a45',
      input_tokens: 304739,
      output_tokens: 1676,
      cache_read_tokens: 301696,
      cache_write_tokens: 0,
      recorded_at: '2026-09-09T21:36:20.242Z',
    }),
    event({
      conversation_id: CONV_88,
      generation_id: '1a9ce2ff-6c83-4f99-9cf9-148787fc2856',
      input_tokens: 154209,
      output_tokens: 391,
      cache_read_tokens: 153088,
      cache_write_tokens: 0,
      recorded_at: '2026-09-09T21:37:35.754Z',
    }),
    event({
      conversation_id: CONV_88,
      generation_id: '51af1827-7670-4574-973a-170fcfeeabc8',
      input_tokens: 2431701,
      output_tokens: 18076,
      cache_read_tokens: 2391424,
      cache_write_tokens: 0,
      recorded_at: '2026-09-09T21:44:21.306Z',
    }),
  ]
}

test('MAX_CURSOR_USAGE_TASK_DELTA_MS is thirty minutes', () => {
  assert.equal(MAX_CURSOR_USAGE_TASK_DELTA_MS, 30 * 60 * 1000)
})

test('88e089be evening events map to tasks 65–71 by temporal join', () => {
  const rounds = rounds88e089be()
  const events = eveningEvents88()
  assert.equal(applyCursorUsage(rounds, events), 6)

  const byTask = (n: number) => rounds.filter((r) => r.task === n)
  const taskIn = (n: number) => byTask(n).reduce((s, r) => s + (r.in_tokens ?? 0), 0)
  const taskOut = (n: number) => byTask(n).reduce((s, r) => s + (r.out_tokens ?? 0), 0)

  assert.equal(taskIn(65), 295328)
  assert.equal(taskOut(65), 452)
  assert.equal(taskIn(66), 295943)
  assert.equal(taskOut(66), 342)
  // 67 and 68 share first_ts; higher task number wins → 68 (prose).
  assert.equal(taskIn(67), 0)
  assert.equal(taskIn(68), 150234)
  assert.equal(taskOut(68), 217)
  assert.equal(taskIn(69), 304739)
  assert.equal(taskOut(69), 1676)
  assert.equal(taskIn(70), 154209)
  assert.equal(taskOut(70), 391)
  assert.equal(taskIn(71), 2431701)
  assert.equal(taskOut(71), 18076)

  // Old August tasks must not receive evening usage.
  assert.equal(taskIn(1), 0)
  assert.equal(taskIn(2), 0)

  // Exact totals across all rounds.
  const totalIn = rounds.reduce((s, r) => s + (r.in_tokens ?? 0), 0)
  const totalOut = rounds.reduce((s, r) => s + (r.out_tokens ?? 0), 0)
  assert.equal(
    totalIn,
    events.reduce((s, e) => s + e.input_tokens!, 0),
  )
  assert.equal(
    totalOut,
    events.reduce((s, e) => s + e.output_tokens!, 0),
  )

  // Prose-only matches still land Outside Tokens.
  const analysis = categoryTally(rounds, defaultPricing())
  assert.equal(analysis.coverage.outside_tokens, 150234 + 217 + 154209 + 391)
})

test('morning events beyond the delta stay unattributed', () => {
  const rounds = rounds88e089be()
  const morning = event({
    conversation_id: CONV_88,
    generation_id: '39c004c3-2fd6-4fe6-b011-f83c152760c4',
    input_tokens: 376474,
    output_tokens: 1096,
    cache_read_tokens: 187520,
    recorded_at: '2026-09-10T08:52:30.822Z',
  })
  assert.equal(matchCursorUsageTask(morning, rounds), null)
  assert.equal(applyCursorUsage(rounds, [...eveningEvents88(), morning]), 6)
  assert.equal(
    rounds.reduce((s, r) => s + (r.in_tokens ?? 0), 0),
    eveningEvents88().reduce((s, e) => s + e.input_tokens!, 0),
  )
})

test('a future task is never selected', () => {
  const session = 'future-task-session'
  const rounds = [
    cursorRound({
      session,
      id: `${session}#r0`,
      task: 1,
      round: 0,
      ts: '2026-09-09T22:00:00.000Z',
      tools: [tool('Read', { path: '/tmp/a.ts' })],
    }),
  ]
  const ev = event({
    conversation_id: session,
    recorded_at: '2026-09-09T21:59:00.000Z',
    input_tokens: 10,
    output_tokens: 1,
  })
  assert.equal(matchCursorUsageTask(ev, rounds), null)
  assert.equal(applyCursorUsage(rounds, [ev]), 0)
  assert.equal(rounds[0]!.in_tokens, null)
})

test('an old task beyond the threshold is not selected', () => {
  const session = 'old-task-session'
  const rounds = [
    cursorRound({
      session,
      id: `${session}#r0`,
      task: 1,
      round: 0,
      ts: '2026-09-09T20:00:00.000Z',
      tools: [tool('Read', { path: '/tmp/a.ts' })],
    }),
  ]
  // 31 minutes after task start — just past MAX_CURSOR_USAGE_TASK_DELTA_MS.
  const ev = event({
    conversation_id: session,
    recorded_at: '2026-09-09T20:31:00.000Z',
    input_tokens: 10,
    output_tokens: 1,
  })
  assert.equal(matchCursorUsageTask(ev, rounds), null)
  assert.equal(applyCursorUsage(rounds, [ev]), 0)
  assert.equal(rounds[0]!.in_tokens, null)
})

test('prose-only task is a valid match with Outside Tokens', () => {
  const session = 'prose-match-session'
  const rounds = [
    cursorRound({
      session,
      id: `${session}#r0`,
      task: 1,
      round: 0,
      ts: '2026-09-09T21:00:00.000Z',
      text: 'only prose',
    }),
  ]
  assert.equal(
    applyCursorUsage(rounds, [
      event({
        conversation_id: session,
        recorded_at: '2026-09-09T21:05:00.000Z',
        input_tokens: 80,
        output_tokens: 8,
      }),
    ]),
    1,
  )
  assert.equal(rounds[0]!.in_tokens, 80)
  const analysis = categoryTally(rounds, defaultPricing())
  assert.equal(analysis.coverage.tokens, 0)
  assert.equal(analysis.coverage.outside_tokens, 88)
})

test('multiple events do not overwrite each other across tasks', () => {
  const session = 'multi-event-session'
  const rounds = [
    cursorRound({
      session,
      id: `${session}#r0`,
      task: 1,
      round: 0,
      ts: '2026-09-09T21:00:00.000Z',
      tools: [tool('Read', { path: '/tmp/a.ts' })],
    }),
    cursorRound({
      session,
      id: `${session}#r1`,
      task: 2,
      round: 1,
      ts: '2026-09-09T21:10:00.000Z',
      tools: [tool('Read', { path: '/tmp/b.ts' })],
    }),
  ]
  applyCursorUsage(rounds, [
    event({
      conversation_id: session,
      generation_id: 'g-a',
      recorded_at: '2026-09-09T21:01:00.000Z',
      input_tokens: 100,
      output_tokens: 10,
    }),
    event({
      conversation_id: session,
      generation_id: 'g-b',
      recorded_at: '2026-09-09T21:11:00.000Z',
      input_tokens: 200,
      output_tokens: 20,
    }),
  ])
  assert.equal(rounds[0]!.in_tokens, 100)
  assert.equal(rounds[0]!.out_tokens, 10)
  assert.equal(rounds[1]!.in_tokens, 200)
  assert.equal(rounds[1]!.out_tokens, 20)
})

test('dedupe by generation_id still collapses stop and afterAgentResponse', () => {
  const session = 'dedupe-apply-session'
  const rounds = [
    cursorRound({
      session,
      id: `${session}#r0`,
      task: 1,
      round: 0,
      ts: '2026-09-09T21:00:00.000Z',
      tools: [tool('Read', { path: '/tmp/a.ts' })],
    }),
  ]
  const a = event({
    conversation_id: session,
    generation_id: 'same-gen',
    input_tokens: 50,
    output_tokens: 5,
    recorded_at: '2026-09-09T21:01:00.000Z',
  })
  const b = event({
    conversation_id: session,
    generation_id: 'same-gen',
    input_tokens: 90,
    output_tokens: 9,
    recorded_at: '2026-09-09T21:01:01.000Z',
  })
  ;(a as { hook_event_name: string }).hook_event_name = 'afterAgentResponse'
  assert.equal(applyCursorUsage(rounds, [a, b]), 1)
  assert.equal(rounds[0]!.in_tokens, 90)
  assert.equal(rounds[0]!.out_tokens, 9)
})

test('repeated applyCursorUsage is idempotent', () => {
  const rounds = rounds88e089be()
  const events = eveningEvents88()
  assert.equal(applyCursorUsage(rounds, events), 6)
  const firstIn = rounds.map((r) => r.in_tokens)
  const firstOut = rounds.map((r) => r.out_tokens)
  assert.equal(applyCursorUsage(rounds, events), 6)
  assert.equal(applyCursorUsage(rounds, events), 6)
  assert.deepEqual(
    rounds.map((r) => r.in_tokens),
    firstIn,
  )
  assert.deepEqual(
    rounds.map((r) => r.out_tokens),
    firstOut,
  )
  assert.equal(
    rounds.reduce((s, r) => s + (r.in_tokens ?? 0), 0),
    events.reduce((s, e) => s + e.input_tokens!, 0),
  )
})

test('same first_ts prefers the higher task number', () => {
  const session = 'tie-break-session'
  const rounds = [
    cursorRound({
      session,
      id: `${session}#r0`,
      task: 3,
      round: 0,
      ts: '2026-09-09T21:32:00.000Z',
      tools: [tool('Read', { path: '/tmp/a.ts' })],
    }),
    cursorRound({
      session,
      id: `${session}#r1`,
      task: 4,
      round: 1,
      ts: '2026-09-09T21:32:00.000Z',
      text: 'prose twin',
    }),
  ]
  const match = matchCursorUsageTask(
    event({
      conversation_id: session,
      recorded_at: '2026-09-09T21:32:34.000Z',
      input_tokens: 1,
      output_tokens: 1,
    }),
    rounds,
  )
  assert.equal(match?.task, 4)
})
