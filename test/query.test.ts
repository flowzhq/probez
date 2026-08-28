import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  fieldsUsed,
  FIELDS,
  keys,
  matches,
  parse,
  print,
  queryFromFilter,
  setSourceQuery,
  sourceQueryOf,
  subjectOf,
} from '../src/query.js'
import type { Query } from '../src/query.js'
import { filterRounds } from '../src/inspect.js'
import type { Round, ToolCall } from '../src/types.js'
import { PRICING, ROUND_DEFAULTS, TOOL_DEFAULTS } from './support.js'

function tool(name: string | null, extra: Partial<ToolCall> = {}): ToolCall {
  return { ...TOOL_DEFAULTS, name, result_chars: 100, is_error: false, ms: 10, ...extra }
}

function round(partial: Partial<Round> & { session: string; round: number }): Round {
  return { ...ROUND_DEFAULTS, id: `msg_${partial.session}_${partial.round}`, ...partial }
}

/** Whether one round satisfies a query, with the labels a caller would have worked out for it. */
function hits(query: Query, one: Round, labels: Array<{ category: string; target: string }> = []): boolean {
  return matches(
    query.node,
    subjectOf(one, {
      pricing: PRICING,
      labels: labels.map((label) => ({
        category: label.category as never,
        target: label.target as never,
        sub: '',
        weight: 1,
        source: '',
      })),
    }),
  )
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

test('bare words are free text and adjacency means and', () => {
  const query = parse('flaky test')
  assert.equal(query.node.kind, 'and')
  assert.equal(query.diagnostics.length, 0)
})

test('a quoted run is one term, spaces and colons and all', () => {
  const query = parse('"git commit -m fix: thing"')
  assert.deepEqual(query.node, {
    kind: 'term',
    text: 'git commit -m fix: thing',
    phrase: true,
    at: { from: 0, to: 26 },
  })
})

test('OR binds looser than adjacency', () => {
  const query = parse('tool:Edit tool:Write OR tool:Read')
  assert.equal(query.node.kind, 'or')
  assert.equal(query.node.kind === 'or' ? query.node.nodes[0]?.kind : null, 'and')
})

test('brackets regroup', () => {
  const query = parse('(tool:Edit OR tool:Write) is:error')
  assert.equal(query.node.kind, 'and')
  assert.equal(query.node.kind === 'and' ? query.node.nodes[0]?.kind : null, 'or')
})

test('a leading dash negates, and a dash inside a word does not', () => {
  assert.equal(parse('-tool:Read').node.kind, 'not')
  const dated = parse('since:2026-08-01')
  assert.equal(dated.node.kind, 'field')
  assert.equal(dated.diagnostics.length, 0)
})

test('a magnitude is read against the field it was written for', () => {
  const counted = parse('input:>2m').node
  assert.equal(counted.kind === 'field' ? counted.low : null, 2_000_000)
  // The same suffix on a duration is minutes, which is the only reading that makes `gen:>2m` mean
  // what anyone typing it means.
  const timed = parse('gen:>2m').node
  assert.equal(timed.kind === 'field' ? timed.low : null, 120_000)
})

test('a range is two bounds', () => {
  const node = parse('cost:0.10..0.50').node
  assert.equal(node.kind === 'field' ? node.op : null, 'range')
  assert.equal(node.kind === 'field' ? node.low : null, 0.1)
  assert.equal(node.kind === 'field' ? node.high : null, 0.5)
})

test('a relative time is measured from the moment given, so the parse is a pure function', () => {
  const now = Date.parse('2026-08-26T12:00:00Z')
  const node = parse('since:7d', { now }).node
  assert.equal(node.kind === 'field' ? node.low : null, now - 7 * 86_400_000)
})

// ---------------------------------------------------------------------------------------------
// Half-typed queries
// ---------------------------------------------------------------------------------------------

test('every prefix of a real query parses, and none of them throws', () => {
  const full = 'category:reconstruction cost:>0.50 -tool:Read since:7d "out_tokens" (a OR b)'
  for (let at = 0; at <= full.length; at += 1) {
    const query = parse(full.slice(0, at))
    assert.equal(typeof query.node.kind, 'string', `broke at ${at}: ${full.slice(0, at)}`)
  }
})

test('an unfinished field is neutral, so a list narrows instead of blanking', () => {
  const query = parse('cost:>')
  assert.equal(query.node.kind, 'all')
  assert.equal(query.diagnostics[0]?.message, '`cost:` needs a value')
  assert.deepEqual(query.diagnostics[0]?.at, { from: 0, to: 6 })
})

test('a value the field cannot take matches nothing, because it is a finished wrong thought', () => {
  const query = parse('category:banana')
  assert.equal(query.node.kind, 'none')
  assert.match(query.diagnostics[0]?.hint ?? '', /reconstruction|planning|delivery|testing/)
})

test('a near-miss key is named rather than silently searched', () => {
  const query = parse('categoy:test')
  assert.equal(query.node.kind, 'term')
  assert.equal(query.diagnostics[0]?.hint, 'did you mean category:?')
})

test('an ordinary colon in free text is not a failed field', () => {
  const query = parse('https://example.com/a')
  assert.equal(query.node.kind, 'term')
  assert.deepEqual(query.diagnostics, [])
})

test('an unclosed quote runs to the end and says so', () => {
  const query = parse('"src/act')
  assert.equal(query.node.kind === 'term' ? query.node.text : null, 'src/act')
  assert.equal(query.diagnostics[0]?.message, 'that quote is never closed')
})

test('diagnostics come back in the order they sit in the text', () => {
  const query = parse('cost:> categoy:test "unclosed')
  const starts = query.diagnostics.map((one) => one.at.from)
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b))
})

test('an unmatched bracket is reported and the rest still runs', () => {
  const query = parse('(tool:Edit')
  assert.equal(query.node.kind, 'field')
  assert.equal(query.diagnostics[0]?.message, 'that bracket is never closed')
})

// ---------------------------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------------------------

test('the directives are lifted out of the predicate tree', () => {
  const query = parse('is:error in:sessions sort:cost limit:10')
  assert.equal(query.entity, 'sessions')
  assert.deepEqual(query.sort, { key: 'cost', desc: true })
  assert.equal(query.limit, 10)
  assert.equal(query.node.kind, 'field')
})

test('sort puts the big end first, and a + asks for the other', () => {
  assert.deepEqual(parse('sort:ms').sort, { key: 'ms', desc: true })
  assert.deepEqual(parse('sort:+ms').sort, { key: 'ms', desc: false })
})

test('a directive that names nothing real is reported and ignored', () => {
  const query = parse('in:widgets')
  assert.equal(query.entity, 'rounds')
  assert.equal(query.diagnostics.length, 1)
})

// ---------------------------------------------------------------------------------------------
// Round-tripping
// ---------------------------------------------------------------------------------------------

test('printing a query and parsing it back yields the same tree', () => {
  for (const text of [
    'tool:Bash is:error',
    '(tool:Edit OR tool:Write) -is:sub',
    'category:reconstruction cost:>0.50 in:sessions sort:cost limit:5',
    '"a phrase" skill:*',
  ]) {
    const once = parse(text)
    const twice = parse(print(once))
    // Spans move when the text is rewritten, so the comparison is of everything else.
    assert.deepEqual(strip(twice.node), strip(once.node), text)
    assert.equal(twice.entity, once.entity)
    assert.deepEqual(twice.sort, once.sort)
    assert.equal(twice.limit, once.limit)
  }
})

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip)
  if (node === null || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'at') continue
    out[key] = strip(value)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// The field table
// ---------------------------------------------------------------------------------------------

test('every field is described, and no key is defined twice', () => {
  const seen = new Set<string>()
  for (const field of FIELDS) {
    assert.notEqual(field.says.trim(), '', field.key)
    assert.equal(seen.has(field.key), false, `${field.key} is in the table twice`)
    seen.add(field.key)
    if (field.kind === 'enum') assert.ok((field.values ?? []).length > 0, field.key)
  }
  // The directives are reserved as keys too, or `in:sessions` would parse as a field.
  assert.ok(keys().includes('in'))
})

test('fieldsUsed names what the tree asks about, so the labelling pass can be skipped', () => {
  assert.deepEqual([...fieldsUsed(parse('tool:Bash is:error').node)].sort(), ['is', 'tool'])
  assert.equal(fieldsUsed(parse('some words').node).size, 0)
})

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

test('a tool is matched by its whole name, the way --tool always has been', () => {
  const one = round({ session: 'a', round: 1, tools: [tool('Read')] })
  assert.equal(hits(parse('tool:Read'), one), true)
  assert.equal(hits(parse('tool:Rea'), one), false)
})

test('a command names its subcommands, the way the tools table prints them', () => {
  const one = round({
    session: 'a',
    round: 1,
    tools: [tool('Bash', { input: { command: 'git commit -m "x"' } })],
  })
  assert.equal(hits(parse('command:git'), one), true)
  assert.equal(hits(parse('command:"git commit"'), one), true)
  assert.equal(hits(parse('command:gitk'), one), false)
})

test('a session prefix stops at the segment it started in', () => {
  const own = round({ session: '504799b8', round: 1 })
  const sub = round({ session: '504799b8/a8261ff4', round: 1, agent: 'sub' })
  assert.equal(hits(parse('session:504799b8'), own), true)
  // Naming a session on its own means that session and not the subagents beneath it.
  assert.equal(hits(parse('session:504799b8'), sub), false)
  assert.equal(hits(parse('session:504799b8/a826'), sub), true)
  assert.equal(hits(parse('session:504799'), own), true)
})

test('source:claude matches persisted claude-code, and never guesses from tokens', () => {
  const claude = round({ session: 'a', round: 1, source: 'claude-code', in_tokens: null })
  const cursor = round({ session: 'b', round: 1, source: 'cursor', in_tokens: null })
  const unlabeled = round({ session: 'c', round: 1 })
  assert.equal(hits(parse('source:claude'), claude), true)
  assert.equal(hits(parse('source:claude-code'), claude), true)
  assert.equal(hits(parse('source:claude'), cursor), false)
  assert.equal(hits(parse('source:cursor'), cursor), true)
  // A round with no field is unknown, not Claude, even if it also has no tokens.
  assert.equal(hits(parse('source:claude'), unlabeled), false)
  assert.equal(hits(parse('source:unknown'), unlabeled), true)
})

test('setSourceQuery replaces a source token rather than appending another', () => {
  assert.equal(setSourceQuery('tool:Bash source:claude', 'cursor'), 'tool:Bash source:cursor')
  assert.equal(setSourceQuery('tool:Bash', 'claude'), 'tool:Bash source:claude')
  assert.equal(setSourceQuery('source:cursor', null), '')
  assert.equal(sourceQueryOf('tool:Bash source:claude source:codex'), 'codex')
})

test('a model is matched anywhere in its name, since nobody types the whole of one', () => {
  const one = round({ session: 'a', round: 1, model: 'claude-opus-5' })
  assert.equal(hits(parse('model:opus'), one), true)
})

test('numbers compare, and a round with nothing to compare does not match', () => {
  const one = round({ session: 'a', round: 1, out_tokens: 4000, ms: 45_000 })
  assert.equal(hits(parse('output:>2k'), one), true)
  assert.equal(hits(parse('output:>8k'), one), false)
  assert.equal(hits(parse('ms:>30s'), one), true)
  const empty = round({ session: 'a', round: 2, in_tokens: null })
  assert.equal(hits(parse('input:>0'), empty), false)
})

test('cost needs rates, and without them a round is unpriced rather than free', () => {
  const one = round({ session: 'a', round: 1, model: 'claude-opus-5', out_tokens: 1_000_000 })
  assert.equal(hits(parse('cost:>50'), one), true)
  // The flag compiler offers no rates, because no flag asks about money.
  assert.equal(
    matches(parse('cost:>50').node, subjectOf(one, { labels: [] })),
    false,
  )
})

test('is: and has: read the round rather than a field of it', () => {
  const failed = round({ session: 'a', round: 1, tools: [tool('Bash', { is_error: true })] })
  assert.equal(hits(parse('is:error'), failed), true)
  // A call that wrote to stderr while the harness reported no error is the failure `is:error`
  // cannot see, which is the whole reason `is:quiet` exists.
  const quiet = round({
    session: 'a',
    round: 2,
    tools: [tool('Bash', { is_error: false, stderr_chars: 40 })],
  })
  assert.equal(hits(parse('is:error'), quiet), false)
  assert.equal(hits(parse('is:quiet'), quiet), true)
  assert.equal(hits(parse('has:thinking'), round({ session: 'a', round: 3, thinking_chars: 10 })), true)
})

test('free text reaches the prompt, the prose and what the tools were pointed at', () => {
  const one = round({
    session: 'a',
    round: 1,
    user_text: 'why is the suite flaky',
    tools: [tool('Read', { input: { file_path: '/repo/src/act.ts' } })],
  })
  assert.equal(hits(parse('flaky'), one), true)
  assert.equal(hits(parse('src/act.ts'), one), true)
  assert.equal(hits(parse('nowhere'), one), false)
})

test('a label is read off the context, not off the round', () => {
  const one = round({ session: 'a', round: 1, tools: [tool('Grep')] })
  assert.equal(hits(parse('category:reconstruction'), one, [
    { category: 'reconstruction', target: 'code' },
  ]), true)
  assert.equal(hits(parse('target:test'), one, [{ category: 'reconstruction', target: 'code' }]), false)
})

// ---------------------------------------------------------------------------------------------
// One filter engine
// ---------------------------------------------------------------------------------------------

test('the flags compile to the tree a typed query produces', () => {
  const rounds = [
    round({ session: 'a', round: 1, tools: [tool('Bash', { input: { command: 'git status' } })] }),
    round({ session: 'a', round: 2, tools: [tool('Read')] }),
    round({ session: 'b', round: 3, agent: 'sub', tools: [tool('Bash', { is_error: true })] }),
    round({ session: 'c', round: 4, source: 'cursor', tools: [tool('Read')] }),
    round({ session: 'd', round: 5, source: 'claude-code', tools: [tool('Read')] }),
  ]
  const pairs: Array<[Parameters<typeof filterRounds>[1], string]> = [
    [{ tool: 'Read' }, 'tool:Read'],
    [{ command: 'git' }, 'command:git'],
    [{ agent: 'sub' }, 'agent:sub'],
    [{ source: 'cursor' }, 'source:cursor'],
    [{ source: 'claude' }, 'source:claude'],
    [{ errorsOnly: true }, 'is:error'],
    [{ session: 'a' }, 'session:a'],
    [{ kind: 'vcs' }, 'kind:vcs'],
  ]
  for (const [filter, text] of pairs) {
    const byFlag = filterRounds(rounds, filter)
    const byQuery = rounds.filter((one) => hits(parse(text), one))
    assert.deepEqual(
      byFlag.map((one) => one.round),
      byQuery.map((one) => one.round),
      text,
    )
  }
})

test('the compiled filter carries no diagnostics and no directives', () => {
  const query = queryFromFilter({ tool: 'Bash', errorsOnly: true })
  assert.deepEqual(query.diagnostics, [])
  assert.equal(query.entity, 'rounds')
  assert.equal(query.node.kind, 'and')
})
