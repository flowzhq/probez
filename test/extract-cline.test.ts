import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { actsOf } from '../src/act.js'
import { classifyCall } from '../src/classify.js'
import { discoverClineProjects } from '../src/discover.js'
import { exportClineSession, extractClineSession, isClineRecord, LEGACY_RESUME_WARNING } from '../src/extract-cline.js'
import { costOf, defaultPricing } from '../src/pricing.js'
import { sniffSource } from '../src/store.js'
import type { Round, SessionFile } from '../src/types.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, '..', '..', 'test', 'fixtures', 'cline')
const SID = '1791373390304_fix01'
const TID = '1791370000000'

/** Discover, export and read every session under some Cline data directories, as `collect` does. */
async function readAll(dirs: string[]): Promise<{ sessions: SessionFile[]; rounds: Map<string, Round[]> }> {
  const projects = await discoverClineProjects(dirs)
  const sessions = projects.flatMap((p) => p.sessions)
  const out = mkdtempSync(join(tmpdir(), 'probez-cline-copy-'))
  const rounds = new Map<string, Round[]>()
  for (const [index, session] of sessions.entries()) {
    const copy = join(out, `${index}.jsonl`)
    assert.equal(await exportClineSession(session.cline!, copy), true)
    rounds.set(session.id, await extractClineSession(copy, session.id))
  }
  return { sessions, rounds }
}

const fixture = await readAll([FIXTURE])
const sdk = fixture.rounds.get(SID)!
const legacy = fixture.rounds.get(TID)!

// ---------------------------------------------------------------- discovery

test('both formats are found and grouped by the directory each recorded', async () => {
  const projects = await discoverClineProjects([FIXTURE])
  const byPath = new Map(projects.map((p) => [p.path, p.sessions.map((s) => s.id).sort()]))
  assert.deepEqual(byPath.get(resolve('/tmp/demo')), [SID, `${SID}/subagents/agent_sub1`, TID].sort())
  // A legacy task with no history entry is placed by the environment details of its first request.
  assert.deepEqual(byPath.get(resolve('/tmp/other')), ['1791360000000'])
  assert.ok(projects.every((p) => p.sources?.length === 1 && p.sources[0] === 'cline'))
})

test('a missing data directory is no projects, not a failure', async () => {
  assert.deepEqual(await discoverClineProjects([join(tmpdir(), 'probez-no-such-cline')]), [])
})

test('the JSONL copies are recognized as Cline by their first line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'probez-cline-sniff-'))
  for (const session of fixture.sessions) {
    const copy = join(dir, 'copy.jsonl')
    await exportClineSession(session.cline!, copy)
    assert.equal(await sniffSource(copy), 'cline')
  }
  assert.equal(isClineRecord({ kind: 'cline.session' }), true)
  assert.equal(isClineRecord({ kind: 'cline.task' }), true)
  assert.equal(isClineRecord({ kind: 'goose.session' }), false)
})

// ---------------------------------------------------------------- SDK sessions

test('an SDK round is one model call, closed by the message carrying its metrics', () => {
  // The second call spans two assistant messages; a display-only status line is no call at all.
  assert.deepEqual(
    sdk.map((r) => r.id),
    ['a1', 'a2', 'a4', 'a5'],
  )
  assert.deepEqual(
    sdk.map((r) => r.model),
    ['anthropic/claude-sonnet-4.5', 'anthropic/claude-sonnet-4.5', 'gpt-5.1', 'gpt-5.1'],
  )
  assert.equal(sdk[1]!.text, 'Fixing it.')
  assert.ok(sdk.every((r) => !r.text.includes('Tests failed.')))
})

test('what the person typed is unwrapped from the tag Cline puts around it, and starts a task', () => {
  assert.deepEqual(
    sdk.map((r) => r.task),
    [1, 1, 2, 2],
  )
  assert.equal(sdk[0]!.user_text, 'fix the off-by-one in sum.js')
  assert.equal(sdk[2]!.user_text, 'now write a note')
})

test('inputTokens is the whole prompt, so the uncached part is what is left of it', () => {
  const [first, second] = sdk
  assert.equal(first!.in_tokens, 8200)
  assert.equal(first!.in_uncached, 1200)
  assert.equal(first!.in_cache_write, 7000)
  assert.equal(first!.in_cache_write_5m, 7000)
  assert.equal(second!.in_cache_read, 8000)
  assert.equal(second!.in_uncached, 100)
  assert.equal(first!.thinking_chars, 'Look first.'.length)
  // Cline's own provider names the model by who serves it; it is priced as the model.
  assert.ok((costOf(first!, defaultPricing()) ?? 0) > 0)
})

test('an SDK round runs from what prompted it to its last message', () => {
  assert.equal(sdk[0]!.ts, '2026-10-07T11:43:11.000Z')
  assert.equal(sdk[0]!.ms, 2000)
  assert.equal(sdk[1]!.ms, 2100)
  assert.deepEqual(
    sdk.map((r) => r.first_input),
    ['user_message', 'tool_result', 'tool_result', 'tool_result'],
  )
})

test('SDK tools carry their outcome, size of change and stderr, however the result was encoded', () => {
  const read = sdk[0]!.tools[0]!
  assert.equal(read.name, 'read_files')
  assert.equal((read.input as { path: string }).path, '/tmp/demo/sum.js')
  assert.equal(read.result_chars, 'for (let i = 0; i <= n; i++) {}'.length)
  assert.equal(read.is_error, false)
  const [edit, run] = sdk[1]!.tools
  // The edit's result arrived as its list encoded into a string.
  assert.equal(edit!.is_error, false)
  assert.deepEqual(edit!.patch, { files: 1, added: 1, removed: 1 })
  // A failed command is reported per command, with the exit status and stderr in its text.
  assert.equal((run!.input as { command: string }).command, 'npm test')
  assert.equal(run!.is_error, true)
  assert.equal(run!.stderr_chars, 'FAIL sum.test.js'.length)
  assert.notEqual(run!.error_kind, null)
  assert.deepEqual(sdk[2]!.tools[0]!.patch, { files: 1, added: 3, removed: 0 })
  // The session ended while this question was open.
  assert.equal(sdk[3]!.tools[0]!.interrupted, true)
  assert.equal(sdk[3]!.tools[0]!.is_error, null)
})

test("Cline's SDK tools classify by what they did", () => {
  assert.equal(actsOf(sdk[0]!.tools[0]!)[0]!.verb, 'read')
  assert.equal(classifyCall(sdk[1]!.tools[0]!)[0]!.category, 'implementation')
  assert.equal(classifyCall(sdk[1]!.tools[1]!)[0]!.category, 'testing')
  assert.equal(actsOf(sdk[3]!.tools[0]!)[0]!.verb, 'ask')
})

test("a subagent's messages beside its parent's are a session of their own, nested under it", () => {
  const sub = fixture.rounds.get(`${SID}/subagents/agent_sub1`)!
  assert.equal(sub.length, 1)
  assert.equal(sub[0]!.agent, 'sub')
  assert.equal(sub[0]!.model, 'anthropic/claude-haiku-4.5')
  assert.equal(sub[0]!.user_text, 'find the tests')
  assert.ok(sdk.every((r) => r.agent === 'main'))
})

/** A copy of the fixture's SDK session, its manifest changed by `change`. */
function variant(change: (manifest: Record<string, unknown>, messages: Array<Record<string, unknown>>) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'probez-cline-variant-'))
  cpSync(join(FIXTURE, 'sessions', SID), join(root, 'sessions', SID), { recursive: true })
  const manifestPath = join(root, 'sessions', SID, `${SID}.json`)
  const messagesPath = join(root, 'sessions', SID, `${SID}.messages.json`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  const file = JSON.parse(readFileSync(messagesPath, 'utf8')) as { messages: Array<Record<string, unknown>> }
  change(manifest, file.messages)
  writeFileSync(manifestPath, JSON.stringify(manifest))
  writeFileSync(messagesPath, JSON.stringify(file))
  return root
}

const LATER = new Date(1791373390000 + 50_000).toISOString()

test("a fork's copy of the session it came from is left to that session", async () => {
  const root = variant((manifest) => {
    manifest.metadata = { fork: { forkedFromSessionId: 'elsewhere', forkedAt: LATER, source: 'cli' } }
  })
  const rounds = (await readAll([root])).rounds.get(SID)!
  assert.deepEqual(
    rounds.map((r) => r.id),
    ['a4', 'a5'],
  )
})

test('a session imported from another agent is left to that agent, until Cline continues it', async () => {
  const root = variant((manifest) => {
    manifest.metadata = { importedFrom: { tool: 'claude-code', sourceSessionId: 'abc', importedAt: LATER } }
  })
  const rounds = (await readAll([root])).rounds.get(SID)!
  assert.deepEqual(
    rounds.map((r) => r.id),
    ['a4', 'a5'],
  )
})

test('a resumed legacy task is read from the legacy task, and from the SDK only after it was resumed', async () => {
  const root = variant((manifest, messages) => {
    manifest.metadata = { legacyTask: true }
    // Cline's conversion: the legacy history without timestamps, the task's lifetime usage on its
    // last assistant message, then the warning — and after it, what the resumed task did.
    messages.unshift(
      { id: 'c1', role: 'user', content: [{ type: 'text', text: 'old question' }] },
      { id: 'c2', role: 'assistant', content: [{ type: 'text', text: 'old answer' }], metrics: { inputTokens: 99_999, outputTokens: 999, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 9 } },
      { id: 'c3', role: 'user', content: LEGACY_RESUME_WARNING },
    )
  })
  // The legacy task the session was resumed from is still there, under the same id.
  const legacyDir = join(root, 'tasks', SID)
  mkdirSync(legacyDir, { recursive: true })
  cpSync(join(FIXTURE, 'tasks', TID, 'ui_messages.json'), join(legacyDir, 'ui_messages.json'))
  writeFileSync(join(root, 'tasks', SID, 'api_conversation_history.json'), '# Current Working Directory (/tmp/demo) Files')
  const both = await readAll([root])
  const resumed = both.rounds.get(`${SID}-resumed`)!
  assert.ok(resumed.every((r) => r.in_tokens !== 99_999 && r.user_text !== 'old question'))
  assert.deepEqual(
    resumed.map((r) => r.id),
    ['a1', 'a2', 'a4', 'a5'],
  )
  assert.equal(both.rounds.get(SID)!.length, legacy.length)

  // Once the legacy task is gone, the converted history is all that is left of it, and is read.
  const alone = variant((manifest, messages) => {
    manifest.metadata = { legacyTask: true }
    messages.unshift(
      { id: 'c2', role: 'assistant', content: [{ type: 'text', text: 'old answer' }], metrics: { inputTokens: 99_999, outputTokens: 999, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 9 } },
      { id: 'c3', role: 'user', content: LEGACY_RESUME_WARNING },
    )
  })
  const only = (await readAll([alone])).rounds.get(SID)!
  assert.equal(only[0]!.in_tokens, 99_999)
  assert.ok(only.every((r) => !r.user_text.includes('legacy conversation')))
})

// ---------------------------------------------------------------- legacy tasks

test('a legacy round is one api_req_started, with everything logged after it until the next', () => {
  assert.equal(legacy.length, 6)
  assert.deepEqual(
    legacy.map((r) => r.model),
    ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5-20250929', 'qwen2.5-coder:32b', 'qwen2.5-coder:32b', 'qwen2.5-coder:32b', null],
  )
  assert.deepEqual(
    legacy.map((r) => r.task),
    [1, 1, 2, 2, 2, 2],
  )
  assert.equal(legacy[0]!.user_text, 'add input validation to sum.js')
  assert.equal(legacy[2]!.user_text, 'use the local model for the rest')
  assert.equal(legacy[0]!.text, 'Let me read it.')
  assert.equal(legacy[0]!.thinking_chars, 'Check the file.'.length)
  // A partial message is the chat view's working copy; the complete one is what counts.
  assert.equal(legacy[3]!.text, 'Validation added; the failing test is unrelated.')
})

test("legacy usage is read by the provider in use: Anthropic's tokensIn excludes the cache, OpenAI's includes it", () => {
  const [first, second, third] = legacy
  assert.equal(first!.in_tokens, 1200 + 3000)
  assert.equal(first!.in_uncached, 1200)
  assert.equal(first!.in_cache_write, 3000)
  assert.equal(second!.in_tokens, 100 + 200 + 4000)
  assert.equal(second!.in_cache_read, 4000)
  assert.equal(third!.in_tokens, 5000)
  assert.equal(third!.in_cache_read, 4000)
  assert.equal(third!.in_uncached, 1000)
})

test('legacy tools carry what the chat log says of them, and the result the API history holds', () => {
  // The result comes from the API history, whether the call was XML in text or a native tool call.
  const read = legacy[0]!.tools[0]!
  assert.equal(read.name, 'read_file')
  assert.equal(actsOf(read)[0]!.verb, 'read')
  assert.equal(read.result_chars, 'function sum(xs) {\n  return xs.reduce((a, b) => a + b, 0)\n}'.length)
  assert.equal(read.is_error, false)
  const [edit, command] = legacy[1]!.tools
  assert.equal(edit!.name, 'replace_in_file')
  assert.equal(edit!.is_error, false)
  assert.deepEqual(edit!.patch, { files: 1, added: 2, removed: 1 })
  assert.equal(command!.name, 'execute_command')
  assert.equal(command!.result_chars, 'Command executed.\nOutput:\nFAIL sum.test.js'.length)
  assert.equal(command!.ms, 5500)
  // The chat log logged an error against it, which a result that does not say so does not undo.
  assert.equal(command!.is_error, true)
  assert.equal(classifyCall(command!)[0]!.category, 'testing')
  // Cline's own wording for a failed tool marks it, and says what kind of failure it was.
  const mcp = legacy[2]!.tools[0]!
  assert.equal(mcp.name, 'mcp__github__create_issue')
  assert.equal(mcp.is_error, true)
  assert.notEqual(mcp.error_kind, null)
  assert.equal(actsOf(mcp)[0]!.verb, 'mcp')
})

test('a legacy result is only given to a tool of the same name; a misaligned one is left out', async () => {
  const root = mkdtempSync(join(tmpdir(), 'probez-cline-align-'))
  cpSync(join(FIXTURE, 'tasks', TID), join(root, 'tasks', TID), { recursive: true })
  cpSync(join(FIXTURE, 'state'), join(root, 'state'), { recursive: true })
  // A history whose only result is for a tool the chat log never shows.
  writeFileSync(
    join(root, 'tasks', TID, 'api_conversation_history.json'),
    JSON.stringify([{ role: 'user', content: [{ type: 'text', text: "[list_files for '.'] Result:\nREADME.md" }] }]),
  )
  const rounds = (await readAll([root])).rounds.get(TID)!
  const read = rounds[0]!.tools[0]!
  assert.equal(read.result_chars, null)
  assert.equal(read.is_error, null)
})

test('a legacy compaction lands on the round after it, with its mode and sizes', () => {
  assert.deepEqual(legacy[3]!.compaction, {
    trigger: 'auto',
    pre_tokens: 9000,
    post_tokens: 1500,
    dropped_tokens: null,
    ms: null,
    ts: new Date(1791370000000 + 23000).toISOString(),
  })
})

test("usage Cline logged apart from any one call is a round of its own, so the task's total is Cline's", () => {
  const [deleted, subagents] = legacy.slice(4)
  assert.equal(deleted!.in_tokens, 700)
  assert.equal(deleted!.agent, 'main')
  assert.equal(subagents!.in_tokens, 300)
  assert.equal(subagents!.agent, 'sub')
  assert.equal(subagents!.user_text, '')
})
