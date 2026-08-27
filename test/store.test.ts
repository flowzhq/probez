import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { sniffSource } from '../src/store.js'

const here = dirname(fileURLToPath(import.meta.url))
const CLAUDE = join(here, '..', '..', 'test', 'fixtures', 'session.jsonl')
const CURSOR = join(here, '..', '..', 'test', 'fixtures', 'cursor-session.jsonl')
const CODEX = join(here, '..', '..', 'test', 'fixtures', 'codex-session.jsonl')

test('sniffSource recognises transcript format, not missing tokens', async () => {
  assert.equal(await sniffSource(CLAUDE), 'claude-code')
  assert.equal(await sniffSource(CURSOR), 'cursor')
  assert.equal(await sniffSource(CODEX), 'codex')
})

test('sniffSource returns unknown when the file is not a known transcript', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'probez-sniff-'))
  const file = join(dir, 'notes.jsonl')
  writeFileSync(file, `${JSON.stringify({ foo: 1 })}\n`)
  assert.equal(await sniffSource(file), 'unknown')

  const empty = join(dir, 'empty.jsonl')
  writeFileSync(empty, '\n')
  assert.equal(await sniffSource(empty), 'unknown')

  assert.equal(await sniffSource(join(dir, 'missing.jsonl')), 'unknown')
})

test('sniffSource does not infer Cursor from a Claude row that happens to lack tokens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'probez-sniff-claude-'))
  const file = join(dir, 'sess.jsonl')
  writeFileSync(
    file,
    `${JSON.stringify({ type: 'user', sessionId: 'aaaa', message: { role: 'user', content: 'hi' } })}\n`,
  )
  assert.equal(await sniffSource(file), 'claude-code')
})
