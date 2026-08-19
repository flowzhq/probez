import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { MAX_RESULT_CHARS, readToolResult } from '../src/result.js'

/**
 * Reading one result out of an archived session.
 *
 * The store keeps a result's size and not its text, so this is the only path back to a body, and
 * the cases below are the ones a real log actually contains: text, a string rather than a block
 * list, an image with no text in it at all, a call that never came back, and a line torn by an
 * interrupted write.
 */

/** A session file holding the given records, one JSON object per line. */
function sessionOf(records: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'probez-result-test-'))
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
  return file
}

/** A user record carrying one tool result, as the harness writes them. */
function resultRecord(id: string, content: unknown, isError?: boolean): unknown {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError === undefined ? {} : { is_error: isError }) }],
    },
  }
}

test('a result is found by the id its call was made with', async () => {
  const file = sessionOf([
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Grep' }] } },
    resultRecord('tu_other', 'not this one'),
    resultRecord('tu_1', [{ type: 'text', text: 'src/cli.ts:41: HELP' }]),
  ])

  const found = await readToolResult(file, 'tu_1')
  assert.notEqual(found, null)
  assert.equal(found!.body, 'src/cli.ts:41: HELP')
  assert.equal(found!.chars, 19)
  assert.equal(found!.truncated, false)
  assert.equal(found!.is_error, false)
  assert.deepEqual(found!.omitted, [])
})

test('a result recorded as a bare string reads the same as one in blocks', async () => {
  const file = sessionOf([resultRecord('tu_1', 'total 8\ndrwx------  probez')])
  const found = await readToolResult(file, 'tu_1')
  assert.equal(found!.body, 'total 8\ndrwx------  probez')
})

test('the harness flag travels with the body', async () => {
  const file = sessionOf([resultRecord('tu_1', 'boom', true)])
  assert.equal((await readToolResult(file, 'tu_1'))!.is_error, true)
})

test('a body longer than the cap is cut, and says so rather than trailing off', async () => {
  const long = 'x'.repeat(500)
  const file = sessionOf([resultRecord('tu_1', long)])

  const cut = await readToolResult(file, 'tu_1', 100)
  assert.equal(cut!.body.length, 100)
  assert.equal(cut!.chars, 500, 'the size reported is the real one, not the size returned')
  assert.equal(cut!.truncated, true)

  // The default is generous enough that ordinary output is never cut.
  const whole = await readToolResult(file, 'tu_1')
  assert.equal(whole!.truncated, false)
  assert.equal(whole!.body.length, 500)
  assert.ok(MAX_RESULT_CHARS > 500)
})

test('content that is not text is named, never silently dropped', async () => {
  // A screenshot: real, sizeable in the round's `result_chars`, and no text at all. Reporting it as
  // an empty result would be a lie about what came back.
  const onlyImage = sessionOf([
    resultRecord('tu_1', [{ type: 'image', source: { type: 'base64', data: 'AAAA' } }]),
  ])
  const image = await readToolResult(onlyImage, 'tu_1')
  assert.equal(image!.body, '')
  assert.equal(image!.chars, 0)
  assert.deepEqual(image!.omitted, ['image'])

  // Mixed, which is what a browser tool returns: the text is shown and the rest is named once.
  const mixed = sessionOf([
    resultRecord('tu_1', [
      { type: 'text', text: 'captured' },
      { type: 'image', source: { type: 'base64', data: 'AAAA' } },
      { type: 'image', source: { type: 'base64', data: 'BBBB' } },
    ]),
  ])
  const both = await readToolResult(mixed, 'tu_1')
  assert.equal(both!.body, 'captured')
  assert.deepEqual(both!.omitted, ['image'], 'the same kind twice is one thing to say, not two')
})

test('no result, no file, and a torn line are all answered rather than thrown', async () => {
  const file = sessionOf([resultRecord('tu_1', 'ok')])
  assert.equal(await readToolResult(file, 'tu_missing'), null)
  assert.equal(await readToolResult(join(file, 'nope.jsonl'), 'tu_1'), null)

  // An interrupted write leaves half a line behind. The line holding the result is still readable,
  // and a scan that threw on the way past would be the thing that lost it.
  const torn = mkdtempSync(join(tmpdir(), 'probez-result-torn-'))
  const path = join(torn, 'session.jsonl')
  writeFileSync(
    path,
    `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1"\n` +
      JSON.stringify(resultRecord('tu_1', 'survived')) +
      '\n',
  )
  assert.equal((await readToolResult(path, 'tu_1'))!.body, 'survived')
})
