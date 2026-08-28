import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'

import { CONTROL, ImportError, parseExport } from '../src/import.js'
import { importProject, importSlug, listStored } from '../src/store.js'
import { ROUND_DEFAULTS } from './support.js'
import type { Round } from '../src/types.js'

function store(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'probez-import-')))
}

/** A round with enough in it to be worth checking on the way out again. */
function round(over: Partial<Round> = {}): Round {
  return {
    ...ROUND_DEFAULTS,
    session: 's1',
    id: 'msg_1',
    ts: '2026-08-01T10:00:00.000Z',
    model: 'claude-opus-5',
    in_uncached: 100,
    in_cache_write: 300,
    in_cache_write_5m: 200,
    in_cache_write_1h: 100,
    in_cache_read: 9_000,
    in_tokens: 9_400,
    out_tokens: 40,
    user_text: 'do the thing',
    text: 'done',
    ...over,
  }
}

function bundle(rounds: Round[], manifest: Record<string, unknown> = {}): string {
  return JSON.stringify({ manifest: { project: 'sent', slug: 'sent-11112222', ...manifest }, rounds })
}

test('a round without a source field is unknown, not Claude', () => {
  const { source: _dropped, ...bare } = round()
  const parsed = parseExport(JSON.stringify(bare))
  assert.equal(parsed.rounds[0]?.source, 'unknown')
})

test('an imported claude alias is persisted as claude-code', () => {
  const raw = JSON.parse(JSON.stringify(round())) as Record<string, unknown>
  raw.source = 'claude'
  const parsed = parseExport(JSON.stringify(raw))
  assert.equal(parsed.rounds[0]?.source, 'claude-code')
})

test('a bundle and the same rounds as jsonl read to the same thing', () => {
  const rounds = [round(), round({ round: 1, id: 'msg_2' })]
  const fromBundle = parseExport(bundle(rounds))
  const fromLines = parseExport(rounds.map((r) => JSON.stringify(r)).join('\n') + '\n')

  assert.deepEqual(fromBundle.rounds, fromLines.rounds)
  assert.equal(fromBundle.name, 'sent')
  // Loose rounds carry no manifest, so there is nothing to name them with.
  assert.equal(fromLines.name, null)
})

test('a round survives the trip with every field intact', () => {
  const original = round({
    gen_ms: 4200,
    wait_ms: 90_000,
    first_input: 'user_message',
    mcp_server: 'figma',
    mcp_tool: 'get_file',
    skill: 'graphify',
    source: 'codex',
    thinking_chars: 512,
    tools: [
      {
        name: 'Bash',
        id: 'toolu_1',
        input: { command: 'npm test' },
        input_chars: 26,
        result_chars: 900,
        is_error: false,
        stderr_chars: 12,
        interrupted: false,
        patch: { files: 2, added: 40, removed: 3 },
        emitted_at: '2026-08-01T10:00:01.000Z',
        result_at: '2026-08-01T10:00:05.000Z',
        ms: 4000,
      },
    ],
    events: [
      { type: 'user_message', ts: '2026-08-01T09:59:00.000Z', chars: 12 },
      { type: 'tool_call', ts: '2026-08-01T10:00:01.000Z', tool_call_id: 'toolu_1' },
    ],
  })

  const [read] = parseExport(bundle([original])).rounds
  assert.deepEqual(read, original)
})

test('the input total is recomputed rather than believed', () => {
  const lying = { ...round(), in_tokens: 999_999 }
  const [read] = parseExport(JSON.stringify(lying)).rounds
  assert.equal(read!.in_tokens, 100 + 300 + 9_000)
})

test('an unsplit cache write is charged at the cheaper rate rather than guessed', () => {
  // Both halves absent: the total is all that is known, and the 5-minute entry is the default.
  const vague = { ...round(), in_cache_write_5m: 0, in_cache_write_1h: 0 }
  const [read] = parseExport(JSON.stringify(vague)).rounds
  assert.equal(read!.in_cache_write_5m, 300)
  assert.equal(read!.in_cache_write_1h, 0)
})

test('records that are not rounds are counted, not silently dropped', () => {
  const text = [JSON.stringify(round()), '{"note":"exported by hand"}', '["nope"]', '7'].join('\n')
  const parsed = parseExport(text)
  assert.equal(parsed.rounds.length, 1)
  assert.equal(parsed.skipped, 3)
})

test('the same round twice is one round', () => {
  const text = [round(), round(), round({ id: 'msg_2' })].map((r) => JSON.stringify(r)).join('\n')
  assert.equal(parseExport(text).rounds.length, 2)
})

test('the format is decided by the contents, not by the name it arrived under', () => {
  // A bundle someone saved as `.jsonl`, and rounds someone saved as `.json`. Both still read.
  assert.equal(parseExport(bundle([round()])).rounds.length, 1)
  assert.equal(parseExport(JSON.stringify(round())).rounds.length, 1)
})

test('control characters never reach anything that prints', () => {
  // `probez round` prints these to a terminal, and a terminal obeys escape sequences it is handed.
  const nasty = round({
    user_text: 'ok\u001b[2Jcleared\r\n\tnext',
    text: 'a\u0007b',
    session: 's1\u0000x',
  })
  const parsed = parseExport(bundle([nasty], { project: 'evil\u001b[2Jname' }))
  const read = parsed.rounds[0]!

  // Tabs and newlines are prose and stay. The escape, the bell, the return and the NUL do not.
  assert.equal(read.user_text, 'ok[2Jcleared\n\tnext')
  assert.equal(read.text, 'ab')
  assert.equal(read.session, 's1x')
  assert.equal(parsed.name, 'evil[2Jname')
  assert.doesNotMatch(read.user_text + read.text + parsed.name, CONTROL)
})

test('an imported commit is kept only when it is shaped like one', () => {
  const hash = 'a'.repeat(40)
  const kept = parseExport(bundle([round({ commit: hash })]))
  assert.equal(kept.rounds[0]?.commit, hash)
  // 64 characters is what a SHA-256 repository writes, and is a hash too.
  const long = 'f'.repeat(64)
  assert.equal(parseExport(bundle([round({ commit: long })])).rounds[0]?.commit, long)

  // Everything else is a sender writing into a column that is read as an identifier.
  for (const bad of ['HEAD', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40), '']) {
    const parsed = parseExport(bundle([round({ commit: bad as string })]))
    assert.equal(parsed.rounds[0]?.commit, null, `kept ${JSON.stringify(bad)}`)
  }
  assert.equal(parseExport(bundle([round({ commit: null })])).rounds[0]?.commit, null)
})

test('a file with nothing usable in it says so instead of importing nothing', () => {
  assert.throws(() => parseExport(''), ImportError)
  assert.throws(() => parseExport('   \n\n'), ImportError)
  assert.throws(() => parseExport('hello, this is a text file'), ImportError)
  // A bundle cut off mid-download is the common case, and "invalid JSON" alone would not say why.
  assert.throws(() => parseExport('{"manifest":{},"rounds":[{"sess'), {
    message: /is it complete/,
  })
  assert.throws(() => parseExport('{"manifest":{}}'), { message: /no `rounds`/ })
})

test('an export from before the token split is refused rather than priced as free', () => {
  const old = {
    session: 's1',
    id: 'msg_1',
    in_tokens: 9_400,
    out_tokens: 40,
    model: 'claude-opus-5',
  }
  assert.throws(() => parseExport(JSON.stringify(old)), { message: /predates probez/ })
})

test('the sender picks the name but never the path', () => {
  const slug = importSlug('../../../../etc/pwned', 'whatever')
  assert.equal(basename(slug), slug)
  assert.match(slug, /^[A-Za-z0-9._-]+$/)
  assert.doesNotMatch(slug, /\.\./)
})

test('two projects of the same name from different senders do not collide', () => {
  assert.notEqual(importSlug('probez', 'alice-machine'), importSlug('probez', 'bob-machine'))
  // Same sender, same project: the same place, which is what makes re-importing an update.
  assert.equal(importSlug('probez', 'alice-machine'), importSlug('probez', 'alice-machine'))
})

test('an import lands in the store and reads back as a project', async () => {
  const dir = store()
  const rounds = [round(), round({ round: 1, id: 'msg_2', session: 's2' })]
  const result = await importProject(dir, 'sent', 'sent-11112222', rounds, 0)

  assert.equal(result.project, 'sent')
  assert.equal(result.rounds, 2)
  assert.equal(result.sessions, 2)

  const stored = await listStored(dir)
  assert.equal(stored.length, 1)
  assert.equal(stored[0]!.slug, result.slug)
  // Nothing on this machine produced it, so there is no local path to claim.
  assert.equal(stored[0]!.path, null)
  assert.notEqual(stored[0]!.imported_at, null)

  const lines = readFileSync(join(result.dir, 'rounds.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.deepEqual(JSON.parse(lines[0]!), rounds[0])
})

test('re-importing the same project replaces it instead of stacking a second copy', async () => {
  const dir = store()
  const first = await importProject(dir, 'sent', 'sent-11112222', [round()], 0)
  const again = await importProject(
    dir,
    'sent',
    'sent-11112222',
    [round(), round({ round: 1, id: 'msg_2' })],
    0,
  )

  assert.equal(again.slug, first.slug)
  assert.equal(again.rounds, 2)
  assert.equal((await listStored(dir)).length, 1)
  // Not appended: the newer export is the whole truth about that project.
  assert.equal(readFileSync(join(again.dir, 'rounds.jsonl'), 'utf8').trim().split('\n').length, 2)
})

test('an import from a different sender sits beside the local project of that name', async () => {
  const dir = store()
  const mine = await importProject(dir, 'probez', 'my-machine', [round()], 0)
  const theirs = await importProject(dir, 'probez', 'their-machine', [round()], 0)

  assert.notEqual(mine.slug, theirs.slug)
  assert.equal((await listStored(dir)).length, 2)
})
