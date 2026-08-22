import assert from 'node:assert/strict'
import { test } from 'node:test'

import { questionShare, questionsOf } from '../src/question.js'
import type { Question } from '../src/question.js'
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

/** One call per round, which is the shape a question is easiest to read in. */
function asked(calls: ToolCall[], task = 1): Round[] {
  return calls.map((call, at) => ({
    ...ROUND_DEFAULTS,
    session: 's',
    round: at,
    task,
    id: `msg_${at}`,
    tools: [call],
  }))
}

/** `<kind>:<calls>` for each question, which is the whole claim this module makes. */
function shape(questions: Question[]): string[] {
  return questions.map((question) => `${question.kind}:${question.calls.length}`)
}

// ---------------------------------------------------------------------------------------------
// What one question is
// ---------------------------------------------------------------------------------------------

test('asking the same thing again is the same question, however little it narrowed', () => {
  // The eleven-grep run this module exists for, shortened. Not one of these calls narrows anything,
  // so `trailsOf` sees no edge, no step and no walk; the cost is real all the same.
  const questions = questionsOf(
    asked([
      bash('grep -n "out_tokens" src/inspect.ts'),
      bash('grep -n "out_tokens" src/inspect.ts | head -20'),
      bash("grep -n 'out_tokens' src/inspect.ts"),
      bash('grep -an "out_tokens" src/inspect.ts'),
    ]),
  )
  assert.equal(questions.length, 1)
  assert.equal(questions[0]!.calls.length, 4)
  assert.deepEqual(questions[0]!.terms, ['out_tokens'])
  // Three of the four asked the same words of the same place. That is the number a walk drops.
  assert.equal(questions[0]!.repeats, 3)
})

test('a word nobody asked before starts a question of its own', () => {
  const questions = questionsOf(
    asked([
      bash('grep -rn "collectProject" src/'),
      bash('grep -rn "slugFor" src/'),
    ]),
  )
  assert.equal(questions.length, 2)
  assert.deepEqual(questions.map((one) => one.terms), [['collectproject'], ['slugfor']])
})

test('a read that asked nothing belongs to the question that named the file', () => {
  const questions = questionsOf(
    asked([
      bash('grep -n "flushStore" src/store.ts'),
      bash('sed -n 40,80p src/store.ts'),
      tool('Read', { file_path: 'src/store.ts', offset: 120, limit: 40 }),
    ]),
  )
  assert.equal(questions.length, 1)
  assert.equal(questions[0]!.calls.length, 3)
  // Both reads exist only to turn a line number into a body. That is the two-step, counted.
  assert.equal(questions[0]!.fetches, 2)
})

test('the same word far enough later is a new question, not a resumption', () => {
  const filler = Array.from({ length: 14 }, (_, at) => bash(`cat src/other${at}.ts`))
  const questions = questionsOf(
    asked([bash('grep -rn "flushStore" src/'), ...filler, bash('grep -rn "flushStore" src/')]),
  )
  const store = questions.filter((one) => one.terms.includes('flushstore'))
  assert.equal(store.length, 2)
  assert.equal(store[0]!.repeats, 0)
})

test('a guess can join a question but cannot say what the question is about', () => {
  // Shortened from the task that prompted the rule. The agent was updating a classifier's table of
  // command kinds; the sweep in the middle is one guess at what that table might be called, and it
  // named seven words. Left to seed the question, `kubectl` and `docker` became part of its
  // identity, and a search of a different corpus entirely — probez's own store, not the repository
  // — matched them much later and was folded in.
  const questions = questionsOf(
    asked([
      bash('grep -rn "CommandKind\\|VERBS" src/'),
      bash('grep -n "docker\\|kubectl\\|terraform\\|aws\\|gcloud\\|CommandKind" test/bash.test.ts'),
      bash('grep -n "VERBS" src/classify.ts'),
      bash('grep -a "kubectl \\|docker \\|aws " ~/.probez/projects/oss/rounds.jsonl'),
    ]),
  )
  // Three calls about the classifier, and one about somewhere else that happens to share a guess.
  assert.equal(questions.length, 2)
  assert.equal(questions[0]!.calls.length, 3)
  assert.deepEqual(questions[1]!.terms, ['kubectl', 'docker'])
  // The sweep is still reported as one of the question's calls, and still counted as a guess.
  assert.equal(questions[0]!.sweeps, 1)
  // And it still says what it asked about, even the parts that could not become identity.
  assert.ok(questions[0]!.terms.includes('gcloud'))
})

test('a question opened by a guess keeps the guess, because it has nothing else', () => {
  // The exemption, stated as a test so it is a decision rather than an oversight: without it a
  // question that begins with a sweep has no identity and nothing can ever join it.
  const questions = questionsOf(
    asked([
      bash('grep -rn "advance\\|newContext\\|CallContext" src/'),
      bash('grep -n "CallContext" src/act.ts'),
    ]),
  )
  assert.equal(questions.length, 1)
  assert.equal(questions[0]!.calls.length, 2)
})

test('a pattern of the language\'s own words is a table of contents, not a guess', () => {
  const questions = questionsOf(
    asked([bash('grep -n "^export \\|^interface \\|^function " src/inspect.ts')]),
  )
  assert.equal(questions[0]!.sweeps, 0)
  assert.equal(questions[0]!.kind, 'outline')
})

test('a question never crosses a user turn, because a new turn is a new subject', () => {
  const questions = questionsOf([
    ...asked([bash('grep -rn "flushStore" src/')], 1),
    ...asked([bash('grep -rn "flushStore" src/')], 2),
  ])
  assert.equal(questions.length, 2)
})

test('a grep after a pipe filtered output and asked the repository nothing', () => {
  // A suite whose output was filtered found nothing out about the repository, so it is not a
  // question at all — it is not even a finding call. In a real store that grep is the commonest
  // of the two by a wide margin, and counted as a question it would invent one at every test run.
  assert.deepEqual(
    shape(questionsOf(asked([
      bash('grep -n "flushStore" src/store.ts'),
      bash('npm test 2>&1 | grep "^not ok"'),
    ]))),
    ['define:1'],
  )
  // Filtering a file the question already opened is still that question, and still a call it cost.
  const piped = questionsOf(asked([
    bash('grep -n "flushStore" src/store.ts'),
    bash('cat src/store.ts | grep collectProject'),
  ]))
  assert.deepEqual(shape(piped), ['define:2'])
  assert.deepEqual(piped[0]!.terms, ['flushstore'])
})

// ---------------------------------------------------------------------------------------------
// Which of the seven it was
// ---------------------------------------------------------------------------------------------

test('a question that reached the test surface is asking what constrains the thing', () => {
  assert.deepEqual(
    shape(questionsOf(asked([bash('grep -rn "deepEqual" test/inspect.test.ts')]))),
    ['covers:1'],
  )
})

test('a question that crossed into prose is the four-places question', () => {
  assert.deepEqual(
    shape(questionsOf(asked([bash("grep -rn '0\\.1\\.[0-9]' README.md docs/PRD.md")]))),
    ['touches:1'],
  )
})

test('a question made of the language’s own words asks what a file declares', () => {
  assert.deepEqual(
    shape(questionsOf(asked([bash('grep -n "^export \\|^interface \\|^function " src/inspect.ts')]))),
    ['outline:1'],
  )
  // A file opened whole asked no word at all, and wanted the same thing.
  assert.deepEqual(shape(questionsOf(asked([tool('Read', { file_path: 'src/inspect.ts' })]))), [
    'outline:1',
  ])
})

test('one word carried into three places is a value being followed between layers', () => {
  assert.deepEqual(
    shape(
      questionsOf(
        asked([
          bash('grep -n "in_tokens" src/extract.ts'),
          bash('grep -n "in_tokens" src/inspect.ts'),
          bash('grep -n "in_tokens" web/src/api.ts'),
        ]),
      ),
    ),
    ['flow:3'],
  )
})

test('a flow survives the synonyms guessed along the way', () => {
  // The count is per word and not over the question's vocabulary. A question re-asked collects
  // every guess the agent made; counting those would rule out exactly the long questions that are
  // most likely to be flows.
  const questions = questionsOf(
    asked([
      bash('grep -n "in_tokens\\|tally\\|Coverage\\|CategoryRow" src/extract.ts'),
      bash('grep -n "in_tokens" src/inspect.ts'),
      bash('grep -n "in_tokens" web/src/api.ts'),
    ]),
  )
  assert.deepEqual(shape(questions), ['flow:3'])
})

test('a word asked of a tree is where-is-this-used, and of one file is show-me-this', () => {
  assert.deepEqual(shape(questionsOf(asked([bash('grep -rn "flushStore" src/')]))), ['refs:1'])
  assert.deepEqual(shape(questionsOf(asked([bash('grep -n "flushStore" src/store.ts')]))), [
    'define:1',
  ])
})

// ---------------------------------------------------------------------------------------------
// What it cost
// ---------------------------------------------------------------------------------------------

test('three words at once is the agent guessing at vocabulary it has not learned', () => {
  const questions = questionsOf(
    asked([bash('grep -n "advance\\|newContext\\|CallContext\\|classifyCall" src/act.ts')]),
  )
  assert.equal(questions[0]!.sweeps, 1)
  // Two alternatives is a spelling, not a guess.
  const spelled = questionsOf(asked([bash('grep -n "advance\\|newContext" src/act.ts')]))
  assert.equal(spelled[0]!.sweeps, 0)
})

test('a share counts questions against the calls they cost, not calls against calls', () => {
  const share = questionShare(
    asked([
      bash('grep -n "out_tokens" src/inspect.ts'),
      bash("grep -n 'out_tokens' src/inspect.ts"),
      bash('grep -rn "slugFor" src/'),
    ]),
  )
  assert.equal(share.questions, 2)
  assert.equal(share.calls, 3)
  assert.equal(share.repeats, 1)
  assert.equal(share.reasked, 1)
  assert.equal(share.worst?.calls.length, 2)
})

test('an absolute path and a typed one are one place once the checkout is known', () => {
  const calls = asked([
    bash('grep -n "flushStore" src/store.ts'),
    tool('Read', { file_path: '/repo/src/store.ts', offset: 40, limit: 40 }),
  ])
  // Without the checkout the two name different files, so the read starts a question of its own.
  assert.equal(questionsOf(calls).length, 2)
  const joined = questionsOf(calls, { root: '/repo' })
  assert.equal(joined.length, 1)
  assert.equal(joined[0]!.fetches, 1)
  assert.deepEqual(joined[0]!.files, ['src/store.ts'])
})
