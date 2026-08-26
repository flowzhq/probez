import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  AskingError,
  askedFile,
  askedKey,
  compileSentence,
  digestOf,
  parseAsked,
  promptFor,
  queryOf,
  readAsked,
  vocabularyOf,
} from '../src/asking.js'
import type { Vocabulary } from '../src/asking.js'
import { FIELDS } from '../src/query.js'
import { buildIndex, SearchIndex } from '../src/searchindex.js'
import type { ReaderConfig } from '../src/reader.js'
import { DEFAULT_TIMEOUT_MS } from '../src/reader.js'
import type { Round, ToolCall } from '../src/types.js'
import { ROUND_DEFAULTS, TOOL_DEFAULTS } from './support.js'

/**
 * Reading a sentence as a query.
 *
 * The tests that matter here are the refusals. What comes back from a reader is somebody else's
 * program's output, and the whole reason this is a bounded thing to do is that a query is all it
 * can be: parsed by probez, refused when it does not read, and never a number.
 */

const VOCABULARY: Vocabulary = {
  tool: [
    { value: 'Bash', rounds: 3632 },
    { value: 'Edit', rounds: 646 },
  ],
  command: [{ value: 'grep', rounds: 1088 }],
}

/** A reader that prints exactly this, and a store to keep its answers in. */
function reader(prints: string): { config: ReaderConfig; dataDir: string } {
  return {
    config: {
      schema_version: 1,
      command: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(prints)})`],
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    dataDir: mkdtempSync(join(tmpdir(), 'probez-ask-test-')),
  }
}

// ---------------------------------------------------------------------------------------------
// What is sent
// ---------------------------------------------------------------------------------------------

test('the prompt carries the schema and the sentence, and nothing else at all', () => {
  const prompt = promptFor('where did last week go', VOCABULARY)

  // Every field a query can name is in it, because the model is told not to invent one.
  for (const field of FIELDS) assert.match(prompt, new RegExp(`\\b${field.key}:`), field.key)
  assert.match(prompt, /where did last week go/)
  // And what this store calls things, which is the part it could not guess.
  assert.match(prompt, /Bash \(3632\)/)
  assert.match(prompt, /grep \(1088\)/)

  // Bounded. A schema plus a sentence is a few kilobytes, and it does not grow with the store.
  assert.ok(prompt.length < 12_000, `${prompt.length} characters is not bounded`)
})

test('a sentence is stripped and bounded before it is sent', () => {
  const prompt = promptFor(`ab${'x'.repeat(900)}`, {})
  assert.equal(prompt.includes(''), false, 'a control character reached the prompt')
  assert.equal(prompt.includes('x'.repeat(500)), false, 'the sentence was not bounded')
})

test('the digest is of the schema, so it moves when the store does and not when a question does', () => {
  const one = digestOf(VOCABULARY)
  assert.equal(one, digestOf(VOCABULARY))
  assert.notEqual(one, digestOf({ ...VOCABULARY, tool: [{ value: 'Read', rounds: 1 }] }))
  // The sentence is not part of it: two questions about the same store share a schema.
  assert.equal(askedKey('one question', one) === askedKey('another', one), false)
})

test('the vocabulary is names, stripped and bounded, most used first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'probez-ask-test-'))
  const tool = (name: string): ToolCall => ({ ...TOOL_DEFAULTS, name, is_error: false })
  const rounds: Round[] = [
    { ...ROUND_DEFAULTS, session: 'a', round: 0, id: 'm0', tools: [tool('Bash'), tool('Bash')] },
    { ...ROUND_DEFAULTS, session: 'a', round: 1, id: 'm1', tools: [tool('Bash')] },
    // A name out of somebody else's log, with a control character in it. Built rather than
    // written, for the same reason as the bell above.
    { ...ROUND_DEFAULTS, session: 'a', round: 2, id: 'm2', tools: [tool(`Ed${String.fromCharCode(0)}it`)] },
  ]
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(dir, 'rounds.jsonl'), rounds.map((one) => JSON.stringify(one)).join('\n') + '\n')
  await buildIndex(dir)

  const vocabulary = vocabularyOf([await SearchIndex.read(dir)])
  assert.deepEqual(
    vocabulary.tool?.map((one) => one.value),
    ['Bash', 'Edit'],
    'a control character survived into the vocabulary',
  )
  assert.equal(vocabulary.tool?.[0]?.rounds, 2)
  // Ids teach a model nothing and would fill the prompt, so they are not sampled.
  assert.equal(vocabulary.session, undefined)
  assert.equal(vocabulary.commit, undefined)
})

test('a project with no index contributes no vocabulary rather than being read in full', () => {
  assert.deepEqual(vocabularyOf([null, null]), {})
})

// ---------------------------------------------------------------------------------------------
// What comes back, and what is refused
// ---------------------------------------------------------------------------------------------

test('a query that reads cleanly is kept, with why it was read that way', () => {
  const asked = parseAsked(
    '{"query":"since:7d cost:>0.10 sort:cost","why":"ranking last week by spend"}',
    'where did last week go',
    'claude',
    'abc123',
  )
  assert.equal(asked.query, 'since:7d cost:>0.10 sort:cost')
  assert.equal(asked.why, 'ranking last week by spend')
  assert.equal(asked.by, 'claude')
  assert.equal(asked.schema, 'abc123')
})

test('a query probez cannot read is refused and quoted, never run', () => {
  // probez handed the model the whole field table, so an invented field is the answer being wrong
  // rather than a near miss to be forgiven.
  assert.throws(
    () => parseAsked('{"query":"categoy:test"}', 'x', 'claude', 'abc'),
    (error: Error) => {
      assert.ok(error instanceof AskingError)
      assert.match(error.message, /cannot read/)
      assert.match(error.message, /categoy:test/, 'the refusal does not quote what was said')
      return true
    },
  )
  assert.throws(() => parseAsked('{"query":"cost:>"}', 'x', 'claude', 'abc'), AskingError)
  assert.throws(() => parseAsked('{"query":"in:widgets"}', 'x', 'claude', 'abc'), AskingError)
})

test('a query that asks nothing is refused, because it is not an answer to a question', () => {
  assert.throws(() => parseAsked('{"query":"in:sessions"}', 'x', 'claude', 'abc'), AskingError)
})

test('an answer with no query in it says what the reader actually said', () => {
  assert.throws(
    () => parseAsked('I am afraid I cannot help with that.', 'x', 'claude', 'abc'),
    (error: Error) => {
      assert.match(error.message, /did not answer with the JSON asked for/)
      assert.match(error.message, /cannot help/)
      return true
    },
  )
  assert.throws(() => parseAsked('', 'x', 'claude', 'abc'), /answered with nothing/)
})

test('a reader that wraps its answer in a report is still read', () => {
  // The shape a CLI run with its own `--output-format json` produces, which is an ordinary setup.
  const asked = parseAsked(
    JSON.stringify({ type: 'result', result: '{"query":"tool:Bash","why":"tools"}' }),
    'x',
    'claude',
    'abc',
  )
  assert.equal(asked.query, 'tool:Bash')
})

// ---------------------------------------------------------------------------------------------
// Running one, and keeping it
// ---------------------------------------------------------------------------------------------

test('a sentence is compiled once and then held, and --again asks afresh', async () => {
  const { config, dataDir } = reader('{"query":"tool:Bash is:error","why":"failing tool calls"}')
  const first = await compileSentence(dataDir, config, 'what failed', VOCABULARY)
  assert.equal(first.ran, true)
  assert.equal(first.asked.query, 'tool:Bash is:error')

  const second = await compileSentence(dataDir, config, 'what failed', VOCABULARY)
  assert.equal(second.ran, false, 'the reader was run a second time for the same question')
  assert.equal(second.asked.at, first.asked.at)

  const again = await compileSentence(dataDir, config, 'what failed', VOCABULARY, { again: true })
  assert.equal(again.ran, true)

  // Kept beside `reader.json` and `pricing.json`, owner-only like everything else here.
  assert.ok(readFileSync(askedFile(dataDir), 'utf8').includes('tool:Bash'))
  assert.equal(statSync(askedFile(dataDir)).mode & 0o077, 0)
})

test('the same question about a different store is a different question', async () => {
  const { config, dataDir } = reader('{"query":"tool:Bash","why":"tools"}')
  await compileSentence(dataDir, config, 'what failed', VOCABULARY)
  await compileSentence(dataDir, config, 'what failed', { tool: [{ value: 'Read', rounds: 1 }] })
  assert.equal(Object.keys(await readAsked(dataDir)).length, 2)
})

test('a reader that answers badly leaves nothing behind', async () => {
  const { config, dataDir } = reader('{"query":"categoy:test"}')
  await assert.rejects(() => compileSentence(dataDir, config, 'x', VOCABULARY), AskingError)
  assert.deepEqual(await readAsked(dataDir), {})
})

test('a held answer whose query no longer reads is dropped rather than shown', async () => {
  const { config, dataDir } = reader('{"query":"tool:Bash","why":"tools"}')
  await compileSentence(dataDir, config, 'what failed', VOCABULARY)
  const { writeFileSync } = await import('node:fs')
  const held = JSON.parse(readFileSync(askedFile(dataDir), 'utf8'))
  for (const key of Object.keys(held.asked)) held.asked[key].query = 'categoy:test'
  writeFileSync(askedFile(dataDir), JSON.stringify(held))
  // A file edited by hand, or written by a probez whose grammar has since moved on.
  assert.deepEqual(await readAsked(dataDir), {})
})

test('the query is handed back as probez reads it, which is what a bar is filled with', () => {
  const asked = parseAsked(
    '{"query":"tool:Bash    is:error   in:sessions","why":"x"}',
    'x',
    'claude',
    'abc',
  )
  assert.equal(queryOf(asked), 'tool:Bash is:error in:sessions')
})
