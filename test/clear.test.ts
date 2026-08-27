import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { applyClear, listStored, planClear } from '../src/store.js'
import type { Round } from '../src/types.js'
import { ROUND_DEFAULTS } from './support.js'

/**
 * Clearing, which is the one thing here that destroys more than it reads.
 *
 * The tests that matter are the ones about what *survives*: a trim that took a session it should
 * have kept, or left a manifest claiming rounds that are gone, is worse than one that took nothing.
 */

const DAY = 86_400_000

function round(session: string, at: number, extra: Partial<Round> = {}): Round {
  return {
    ...ROUND_DEFAULTS,
    session,
    round: 0,
    id: `msg_${session}_${at}`,
    model: 'claude-opus-5',
    ts: new Date(at).toISOString(),
    ...extra,
  }
}

/** A store holding one project, with the archived copies and the state a real collect leaves. */
function store(rounds: Round[], extra: { orphan?: { id: string; mtimeMs: number } } = {}): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'probez-clear-test-'))
  const dir = join(dataDir, 'projects', 'demo-abcd1234')
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  writeFileSync(join(dir, 'rounds.jsonl'), rounds.map((one) => JSON.stringify(one)).join('\n') + '\n')

  const sessions: Record<string, { size: number; mtimeMs: number }> = {}
  for (const id of new Set(rounds.map((one) => one.session))) {
    writeFileSync(join(dir, 'sessions', `${id}.jsonl`), 'x'.repeat(1000))
    sessions[id] = { size: 1000, mtimeMs: Date.now() }
  }
  if (extra.orphan !== undefined) {
    writeFileSync(join(dir, 'sessions', `${extra.orphan.id}.jsonl`), 'x'.repeat(500))
    sessions[extra.orphan.id] = { size: 500, mtimeMs: extra.orphan.mtimeMs }
  }
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ schema_version: 6, sessions }, null, 2))
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        schema_version: 6,
        project: 'demo',
        path: '/work/demo',
        key: 'demo',
        sessions: Object.keys(sessions).length,
        rounds: rounds.length,
        tasks: 1,
        in_tokens: 999,
        out_tokens: 99,
        first_ts: rounds[0]?.ts ?? null,
        last_ts: rounds.at(-1)?.ts ?? null,
        collected_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
  writeFileSync(join(dir, 'analysis.jsonl'), '{"schema_version":6}\n')
  writeFileSync(join(dir, 'search.jsonl'), '{"index_version":1}\n')
  return dataDir
}

const projectDirOf = (dataDir: string): string => join(dataDir, 'projects', 'demo-abcd1234')

// ---------------------------------------------------------------------------------------------
// What a plan says
// ---------------------------------------------------------------------------------------------

test('a plan reads the store and changes nothing in it', async () => {
  const now = Date.now()
  const dataDir = store([round('old', now - 40 * DAY), round('new', now - 2 * DAY)])
  const before = readFileSync(join(projectDirOf(dataDir), 'rounds.jsonl'), 'utf8')

  const plan = await planClear(dataDir, { before: now - 30 * DAY })
  assert.equal(plan.totals.projects, 1)
  assert.equal(plan.totals.sessions, 1)
  assert.equal(plan.totals.rounds, 1)
  assert.equal(plan.projects[0]?.whole, false)

  assert.equal(readFileSync(join(projectDirOf(dataDir), 'rounds.jsonl'), 'utf8'), before)
  assert.ok(existsSync(join(projectDirOf(dataDir), 'search.jsonl')))
})

test('a session is old when its newest round is, not its oldest', async () => {
  const now = Date.now()
  // One session running from forty days ago to yesterday. It is not an old session.
  const dataDir = store([round('long', now - 40 * DAY), round('long', now - 1 * DAY)])
  const plan = await planClear(dataDir, { before: now - 30 * DAY })
  assert.equal(plan.totals.projects, 0, 'a session with recent work was marked old')
})

test('a project where nothing survives goes entirely rather than being emptied', async () => {
  const now = Date.now()
  const dataDir = store([round('a', now - 60 * DAY), round('b', now - 50 * DAY)])
  const plan = await planClear(dataDir, { before: now - 30 * DAY })
  assert.equal(plan.projects[0]?.whole, true)
  await applyClear(dataDir, plan)
  assert.equal(existsSync(projectDirOf(dataDir)), false)
  assert.deepEqual(await listStored(dataDir), [])
})

test('a session with no rounds is dated by the agent file, so it can be cleared at all', async () => {
  const now = Date.now()
  const fresh = store([round('keep', now - 1 * DAY)], {
    orphan: { id: 'orphan', mtimeMs: now - 2 * DAY },
  })
  assert.equal((await planClear(fresh, { before: now - 30 * DAY })).totals.projects, 0)

  const stale = store([round('keep', now - 1 * DAY)], {
    orphan: { id: 'orphan', mtimeMs: now - 90 * DAY },
  })
  const plan = await planClear(stale, { before: now - 30 * DAY })
  assert.deepEqual(plan.projects[0]?.ids, ['orphan'])
  // It has no rounds, so clearing it frees an archived copy and nothing else.
  assert.equal(plan.totals.rounds, 0)
  await applyClear(stale, plan)
  assert.equal(existsSync(join(projectDirOf(stale), 'sessions', 'orphan.jsonl')), false)
  assert.ok(existsSync(join(projectDirOf(stale), 'sessions', 'keep.jsonl')))
})

// ---------------------------------------------------------------------------------------------
// What a trim leaves behind
// ---------------------------------------------------------------------------------------------

test('a trim keeps every surviving round, in the order they were in', async () => {
  const now = Date.now()
  const rounds: Round[] = []
  for (let at = 0; at < 40; at += 1) {
    rounds.push(round(at % 2 === 0 ? 'old' : 'new', now - (at % 2 === 0 ? 60 : 2) * DAY, { round: at }))
  }
  const dataDir = store(rounds)
  const plan = await planClear(dataDir, { before: now - 30 * DAY })
  const done = await applyClear(dataDir, plan)

  assert.equal(done.rounds, 20)
  const left = readFileSync(join(projectDirOf(dataDir), 'rounds.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Round)
  assert.equal(left.length, 20)
  assert.ok(left.every((one) => one.session === 'new'))
  // File order is what the search index addresses rounds by, so it has to survive a rewrite.
  assert.deepEqual(left.map((one) => one.round), rounds.filter((one) => one.session === 'new').map((one) => one.round))
})

test('a trim takes the archived copies, the state entries and the derived files with it', async () => {
  const now = Date.now()
  const dataDir = store([round('old', now - 60 * DAY), round('new', now - 1 * DAY)])
  await applyClear(dataDir, await planClear(dataDir, { before: now - 30 * DAY }))
  const dir = projectDirOf(dataDir)

  assert.equal(existsSync(join(dir, 'sessions', 'old.jsonl')), false, 'the archived copy stayed')
  assert.ok(existsSync(join(dir, 'sessions', 'new.jsonl')))
  // The state is what tells the next collect a session is already read. Saying so about one that
  // is no longer here would mean it never came back.
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as {
    sessions: Record<string, unknown>
  }
  assert.deepEqual(Object.keys(state.sessions), ['new'])
  // Both are derived from the rounds and would be about rounds that are gone.
  assert.equal(existsSync(join(dir, 'analysis.jsonl')), false)
  assert.equal(existsSync(join(dir, 'search.jsonl')), false)
})

test('a trimmed manifest counts what is left, not what there was', async () => {
  const now = Date.now()
  const dataDir = store([
    round('old', now - 60 * DAY, { in_tokens: 500, out_tokens: 50 }),
    round('new', now - 1 * DAY, { in_tokens: 111, out_tokens: 11 }),
  ])
  await applyClear(dataDir, await planClear(dataDir, { before: now - 30 * DAY }))
  const [row] = await listStored(dataDir)
  assert.equal(row?.rounds, 1)
  assert.equal(row?.sessions, 1)
  assert.equal(row?.in_tokens, 111)
  assert.equal(row?.out_tokens, 11)
  // The name and the path are not counts and are carried across untouched.
  assert.equal(row?.project, 'demo')
  assert.equal(row?.path, '/work/demo')
})

test('the store is owner-only after a trim, as it was before', async () => {
  const now = Date.now()
  const dataDir = store([round('old', now - 60 * DAY), round('new', now - 1 * DAY)])
  await applyClear(dataDir, await planClear(dataDir, { before: now - 30 * DAY }))
  for (const name of ['rounds.jsonl', 'state.json', 'manifest.json']) {
    assert.equal(statSync(join(projectDirOf(dataDir), name)).mode & 0o077, 0, name)
  }
})

// ---------------------------------------------------------------------------------------------
// Clearing everything, and the fence around it
// ---------------------------------------------------------------------------------------------

test('clearing everything takes every project and leaves the settings beside them', async () => {
  const now = Date.now()
  const dataDir = store([round('a', now - 1 * DAY)])
  writeFileSync(join(dataDir, 'pricing.json'), '{"schema_version":1,"models":{}}\n')
  writeFileSync(join(dataDir, 'reader.json'), '{"schema_version":1,"command":["claude"]}\n')

  const plan = await planClear(dataDir, { before: null })
  assert.equal(plan.projects[0]?.whole, true)
  // A whole removal counts the manifest's sessions, so an imported project — which has rounds and
  // no state at all — does not report nought of them.
  assert.equal(plan.totals.sessions, 1)

  const done = await applyClear(dataDir, plan)
  assert.equal(done.whole, 1)
  assert.deepEqual(done.removed, ['demo'])
  assert.deepEqual(await listStored(dataDir), [])
  assert.ok(existsSync(join(dataDir, 'pricing.json')), 'the rates went with the projects')
  assert.ok(existsSync(join(dataDir, 'reader.json')), 'the reader went with the projects')
})

test('a plan naming something outside the store cannot reach it', async () => {
  const now = Date.now()
  const dataDir = store([round('a', now - 1 * DAY)])
  const outside = mkdtempSync(join(tmpdir(), 'probez-elsewhere-'))
  writeFileSync(join(outside, 'precious.txt'), 'do not remove me')

  // The slug is the only thing `applyClear` will resolve, and it resolves it the way
  // `removeProject` does: the shape has to be one `slugFor` produces and the path it lands on has
  // to be under `<data-dir>/projects/`.
  const done = await applyClear(dataDir, {
    before: null,
    projects: [
      { slug: '../../../../etc', project: 'x', dir: outside, sessions: 1, ids: [], rounds: 1, bytes: 0, whole: true },
      { slug: 'no such slug!', project: 'y', dir: outside, sessions: 1, ids: [], rounds: 1, bytes: 0, whole: true },
    ],
    totals: { projects: 2, whole: 2, sessions: 2, rounds: 2, bytes: 0 },
  })
  assert.equal(done.projects, 0)
  assert.ok(existsSync(join(outside, 'precious.txt')))
  assert.equal((await listStored(dataDir)).length, 1, 'the real project was touched instead')
})

test('an interrupted trim leaves the rounds it started from', async () => {
  const now = Date.now()
  const dataDir = store([round('old', now - 60 * DAY), round('new', now - 1 * DAY)])
  const dir = projectDirOf(dataDir)
  const before = readFileSync(join(dir, 'rounds.jsonl'), 'utf8')
  // The new file is written beside the old one and moved over it at the end, so a leftover from a
  // run that died part-way is ignored rather than read.
  writeFileSync(join(dir, 'rounds.jsonl.trim'), 'half a rou')
  await applyClear(dataDir, await planClear(dataDir, { before: now - 30 * DAY }))
  const after = readFileSync(join(dir, 'rounds.jsonl'), 'utf8')
  assert.notEqual(after, before)
  assert.equal(after.trim().split('\n').length, 1)
  assert.equal(existsSync(join(dir, 'rounds.jsonl.trim')), false)
})
