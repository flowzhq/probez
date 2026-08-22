import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parsePlaced } from '../src/bash.js'
import { probesIn, scopeOf, siteOf, sitesIn, trailsOf } from '../src/trail.js'
import type { Trail } from '../src/trail.js'
import type { Round, ToolCall } from '../src/types.js'
import { ROUND_DEFAULTS, TOOL_DEFAULTS } from './support.js'

let next = 0

function tool(name: string, input: unknown, extra: Partial<ToolCall> = {}): ToolCall {
  next += 1
  return { ...TOOL_DEFAULTS, name, id: `t${next}`, input, result_chars: 0, ms: 0, ...extra }
}

function bash(command: string): ToolCall {
  return tool('Bash', { command })
}

/** One call per round, which is the shape a walk is easiest to read in. */
function walk(calls: ToolCall[], task = 1): Round[] {
  return calls.map((call, at) => ({
    ...ROUND_DEFAULTS,
    session: 's',
    round: at,
    task,
    id: `msg_${at}`,
    tools: [call],
  }))
}

/** `<from>-<edge>-><to>` for each linked step, which is the whole claim a trail makes. */
function edges(trail: Trail): string[] {
  return trail.steps
    .filter((step) => step.source !== null)
    .map((step) => `${step.source}-${step.edge}->${step.at}`)
}

// ---------------------------------------------------------------------------------------------
// What one call reached
// ---------------------------------------------------------------------------------------------

test('a probe is the word a search asked about, reduced to what could name a file', () => {
  assert.deepEqual(probesIn(bash('grep -rn "deepEqual" tests/')), ['deepequal'])
  assert.deepEqual(probesIn(bash('rg --type ts flushStore src/')), ['flushstore'])
  assert.deepEqual(probesIn(tool('Grep', { pattern: 'writeRounds' })), ['writerounds'])
  assert.deepEqual(probesIn(bash('find . -name "*.test.ts"')), ['test'])
  // A negated predicate names where not to look, which is not a question about the repository.
  assert.deepEqual(probesIn(bash("find . -type f -not -path '*/node_modules/*'")), [])
  // `-e` carries the pattern, so the bare argument after it is where to look, not what for.
  assert.deepEqual(probesIn(bash('grep -e collectProject -e slugFor src')), [
    'collectproject',
    'slugfor',
  ])
})

test('a grep after a pipe is filtering output, not asking the repository anything', () => {
  assert.deepEqual(probesIn(bash('npm test 2>&1 | grep "^not ok"')), [])
  assert.deepEqual(probesIn(bash('cat src/store.ts | grep collectProject')), [])
  // The same word on the other side of the pipe is a real question.
  assert.deepEqual(probesIn(bash('grep collectProject src/store.ts | head -20')), [
    'collectproject',
  ])
})

test('a pattern that is punctuation and short words asks about nothing nameable', () => {
  assert.deepEqual(probesIn(bash('grep -E "^(not ok|# [0-9]+)" out.txt')), [])
  assert.deepEqual(probesIn(bash('grep "^  it(" tests/vip.test.ts')), [])
})

test('a call names every path it touched, not just the one it was about', () => {
  assert.deepEqual(sitesIn(bash('cat src/a.ts src/b.ts src/c.ts')), [
    'src/a.ts',
    'src/b.ts',
    'src/c.ts',
  ])
  // A heredoc body is where a script names the file it rewrites, and an argument scan never sees it.
  assert.deepEqual(sitesIn(bash("python3 - <<'PY'\np = open('src/store.ts', 'w')\nPY")), [
    'src/store.ts',
  ])
})

test('scope is how wide the call reached', () => {
  const cases: Array<[ToolCall, string]> = [
    [bash('find . -type f'), 'tree'],
    [bash('rg flush'), 'tree'],
    [bash('grep -rn flush src'), 'dir'],
    [bash('cat src/store.ts'), 'file'],
    [bash('sed -n 85,110p src/store.ts'), 'span'],
    [tool('Read', { file_path: 'src/store.ts' }), 'file'],
    [tool('Read', { file_path: 'src/store.ts', offset: 40 }), 'span'],
    [tool('Glob', { pattern: '**/*.ts' }), 'tree'],
  ]
  for (const [call, want] of cases) {
    assert.equal(scopeOf(call, sitesIn(call)), want, JSON.stringify(call.input))
  }
})

test('a path is where it is relative to the checkout, so one file is one place', () => {
  assert.equal(siteOf('/repo/src/store.ts', '/repo'), 'src/store.ts')
  assert.equal(siteOf('/repo/src/store.ts', '/repo/'), 'src/store.ts')
  assert.equal(siteOf('./src/store.ts', '/repo'), 'src/store.ts')
  assert.equal(siteOf('/repo', '/repo'), '.')
  // Somewhere else on the machine is somewhere else. Rewriting it would fold the agent's own
  // notes into the project's source.
  assert.equal(siteOf('/Users/me/.claude/plan.md', '/repo'), '/Users/me/.claude/plan.md')
  // With no checkout to measure against, a path is left exactly as the call named it.
  assert.equal(siteOf('/repo/src/store.ts', ''), '/repo/src/store.ts')
})

test('a read of an absolute path follows a search that named the same file relatively', () => {
  const rounds = walk([
    bash('grep -rn "flushStore" src/'),
    bash('grep -n "flushStore" src/store.ts'),
    tool('Read', { file_path: '/repo/src/store.ts', offset: 40, limit: 40 }),
  ])
  // `Read` records an absolute path and a command records what was typed. Without the checkout the
  // two are different places, so the fetch half of every locate-then-fetch pair goes unexplained.
  const [shallow] = trailsOf(rounds)
  assert.equal(shallow, undefined)

  const [trail] = trailsOf(rounds, { root: '/repo' })
  assert.ok(trail !== undefined)
  assert.deepEqual(edges(trail), ['0-narrow->1', '1-narrow->2'])
  // Two places and not three: the read and the grep before it named one file between them.
  assert.equal(trail.paths, 2)
})

// ---------------------------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------------------------

test('a search names a word, and opening a file that carries it is following the search', () => {
  const rounds = walk([
    bash('grep -rn "delivery" src'),
    bash('cat src/services/delivery-service.ts'),
    bash('sed -n 40,80p src/services/delivery-service.ts'),
  ])
  const [trail] = trailsOf(rounds)
  assert.ok(trail !== undefined)
  assert.deepEqual(edges(trail), ['0-probe->1', '1-narrow->2'])
  assert.equal(trail.depth, 3)
  assert.equal(trail.root, 'probe')
})

test('a path under a directory an earlier call reached is a narrowing of it', () => {
  const rounds = walk([
    bash('grep -rn "deepEqual" tests/'),
    bash('sed -n 85,110p tests/app.test.ts'),
    bash('sed -n 12,40p tests/deliveries.test.ts'),
  ])
  const [trail] = trailsOf(rounds)
  assert.ok(trail !== undefined)
  assert.deepEqual(edges(trail), ['0-narrow->1', '0-narrow->2'])
  // One call explaining two is fan-out, which is width rather than depth.
  assert.equal(trail.breadth, 2)
  assert.equal(trail.depth, 2)
})

test('reading the same file again at the same width is paging, not a walk', () => {
  const rounds = walk([
    tool('Read', { file_path: 'src/store.ts', offset: 1 }),
    tool('Read', { file_path: 'src/store.ts', offset: 200 }),
    tool('Read', { file_path: 'src/store.ts', offset: 400 }),
    tool('Read', { file_path: 'src/store.ts', offset: 600 }),
  ])
  assert.deepEqual(trailsOf(rounds), [])
})

test('a result body proves an edge that the inputs alone cannot show', () => {
  const listing = bash('find . -type f')
  const rounds = walk([
    listing,
    bash('cat src/domain/types.ts'),
    bash('cat src/lib/money.ts'),
    bash('cat src/lib/geo.ts'),
  ])
  // Shallow: the tree only ever existed in the output, so nothing links.
  assert.deepEqual(trailsOf(rounds), [])

  const results = new Map([
    [listing.id!, './src/domain/types.ts\n./src/lib/money.ts\n./src/lib/geo.ts\n'],
  ])
  const [trail] = trailsOf(rounds, { results })
  assert.ok(trail !== undefined)
  assert.deepEqual(edges(trail), ['0-listed->1', '0-listed->2', '0-listed->3'])
  assert.equal(trail.confidence, 'proven')
  assert.equal(trail.root, 'listing')
})

test('a step attaches to the most recent call that explains it, not the first', () => {
  const rounds = walk([
    bash('grep -rn "store" src'),
    bash('cat src/store.ts'),
    bash('grep -rn "store" src/lib'),
    bash('cat src/lib/store-io.ts'),
  ])
  const [trail] = trailsOf(rounds)
  assert.ok(trail !== undefined)
  // Call 0 explains call 3 too, by the same word and the same containment. Provenance is the last
  // place the agent could have learned it, which is the only reading that keeps a walk a walk
  // rather than one node with every later call hanging off it.
  assert.deepEqual(edges(trail), ['0-probe->1', '0-narrow->2', '2-probe->3'])
  assert.equal(trail.depth, 3)
})

// ---------------------------------------------------------------------------------------------
// Trails
// ---------------------------------------------------------------------------------------------

test('a walk that never leaves one file is reading a file', () => {
  const rounds = walk([
    bash('grep -n "collect" src/store.ts'),
    bash('sed -n 1,40p src/store.ts'),
    bash('sed -n 90,130p src/store.ts'),
  ])
  assert.deepEqual(trailsOf(rounds), [])
})

test('two unlinked reads and a third are not a walk', () => {
  assert.deepEqual(
    trailsOf(walk([bash('cat README.md'), bash('cat package.json'), bash('cat tsconfig.json')])),
    [],
  )
})

test('a walk never crosses a user turn', () => {
  const first = walk([bash('grep -rn "store" src'), bash('cat src/store.ts')], 1)
  const second = walk([bash('sed -n 1,40p src/store.ts')], 2).map((round) => ({
    ...round,
    round: round.round + 2,
  }))
  assert.deepEqual(trailsOf([...first, ...second]), [])
})

test('a write to somewhere the walk visited is what the walk was for', () => {
  const rounds = walk([
    bash('grep -rn "delivery" src'),
    bash('cat src/services/delivery-service.ts'),
    bash('sed -n 40,80p src/services/delivery-service.ts'),
    bash('npm test'),
    tool('Edit', { file_path: 'src/services/delivery-service.ts' }),
  ])
  const [trail] = trailsOf(rounds)
  assert.ok(trail !== undefined)
  assert.equal(trail.outcome, 'edit')
  assert.equal(trail.ended_on, 'src/services/delivery-service.ts')
})

test('a suite reached without a change is work checked rather than changed', () => {
  const rounds = walk([
    bash('grep -rn "delivery" src'),
    bash('cat src/services/delivery-service.ts'),
    bash('sed -n 40,80p src/services/delivery-service.ts'),
    bash('npm test'),
  ])
  assert.equal(trailsOf(rounds)[0]?.outcome, 'test')
})

test('a search that led nowhere says so', () => {
  const rounds = walk([
    bash('grep -rn "delivery" src'),
    bash('cat src/services/delivery-service.ts'),
    bash('sed -n 40,80p src/services/delivery-service.ts'),
  ])
  assert.equal(trailsOf(rounds)[0]?.outcome, 'abandoned')
})

test('a write between two linked reads does not break the walk', () => {
  const rounds = walk([
    bash('grep -rn "delivery" src'),
    bash('cat src/services/delivery-service.ts'),
    tool('Edit', { file_path: 'src/routes/deliveries.ts' }),
    bash('sed -n 40,80p src/services/delivery-service.ts'),
  ])
  const [trail] = trailsOf(rounds)
  assert.ok(trail !== undefined)
  assert.equal(trail.steps.length, 3)
  assert.deepEqual(edges(trail), ['0-probe->1', '1-narrow->3'])
})

test('a trail carries its share of what the rounds cost', () => {
  const rounds = walk([
    bash('grep -rn "delivery" src'),
    bash('cat src/services/delivery-service.ts'),
    bash('sed -n 40,80p src/services/delivery-service.ts'),
  ]).map((round) => ({ ...round, ms: 1000, in_tokens: 300, out_tokens: 30 }))
  const [trail] = trailsOf(rounds)
  assert.ok(trail !== undefined)
  assert.equal(trail.ms, 3000)
  assert.equal(trail.in_tokens, 900)
  assert.equal(trail.out_tokens, 90)
})

test('a call that ran several commands charges each of them a share of its round', () => {
  const rounds: Round[] = [
    {
      ...ROUND_DEFAULTS,
      session: 's',
      round: 0,
      id: 'msg_0',
      ms: 1000,
      tools: [bash('grep -rn "delivery" src'), bash('cat src/services/delivery-service.ts')],
    },
    {
      ...ROUND_DEFAULTS,
      session: 's',
      round: 1,
      id: 'msg_1',
      ms: 1000,
      tools: [bash('sed -n 40,80p src/services/delivery-service.ts')],
    },
  ]
  const [trail] = trailsOf(rounds)
  assert.ok(trail !== undefined)
  // Two of the first round's calls at half each, plus the whole of the second.
  assert.equal(trail.ms, 2000)
})

// ---------------------------------------------------------------------------------------------
// The parser this rests on
// ---------------------------------------------------------------------------------------------

test('a command knows which side of a pipe it ran on', () => {
  assert.deepEqual(
    parsePlaced('npm test 2>&1 | grep "not ok" | head -5').map((one) => [one.name, one.piped]),
    [
      ['npm test', false],
      ['grep', true],
      ['head', true],
    ],
  )
  // `||` is not a pipe, and neither is one inside a quoted argument.
  assert.deepEqual(
    parsePlaced('npm test || echo "a | b"').map((one) => [one.name, one.piped]),
    [
      ['npm test', false],
      ['echo', false],
    ],
  )
})

test('placed commands keep repeats that the tally folds', () => {
  assert.deepEqual(
    parsePlaced('grep a src | grep b').map((one) => one.name),
    ['grep', 'grep'],
  )
})
