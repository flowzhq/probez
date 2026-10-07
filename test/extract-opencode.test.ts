import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { classifyCall } from '../src/classify.js'
import { discoverOpencodeProjects } from '../src/discover.js'
import {
  canReadOpencodeDb,
  exportOpencodeSession,
  extractOpencodeSession,
  isOpencodeRecord,
} from '../src/extract-opencode.js'
import { costOf, defaultPricing } from '../src/pricing.js'
import { sniffSource } from '../src/store.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, '..', '..', 'test', 'fixtures', 'opencode-session.jsonl')
const rounds = await extractOpencodeSession(FIXTURE, 'ses_fixture')

test('a round is one model call: each step, not each message', () => {
  // Two steps in the first assistant message, the compaction summary, then one more message.
  assert.equal(rounds.length, 4)
  assert.deepEqual(
    rounds.map((r) => r.model),
    ['claude-sonnet-4-5', 'claude-sonnet-4-5', 'claude-sonnet-4-5', 'gpt-5.1'],
  )
})

test("a fork's copy of the session it came from is not read again", () => {
  assert.ok(rounds.every((r) => r.in_uncached !== 999))
  assert.ok(rounds.every((r) => r.user_text !== 'an earlier question'))
})

test('a typed message starts a task; a compaction request and injected text do not', () => {
  assert.deepEqual(
    rounds.map((r) => r.task),
    [1, 1, 1, 2],
  )
  assert.equal(rounds[0]!.user_text, 'fix the off-by-one in loop.ts')
  assert.equal(rounds[3]!.user_text, 'now write a note')
})

test('usage is per step, input is already uncached, and reasoning counts as output', () => {
  const [first, second] = rounds
  assert.equal(first!.in_uncached, 1200)
  assert.equal(first!.in_cache_write, 3000)
  assert.equal(first!.in_cache_write_5m, 3000)
  assert.equal(first!.in_cache_write_1h, 0)
  assert.equal(first!.in_tokens, 4200)
  assert.equal(first!.out_tokens, 40 + 20)
  assert.equal(second!.in_cache_read, 4000)
  assert.equal(second!.in_tokens, 4050)
  assert.equal(rounds[3]!.out_tokens, 30 + 12)
  assert.ok((costOf(first!, defaultPricing()) ?? 0) > 0)
})

test('the result of a tool prompts the next model call, whichever call that is', () => {
  // The failed `npm test` is what the compaction summary was called with.
  assert.deepEqual(
    rounds.map((r) => r.first_input),
    ['user_message', 'tool_result', 'tool_result', 'user_message'],
  )
})

test('a step runs from its start to its finish', () => {
  assert.equal(rounds[0]!.ts, '2026-01-06T10:00:01.200Z')
  assert.equal(rounds[0]!.ms, 1800)
  // Generation ends with the last thing the model emitted — the tool call at 2s — not when the
  // step closed after the tool had run.
  assert.equal(rounds[0]!.gen_ms, 1000)
  assert.equal(rounds[1]!.ts, '2026-01-06T10:00:03.100Z')
  assert.equal(rounds[3]!.wait_ms, 80_000 - 64_000)
})

test('tools carry their outcome, timing and size of change', () => {
  const read = rounds[0]!.tools[0]!
  assert.equal(read.name, 'read')
  assert.equal(read.is_error, false)
  assert.equal(read.ms, 50)
  const [edit, bash] = rounds[1]!.tools
  assert.deepEqual(edit!.patch, { files: 1, added: 1, removed: 1 })
  assert.equal(bash!.is_error, true)
  assert.notEqual(bash!.error_kind, null)
  const [write, running] = rounds[3]!.tools
  assert.deepEqual(write!.patch, { files: 1, added: 3, removed: 0 })
  assert.equal(running!.interrupted, true)
  assert.equal(running!.is_error, null)
  assert.equal(rounds[0]!.thinking_chars, 'Look first.'.length)
})

test("OpenCode's tools classify by what they did", () => {
  assert.equal(classifyCall(rounds[0]!.tools[0]!)[0]!.sub, 'read')
  assert.equal(classifyCall(rounds[1]!.tools[0]!)[0]!.category, 'implementation')
  assert.equal(classifyCall(rounds[1]!.tools[1]!)[0]!.category, 'testing')
})

test('the compaction summary is counted, and the mark lands on the round after it', () => {
  const summary = rounds[2]!
  assert.equal(summary.in_tokens, 8000)
  assert.equal(summary.compaction, null)
  const after = rounds[3]!.compaction
  assert.equal(after?.trigger, 'auto')
  assert.equal(after?.pre_tokens, 8000)
  assert.equal(after?.post_tokens, 300)
  assert.equal(after?.ms, 3500)
})

test('the JSONL copy is recognized as OpenCode by its first line', async () => {
  assert.equal(await sniffSource(FIXTURE), 'opencode')
  assert.equal(isOpencodeRecord({ kind: 'opencode.session' }), true)
  assert.equal(isOpencodeRecord({ type: 'session', cwd: '/x' }), false)
})

// The database tests need Node's built-in SQLite (22.13 and later); they are skipped without it.
const sqlite = await canReadOpencodeDb()

test('discovery reads sessions from the database, groups by directory, and nests subagents', { skip: !sqlite }, async () => {
  const name = 'node:sqlite'
  const { DatabaseSync } = (await import(name)) as {
    DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): void } }
  }
  const root = mkdtempSync(join(tmpdir(), 'probez-opencode-'))
  mkdirSync(root, { recursive: true })
  const db = new DatabaseSync(join(root, 'opencode.db'))
  db.exec(`create table session (id text primary key, project_id text, parent_id text, slug text, directory text, title text, version text, time_created integer, time_updated integer);
    create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
    create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);`)
  const session = db.prepare('insert into session values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  session.run('ses_a', 'p', null, 'a', '/work/a', 'A', '1.18', 1000, 1000)
  session.run('ses_child', 'p', 'ses_a', 'c', '/work/a', 'child', '1.18', 2000, 2000)
  session.run('ses_b', 'p', null, 'b', '/work/b', 'B', '1.18', 3000, 3000)
  db.prepare('insert into message values (?, ?, ?, ?, ?)').run('msg_1', 'ses_a', 1100, 1500, JSON.stringify({ role: 'user', time: { created: 1100 } }))
  db.prepare('insert into part values (?, ?, ?, ?, ?, ?)').run('prt_1', 'msg_1', 'ses_a', 1100, 1100, JSON.stringify({ type: 'text', text: 'hi' }))

  const projects = await discoverOpencodeProjects(root)
  const byPath = new Map(projects.map((p) => [p.path, p]))
  assert.equal(projects.length, 2)
  const a = byPath.get(resolve('/work/a'))!
  assert.deepEqual(a.sessions.map((s) => s.id).sort(), ['ses_a', 'ses_a/subagents/ses_child'])
  assert.ok(a.sessions.every((s) => s.source === 'opencode' && s.opencode?.db !== undefined))
  // A session's size and time are its own, so a change to one does not mark the others stale.
  const sessionA = a.sessions.find((s) => s.id === 'ses_a')!
  assert.equal(sessionA.size, 2)
  assert.equal(sessionA.mtimeMs, 1500)

  const copy = join(root, 'copy.jsonl')
  assert.equal(await exportOpencodeSession(sessionA.opencode!, copy), true)
  const lines = readFileSync(copy, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { kind: string })
  assert.deepEqual(
    lines.map((line) => line.kind),
    ['opencode.session', 'opencode.message', 'opencode.part'],
  )
  assert.equal(await exportOpencodeSession({ db: join(root, 'opencode.db'), session: 'ses_gone' }, copy), false)
})

test('a missing data directory is no projects, not a failure', async () => {
  assert.deepEqual(await discoverOpencodeProjects(join(tmpdir(), 'probez-no-such-opencode')), [])
})
