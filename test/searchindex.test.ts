import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { parse } from '../src/query.js'
import { fromRounds, fromStore, search } from '../src/search.js'
import { buildIndex, indexFile, relax, SearchIndex, tokensOf } from '../src/searchindex.js'
import type { Round, ToolCall } from '../src/types.js'
import { PRICING, ROUND_DEFAULTS, TOOL_DEFAULTS } from './support.js'

/**
 * The index is derived data, and the one property that matters about derived data is that it agrees
 * with what it was derived from. Nearly every test here is a form of that: the same query, answered
 * both ways, has to come back with the same rounds.
 */

function tool(name: string | null, extra: Partial<ToolCall> = {}): ToolCall {
  return { ...TOOL_DEFAULTS, name, result_chars: 100, is_error: false, ms: 10, ...extra }
}

function round(partial: Partial<Round> & { session: string; round: number }): Round {
  return {
    ...ROUND_DEFAULTS,
    id: `msg_${partial.session}_${partial.round}`,
    model: 'claude-opus-5',
    ts: `2026-08-${String((partial.round % 27) + 1).padStart(2, '0')}T10:00:00.000Z`,
    ...partial,
  }
}

/** A store directory holding these rounds, and nothing else. */
function store(rounds: Round[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'probez-index-test-'))
  writeFileSync(join(dir, 'rounds.jsonl'), rounds.map((one) => JSON.stringify(one)).join('\n') + '\n')
  return dir
}

/** A corpus wide enough that a query has something to be wrong about. */
function corpus(): Round[] {
  const rounds: Round[] = []
  const prompts = [
    'why is the suite flaky',
    'run npm test and fix what breaks',
    'the pnpm test script is different',
    'read src/act.ts and tell me what targetOf does',
    '',
  ]
  for (let at = 0; at < 40; at += 1) {
    const editing = at % 3 === 0
    rounds.push(
      round({
        session: at < 25 ? 'aaaa1111' : 'bbbb2222',
        round: at,
        task: (at % 4) + 1,
        agent: at % 7 === 0 ? 'sub' : 'main',
        user_text: prompts[at % prompts.length]!,
        text: at % 5 === 0 ? 'Here is what I found.' : '',
        thinking_chars: at % 6 === 0 ? 120 : 0,
        in_tokens: 1000 * at,
        in_uncached: 10 * at,
        in_cache_read: 900 * at,
        out_tokens: 100 + at,
        ms: at * 250,
        gen_ms: at * 400,
        skill: at % 11 === 0 ? 'code-review' : null,
        commit: at % 9 === 0 ? 'deadbeefdeadbeef' : null,
        source: at % 5 === 0 ? 'cursor' : at % 5 === 1 ? 'codex' : 'claude-code',
        tools: editing
          ? [tool('Edit', { patch: { files: 1, added: at, removed: 1 } })]
          : [
              tool('Bash', {
                input: { command: at % 4 === 0 ? 'git status' : 'grep -rn out_tokens src' },
                is_error: at % 8 === 0,
                stderr_chars: at % 10 === 0 ? 40 : null,
              }),
            ],
      }),
    )
  }
  return rounds
}

/** Both ways of answering the same query, as the round ids each returned. */
async function bothWays(dir: string, rounds: Round[], text: string): Promise<[string[], string[]]> {
  const query = parse(text, { now: Date.parse('2026-08-28T00:00:00Z') })
  const indexed = await search([await fromStore(dir, 'demo')], query, { pricing: PRICING, limit: 0 })
  const scanned = await search([fromRounds('demo', rounds)], query, { pricing: PRICING, limit: 0 })
  const ids = (result: Awaited<ReturnType<typeof search>>): string[] =>
    result.hits
      .map((hit) => `${(hit as { session: string }).session}#${(hit as { round: number }).round}`)
      .sort()
  assert.equal(indexed.scanned.indexed, 1, `${text} was not answered from the index`)
  return [ids(indexed), ids(scanned)]
}

// ---------------------------------------------------------------------------------------------
// The property that matters
// ---------------------------------------------------------------------------------------------

test('the index and the rounds answer every kind of query identically', async () => {
  const rounds = corpus()
  const dir = store(rounds)
  await buildIndex(dir)

  const queries = [
    'tool:Bash',
    'tool:Edit is:error',
    'command:git',
    'command:"git status"',
    'kind:vcs',
    'category:reconstruction',
    'target:code',
    'agent:sub',
    'source:claude',
    'source:cursor',
    'source:codex',
    'session:aaaa1111',
    'task:2',
    'round:12',
    'model:opus',
    'skill:*',
    'commit:deadbeef',
    'cost:>0.05',
    'cost:0.01..0.20',
    'ms:>5s',
    'gen:>2s',
    'input:>10k',
    'output:>120',
    'cached:>5k',
    'thinking:>0',
    'calls:>0',
    'errors:>0',
    'files:>0',
    'added:>10',
    'since:7d',
    'before:2026-08-20',
    'is:error',
    'is:quiet',
    'is:sub',
    'is:main',
    'has:patch',
    'has:thinking',
    'has:text',
    'has:skill',
    'has:commit',
    // Free text, which the index can only narrow towards.
    'flaky',
    'out_tokens',
    '"npm test"',
    'src/act.ts',
    'targetof',
    // And the shapes that combine them.
    'tool:Bash -is:error',
    '(tool:Edit OR tool:Bash) is:error',
    'flaky OR "npm test"',
    '-flaky tool:Bash',
    'flaky -tool:Edit',
    'category:reconstruction cost:>0.02 -tool:Edit since:30d',
    'nothingmatchesthisword',
  ]

  for (const text of queries) {
    const [indexed, scanned] = await bothWays(dir, rounds, text)
    assert.deepEqual(indexed, scanned, `\`${text}\` disagreed`)
  }
})

test('a word matches the start of a word and not the middle of one', async () => {
  const rounds = corpus()
  const dir = store(rounds)
  await buildIndex(dir)
  // `tok` is the start of `out_tokens`'s second word; `oken` is inside it.
  const [found] = await bothWays(dir, rounds, 'tok')
  assert.ok(found.length > 0)
  const [missing, alsoMissing] = await bothWays(dir, rounds, 'oken')
  assert.deepEqual(missing, [])
  assert.deepEqual(alsoMissing, [])
})

test('a phrase does not match inside a longer word', async () => {
  const rounds = corpus()
  const dir = store(rounds)
  await buildIndex(dir)
  const [npm] = await bothWays(dir, rounds, '"npm test"')
  const [pnpm] = await bothWays(dir, rounds, '"pnpm test"')
  assert.ok(npm.length > 0 && pnpm.length > 0)
  // Both exist in the corpus and neither finds the other, which is the boundary rule doing its job.
  assert.equal(npm.some((id) => pnpm.includes(id)), false)
})

test('the totals a share is divided by come off the index and match the rounds', async () => {
  const rounds = corpus()
  const dir = store(rounds)
  await buildIndex(dir)
  const query = parse('tool:Edit')
  const indexed = await search([await fromStore(dir, 'demo')], query, { pricing: PRICING })
  const scanned = await search([fromRounds('demo', rounds)], query, { pricing: PRICING })
  assert.deepEqual(indexed.scope, scanned.scope)
  assert.deepEqual(indexed.totals, scanned.totals)
  assert.equal(indexed.share.cost, scanned.share.cost)
})

test('a task keeps its name when the round that named it is not among the matches', async () => {
  const rounds = corpus()
  const dir = store(rounds)
  await buildIndex(dir)
  const query = parse('tool:Edit in:tasks')
  const indexed = await search([await fromStore(dir, 'demo')], query, { pricing: PRICING, limit: 0 })
  const scanned = await search([fromRounds('demo', rounds)], query, { pricing: PRICING, limit: 0 })
  const shape = (result: Awaited<ReturnType<typeof search>>): string[] =>
    result.hits
      .map((hit) => {
        const row = hit as { session: string; task: number; asked: string; of: number }
        return `${row.session}#${row.task} of=${row.of} asked=${row.asked}`
      })
      .sort()
  assert.deepEqual(shape(indexed), shape(scanned))
  assert.ok(shape(indexed).some((row) => row.includes('asked=why is the suite flaky')))
})

// ---------------------------------------------------------------------------------------------
// Staleness, absence, and everything else that means "read the rounds"
// ---------------------------------------------------------------------------------------------

test('an index whose rounds have moved underneath it is not used', async () => {
  const rounds = corpus()
  const dir = store(rounds)
  await buildIndex(dir)
  assert.notEqual(await SearchIndex.read(dir), null)

  const file = join(dir, 'rounds.jsonl')
  const before = readFileSync(file, 'utf8')
  writeFileSync(file, before + JSON.stringify(round({ session: 'cccc3333', round: 99 })) + '\n')
  assert.equal(await SearchIndex.read(dir), null)

  // And a search still answers, by reading the rounds and saying that it had to.
  const result = await search([await fromStore(dir, 'demo')], parse('tool:Bash'), {
    pricing: PRICING,
  })
  assert.equal(result.scanned.read, 1)
  assert.equal(result.scanned.indexed, 0)
  assert.ok(result.totals.rounds > 0)
})

test('an index from a version this probez does not know is not used', async () => {
  const dir = store(corpus())
  await buildIndex(dir)
  const file = indexFile(dir)
  const lines = readFileSync(file, 'utf8').split('\n')
  const header = JSON.parse(lines[0]!)
  header.index_version = 999
  lines[0] = JSON.stringify(header)
  writeFileSync(file, lines.join('\n'))
  assert.equal(await SearchIndex.read(dir), null)
})

test('a half-written index is not an index', async () => {
  const dir = store(corpus())
  await buildIndex(dir)
  const file = indexFile(dir)
  const text = readFileSync(file, 'utf8')
  writeFileSync(file, text.slice(0, Math.floor(text.length / 3)))
  assert.equal(await SearchIndex.read(dir), null)
})

test('a project with no index answers by reading its rounds', async () => {
  const rounds = corpus()
  const dir = store(rounds)
  const result = await search([await fromStore(dir, 'demo')], parse('tool:Bash'), {
    pricing: PRICING,
  })
  assert.equal(result.scanned.read, 1)
  const scanned = await search([fromRounds('demo', rounds)], parse('tool:Bash'), {
    pricing: PRICING,
  })
  assert.equal(result.totals.rounds, scanned.totals.rounds)
})

test('the index is written owner-only, and stays that way when it is rewritten', async () => {
  const dir = store(corpus())
  await buildIndex(dir)
  const file = indexFile(dir)
  assert.equal(statSync(file).mode & 0o077, 0)
  // A store somebody once loosened is repaired on the next build, not left loose: the index holds
  // prompts and shell commands like everything else here.
  chmodSync(file, 0o644)
  writeFileSync(join(dir, 'rounds.jsonl'), readFileSync(join(dir, 'rounds.jsonl')))
  await buildIndex(dir)
  assert.equal(statSync(file).mode & 0o077, 0)
})

test('a torn line keeps its place and matches nothing', async () => {
  const rounds = corpus()
  const dir = store(rounds)
  const file = join(dir, 'rounds.jsonl')
  const lines = readFileSync(file, 'utf8').split('\n')
  // A write cut off mid-record, which is what an interrupted collect leaves behind.
  lines.splice(5, 0, '{"session":"aaaa1111","round":5,"tool')
  writeFileSync(file, lines.join('\n'))
  await buildIndex(dir)

  const result = await search([await fromStore(dir, 'demo')], parse('tool:Bash'), {
    pricing: PRICING,
    limit: 0,
  })
  assert.equal(result.scanned.indexed, 1)
  // Every round that came back is a real one, and the torn line is not among them.
  assert.ok(result.hits.length > 0)
  for (const hit of result.hits) {
    assert.equal(typeof (hit as { session: string }).session, 'string')
  }
})

test('questions and trails are read from the rounds, because neither is a slice', async () => {
  const dir = store(corpus())
  await buildIndex(dir)
  const result = await search([await fromStore(dir, 'demo')], parse('tool:Bash in:questions'), {
    pricing: PRICING,
  })
  // The index is current; these two still read the rounds, and the result says so.
  assert.equal(result.scanned.read, 1)
  assert.equal(result.scanned.indexed, 0)
})

// ---------------------------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------------------------

test('relaxing a tree only ever widens it', () => {
  // A term cannot be answered from columns, so it drops out.
  assert.deepEqual(relax(parse('flaky').node), { kind: 'all' })
  // A negated term has to go whole: `-flaky` is false only where `flaky` is true, and the columns
  // cannot say where that is, so keeping it would drop rounds that do match.
  assert.deepEqual(relax(parse('-flaky').node), { kind: 'all' })
  // An alternation with one unanswerable branch cannot be narrowed at all.
  assert.deepEqual(relax(parse('flaky OR tool:Bash').node), { kind: 'all' })
  // What is left of an and is still worth applying.
  assert.equal(relax(parse('flaky tool:Bash').node).kind, 'field')
  // And a query of only fields is untouched.
  assert.equal(relax(parse('tool:Bash is:error').node).kind, 'and')
})

test('tokens are runs of letters and digits, and the very short and very long are left out', () => {
  assert.deepEqual(tokensOf('src/act.ts'), ['src', 'act', 'ts'])
  assert.deepEqual(tokensOf('out_tokens'), ['out', 'tokens'])
  assert.deepEqual(tokensOf('a b cd'), ['cd'])
  assert.deepEqual(tokensOf('x'.repeat(41)), [])
})

test('facet counts are what a typeahead offers, most used first', async () => {
  const dir = store(corpus())
  await buildIndex(dir)
  const index = await SearchIndex.read(dir)
  assert.notEqual(index, null)
  const tools = index!.facets('tool')
  assert.deepEqual(tools.map((row) => row.value).sort(), ['Bash', 'Edit'])
  assert.ok(tools[0]!.rounds >= tools[1]!.rounds)
  const sources = index!.facets('source')
  assert.ok(sources.some((row) => row.value === 'claude'))
  assert.ok(sources.some((row) => row.value === 'cursor'))
  assert.ok(sources.some((row) => row.value === 'codex'))
  assert.equal(
    tools.reduce((sum, row) => sum + row.rounds, 0),
    40,
  )
})

test('an index built from an empty store is an index of nothing rather than a failure', async () => {
  const dir = store([])
  const built = await buildIndex(dir)
  assert.equal(built?.rounds, 0)
  const result = await search([await fromStore(dir, 'demo')], parse('tool:Bash'), {
    pricing: PRICING,
  })
  assert.equal(result.totals.rounds, 0)
  assert.equal(result.scanned.indexed, 1)
})

test('there is nothing to index where there are no rounds at all', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'probez-index-test-'))
  assert.equal(await buildIndex(dir), null)
  assert.equal(await SearchIndex.read(dir), null)
})

test('an index whose mtime is untouched but whose size changed is refused', async () => {
  const dir = store(corpus())
  await buildIndex(dir)
  const file = join(dir, 'rounds.jsonl')
  const was = statSync(file)
  writeFileSync(file, readFileSync(file, 'utf8') + JSON.stringify(round({ session: 'z', round: 1 })) + '\n')
  // Put the clock back, so size is the only thing left to notice.
  utimesSync(file, was.atime, was.mtime)
  assert.equal(await SearchIndex.read(dir), null)
})
