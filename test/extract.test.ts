import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { extractSession, foldPatch, truncateInput } from '../src/extract.js'
import { parseHeadLog } from '../src/git.js'
import type { Round } from '../src/types.js'

// Compiled output lives at dist/test/, so the fixture is two levels up from here.
const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, '..', '..', 'test', 'fixtures', 'session.jsonl')
const COMPACTED = join(here, '..', '..', 'test', 'fixtures', 'compaction-session.jsonl')

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

test('the three input classes are kept apart, and still sum to the total', () => {
  const r = round('msg_b')
  assert.equal(r.in_uncached, 2)
  assert.equal(r.in_cache_write, 0)
  assert.equal(r.in_cache_read, 200)
  assert.equal(r.in_uncached + r.in_cache_write + r.in_cache_read, r.in_tokens)

  // The snapshot that wins for the total wins for the split too, rather than the two disagreeing.
  const a = round('msg_a')
  assert.equal(a.in_uncached, 5)
  assert.equal(a.in_cache_write, 100)
  assert.equal(a.in_cache_read, 0)
  assert.equal(a.in_uncached + a.in_cache_write + a.in_cache_read, a.in_tokens)
})

test('a round records its moments in file order', () => {
  assert.deepEqual(
    round('msg_a').events.map((e) => e.type),
    ['user_message', 'reasoning', 'text', 'tool_call'],
  )
  // The result that prompted the round precedes it in the file and belongs to it here.
  assert.deepEqual(
    round('msg_b').events.map((e) => e.type),
    ['tool_result', 'text', 'tool_call'],
  )
  const call = round('msg_a').events.find((e) => e.type === 'tool_call')
  assert.equal(call?.tool_call_id, 'tu_1')
})

test('generation time spans the wait before the model spoke, which ms does not', () => {
  // msg_b is prompted at 00:00:04 and answers at 00:00:05, all in one record: ms sees none of it.
  const b = round('msg_b')
  assert.equal(b.ms, 0)
  assert.equal(b.gen_ms, 1000)
  assert.equal(b.first_input, 'tool_result')
})

test('waiting on a person is measured, and only when there was a person to wait for', () => {
  // msg_b's round was driven by a tool result, so nobody was waited on.
  assert.equal(round('msg_b').wait_ms, null)
  // Nothing had been said before msg_a, so its user message waited on nothing.
  assert.equal(round('msg_a').wait_ms, null)
  // msg_b last spoke at 00:00:05; the prompt behind msg_c arrived at 00:00:08.
  assert.equal(round('msg_c').wait_ms, 3000)
})

test('work the harness attributed to a server or a skill says so', () => {
  const r = round('msg_c')
  assert.equal(r.mcp_server, 'figma')
  assert.equal(r.mcp_tool, 'get_screenshot')
  assert.equal(r.skill, 'dataviz')
  assert.equal(round('msg_a').mcp_server, null)
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

test('a truncated input still says how large it was', () => {
  const edit = round('msg_b').tools[0]!
  // The kept value is far shorter than what was passed, and the size is what says so.
  assert.ok(edit.input_chars > 2500)
  assert.ok(JSON.stringify(edit.input).length < edit.input_chars)
})

test('a call carries its id and both ends of its wall time', () => {
  const read = round('msg_a').tools[0]!
  assert.equal(read.id, 'tu_1')
  assert.equal(read.emitted_at, '2026-01-01T00:00:03.000Z')
  assert.equal(read.result_at, '2026-01-01T00:00:04.000Z')
})

test('a command that failed while the harness reported success is still visible', () => {
  const bash = round('msg_c').tools[0]!
  // This is the gap the harness flag leaves: it says the call was accepted, not that it worked.
  assert.equal(bash.is_error, false)
  assert.equal(bash.stderr_chars, 9)
  assert.equal(bash.interrupted, true)
})

test('an edit records the lines it changed', () => {
  const edit = round('msg_b').tools[0]!
  assert.deepEqual(edit.patch, { files: 1, added: 2, removed: 1 })
  // A tool that does not patch files says so by having none, not by reporting zeroes.
  assert.equal(round('msg_a').tools[0]!.patch, null)
})

test('a new file counts as lines added, not as a change of nothing', () => {
  // A create has nothing to diff against, so it arrives with an empty patch and its content.
  assert.deepEqual(
    foldPatch({ type: 'create', filePath: '/tmp/demo/new.ts', structuredPatch: [], content: 'a\nb\nc' }),
    { files: 1, added: 3, removed: 0 },
  )
  // An empty write really did add nothing, and a result with no patch at all is not an edit.
  assert.deepEqual(foldPatch({ filePath: '/tmp/demo/new.ts', structuredPatch: [], content: '' }), {
    files: 1,
    added: 0,
    removed: 0,
  })
  assert.equal(foldPatch({ stdout: 'hi' }), null)
})

test('truncateInput leaves short values alone and recurses', () => {
  assert.deepEqual(truncateInput({ a: 'short', b: [{ c: 1 }] }), { a: 'short', b: [{ c: 1 }] })
  const long = truncateInput({ a: 'q'.repeat(2001) }) as { a: string }
  assert.equal(long.a, `${'q'.repeat(200)}…(2001 chars)`)
})

/**
 * A commit stamped on a round is the one HEAD was on when its *task* started, so the fixture is
 * read against a reflog that moves in the middle of task 1: task 1 must still report where it began
 * even though the checkout had moved on by the time it ended.
 *
 * The fixture opens at 1767225600 and its second task at +8s.
 */
const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const HEAD = parseHeadLog(
  [
    `${'0'.repeat(40)} ${OLD} A <a@example.com> 1767225000 +0000\tcommit: before the session`,
    `${OLD} ${NEW} A <a@example.com> 1767225604 +0000\tcommit: made during task 1`,
  ].join('\n'),
)

const stamped = await extractSession(FIXTURE, 'demo', HEAD)
const commitOf = (id: string): string | null => {
  const found = stamped.find((r) => r.id === id)
  assert.ok(found, `no round ${id}`)
  return found.commit
}

test('a task is stamped with where it started, not what it ended on', () => {
  // msg_a and msg_b are task 1, which opened at 00:00:00, four seconds before the commit at +4s.
  assert.equal(commitOf('msg_a'), OLD)
  assert.equal(commitOf('msg_b'), OLD)
  // msg_c opens task 2 at 00:00:08, by which time HEAD had moved.
  assert.equal(commitOf('msg_c'), NEW)
  assert.equal(commitOf('msg_d'), NEW)
})

test('a subagent carries the commit of the task it was delegated by', () => {
  const sub = stamped.find((r) => r.id === 'msg_c2')
  assert.equal(sub?.agent, 'sub')
  assert.equal(sub?.task, 2)
  assert.equal(sub?.commit, NEW)
})

test('with no history to read, every round records no commit rather than a guess', () => {
  assert.ok(rounds.every((r) => r.commit === null))
})

// --- compaction ---------------------------------------------------------------------------------

const compacted = await extractSession(COMPACTED, 'compacted')
const byCompactedId = new Map(compacted.map((r) => [r.id, r]))
const compactedRound = (id: string): Round => {
  const found = byCompactedId.get(id)
  assert.ok(found, `no round ${id}`)
  return found
}

test('a compact boundary lands on the round that followed it', () => {
  assert.deepEqual(compactedRound('msg_post').compaction, {
    trigger: 'auto',
    pre_tokens: 999038,
    post_tokens: 23977,
    dropped_tokens: 975061,
    ms: 125645,
    ts: '2026-01-01T00:02:10.000Z',
  })
})

test('a compact boundary is not read as a round of its own', () => {
  assert.deepEqual(
    compacted.map((r) => r.id),
    ['msg_pre', 'msg_sub', 'msg_post', 'msg_after'],
  )
})

test('the round before a compaction, and every later one, carries none', () => {
  assert.equal(compactedRound('msg_pre').compaction, null)
  assert.equal(compactedRound('msg_after').compaction, null)
})

test('a subagent answering after a compaction does not take it', () => {
  // The subagent was never part of the context that was compacted, so the boundary belongs to the
  // next main-thread round rather than to whichever round simply came next in the file.
  assert.equal(compactedRound('msg_sub').compaction, null)
  assert.equal(compactedRound('msg_sub').agent, 'sub')
  assert.ok(compactedRound('msg_post').compaction !== null)
})

test('a compaction shows up as input tokens collapsing between rounds', () => {
  assert.equal(compactedRound('msg_pre').in_tokens, 999038)
  assert.equal(compactedRound('msg_post').in_tokens, 23977)
})
