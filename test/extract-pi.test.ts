import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { classifyCall } from '../src/classify.js'
import { discoverPiProjects } from '../src/discover.js'
import { extractPiSession, isPiRecord } from '../src/extract-pi.js'
import { costOf, defaultPricing } from '../src/pricing.js'
import { sniffSource } from '../src/store.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, '..', '..', 'test', 'fixtures', 'pi-session.jsonl')

const sessionId = '2026-01-06T09-59-59-000Z_eeee5555-0000-0000-0000-000000000000'
const rounds = await extractPiSession(FIXTURE, sessionId)

test('one round per assistant message, keyed by its entry id', () => {
  assert.equal(rounds.length, 6)
  assert.deepEqual(
    rounds.map((r) => r.id),
    ['a0000005', 'a0000007', 'a0000009', 'a000000b', 'a000000e', 'a0000011'],
  )
  assert.deepEqual(
    rounds.map((r) => r.round),
    [0, 1, 2, 3, 4, 5],
  )
  assert.ok(rounds.every((r) => r.session === sessionId && r.agent === 'main'))
})

test('a user message starts a task, and a later one starts another', () => {
  assert.deepEqual(
    rounds.map((r) => r.task),
    [1, 1, 1, 1, 2, 2],
  )
  assert.equal(rounds[0]!.user_text, 'fix the off-by-one in loop.ts')
  assert.equal(rounds[4]!.user_text, 'now write a note')
  assert.deepEqual(
    rounds.map((r) => r.first_input),
    ['user_message', 'tool_result', 'tool_result', 'tool_result', 'user_message', 'tool_result'],
  )
})

test('usage is stored as Pi split it: input is already the uncached part', () => {
  const second = rounds[1]!
  assert.equal(second.in_uncached, 50)
  assert.equal(second.in_cache_read, 4200)
  assert.equal(second.in_cache_write, 0)
  assert.equal(second.in_tokens, 4250)
  assert.equal(second.out_tokens, 60)
})

test('cacheWrite1h is the one-hour part of cacheWrite, and the rest is five-minute', () => {
  const first = rounds[0]!
  assert.equal(first.in_cache_write, 3000)
  assert.equal(first.in_cache_write_1h, 3000)
  assert.equal(first.in_cache_write_5m, 0)
  assert.equal(first.in_tokens, 1200 + 3000)
})

test('each round names the model that answered it, through a mid-session switch', () => {
  assert.deepEqual(
    rounds.map((r) => r.model),
    ['claude-sonnet-4-5', 'claude-sonnet-4-5', 'claude-sonnet-4-5', 'claude-sonnet-4-5', 'claude-sonnet-4-5', 'gpt-5.1'],
  )
  // A published model is priced, so a Pi round costs what the same call costs from any agent.
  assert.ok((costOf(rounds[0]!, defaultPricing()) ?? 0) > 0)
})

test('a round starts when the call began and ends when Pi wrote the message', () => {
  const first = rounds[0]!
  assert.equal(first.ts, '2026-01-06T10:00:00.200Z')
  assert.equal(first.ms, 2800)
  // From the person's message at 0s to the response at 3s, which includes the wait before it began.
  assert.equal(first.gen_ms, 3000)
})

test('the wait before a new task runs from the last response to the person speaking', () => {
  assert.equal(rounds[4]!.wait_ms, 70_000 - 14_000)
  assert.equal(rounds[0]!.wait_ms, null)
})

test('a tool call pairs with its result, and the result decides the error', () => {
  const read = rounds[0]!.tools[0]!
  assert.equal(read.name, 'read')
  assert.equal(read.is_error, false)
  assert.equal(read.result_chars, 'for (let i = 0; i <= n; i++) {}'.length)
  assert.equal(read.ms, 50)

  const bash = rounds[2]!.tools[0]!
  assert.equal(bash.name, 'bash')
  assert.equal(bash.is_error, true)
  assert.notEqual(bash.error_kind, null)
})

test('an edit is sized from its diff, and a write by the lines it wrote', () => {
  assert.deepEqual(rounds[1]!.tools[0]!.patch, { files: 1, added: 1, removed: 1 })
  assert.deepEqual(rounds[4]!.tools[0]!.patch, { files: 1, added: 3, removed: 0 })
})

test("Pi's built-in tools classify by what they did", () => {
  assert.equal(classifyCall(rounds[0]!.tools[0]!)[0]!.sub, 'read')
  assert.equal(classifyCall(rounds[1]!.tools[0]!)[0]!.category, 'implementation')
  assert.equal(classifyCall(rounds[2]!.tools[0]!)[0]!.category, 'testing')
  // A write is classified by what it wrote: NOTES.md is documentation, not code.
  assert.equal(classifyCall(rounds[4]!.tools[0]!)[0]!.category, 'documentation')
})

test('thinking is counted and prose is kept', () => {
  assert.equal(rounds[0]!.thinking_chars, 'Look first.'.length)
  assert.equal(rounds[3]!.text, 'Fixed the loop; one test still fails.')
})

test('a compaction lands on the round after it, with the size it summarized', () => {
  assert.equal(rounds[3]!.compaction, null)
  assert.equal(rounds[4]!.compaction?.pre_tokens, 52000)
  assert.equal(rounds[4]!.compaction?.ts, '2026-01-06T10:01:00.000Z')
})

test('the session header identifies a Pi file to the sniffer and nothing else does', async () => {
  assert.equal(await sniffSource(FIXTURE), 'pi')
  assert.equal(isPiRecord({ type: 'session', version: 3, id: 'x', cwd: '/tmp' }), true)
  assert.equal(isPiRecord({ type: 'user', sessionId: 'x', cwd: '/tmp' }), false)
})

test("a fork skips the copy of its parent's history, so no call is counted twice", async () => {
  // Pi seeds a fork with the parent's entries verbatim, then writes its own after a newer header.
  const parent = readFileSync(FIXTURE, 'utf8').trim().split('\n').slice(1)
  const header = {
    type: 'session',
    version: 3,
    id: 'ffff6666-0000-0000-0000-000000000000',
    timestamp: '2026-01-06T11:00:00.000Z',
    cwd: '/tmp/demo',
    parentSession: '/sessions/2026-01-06T09-59-59-000Z_eeee5555-0000-0000-0000-000000000000.jsonl',
  }
  const own = [
    { type: 'message', id: 'b0000001', parentId: 'a0000011', timestamp: '2026-01-06T11:00:05.000Z', message: { role: 'user', content: 'now add a range function', timestamp: Date.parse('2026-01-06T11:00:05.000Z') } },
    { type: 'message', id: 'b0000002', parentId: 'b0000001', timestamp: '2026-01-06T11:00:09.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Added.' }], provider: 'anthropic', model: 'claude-sonnet-4-5', usage: { input: 30, output: 5, cacheRead: 900, cacheWrite: 0, totalTokens: 935 }, stopReason: 'stop', timestamp: Date.parse('2026-01-06T11:00:06.000Z') } },
  ]
  const dir = mkdtempSync(join(tmpdir(), 'probez-pi-fork-'))
  const file = join(dir, 'fork.jsonl')
  writeFileSync(file, [JSON.stringify(header), ...parent, ...own.map((row) => JSON.stringify(row))].join('\n') + '\n')

  const forked = await extractPiSession(file, 'fork')
  assert.deepEqual(forked.map((r) => r.id), ['b0000002'])
  assert.equal(forked[0]!.task, 1)
  assert.equal(forked[0]!.user_text, 'now add a range function')
  assert.equal(forked[0]!.in_tokens, 930)
})

test('a legacy v1 file, whose header has no version, is still sniffed as Pi', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'probez-pi-v1-'))
  const file = join(dir, 'legacy.jsonl')
  writeFileSync(
    file,
    [
      { type: 'session', id: 'v1', timestamp: '2025-11-01T09:00:00.000Z', cwd: '/work/a' },
      { type: 'message', timestamp: '2025-11-01T09:00:01.000Z', message: { role: 'user', content: 'hi', timestamp: 0 } },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  )
  assert.equal(await sniffSource(file), 'pi')
})

test('discovery groups sessions by the cwd each header recorded, not by folder name', async () => {
  const root = mkdtempSync(join(tmpdir(), 'probez-pi-'))
  const write = (folder: string, name: string, cwd: string | null): void => {
    mkdirSync(join(root, folder), { recursive: true })
    const header = cwd === null ? { type: 'model_change' } : { type: 'session', version: 3, id: name, cwd }
    writeFileSync(join(root, folder, `${name}.jsonl`), `${JSON.stringify(header)}\n`)
  }
  write('--work-a--', '2026-01-01_aaaa', '/work/a')
  write('--work-a--', '2026-01-02_bbbb', '/work/a')
  // The folder name is a lossy encoding; a session filed under the wrong one still goes by its cwd.
  write('--work-a--', '2026-01-03_cccc', '/work/b')
  // No header, so nowhere to place it.
  write('--work-c--', '2026-01-04_dddd', null)

  const projects = await discoverPiProjects(root)
  const byPath = new Map(projects.map((p) => [p.path, p]))
  assert.equal(projects.length, 2)
  assert.deepEqual(
    byPath.get(resolve('/work/a'))!.sessions.map((s) => s.id).sort(),
    ['2026-01-01_aaaa', '2026-01-02_bbbb'],
  )
  assert.deepEqual(byPath.get(resolve('/work/b'))!.sources, ['pi'])
  assert.ok(projects.every((p) => p.sessions.every((s) => s.source === 'pi')))
})

test('a missing sessions directory is no projects, not a failure', async () => {
  assert.deepEqual(await discoverPiProjects(join(tmpdir(), 'probez-no-such-pi-dir')), [])
})
