import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { useCommandKinds } from '../src/bash.js'
import { labelRounds } from '../src/inspect.js'
import { applyClear, eachRound, importProject, listStored, MERGED_FILE, mergeIntoProject, planClear } from '../src/store.js'
import { exportProject, facetsPayload, forgetRounds, roundPayload } from '../src/viewdata.js'
import { buildIndex } from '../src/searchindex.js'
import { ROUND_DEFAULTS, TOOL_DEFAULTS } from './support.js'
import type { Round } from '../src/types.js'

/**
 * Writes to a project that something else is writing to, and reads that must not pass for empty.
 *
 * Each of these is a way to lose rounds quietly: a rewrite that raced an append, a merge cut short,
 * an unreadable file taken for a missing one.
 */

function store(): string {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'probez-writes-')))
  writeFileSync(join(dataDir, 'identity.json'), JSON.stringify({ name: 'Itay' }))
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
    in_tokens: 1_000,
    out_tokens: 40,
    ...over,
  }
}

async function project(dataDir: string, rounds = [round(), round({ round: 1, id: 'msg_2' })]): Promise<{ slug: string; dir: string }> {
  const { slug } = await importProject(dataDir, 'app', 'app', rounds, 0)
  const dir = (await listStored(dataDir)).find((one) => one.slug === slug)!.dir
  return { slug, dir }
}

const theirs = (): Round[] => [
  round({ session: 's9', id: 'x1', committer: 'Dana' }),
  round({ session: 's9', round: 1, id: 'x2', committer: 'Dana' }),
]

const lineCount = (file: string): number => readFileSync(file, 'utf8').trim().split('\n').length

/** A process that is alive for as long as the test needs it, and whose pid can hold a lock. */
function sleeper(): { pid: number; stop: () => void } {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  return { pid: child.pid!, stop: () => child.kill() }
}

/** The pid of a process that has already exited. */
async function gonePid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((resolve) => child.on('exit', resolve))
  return child.pid!
}

test('a merge waits while another process is writing to the project', async () => {
  const dataDir = store()
  const { slug, dir } = await project(dataDir)
  const other = sleeper()
  try {
    writeFileSync(join(dir, 'write.lock'), String(other.pid))
    let done = false
    const merging = mergeIntoProject(dataDir, slug, theirs(), 0).then((result) => {
      done = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(done, false, 'the merge did not wait for the other writer')
    assert.equal(lineCount(join(dir, 'rounds.jsonl')), 2)

    rmSync(join(dir, 'write.lock'))
    const result = await merging
    assert.equal(result?.added, 2)
    assert.equal(lineCount(join(dir, 'rounds.jsonl')), 4)
    assert.equal(existsSync(join(dir, 'write.lock')), false, 'the merge left its lock behind')
  } finally {
    other.stop()
  }
})

test('a lock left by a process that is gone does not hold anything up', async () => {
  const dataDir = store()
  const { slug, dir } = await project(dataDir)
  writeFileSync(join(dir, 'write.lock'), String(await gonePid()))
  const result = await mergeIntoProject(dataDir, slug, theirs(), 0)
  assert.equal(result?.added, 2)
  assert.equal(existsSync(join(dir, 'write.lock')), false)
})

test('writers racing to take over the same abandoned lock still go one at a time', async () => {
  const dataDir = store()
  const { slug, dir } = await project(dataDir)
  writeFileSync(join(dir, 'write.lock'), String(await gonePid()))
  // Each would rewrite rounds.jsonl from what it read; two at once would leave only one's rounds.
  const merges = ['a', 'b', 'c', 'd'].map((name) =>
    mergeIntoProject(dataDir, slug, [round({ session: `s-${name}`, id: name, committer: 'Dana' })], 0),
  )
  const results = await Promise.all(merges)
  assert.deepEqual(results.map((one) => one?.added), [1, 1, 1, 1])
  assert.equal(lineCount(join(dir, 'rounds.jsonl')), 6)
  assert.equal(lineCount(join(dir, MERGED_FILE)), 4)
  assert.equal(existsSync(join(dir, 'write.lock')), false)
  assert.equal(existsSync(join(dir, 'write.lock.takeover')), false)
})

// The merge writes its copy before the rounds, so this is the state a cut-short merge leaves. The
// other order left the rounds written and the copy not, which merging again could not see to repair.
test('a merge cut short is repaired by merging the same file again', async () => {
  const dataDir = store()
  const { slug, dir } = await project(dataDir)
  await mergeIntoProject(dataDir, slug, theirs(), 0)

  // Where an interruption now leaves it: the copy written, the rounds not yet.
  const rounds = readFileSync(join(dir, 'rounds.jsonl'), 'utf8').trim().split('\n')
  writeFileSync(join(dir, 'rounds.jsonl'), rounds.filter((line) => !line.includes('"s9"')).join('\n') + '\n')
  assert.equal(lineCount(join(dir, MERGED_FILE)), 2)

  const again = await mergeIntoProject(dataDir, slug, theirs(), 0)
  assert.equal(again?.added, 2)
  assert.equal(lineCount(join(dir, 'rounds.jsonl')), 4)
  assert.equal(lineCount(join(dir, MERGED_FILE)), 2)
})

test('a rounds file that cannot be read is not read as an empty one', async () => {
  const dataDir = store()
  const { slug, dir } = await project(dataDir)
  const seen: Round[] = []
  await eachRound(join(dir, 'missing.jsonl'), (one) => seen.push(one))
  assert.equal(seen.length, 0)

  // A directory where the file should be: there, and unreadable.
  rmSync(join(dir, 'rounds.jsonl'))
  mkdirSync(join(dir, 'rounds.jsonl'))
  await assert.rejects(eachRound(join(dir, 'rounds.jsonl'), () => undefined))
  await assert.rejects(mergeIntoProject(dataDir, slug, theirs(), 0))
  await assert.rejects(exportProject(dataDir, slug, 'jsonl'))
})

test('a project with no rounds file exports as an empty one', async () => {
  const dataDir = store()
  const { slug, dir } = await project(dataDir)
  rmSync(join(dir, 'rounds.jsonl'))
  const exported = await exportProject(dataDir, slug, 'jsonl')
  assert.equal(exported.body, '')
})

test('a round is found by its whole session id, never by a subagent that shares its start', async () => {
  const dataDir = store()
  const parent = 'sess-1'
  const child = `${parent}/subagents/agent-a`
  // The subagent's round 0 first, as an incremental collect can leave it.
  const { slug } = await project(dataDir, [
    round({ session: child, id: 'child_0', out_tokens: 1 }),
    round({ session: parent, id: 'parent_0', out_tokens: 2 }),
  ])
  const payload = await roundPayload(dataDir, slug, parent, 0)
  assert.equal(payload.round.id, 'parent_0')
  assert.equal((await roundPayload(dataDir, slug, child, 0)).round.id, 'child_0')
})

test('labels remembered for a round follow a change to the command table', () => {
  const one = round({ tools: [{ ...TOOL_DEFAULTS, name: 'Bash', input: { command: './bin/check callers foo' } }] })
  const kind = (): string => labelRounds([one]).get(one)!.map((label) => `${label.category}/${label.sub}`).join(',')
  useCommandKinds({})
  const before = kind()
  assert.notEqual(before, 'reconstruction/graph')
  useCommandKinds({ check: 'graph' })
  try {
    assert.equal(kind(), 'reconstruction/graph')
  } finally {
    useCommandKinds({})
  }
  assert.equal(kind(), before)
})

test('search suggestions are remembered only until the rounds under them change', async () => {
  const dataDir = store()
  const { slug, dir } = await project(dataDir)
  await buildIndex(dir)
  const models = async (): Promise<string[]> =>
    (await facetsPayload(dataDir, { key: 'model' })).values.map((one) => `${one.value}:${one.rounds}`)
  assert.deepEqual(await models(), ['claude-opus-5:2'])
  assert.deepEqual(await models(), ['claude-opus-5:2'])

  await mergeIntoProject(dataDir, slug, [round({ session: 's9', id: 'x1', committer: 'Dana', model: 'claude-sonnet-5' })], 0)
  // The merge left the index behind the rounds: nothing is offered from it until it is rebuilt.
  assert.deepEqual(await models(), [])
  await buildIndex(dir)
  assert.deepEqual(await models(), ['claude-opus-5:2', 'claude-sonnet-5:1'])

  const unknown = await facetsPayload(dataDir, { key: 'nonsense' })
  assert.deepEqual(unknown.values, [])
})

test('a clear by age spares what arrived after it was planned', async () => {
  const dataDir = store()
  const before = Date.now() - 30 * 86_400_000
  const now = new Date().toISOString()

  // Planned as a whole removal, then a merge brings a round from today.
  const { slug, dir } = await project(dataDir)
  const plan = await planClear(dataDir, { before })
  assert.equal(plan.projects[0]?.whole, true)
  await mergeIntoProject(dataDir, slug, [round({ session: 's9', id: 'x1', committer: 'Dana', ts: now })], 0)

  const done = await applyClear(dataDir, plan)
  assert.equal(done.whole, 0, 'the project went whole despite a round from today')
  const lines = readFileSync(join(dir, 'rounds.jsonl'), 'utf8').trim().split('\n')
  assert.deepEqual(lines.map((line) => (JSON.parse(line) as Round).session), ['s9'])
})

test('a session planned for a trim is kept once it gains a recent round', async () => {
  const dataDir = store()
  const before = Date.now() - 30 * 86_400_000
  const now = new Date().toISOString()
  const { slug, dir } = await project(dataDir, [
    round(),
    round({ round: 1, id: 'msg_2' }),
    round({ session: 's2', id: 'msg_3', ts: now }),
  ])
  const plan = await planClear(dataDir, { before })
  assert.deepEqual(plan.projects[0]?.ids, ['s1'])
  // The sync that was running when the clear was asked for lands a new round in s1.
  await mergeIntoProject(dataDir, slug, [round({ round: 2, id: 'msg_4', committer: 'Dana', ts: now })], 0)

  const done = await applyClear(dataDir, plan)
  assert.equal(done.rounds, 0)
  assert.equal(lineCount(join(dir, 'rounds.jsonl')), 4)
})
