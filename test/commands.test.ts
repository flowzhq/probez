import assert from 'node:assert/strict'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { parseCommands, useCommandKinds } from '../src/bash.js'
import { classifyCall } from '../src/classify.js'
import {
  CommandsError,
  commandsFile,
  readCommandKinds,
  writeCommandKinds,
} from '../src/commands.js'
import type { ToolCall } from '../src/types.js'
import { TOOL_DEFAULTS } from './support.js'

/**
 * Naming a command this machine knows and the shipped table does not.
 *
 * The reason this file exists is that probez only ever sees a command's last path segment, so a
 * repository's own `bin/check` is recorded as `check` — a name far too generic for a table shared
 * with every other machine.
 */

function store(commands: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'probez-commands-test-'))
  writeFileSync(commandsFile(dir), JSON.stringify(commands, null, 2))
  return dir
}

function bash(command: string): ToolCall {
  return { ...TOOL_DEFAULTS, name: 'Bash', input: { command } }
}

test('a name from the local table classifies a command the shipped one has never heard of', async () => {
  const dir = store({ schema_version: 1, commands: { check: 'graph' } })
  useCommandKinds(await readCommandKinds(dir))
  try {
    assert.deepEqual(parseCommands('./bin/check graph'), [{ name: 'check', kind: 'graph' }])
    const [label] = classifyCall(bash('./bin/check callers foo'))
    assert.equal(`${label?.category}/${label?.sub}`, 'reconstruction/graph')
  } finally {
    useCommandKinds({})
  }
})

test('the local table sits over the shipped one, so it can correct as well as add', async () => {
  const dir = store({ schema_version: 1, commands: { make: 'test' } })
  useCommandKinds(await readCommandKinds(dir))
  try {
    // `make` ships as a build multiplexer. A repository where it only ever runs tests can say so.
    assert.deepEqual(parseCommands('make'), [{ name: 'make', kind: 'test' }])
  } finally {
    useCommandKinds({})
  }
})

test('with no file there is no local table, which is the ordinary case', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'probez-commands-test-'))
  assert.deepEqual(await readCommandKinds(dir), {})
  useCommandKinds(await readCommandKinds(dir))
  assert.deepEqual(parseCommands('./bin/check graph'), [{ name: 'check', kind: 'other' }])
})

test('a half-written file is not a taxonomy, and one bad row does not take the rest', async () => {
  assert.deepEqual(await readCommandKinds(store('not an object')), {})
  assert.deepEqual(await readCommandKinds(store({ commands: [] })), {})
  const mixed = await readCommandKinds(
    store({
      schema_version: 1,
      commands: {
        check: 'graph',
        // A kind nothing emits, a name that is a path, and a value that is not a string.
        bad: 'archaeology',
        'tools/thing': 'search',
        worse: 7,
        keep: 'test',
      },
    }),
  )
  assert.deepEqual(mixed, { check: 'graph', keep: 'test' })
})

test('what is written back is checked, and written owner-only like the rest of the store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'probez-commands-test-'))
  const saved = await writeCommandKinds(dir, { Check: 'graph', 'npm test': 'test' })
  assert.deepEqual(saved, { check: 'graph', 'npm test': 'test' })
  assert.equal(statSync(commandsFile(dir)).mode & 0o077, 0)
  assert.deepEqual(await readCommandKinds(dir), saved)

  await assert.rejects(() => writeCommandKinds(dir, { check: 'archaeology' as never }), CommandsError)
  await assert.rejects(() => writeCommandKinds(dir, { 'a/b': 'graph' }), CommandsError)
  // The refusal names what a kind can be, since the point of the message is to be actionable.
  await assert.rejects(
    () => writeCommandKinds(dir, { check: 'nope' as never }),
    (error: Error) => /graph/.test(error.message),
  )
})

test('a shell handed a script is the script, so both ways of running it agree', () => {
  // `bash bin/check graph` and `./bin/check graph` are the same work. Before this they were counted
  // as two different things, and the first landed on Reconstruction by accident — `bash` is a
  // `run` command, and a `run` command outside the project reads as a query.
  assert.deepEqual(parseCommands('bash bin/check graph'), parseCommands('./bin/check graph'))
  assert.deepEqual(parseCommands('/bin/sh scripts/deploy.sh'), [
    { name: 'deploy.sh', kind: 'other' },
  ])
  // A shell given a flag, or nothing, is still a shell: `-c` runs a command inside a string this
  // reader does not open, and a bare shell started one.
  assert.deepEqual(parseCommands('bash -c "grep -rn x src"'), [{ name: 'bash', kind: 'run' }])
  assert.deepEqual(parseCommands('bash'), [{ name: 'bash', kind: 'run' }])
})

test('a code-query tool is Reconstruction by another means, not a kind of its own', () => {
  // Kept inside Reconstruction on purpose: a tool that pulled its own usage into a category beside
  // it would make Reconstruction fall the moment anybody installed it, which is the one number it
  // exists to move.
  for (const command of ['codeql query run x.ql', 'semgrep --config p/ci']) {
    const [label] = classifyCall(bash(command))
    assert.equal(`${label?.category}/${label?.sub}`, 'reconstruction/graph', command)
  }
  const [grep] = classifyCall(bash('grep -rn foo src'))
  assert.equal(`${grep?.category}/${grep?.sub}`, 'reconstruction/locate')
})
