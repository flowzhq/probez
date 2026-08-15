import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  asked,
  filterRounds,
  findRound,
  findTask,
  looksLikeSelector,
  matchSession,
  SelectorError,
  sessionRows,
  taskRows,
  toolSummary,
  toolTally,
} from '../src/inspect.js'
import type { Round, ToolCall } from '../src/types.js'

function tool(name: string | null, extra: Partial<ToolCall> = {}): ToolCall {
  return { name, input: {}, result_chars: 100, is_error: false, ms: 10, ...extra }
}

function round(partial: Partial<Round> & { session: string; round: number }): Round {
  return {
    task: 1,
    agent: 'main',
    id: `msg_${partial.session}_${partial.round}`,
    ts: `2026-01-0${partial.round + 1}T00:00:00.000Z`,
    ms: 100,
    model: 'claude-opus-5',
    in_tokens: 1000,
    out_tokens: 10,
    user_text: '',
    text: '',
    thinking_chars: 0,
    tools: [],
    ...partial,
  }
}

const rounds: Round[] = [
  round({ session: 'aaaa1111', round: 0, task: 1, tools: [tool('Read'), tool('Bash')] }),
  round({ session: 'aaaa1111', round: 1, task: 1, tools: [tool('Bash', { is_error: true, ms: 50 })] }),
  round({ session: 'aaaa1111', round: 2, task: 2, agent: 'sub', tools: [tool('Edit')] }),
  // The second session runs after the first, the way two sessions in one project actually do.
  round({ session: 'bbbb2222', round: 0, task: 1, ts: '2026-01-05T00:00:00.000Z', tools: [tool(null), tool('Read')] }),
  round({ session: 'bbbb2222', round: 1, task: 1, ts: '2026-01-06T00:00:00.000Z', tools: [] }),
]

test('sessions group, and tasks are counted within each session', () => {
  const rows = sessionRows(rounds)
  assert.deepEqual(
    rows.map((r) => [r.session, r.rounds, r.tasks]),
    [
      ['aaaa1111', 3, 2],
      ['bbbb2222', 2, 1],
    ],
  )
  // Task 1 exists in both sessions and must not be merged across them.
  assert.equal(
    rows.reduce((sum, r) => sum + r.tasks, 0),
    3,
  )
})

test('a session row counts its tool calls, errors and tokens', () => {
  const [first] = sessionRows(rounds)
  assert.ok(first)
  assert.equal(first.tool_calls, 4)
  assert.equal(first.errors, 1)
  assert.equal(first.in_tokens, 3000)
  assert.equal(first.out_tokens, 30)
  assert.equal(first.first_ts, '2026-01-01T00:00:00.000Z')
  assert.equal(first.last_ts, '2026-01-03T00:00:00.000Z')
})

test('sessions are ordered by when they were last active, not by the order rounds arrive', () => {
  const rows = sessionRows([...rounds].reverse())
  assert.deepEqual(
    rows.map((r) => r.session),
    ['aaaa1111', 'bbbb2222'],
  )
})

test('the tool tally sums calls, errors, result size and time', () => {
  const rows = toolTally(rounds)
  assert.deepEqual(
    rows.map((r) => [r.name, r.calls, r.errors]),
    [
      ['Bash', 2, 1],
      ['Read', 2, 0],
      ['Edit', 1, 0],
    ],
  )
  const bash = rows.find((r) => r.name === 'Bash')!
  assert.equal(bash.result_chars, 200)
  assert.equal(bash.ms, 60)
})

// One session's worth of rounds, as `probez session` narrows them before rolling them up.
const oneSession: Round[] = [
  round({ session: 'aaaa1111', round: 0, task: 1, user_text: 'why does the sync loop drop events?' }),
  round({ session: 'aaaa1111', round: 1, task: 1, out_tokens: 40 }),
  // A subagent round is still work its task paid for.
  round({ session: 'aaaa1111', round: 2, task: 1, agent: 'sub', ms: 250 }),
  round({ session: 'aaaa1111', round: 3, task: 2, user_text: 'now make it retry', in_tokens: 500 }),
]

test('tasks roll up the rounds that belong to them, subagents included', () => {
  const rows = taskRows(oneSession)
  assert.deepEqual(
    rows.map((r) => [r.task, r.rounds, r.in_tokens, r.out_tokens, r.ms]),
    [
      [1, 3, 3000, 60, 450],
      [2, 1, 500, 10, 100],
    ],
  )
})

test('task 1 of one session is not task 1 of the next', () => {
  // Task numbers restart in every session, so merging them by number alone would invent a task
  // that never happened. The id carries the session for exactly this reason.
  const rows = taskRows(rounds)
  assert.deepEqual(
    rows.map((r) => [r.session, r.task, r.rounds]),
    [
      ['aaaa1111', 1, 2],
      ['aaaa1111', 2, 1],
      ['bbbb2222', 1, 2],
    ],
  )
})

test('a task selector names its session, or takes the only one there is', () => {
  assert.deepEqual(
    findTask(rounds, 'aaaa1111#1').map((r) => r.round),
    [0, 1],
  )
  assert.deepEqual(
    findTask(rounds, 'bbbb#1').map((r) => r.round),
    [0, 1],
  )
  // A hinted session, from --session, stands in for the prefix.
  assert.deepEqual(findTask(rounds, '2', 'aaaa1111').map((r) => r.round), [2])
  const single = rounds.filter((r) => r.session === 'aaaa1111')
  assert.equal(findTask(single, '2').length, 1)
})

test('an unresolvable task selector says what went wrong', () => {
  assert.throws(() => findTask(rounds, 'aaaa1111#9'), (error: Error) => {
    assert.match(error.message, /no task 9, which runs 1 to 2/)
    return true
  })
  // Tasks start at 1, so 0 is not a task at all.
  assert.throws(() => findTask(rounds, 'aaaa1111#0'), (error: Error) => {
    assert.match(error.message, /tasks start at 1/)
    return true
  })
  assert.throws(() => findTask(rounds, 'nope'), (error: Error) => {
    assert.match(error.message, /is not a task selector/)
    return true
  })
  assert.throws(() => findTask(rounds, '1'), (error: Error) => {
    assert.match(error.message, /2 sessions/)
    return true
  })
  assert.throws(() => findTask([], '1'), SelectorError)
})

test('a task is named by what opened it, not by the rounds tool results drove', () => {
  const rows = taskRows(oneSession)
  assert.equal(rows[0]?.asked, 'why does the sync loop drop events?')
  assert.equal(rows[1]?.asked, 'now make it retry')
  // Nothing to roll up is an empty list, not a task 0.
  assert.deepEqual(taskRows([]), [])
})

test('a prompt is read without the envelope the harness wrapped it in', () => {
  const wrapped =
    '<local-command-caveat>Caveat: generated while running local commands.</local-command-caveat>\n' +
    '<command-name>/clear</command-name>\n            <command-args></command-args>\n' +
    'break Bash down by command'
  assert.equal(asked(wrapped), 'break Bash down by command')
  assert.equal(asked('  just a prompt  '), 'just a prompt')
  // Envelope and nothing else still has to say something, so it stands in for itself.
  assert.equal(asked('<command-name>/clear</command-name>'), '<command-name>/clear</command-name>')
})

// Bash calls carrying real command strings, which is what the second level is derived from.
const bashRounds: Round[] = [
  round({
    session: 'cccc3333',
    round: 0,
    tools: [
      tool('Bash', { input: { command: 'cd repo && npm test' }, ms: 40, result_chars: 300 }),
      tool('Bash', { input: { command: 'git status' }, ms: 5, result_chars: 20 }),
    ],
  }),
  round({
    session: 'cccc3333',
    round: 1,
    tools: [
      tool('Bash', { input: { command: 'git commit -m "x"' }, is_error: true, ms: 7, result_chars: 10 }),
      tool('Read', { input: { file_path: 'src/cli.ts' } }),
    ],
  }),
]

test('a tool with no second level is unchanged, and asking for one is opt-in', () => {
  assert.equal(toolTally(bashRounds)[0]?.sub, undefined)
  assert.equal(toolTally(bashRounds, 'command').find((r) => r.name === 'Read')?.sub, undefined)
})

test('a call that ran several commands is counted for each of them', () => {
  const bash = toolTally(bashRounds, 'command').find((r) => r.name === 'Bash')!
  assert.equal(bash.calls, 3)
  assert.deepEqual(
    bash.sub!.map((r) => [r.name, r.calls, r.kind]),
    [
      ['cd', 1, 'nav'],
      ['git commit', 1, 'vcs'],
      ['git status', 1, 'vcs'],
      ['npm test', 1, 'test'],
    ],
  )
  // Four commands out of three calls: `cd repo && npm test` counts for both of them.
  assert.equal(
    bash.sub!.reduce((sum, r) => sum + r.calls, 0),
    4,
  )
})

test('a command is charged the whole call, since a call has one result and one duration', () => {
  const bash = toolTally(bashRounds, 'command').find((r) => r.name === 'Bash')!
  const cd = bash.sub!.find((r) => r.name === 'cd')!
  const npm = bash.sub!.find((r) => r.name === 'npm test')!
  assert.equal(cd.ms, 40)
  assert.equal(npm.ms, 40)
  assert.equal(cd.result_chars, 300)
  // The failure belongs to the call, and `git commit` is the only command in it.
  assert.equal(bash.errors, 1)
  assert.equal(bash.sub!.find((r) => r.name === 'git commit')!.errors, 1)
  assert.equal(cd.errors, 0)
})

test('by kind, distinct commands of one kind are one use of that kind', () => {
  const bash = toolTally(bashRounds, 'kind').find((r) => r.name === 'Bash')!
  assert.deepEqual(
    bash.sub!.map((r) => [r.name, r.calls]),
    [
      ['vcs', 2],
      ['nav', 1],
      ['test', 1],
    ],
  )
})

test('a Bash call whose command cannot be read still occupies a row', () => {
  const opaque = [round({ session: 'dddd4444', round: 0, tools: [tool('Bash', { input: { command: '$CMD' } })] })]
  const bash = toolTally(opaque, 'command')[0]!
  assert.equal(bash.calls, 1)
  assert.deepEqual(bash.sub!.map((r) => r.name), ['(unparsed)'])
})

test('rounds filter by command and by kind of work', () => {
  // A bare program name also names its subcommands, the way the sub-rows read.
  assert.equal(filterRounds(bashRounds, { command: 'git' }).length, 2)
  assert.equal(filterRounds(bashRounds, { command: 'git commit' }).length, 1)
  assert.equal(filterRounds(bashRounds, { command: 'Git' }).length, 2)
  // `commit` is not a program, so it matches nothing on its own.
  assert.equal(filterRounds(bashRounds, { command: 'commit' }).length, 0)
  assert.equal(filterRounds(bashRounds, { kind: 'test' }).length, 1)
  assert.equal(filterRounds(bashRounds, { kind: 'vcs' }).length, 2)
  assert.equal(filterRounds(bashRounds, { kind: 'vcs', errorsOnly: true }).length, 1)
})

test('a call whose name never arrived gets no bucket of its own', () => {
  assert.deepEqual(
    toolTally(rounds).map((r) => r.name),
    ['Bash', 'Read', 'Edit'],
  )
})

test('the per-round tool summary counts by name and flags failures', () => {
  assert.equal(toolSummary(rounds[0]!), 'Bash 1 · Read 1')
  assert.equal(toolSummary(rounds[1]!), 'Bash 1 ✗1')
  assert.equal(toolSummary(rounds[4]!), '·')
})

test('filters compose', () => {
  assert.equal(filterRounds(rounds, { session: 'aaaa1111' }).length, 3)
  assert.equal(filterRounds(rounds, { task: 2 }).length, 1)
  assert.equal(filterRounds(rounds, { agent: 'sub' }).length, 1)
  assert.equal(filterRounds(rounds, { errorsOnly: true }).length, 1)
  // Tool names are matched case-insensitively, since they are typed by hand.
  assert.equal(filterRounds(rounds, { tool: 'bash' }).length, 2)
  assert.equal(filterRounds(rounds, { session: 'aaaa1111', tool: 'Bash', errorsOnly: true }).length, 1)
  assert.equal(filterRounds(rounds, { task: 2, errorsOnly: true }).length, 0)
})

test('a session prefix resolves when it is unique, and names the candidates when it is not', () => {
  const ids = ['aaaa1111', 'aaaa2222', 'bbbb3333']
  assert.equal(matchSession(ids, 'b'), 'bbbb3333')
  assert.equal(matchSession(ids, 'aaaa1'), 'aaaa1111')
  assert.equal(matchSession(ids, 'aaaa1111'), 'aaaa1111')
  assert.throws(() => matchSession(ids, 'aaaa'), (error: Error) => {
    assert.ok(error instanceof SelectorError)
    assert.match(error.message, /matches 2 sessions: aaaa1111, aaaa2222/)
    return true
  })
  assert.throws(() => matchSession(ids, 'zz'), SelectorError)
})

test('an id is told apart from a project name by its shape', () => {
  assert.ok(looksLikeSelector('7'))
  assert.ok(looksLikeSelector('0'))
  assert.ok(looksLikeSelector('1.7'))
  assert.ok(looksLikeSelector('aaaa1111#7'))
  assert.ok(looksLikeSelector('aaaa1111#1.7'))
  assert.ok(!looksLikeSelector('probez'))
  assert.ok(!looksLikeSelector('~/Dev/probez'))
  assert.ok(!looksLikeSelector('7probez'))
})

test('a round is found by session prefix, and by task.round alone when unambiguous', () => {
  assert.equal(findRound(rounds, 'bbbb#1.1').session, 'bbbb2222')
  assert.equal(findRound(rounds, 'aaaa1111#2.2').round, 2)
  // A hinted session, from --session, stands in for the prefix.
  assert.equal(findRound(rounds, '1.1', 'bbbb2222').session, 'bbbb2222')
  const single = rounds.filter((r) => r.session === 'aaaa1111')
  assert.equal(findRound(single, '2.2').round, 2)
})

test('a task id given to round says so, rather than naming a different round', () => {
  // The failure this whole scheme exists to prevent: `aaaa1111#2` is task 2, and answering it as
  // round 2 would be a real round and the wrong answer.
  assert.throws(() => findRound(rounds, 'aaaa1111#2'), (error: Error) => {
    assert.match(error.message, /names a task/)
    assert.match(error.message, /probez task aaaa1111#2/)
    return true
  })
  assert.throws(() => findTask(rounds, 'aaaa1111#2.2'), (error: Error) => {
    assert.match(error.message, /names a round\. Its task is aaaa1111#2/)
    return true
  })
})

test('the task in a round id is checked, not ignored', () => {
  // Round 2 of that session is in task 2, so this id was assembled from two different rows.
  assert.throws(() => findRound(rounds, 'aaaa1111#1.2'), (error: Error) => {
    assert.match(error.message, /is in task 2, not task 1\. Try aaaa1111#2.2/)
    return true
  })
})

test('an unresolvable selector says what went wrong', () => {
  assert.throws(() => findRound(rounds, '1.1'), (error: Error) => {
    assert.match(error.message, /2 sessions/)
    return true
  })
  assert.throws(() => findRound(rounds, 'aaaa1111#1.9'), (error: Error) => {
    assert.match(error.message, /no round 9, which runs 0 to 2/)
    return true
  })
  assert.throws(() => findRound(rounds, 'nope'), SelectorError)
  assert.throws(() => findRound([], '1.1'), (error: Error) => {
    assert.match(error.message, /nothing collected/)
    return true
  })
})
