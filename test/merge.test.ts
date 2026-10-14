import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { applyClear, collectProject, importProject, listStored, MERGED_FILE, planClear, readRoundsIn } from '../src/store.js'
import { BadRequest, exportProject, forgetRounds, identityPayload, mergeExport, NotFound, searchPayload } from '../src/viewdata.js'
import { ROUND_DEFAULTS } from './support.js'
import type { Project, Round } from '../src/types.js'

const FIXTURE = fileURLToPath(new URL('../../test/fixtures/session.jsonl', import.meta.url))

/**
 * One project worked on from two machines.
 *
 * The project here is written with `importProject`, which is the shortest way to a store with a
 * manifest; what is merged into it is what the other machine's `exportProject` would write.
 */

function store(name = 'Itay'): string {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'probez-merge-')))
  writeFileSync(join(dataDir, 'identity.json'), JSON.stringify({ name }))
  forgetRounds()
  return dataDir
}

function round(over: Partial<Round> = {}): Round {
  return {
    ...ROUND_DEFAULTS,
    session: 's1',
    id: 'msg_1',
    ts: '2026-08-01T10:00:00.000Z',
    model: 'claude-opus-5',
    in_uncached: 100,
    in_cache_write: 0,
    in_cache_write_5m: 0,
    in_cache_write_1h: 0,
    in_cache_read: 900,
    in_tokens: 1_000,
    out_tokens: 40,
    ...over,
  }
}

const lines = (rounds: Round[]): string => rounds.map((one) => JSON.stringify(one)).join('\n') + '\n'

async function mine(dataDir: string): Promise<string> {
  const local = [round(), round({ round: 1, id: 'msg_2' })]
  return (await importProject(dataDir, 'app', 'app', local, 0)).slug
}

test('a merge adds the other machine\'s rounds, named for who recorded them', async () => {
  const dataDir = store()
  const slug = await mine(dataDir)
  const theirs = [round({ session: 's9', id: 'x1', committer: 'Dana' }), round({ session: 's9', round: 1, id: 'x2', committer: 'Dana' })]

  const merged = await mergeExport(dataDir, slug, { text: lines(theirs) })
  assert.equal(merged.added, 2)
  assert.equal(merged.rounds, 4)
  assert.equal(merged.sessions, 2)
  assert.deepEqual(merged.committers, [{ name: 'Dana', rounds: 2 }])

  const stored = (await listStored(dataDir)).find((one) => one.slug === slug)!
  assert.deepEqual(stored.committers, ['Dana'])
  assert.equal(stored.rounds, 4)
  assert.notEqual(stored.merged_at, null)
  // A copy beside the rounds, which is what a schema rebuild puts back.
  assert.equal(readFileSync(join(stored.dir, MERGED_FILE), 'utf8').trim().split('\n').length, 2)
  assert.deepEqual((await identityPayload(dataDir)).committers, ['Itay', 'Dana'])
})

test('merging the same file twice changes nothing, and a newer one brings what is new', async () => {
  const dataDir = store()
  const slug = await mine(dataDir)
  const first = [round({ session: 's9', id: 'x1', committer: 'Dana', out_tokens: 1 })]
  await mergeExport(dataDir, slug, { text: lines(first) })
  const stored = (await listStored(dataDir)).find((one) => one.slug === slug)!
  const before = statSync(join(stored.dir, 'rounds.jsonl')).mtimeMs
  const manifest = readFileSync(join(stored.dir, 'manifest.json'), 'utf8')
  const again = await mergeExport(dataDir, slug, { text: lines(first) })
  assert.equal(again.added, 0)
  assert.equal(again.updated, 0)
  assert.equal(again.rounds, 3)
  // Nothing changed, so nothing was written: not the rounds, and not the manifest's merged_at.
  assert.equal(statSync(join(stored.dir, 'rounds.jsonl')).mtimeMs, before)
  assert.equal(readFileSync(join(stored.dir, 'manifest.json'), 'utf8'), manifest)

  const newer = [
    round({ session: 's9', id: 'x1', committer: 'Dana', out_tokens: 7 }),
    round({ session: 's9', round: 1, id: 'x2', committer: 'Dana' }),
  ]
  const later = await mergeExport(dataDir, slug, { text: lines(newer) })
  assert.equal(later.added, 1)
  assert.equal(later.updated, 1)
  const rounds = await readRoundsIn(stored.dir)
  assert.equal(rounds.length, 4)
  assert.equal(rounds.find((one) => one.id === 'x1')?.out_tokens, 7)
})

test('a round collected here is never replaced by somebody else\'s copy of it', async () => {
  const dataDir = store()
  const slug = await mine(dataDir)
  // My own export, sent back to me: every round in it is one I already have.
  const result = await mergeExport(dataDir, slug, { text: lines([round({ committer: 'Itay', out_tokens: 999 })]) })
  assert.equal(result.kept, 1)
  assert.equal(result.added, 0)
  const stored = (await listStored(dataDir)).find((one) => one.slug === slug)!
  const rounds = await readRoundsIn(stored.dir)
  assert.equal(rounds.find((one) => one.id === 'msg_1')?.out_tokens, 40)
  assert.equal(rounds.find((one) => one.id === 'msg_1')?.committer, undefined)
})

test('an export names its rounds for this machine, and a merge reads that name back', async () => {
  const sender = store('Dana')
  const sent = await mine(sender)
  const jsonl = await exportProject(sender, sent, 'jsonl')
  for (const line of jsonl.body.trim().split('\n')) assert.equal((JSON.parse(line) as Round).committer, 'Dana')
  const bundle = await exportProject(sender, sent, 'json')
  assert.equal((JSON.parse(bundle.body) as { committer: string }).committer, 'Dana')

  // Same session ids as the receiver's own, so only the session names differ in what is merged.
  const receiver = store('Itay')
  const slug = (await importProject(receiver, 'app', 'app', [round({ session: 'mine' })], 0)).slug
  const result = await mergeExport(receiver, slug, { text: bundle.body })
  assert.equal(result.added, 2)
  assert.deepEqual(result.committers, [{ name: 'Dana', rounds: 2 }])
})

test('a file that does not say whose work it is needs a name before it merges', async () => {
  const dataDir = store()
  const slug = await mine(dataDir)
  const unnamed = lines([round({ session: 's9', id: 'x1' })])
  await assert.rejects(mergeExport(dataDir, slug, { text: unnamed }), BadRequest)
  const named = await mergeExport(dataDir, slug, { text: unnamed, committer: 'Dana' })
  assert.deepEqual(named.committers, [{ name: 'Dana', rounds: 1 }])
})

test('a darkened export names nobody, though it still tells its people apart', async () => {
  const dataDir = store('Dana Real-Name')
  const slug = await mine(dataDir)
  await mergeExport(dataDir, slug, { text: lines([round({ session: 's9', id: 'x1', committer: 'Bob Real-Name' })]) })
  for (const format of ['jsonl', 'json'] as const) {
    const body = (await exportProject(dataDir, slug, format, true)).body
    assert.doesNotMatch(body, /Real-Name/, format)
  }
  const bundle = JSON.parse((await exportProject(dataDir, slug, 'json', true)).body) as {
    committer: string
    rounds: Round[]
  }
  const names = new Set(bundle.rounds.map((one) => one.committer))
  assert.equal(names.size, 2)
  assert.ok(names.has(bundle.committer))
})

test('an undarkened .jsonl export is the stored lines with a name on the front, torn lines and all', async () => {
  const dataDir = store()
  const slug = await mine(dataDir)
  const stored = (await listStored(dataDir)).find((one) => one.slug === slug)!
  const file = join(stored.dir, 'rounds.jsonl')
  const held = readFileSync(file, 'utf8')
  writeFileSync(file, held + '{"session":"torn\n')
  forgetRounds()
  const sent = (await exportProject(dataDir, slug, 'jsonl')).body.trim().split('\n')
  assert.equal(sent.length, 3)
  assert.equal(sent[2], '{"session":"torn')
  assert.equal(sent[0], '{"committer":"Itay",' + held.split('\n')[0]!.slice(1))
})

test('clearing a session takes its merged copy too, so a rebuild cannot bring it back', async () => {
  const dataDir = store()
  const slug = await mine(dataDir)
  await mergeExport(dataDir, slug, {
    text: lines([
      round({ session: 'old', id: 'o1', committer: 'Dana', ts: '2020-01-01T00:00:00.000Z' }),
      round({ session: 'new', id: 'n1', committer: 'Dana', ts: '2026-09-01T00:00:00.000Z' }),
    ]),
  })
  const plan = await planClear(dataDir, { before: Date.parse('2021-01-01'), slug })
  await applyClear(dataDir, plan)
  const stored = (await listStored(dataDir)).find((one) => one.slug === slug)!
  const merged = readFileSync(join(stored.dir, MERGED_FILE), 'utf8')
  assert.doesNotMatch(merged, /"old"/)
  assert.match(merged, /"new"/)
  assert.deepEqual(stored.committers, ['Dana'])
})

test('typing in:trails into a search is refused without --debug, as ?in=trails is', async () => {
  const dataDir = store()
  await mine(dataDir)
  await assert.rejects(searchPayload(dataDir, { q: 'tool:Read in:trails' }), NotFound)
  await assert.rejects(searchPayload(dataDir, { q: 'tool:Read', entity: 'questions' }), NotFound)
})

test('two merges sent at once both land, because each waits for the one before it', async () => {
  const dataDir = store()
  const slug = await mine(dataDir)
  const one = lines([round({ session: 'a', id: 'a1', committer: 'Dana' })])
  const two = lines([round({ session: 'b', id: 'b1', committer: 'Bob' })])
  // Unserialized, both would read the same two rounds and the second rename would drop the first's.
  await Promise.all([mergeExport(dataDir, slug, { text: one }), mergeExport(dataDir, slug, { text: two })])
  const stored = (await listStored(dataDir)).find((row) => row.slug === slug)!
  const ids = (await readRoundsIn(stored.dir)).map((row) => row.id).sort()
  assert.deepEqual(ids, ['a1', 'b1', 'msg_1', 'msg_2'])
  assert.deepEqual(stored.committers, ['Bob', 'Dana'])
})

test('a schema rebuild puts merged rounds back, in the current shape', async () => {
  const dataDir = store()
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'probez-merge-work-')))
  const session = join(work, 'aaaaaaaa-0000-0000-0000-000000000000.jsonl')
  writeFileSync(session, readFileSync(FIXTURE, 'utf8').replaceAll('/tmp/demo', work))
  const info = statSync(session)
  const project: Project = {
    key: 'merge-rebuild',
    path: work,
    dir: work,
    lastActivity: info.mtimeMs,
    sessions: [{ id: 'aaaaaaaa-0000-0000-0000-000000000000', file: session, size: info.size, mtimeMs: info.mtimeMs, source: 'claude-code' }],
  }
  const first = await collectProject(project, dataDir)
  const slug = first.slug
  await mergeExport(dataDir, slug, { text: lines([round({ session: 'theirs', id: 't1', committer: 'Dana' })]) })

  // Age the store, and age the merged copy the way an older probez would have written it.
  const dir = join(dataDir, 'projects', slug)
  for (const name of ['state.json', 'manifest.json']) {
    const json = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>
    json.schema_version = 1
    writeFileSync(join(dir, name), JSON.stringify(json))
  }
  const aged = JSON.parse(readFileSync(join(dir, MERGED_FILE), 'utf8').trim()) as Record<string, unknown>
  delete aged.events
  delete aged.in_tokens
  writeFileSync(join(dir, MERGED_FILE), JSON.stringify(aged) + '\n')

  const again = await collectProject(project, dataDir)
  assert.equal(again.rebuilt, true)
  const rounds = await readRoundsIn(dir)
  const theirs = rounds.find((one) => one.id === 't1')
  assert.ok(theirs !== undefined, 'the merged round survives the rebuild')
  assert.equal(theirs.committer, 'Dana')
  assert.ok(Array.isArray(theirs.events), 'and comes back in the current shape')
  assert.equal(theirs.in_tokens, 1_000)
  const copy = JSON.parse(readFileSync(join(dir, MERGED_FILE), 'utf8').trim()) as Round
  assert.ok(Array.isArray(copy.events), 'the copy is rewritten in that shape too')
  assert.equal(rounds.filter((one) => one.id === 't1').length, 1)
})
