import assert from 'node:assert/strict'
import { test } from 'node:test'

import { benign, countsAsFailure, errorKindOf, failed, isErrorKind } from '../src/errors.js'
import type { ToolCall } from '../src/types.js'
import { TOOL_DEFAULTS } from './support.js'

function call(extra: Partial<ToolCall> = {}): ToolCall {
  return { ...TOOL_DEFAULTS, name: 'Bash', is_error: true, ...extra }
}

/**
 * Every body here is copied from a real transcript rather than written to suit the reader. The
 * whole value of the field is that it matches what harnesses actually emit, so a rule that only
 * passes against invented text is a rule that will read a store as `other`.
 */
test('a failure is named by what the harness actually wrote', () => {
  const cases: Array<[string, string, unknown, string]> = [
    ['Exit code 1\nsrc/x.ts:4: nope', 'Bash', { command: 'npm test' }, 'exit'],
    ['Exit code 127\ncommand not found', 'Bash', { command: 'probez' }, 'exit'],
    ['<tool_use_error>String to replace not found in file.', 'Edit', {}, 'harness'],
    ['<tool_use_error>File has not been read yet. Read it first before writing to it.', 'Write', {}, 'harness'],
    ['<tool_use_error>Unknown skill: figma-use</tool_use_error>', 'Skill', {}, 'harness'],
    ['File content (52000 tokens) exceeds maximum allowed tokens (25000).', 'Read', {}, 'limit'],
    ["EISDIR: illegal operation on a directory, read '/tmp/x'", 'Read', {}, 'limit'],
    ['Output does not match required schema: root: must NOT have additional properties', 'StructuredOutput', {}, 'schema'],
    ["The user doesn't want to proceed with this tool use. The tool use was rejected", 'Bash', {}, 'denied'],
    ['Permission for this action was denied by the Claude Code auto mode classifier.', 'Bash', {}, 'denied'],
    ['Error: Multiple repositories indexed.', 'mcp__gitnexus__query', {}, 'remote'],
    ['something nobody has seen before', 'Bash', {}, 'other'],
  ]
  for (const [body, name, input, want] of cases) {
    assert.equal(errorKindOf(body, name, input), want, body.slice(0, 40))
  }
})

test('a search that found nothing is not a failure, and a search that broke still is', () => {
  // grep says "no matches" with exit 1 and "bad pattern or unreadable file" with exit 2. Only the
  // first is an answer, and this distinction is the whole reason `nomatch` exists.
  assert.equal(errorKindOf('Exit code 1', 'Bash', { command: 'grep -n foo src/x.ts' }), 'nomatch')
  assert.equal(errorKindOf('Exit code 2', 'Bash', { command: 'grep -n foo src/x.ts' }), 'exit')
  assert.equal(errorKindOf('Exit code 1', 'Bash', { command: 'diff a b' }), 'nomatch')
  assert.equal(errorKindOf('Exit code 1', 'Bash', { command: 'cd /tmp && grep -rn foo .' }), 'nomatch')
})

test('only the last command decides, because that is the status a shell reports', () => {
  // `grep x f | wc -l` exits from `wc`. Reading the leading program instead would file every failed
  // pipeline that happens to start with a search as a finding.
  assert.equal(errorKindOf('Exit code 1', 'Bash', { command: 'grep -rn foo . | head -5' }), 'exit')
  assert.equal(errorKindOf('Exit code 1', 'Bash', { command: 'grep -rn foo . && npm test' }), 'exit')
})

test('an exit status given as a field reads the same as one written into the body', () => {
  // Codex records `exit_code` beside the output; Claude Code writes `Exit code N` at the head of it.
  assert.equal(errorKindOf('no matches', 'shell', { command: 'grep -n foo x.ts' }, 1), 'nomatch')
  assert.equal(errorKindOf('1 test failed', 'shell', { command: 'npm test' }, 1), 'exit')
})

test('a call that did not fail is neither a failure nor a no-fault flag', () => {
  assert.equal(failed(call({ is_error: false })), false)
  assert.equal(benign(call({ is_error: false })), false)
  assert.equal(failed(call({ is_error: null })), false)
})

test('a no-match or a refusal is flagged, and is not counted as a failure', () => {
  assert.equal(failed(call({ error_kind: 'nomatch' })), false)
  assert.equal(benign(call({ error_kind: 'nomatch' })), true)
  assert.equal(failed(call({ error_kind: 'denied' })), false)
  assert.equal(benign(call({ error_kind: 'denied' })), true)
})

test('a real fault counts, whatever kind it is', () => {
  for (const kind of ['harness', 'exit', 'limit', 'schema', 'remote', 'other'] as const) {
    assert.equal(failed(call({ error_kind: kind })), true, kind)
    assert.equal(benign(call({ error_kind: kind })), false, kind)
  }
})

test('a failure collected before kinds existed still counts as one', () => {
  // The store predates `error_kind`, and every round in it carries `is_error` with no kind. Reading
  // that as "not a failure" would silently erase the error history of every existing store.
  assert.equal(failed(call({ error_kind: null })), true)
  assert.equal(benign(call({ error_kind: null })), false)
  assert.equal(countsAsFailure(null), true)
})

test('only the kinds in the table are kinds', () => {
  assert.equal(isErrorKind('harness'), true)
  assert.equal(isErrorKind('nomatch'), true)
  assert.equal(isErrorKind('repair'), false)
  assert.equal(isErrorKind(''), false)
})
