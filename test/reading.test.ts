import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { questionsOf } from '../src/question.js'
import type { Question } from '../src/question.js'
import { DEFAULT_TIMEOUT_MS, readerFile, readReader, runReader, writeReader } from '../src/reader.js'
import type { ReaderConfig } from '../src/reader.js'
import {
  digestOf,
  explainQuestion,
  isStale,
  parseReading,
  promptFor,
  readingKey,
  readingsFile,
  readReadings,
  ReadingError,
} from '../src/reading.js'
import type { Round, ToolCall } from '../src/types.js'
import { ROUND_DEFAULTS, TOOL_DEFAULTS } from './support.js'

/**
 * The reader, which is the one thing in probez that runs a program.
 *
 * Most of what is asserted here is a refusal: that the prompt carries the calls and nothing that
 * was said around them, that argv is argv and not a shell line, and that every way a reader can
 * misbehave — missing, failing, hanging, answering in prose — comes back as a message rather than
 * as a hang or a crash.
 */

let next = 0

function bash(command: string): ToolCall {
  next += 1
  return { ...TOOL_DEFAULTS, name: 'Bash', id: `t${next}`, input: { command }, result_chars: 0, ms: 0 }
}

function asked(commands: string[], extra: Partial<Round> = {}): Round[] {
  return commands.map((command, at) => ({
    ...ROUND_DEFAULTS,
    session: 's',
    round: at,
    task: 1,
    id: `msg_${at}`,
    tools: [bash(command)],
    ...extra,
  }))
}

function oneQuestion(rounds: Round[]): Question {
  const questions = questionsOf(rounds)
  assert.equal(questions.length, 1, 'the fixture should be one question')
  return questions[0]!
}

/** A reader written as a node script, so the tests need nothing installed to have one. */
function fakeReader(dir: string, name: string, body: string): string[] {
  const file = join(dir, name)
  writeFileSync(file, body, 'utf8')
  return [process.execPath, file]
}

function config(command: string[], timeout = 10_000): ReaderConfig {
  return { schema_version: 1, command, timeout_ms: timeout }
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'probez-reader-'))
}

// ---------------------------------------------------------------------------------------------
// What is sent
// ---------------------------------------------------------------------------------------------

test('the prompt carries the calls, and nothing said around them', () => {
  const rounds = asked(['grep -rn "out_tokens" src/', 'sed -n 40,80p src/inspect.ts'], {
    user_text: 'PRIVATE-PROMPT: figure out why the bill is wrong',
    text: 'PRIVATE-REPLY: I will look at the token fields',
  })
  const prompt = promptFor(oneQuestion(rounds))

  assert.ok(prompt.includes('grep -rn "out_tokens" src/'), prompt)
  assert.ok(prompt.includes('sed -n 40,80p src/inspect.ts'), prompt)
  // The two things that must never reach a program probez started.
  assert.ok(!prompt.includes('PRIVATE-PROMPT'), 'the person\'s prompt must not be sent')
  assert.ok(!prompt.includes('PRIVATE-REPLY'), 'the assistant\'s prose must not be sent')
})

test('the digest follows the calls, not the wording around them', () => {
  const one = oneQuestion(asked(['grep -rn "out_tokens" src/']))
  const other = oneQuestion(asked(['grep -rn "in_tokens" src/']))
  assert.notEqual(digestOf(one), digestOf(other))
  assert.equal(digestOf(one), digestOf(oneQuestion(asked(['grep -rn "out_tokens" src/']))))
})

// ---------------------------------------------------------------------------------------------
// What comes back
// ---------------------------------------------------------------------------------------------

test('a reading is found inside whatever the reader printed around it', () => {
  const noisy = [
    'thinking…',
    '{"asked": "Where is out_tokens summed?", "kind": "flow", "why": "one word, three layers"}',
    'done',
  ].join('\n')
  const reading = parseReading(noisy, 'fake', 'abc')
  assert.equal(reading.asked, 'Where is out_tokens summed?')
  assert.equal(reading.kind, 'flow')
  assert.equal(reading.evidence, 'abc')
})

test('a reading wrapped in a report about the run is still a reading', () => {
  // What a CLI run with its own `--output-format json` prints: the answer as a string field.
  const wrapped = JSON.stringify({
    type: 'result',
    cost_usd: 0.01,
    result: '{"asked": "What does inspect.ts declare?", "kind": "outline", "why": "no name asked"}',
  })
  assert.equal(parseReading(wrapped, 'fake', '').kind, 'outline')
})

test('a kind outside the table is a named hole rather than the closest guess', () => {
  const reading = parseReading('{"asked": "Where is it used?", "kind": "usage"}', 'fake', '')
  assert.equal(reading.kind, null)
  assert.equal(reading.why, '')
})

test('a reader that answers in prose says so, quoting what it said', () => {
  assert.throws(
    () => parseReading('I am not able to help with that.', 'fake', ''),
    (error: Error) =>
      error instanceof ReadingError && error.message.includes('I am not able to help with that.'),
  )
  assert.throws(() => parseReading('   ', 'fake', ''), ReadingError)
  // An object with no sentence in it is not an answer either.
  assert.throws(() => parseReading('{"kind": "flow"}', 'fake', ''), ReadingError)
})

// ---------------------------------------------------------------------------------------------
// Running one
// ---------------------------------------------------------------------------------------------

test('the command is argv, so nothing in it reaches a shell', async () => {
  const dir = scratch()
  try {
    // If this went through a shell, `$(echo hurt)` would be substituted and `;` would start a
    // second command. Run directly, both are just characters in an argument.
    const reader = fakeReader(
      dir,
      'echo-argv.js',
      'process.stdout.write(JSON.stringify({ asked: process.argv[2], kind: "other" }))',
    )
    const said = await runReader(config([...reader, '$(echo hurt); rm -rf .']), 'ignored')
    assert.equal(parseReading(said, 'fake', '').asked, '$(echo hurt); rm -rf .')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the prompt arrives on stdin', async () => {
  const dir = scratch()
  try {
    const reader = fakeReader(
      dir,
      'echo-stdin.js',
      [
        'let seen = ""',
        'process.stdin.on("data", (chunk) => { seen += chunk })',
        'process.stdin.on("end", () => {',
        '  process.stdout.write(JSON.stringify({ asked: "saw " + seen.length + " chars", kind: "other" }))',
        '})',
      ].join('\n'),
    )
    const prompt = promptFor(oneQuestion(asked(['grep -rn "store" src/'])))
    const said = await runReader(config(reader), prompt)
    assert.equal(parseReading(said, 'fake', '').asked, `saw ${prompt.length} chars`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a reader that fails, hangs or is not there comes back as a message', async () => {
  const dir = scratch()
  try {
    const failing = fakeReader(
      dir,
      'fails.js',
      'process.stderr.write("no model configured\\nand more\\n"); process.exit(3)',
    )
    await assert.rejects(runReader(config(failing), 'x'), (error: Error) => {
      assert.match(error.message, /exited 3/)
      assert.match(error.message, /no model configured/)
      // Only the first line of the complaint, not the whole of a log.
      assert.ok(!error.message.includes('and more'), error.message)
      return true
    })

    const hanging = fakeReader(dir, 'hangs.js', 'setInterval(() => {}, 1000)')
    await assert.rejects(runReader(config(hanging, 300), 'x'), /did not answer within/)

    await assert.rejects(
      runReader(config([join(dir, 'nothing-here')]), 'x'),
      /there is no .* on this machine's PATH/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a reader that will not stop printing is stopped', async () => {
  const dir = scratch()
  try {
    const loud = fakeReader(
      dir,
      'loud.js',
      'const line = "x".repeat(4096) + "\\n"\nsetInterval(() => process.stdout.write(line), 1)',
    )
    await assert.rejects(runReader(config(loud, 20_000), 'x'), /printed more than/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// The config, and the cache
// ---------------------------------------------------------------------------------------------

test('an unconfigured probez has nothing it could run', async () => {
  const dir = scratch()
  try {
    assert.equal(await readReader(dir), null)
    writeFileSync(readerFile(dir), '{"command": []}\n', 'utf8')
    assert.equal(await readReader(dir), null, 'an empty command is no reader')
    writeFileSync(readerFile(dir), 'not json at all', 'utf8')
    assert.equal(await readReader(dir), null, 'a half-written config is no reader')
    writeFileSync(readerFile(dir), '{"command": ["claude", 7]}\n', 'utf8')
    assert.equal(await readReader(dir), null, 'a command that is not all strings is no reader')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the config is written owner-only, and a missing timeout is the default', async () => {
  const dir = scratch()
  try {
    await writeReader(dir, { schema_version: 1, command: ['claude', '-p'], timeout_ms: 0 })
    assert.equal(statSync(readerFile(dir)).mode & 0o077, 0)
    writeFileSync(readerFile(dir), '{"command": ["claude", "-p"]}\n', 'utf8')
    const config = await readReader(dir)
    assert.deepEqual(config?.command, ['claude', '-p'])
    assert.equal(config?.timeout_ms, DEFAULT_TIMEOUT_MS)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a reading is kept, reused without running anything, and re-asked only when asked for', async () => {
  const dir = scratch()
  try {
    const counter = join(dir, 'runs')
    writeFileSync(counter, '', 'utf8')
    const reader = fakeReader(
      dir,
      'counts.js',
      [
        `const fs = require("node:fs")`,
        `fs.appendFileSync(${JSON.stringify(counter)}, "x")`,
        `const n = fs.readFileSync(${JSON.stringify(counter)}, "utf8").length`,
        'process.stdout.write(JSON.stringify({ asked: "run " + n, kind: "refs", why: "because" }))',
      ].join('\n'),
    )
    const question = oneQuestion(asked(['grep -rn "store" src/']))

    const first = await explainQuestion(dir, config(reader), question)
    assert.equal(first.asked, true)
    assert.equal(first.reading.asked, 'run 1')
    assert.equal(first.reading.kind, 'refs')
    assert.equal(statSync(readingsFile(dir)).mode & 0o077, 0, 'a reading is owner-only')

    const again = await explainQuestion(dir, config(reader), question)
    assert.equal(again.asked, false, 'a reading already held runs nothing')
    assert.equal(again.reading.asked, 'run 1')
    assert.equal(readFileSync(counter, 'utf8').length, 1)

    const forced = await explainQuestion(dir, config(reader), question, { again: true })
    assert.equal(forced.reading.asked, 'run 2')
    assert.equal(readFileSync(counter, 'utf8').length, 2)

    const held = await readReadings(dir)
    assert.deepEqual(Object.keys(held), [readingKey('s', 1, 0)])

    // The same question asked of different calls is a reading about calls that have moved.
    const moved = oneQuestion(asked(['grep -rn "store" src/', 'grep -rn "store" test/']))
    assert.equal(isStale(held[readingKey('s', 1, 0)]!, question), false)
    assert.equal(isStale(held[readingKey('s', 1, 0)]!, moved), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
