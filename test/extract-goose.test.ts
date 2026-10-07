import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { actsOf } from '../src/act.js'
import { classifyCall } from '../src/classify.js'
import { discoverGooseProjects } from '../src/discover.js'
import {
  canReadGooseDb,
  exportGooseSession,
  extractGooseSession,
  gooseToolName,
  isGooseRecord,
} from '../src/extract-goose.js'
import { costOf, defaultPricing } from '../src/pricing.js'
import { sniffSource } from '../src/store.js'
import type { ToolCall } from '../src/types.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, '..', '..', 'test', 'fixtures', 'goose-session.jsonl')
const rounds = await extractGooseSession(FIXTURE, '20260106_1')

test('a round is one model call, however many messages Goose split its reply into', () => {
  // Two calls, the compaction summary, then one more call.
  assert.deepEqual(
    rounds.map((r) => r.id),
    ['msg_r1', 'msg_r2', 'ledger-2', 'msg_r3'],
  )
  assert.deepEqual(
    rounds.map((r) => r.model),
    ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5', 'claude-sonnet-4-5', 'gpt-5.1'],
  )
  // The tool requests after the message carrying the usage are the same call's.
  assert.deepEqual(
    rounds[0]!.tools.map((t) => t.name),
    ['developer__shell', 'developer__tree'],
  )
  assert.deepEqual(
    rounds[1]!.tools.map((t) => t.name),
    // Goose 1.53 records the developer extension's tools bare; older versions prefixed them.
    ['edit', 'developer__shell'],
  )
})

test('history a fork or an import copied in is not read again', () => {
  assert.ok(rounds.every((r) => r.in_tokens !== 999))
  assert.ok(rounds.every((r) => r.user_text !== 'an earlier question'))
})

test('a typed message starts a task; a turn-context note and a compaction summary do not', () => {
  assert.deepEqual(
    rounds.map((r) => r.task),
    [1, 1, 1, 2],
  )
  assert.equal(rounds[0]!.user_text, 'fix the off-by-one in loop.ts')
  assert.equal(rounds[3]!.user_text, 'now write a note')
  assert.equal(rounds[0]!.text, 'Let me look.')
})

test('input includes the cache, so the uncached part is what is left of it', () => {
  const [first, second, , last] = rounds
  assert.equal(first!.in_tokens, 8200)
  assert.equal(first!.in_uncached, 1200)
  assert.equal(first!.in_cache_write, 7000)
  assert.equal(first!.in_cache_write_5m, 7000)
  assert.equal(first!.in_cache_write_1h, 0)
  assert.equal(first!.in_cache_read, 0)
  assert.equal(first!.out_tokens, 60)
  assert.equal(second!.in_tokens, 8300)
  assert.equal(second!.in_cache_read, 8000)
  assert.equal(second!.in_uncached, 100)
  assert.equal(last!.in_uncached, 500)
  assert.equal(last!.out_tokens, 42)
  assert.ok((costOf(first!, defaultPricing()) ?? 0) > 0)
})

test("thinking Goose copies onto each of a call's tool requests is counted once", () => {
  assert.equal(rounds[0]!.thinking_chars, 'Look first.'.length)
})

test("a call's timing is its own elapsed time, since Goose's timestamps are whole seconds", () => {
  assert.equal(rounds[0]!.ts, '2026-01-06T10:00:02.000Z')
  assert.equal(rounds[0]!.ms, 1800)
  assert.equal(rounds[0]!.gen_ms, 1800)
  assert.equal(rounds[3]!.wait_ms, 80_000 - 8_000)
})

test('the result of a tool prompts the next model call, whichever call that is', () => {
  // The failed `npm test` is what the compaction summary was called with.
  assert.deepEqual(
    rounds.map((r) => r.first_input),
    ['user_message', 'tool_result', 'tool_result', 'user_message'],
  )
})

test('tools carry their outcome, timing and size of change', () => {
  const [shell, tree] = rounds[0]!.tools
  assert.equal(shell!.is_error, false)
  assert.equal(shell!.ms, 1000)
  assert.equal(shell!.result_chars, 'for (let i = 0; i <= n; i++) {}'.length)
  assert.equal(tree!.result_chars, 'src/\n  loop.ts 3'.length)
  const [edit, test] = rounds[1]!.tools
  assert.deepEqual(edit!.patch, { files: 1, added: 1, removed: 1 })
  assert.equal(test!.is_error, true)
  // Goose's shell reports stderr and the exit status apart from stdout, as a real session shows.
  assert.equal(test!.stderr_chars, 'FAIL loop.test.ts\n1 failing'.length)
  assert.equal(shell!.stderr_chars, 0)
  assert.equal(tree!.stderr_chars, null)
  assert.notEqual(test!.error_kind, null)
  const [write, mcp] = rounds[3]!.tools
  assert.deepEqual(write!.patch, { files: 1, added: 3, removed: 0 })
  // A configured extension is an MCP server; this one never answered.
  assert.equal(mcp!.name, 'mcp__github__create_issue')
  assert.equal(mcp!.interrupted, true)
  assert.equal(mcp!.is_error, null)
})

test("Goose's tools classify by what they did", () => {
  assert.equal(classifyCall(rounds[1]!.tools[0]!)[0]!.category, 'implementation')
  assert.equal(classifyCall(rounds[1]!.tools[1]!)[0]!.category, 'testing')
  assert.equal(actsOf(rounds[0]!.tools[1]!)[0]!.verb, 'search')
  assert.equal(actsOf(rounds[3]!.tools[1]!)[0]!.verb, 'mcp')
  const editor = (command: string): ToolCall =>
    ({ ...rounds[0]!.tools[0]!, name: 'developer__text_editor', input: { command, path: 'src/a.ts' } }) as ToolCall
  assert.equal(actsOf(editor('view'))[0]!.verb, 'read')
  assert.equal(actsOf(editor('str_replace'))[0]!.verb, 'write')
  assert.equal(actsOf(editor('str_replace'))[0]!.path, 'src/a.ts')
})

test("a built-in extension's tools keep their names; any other extension's are MCP", () => {
  assert.equal(gooseToolName('developer__shell'), 'developer__shell')
  assert.equal(gooseToolName('todo__todo_write'), 'todo__todo_write')
  assert.equal(gooseToolName('github__create_issue'), 'mcp__github__create_issue')
  assert.equal(gooseToolName('unparseable_tool_call'), 'unparseable_tool_call')
})

test('the compaction summary is counted from the ledger, and the mark lands on the round after it', () => {
  const summary = rounds[2]!
  assert.equal(summary.in_tokens, 9000)
  assert.equal(summary.out_tokens, 300)
  assert.equal(summary.compaction, null)
  const after = rounds[3]!.compaction
  // Goose's continuation text is fixed, and only the one for `/compact` names the person.
  assert.equal(after?.trigger, 'auto')
  assert.equal(after?.pre_tokens, 9000)
  assert.equal(after?.post_tokens, 300)
  assert.equal(after?.ts, '2026-01-06T10:00:20.000Z')
})

test('the JSONL copy is recognized as Goose by its first line', async () => {
  assert.equal(await sniffSource(FIXTURE), 'goose')
  assert.equal(isGooseRecord({ kind: 'goose.session' }), true)
  assert.equal(isGooseRecord({ kind: 'opencode.session' }), false)
})

test('a session from before per-message usage splits a call wherever a tool answered', async () => {
  const root = mkdtempSync(join(tmpdir(), 'probez-goose-old-'))
  const file = join(root, 'old.jsonl')
  const at = (s: number): number => 1_700_000_000_000 + s * 1000
  const request = (id: string, command: string) => ({
    type: 'toolRequest',
    id,
    toolCall: { status: 'success', value: { name: 'developer__shell', arguments: { command } } },
  })
  const response = (id: string) => ({
    type: 'toolResponse',
    id,
    toolResult: { status: 'success', value: [{ type: 'text', text: 'ok' }] },
  })
  const lines = [
    { kind: 'goose.session', id: 'old', working_dir: '/w', parent: null, session_type: 'sub_agent', model: 'gpt-4o', created: null },
    { kind: 'goose.message', id: 'u', role: 'user', created: at(1), content: [{ type: 'text', text: 'hi' }], metadata: {} },
    { kind: 'goose.message', id: 'a1', role: 'assistant', created: at(2), content: [{ type: 'text', text: 'a' }, request('c1', 'ls')], metadata: {} },
    { kind: 'goose.message', id: 'p1', role: 'user', created: at(3), content: [response('c1')], metadata: {} },
    { kind: 'goose.message', id: 'a2', role: 'assistant', created: at(4), content: [request('c2', 'pwd')], metadata: {} },
    { kind: 'goose.message', id: 'p2', role: 'user', created: at(5), content: [response('c2')], metadata: {} },
    { kind: 'goose.message', id: 'a3', role: 'assistant', created: at(6), content: [{ type: 'text', text: 'done' }], metadata: {} },
  ]
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  const old = await extractGooseSession(file, 'old')
  assert.equal(old.length, 3)
  assert.ok(old.every((r) => r.model === 'gpt-4o' && r.in_tokens === null && r.agent === 'sub'))
  assert.equal(old[1]!.ms, 0)
})

// The database tests need Node's built-in SQLite (22.13 and later); they are skipped without it.
const sqlite = await canReadGooseDb()

test('discovery reads the database and the files it left behind, groups by directory, and nests subagents', { skip: !sqlite }, async () => {
  const name = 'node:sqlite'
  const { DatabaseSync } = (await import(name)) as {
    DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): void }; close(): void }
  }
  const root = mkdtempSync(join(tmpdir(), 'probez-goose-'))
  const dir = join(root, 'sessions')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'sessions.db'))
  db.exec(`create table sessions (id text primary key, name text, session_type text, working_dir text not null,
      created_at timestamp default current_timestamp, updated_at timestamp default current_timestamp,
      provider_name text, model_config_json text, parent_session_id text);
    create table messages (id integer primary key autoincrement, message_id text, session_id text, role text,
      content_json text, created_timestamp integer, metadata_json text);
    create table usage_ledger (id integer primary key autoincrement, session_id text, created_timestamp integer,
      model text, input_tokens integer, output_tokens integer, total_tokens integer, cache_read_tokens integer,
      cache_write_tokens integer, cost real, cost_source text, is_compaction integer default 0);`)
  const session = db.prepare('insert into sessions values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  session.run('ses_a', 'A', 'user', '/work/a', '2026-01-06 10:00:00', '2026-01-06 10:05:00', 'anthropic', '{"model_name":"claude-sonnet-4-5"}', null)
  session.run('ses_child', 'child', 'sub_agent', '/work/a', '2026-01-06 10:01:00', '2026-01-06 10:02:00', 'anthropic', null, 'ses_a')
  session.run('ses_b', 'B', 'user', '/work/b', '2026-01-06 11:00:00', '2026-01-06 11:00:00', null, null, null)
  const message = db.prepare('insert into messages (message_id, session_id, role, content_json, created_timestamp, metadata_json) values (?, ?, ?, ?, ?, ?)')
  message.run('m1', 'ses_a', 'user', '[{"type":"text","text":"hi"}]', 1767693601, '{"userVisible":true,"agentVisible":true}')
  message.run('m2', 'ses_a', 'assistant', '[{"type":"text","text":"hello"}]', 1767693602, '{"usage":{"inputTokens":10,"outputTokens":2}}')
  db.prepare('insert into usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens, is_compaction) values (?, ?, ?, ?, ?, ?)')
    .run('ses_a', 1767693602, 'claude-sonnet-4-5', 10, 2, 0)
  db.close()
  // A file from before the database: one Goose has imported (same id), and one it has not.
  writeFileSync(join(dir, 'ses_b.jsonl'), '{"working_dir":"/work/elsewhere"}\n')
  writeFileSync(
    join(dir, '20250101_120000.jsonl'),
    '{"working_dir":"/work/legacy","description":"old"}\n{"id":"x","role":"user","created":1735732800,"content":[{"type":"text","text":"old"}]}\n',
  )

  const projects = await discoverGooseProjects(dir)
  const byPath = new Map(projects.map((p) => [p.path, p]))
  assert.deepEqual([...byPath.keys()].sort(), [resolve('/work/a'), resolve('/work/b'), resolve('/work/legacy')].sort())
  const a = byPath.get(resolve('/work/a'))!
  assert.deepEqual(a.sessions.map((s) => s.id).sort(), ['ses_a', 'ses_a/subagents/ses_child'])
  assert.ok(a.sessions.every((s) => s.source === 'goose' && s.goose?.db !== undefined))
  const sessionA = a.sessions.find((s) => s.id === 'ses_a')!
  // Two messages, one ledger row, and the newest message's row id.
  assert.equal(sessionA.size, 2 + 1 + 2)
  assert.equal(sessionA.mtimeMs, Date.parse('2026-01-06T10:05:00Z'))
  assert.equal(byPath.get(resolve('/work/b'))!.sessions[0]!.goose?.db !== undefined, true)

  const copy = join(root, 'copy.jsonl')
  assert.equal(await exportGooseSession(sessionA.goose!, copy), true)
  const lines = readFileSync(copy, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
  assert.deepEqual(
    lines.map((line) => line.kind),
    ['goose.session', 'goose.message', 'goose.message', 'goose.usage'],
  )
  assert.equal(lines[0]!.created, Date.parse('2026-01-06T10:00:00Z'))
  assert.equal(lines[0]!.model, 'claude-sonnet-4-5')
  assert.equal(lines[1]!.created, 1767693601000)
  const read = await extractGooseSession(copy, 'ses_a')
  assert.equal(read.length, 1)
  assert.equal(read[0]!.in_tokens, 10)

  const legacy = byPath.get(resolve('/work/legacy'))!.sessions[0]!
  assert.equal(legacy.id, '20250101_120000')
  assert.equal(await exportGooseSession(legacy.goose!, copy), true)
  assert.deepEqual(
    readFileSync(copy, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { kind: string }).kind),
    ['goose.session', 'goose.message'],
  )
  assert.equal(await exportGooseSession({ db: join(dir, 'sessions.db'), session: 'ses_gone' }, copy), false)
})

test('a missing sessions directory is no projects, not a failure', async () => {
  assert.deepEqual(await discoverGooseProjects(join(tmpdir(), 'probez-no-such-goose')), [])
})
