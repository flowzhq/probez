import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { mock, test } from 'node:test'

import { useCommandKinds } from '../src/bash.js'
import { labelRounds } from '../src/inspect.js'
import { applyClear, eachRound, eachRoundLine, importProject, listStored, MERGED_FILE, mergeIntoProject, planClear, removeProject, withProjectLock, writeAnalysis } from '../src/store.js'
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
  await eachRound(join(dir, 'missing.jsonl'), (one) => {
    seen.push(one)
  })
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

test('a cache waits for whoever holds the project, and does not bring back a project they deleted', async () => {
  const dataDir = store()
  const { dir } = await project(dataDir)
  const other = sleeper()
  try {
    writeFileSync(join(dir, 'write.lock'), String(other.pid))
    let done = false
    const writing = Promise.all([
      writeAnalysis(join(dir, 'analysis.jsonl'), { rounds: 2, toolless: 0 }, []),
      buildIndex(dir),
    ]).then((result) => {
      done = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(done, false, 'the caches were written under another writer')

    // The other writer was a delete. What a sync or a collect computed before it is now about a
    // project that is not there, and writing it would bring the folder back holding only caches.
    rmSync(dir, { recursive: true, force: true })
    const [, index] = await writing
    assert.equal(index, null)
    assert.equal(existsSync(dir), false, 'the deleted project came back')
  } finally {
    other.stop()
  }
})

test('a project being removed is gone to anyone waiting on it, and leaves nothing behind', async () => {
  const dataDir = store()
  const { slug, dir } = await project(dataDir)
  // A merge queued behind the delete finds no project, rather than a lock inside a folder that is
  // still being deleted. Whichever goes first, the project ends up gone and nothing is half there.
  const [removed] = await Promise.all([removeProject(dataDir, slug), mergeIntoProject(dataDir, slug, theirs(), 0)])
  assert.equal(removed?.slug, slug)
  assert.equal(existsSync(dir), false)
  assert.deepEqual(readdirSync(join(dataDir, 'projects')), [], 'the folder moved aside was deleted too')

  // One a crash left mid-delete is never taken for a project, readable or not.
  mkdirSync(join(dataDir, 'projects', `.removing-${slug}-left`), { recursive: true })
  assert.deepEqual(await listStored(dataDir), [])
  assert.deepEqual((await planClear(dataDir)).projects, [])
})

test('a writer lets go of its own lock only, not one taken after its project was moved away', async () => {
  const dataDir = store()
  const { dir } = await project(dataDir)
  const other = sleeper()
  try {
    // What a delete does under the lock, with a collect waiting on the project: the folder goes
    // aside with this lock in it, and the collect makes the folder again and takes a lock there.
    await withProjectLock(dir, async () => {
      renameSync(dir, `${dir}-aside`)
      mkdirSync(dir)
      writeFileSync(join(dir, 'write.lock'), String(other.pid))
    })
    assert.equal(readFileSync(join(dir, 'write.lock'), 'utf8'), String(other.pid), 'the collect lost its lock')
    // And the lock that went aside was the one this writer made, which it leaves where it went.
    assert.equal(readFileSync(join(`${dir}-aside`, 'write.lock'), 'utf8'), String(process.pid))
  } finally {
    other.stop()
  }

  // Its own lock it does let go of, so the next writer is not kept waiting.
  const { dir: next } = await project(store())
  await withProjectLock(next, async () => assert.equal(existsSync(join(next, 'write.lock')), true))
  assert.equal(existsSync(join(next, 'write.lock')), false)
})

test('what a removal cut short left behind is taken by the next removal, or the next clear', async () => {
  const dataDir = store()
  const projects = join(dataDir, 'projects')
  const leftover = (name: string): string => {
    const at = join(projects, `.removing-${name}`)
    mkdirSync(join(at, 'sessions'), { recursive: true })
    writeFileSync(join(at, 'rounds.jsonl'), 'x'.repeat(4096))
    return at
  }
  const { slug } = await project(dataDir)
  const first = leftover('one')
  await removeProject(dataDir, slug)
  assert.equal(existsSync(first), false, 'a delete left the last one in place')

  const second = leftover('two')
  const { slug: kept } = await project(dataDir, [round({ ts: new Date().toISOString() })])
  await applyClear(dataDir, await planClear(dataDir, { before: Date.now() - 86_400_000 }))
  assert.equal(existsSync(second), false, 'a clear left it in place')
  // A clear that removes nothing still sweeps, and the project it spared is still there.
  assert.deepEqual((await listStored(dataDir)).map((one) => one.slug), [kept])
})

test('a trim that cannot write fails that project, and leaves it and nothing else behind', async () => {
  const dataDir = store()
  const before = Date.now() - 30 * 86_400_000
  const now = new Date().toISOString()
  // More kept rounds than one batch, so the write that fails is one made while still reading.
  const recent = Array.from({ length: 2_500 }, (_, at) => round({ session: 's2', round: at, id: `k${at}`, ts: now }))
  const { dir } = await project(dataDir, [round(), ...recent])
  const original = readFileSync(join(dir, 'rounds.jsonl'), 'utf8')
  const plan = await planClear(dataDir, { before })
  assert.deepEqual(plan.projects[0]?.ids, ['s1'])

  const undo = diskFullFor('.trim')
  try {
    // A rejection nobody was waiting on would end the process here rather than fail this. Caught,
    // it is the project's failure, reported by name, and not the whole clear's.
    const done = await applyClear(dataDir, plan)
    assert.deepEqual(done.failed, [{ project: 'app', error: 'no space left on device' }])
    assert.equal(done.projects, 0)
  } finally {
    undo()
  }
  assert.equal(readFileSync(join(dir, 'rounds.jsonl'), 'utf8'), original)
  assert.equal(existsSync(join(dir, 'rounds.jsonl.trim')), false, 'the half-written copy was left behind')
  assert.equal(existsSync(join(dir, 'write.lock')), false, 'the lock was not let go')
})

test('a project someone else is still writing is passed over, and the clear goes on and says so', async () => {
  const dataDir = store()
  const first = await project(dataDir)
  const { slug: second } = await importProject(dataDir, 'api', 'api', [round({ session: 's5', id: 'm5' })], 0)
  const plan = await planClear(dataDir, { before: null })
  assert.equal(plan.projects.length, 2)

  const other = sleeper()
  try {
    writeFileSync(join(first.dir, 'write.lock'), String(other.pid))
    // Gives up at once on the held project, the way the real wait does once it runs out.
    const done = await applyClear(dataDir, plan, (slug, work) =>
      slug === first.slug ? withProjectLock(first.dir, work, false, 0) : work(),
    )
    assert.deepEqual(done.locked, ['app'])
    assert.deepEqual(done.removed, ['api'])
    assert.deepEqual((await listStored(dataDir)).map((one) => one.slug), [first.slug])
    assert.equal((await listStored(dataDir)).some((one) => one.slug === second), false)
  } finally {
    other.stop()
  }
})

/** `appendFile` failing as a full disk does, for files whose name ends with `suffix`, until undone. */
function diskFullFor(suffix: string): () => void {
  const real = fsp.appendFile
  const full = mock.method(fsp, 'appendFile', (async (file: Parameters<typeof real>[0], ...rest: unknown[]) => {
    if (String(file).endsWith(suffix)) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
    return (real as (...args: unknown[]) => Promise<void>)(file, ...rest)
  }) as typeof real)
  syncBuiltinESMExports()
  return () => {
    full.mock.restore()
    syncBuiltinESMExports()
  }
}

test('a line visitor that fails stops the read and is thrown as it is, not taken for a missing file', async () => {
  const dataDir = store()
  const { dir } = await project(dataDir)
  const seen: number[] = []
  const missing = Object.assign(new Error('gone'), { code: 'ENOENT' })
  await assert.rejects(
    eachRoundLine(join(dir, 'rounds.jsonl'), async (at) => {
      seen.push(at)
      throw missing
    }),
    (error) => error === missing,
  )
  assert.deepEqual(seen, [0], 'the read went on past the failure')
})

test('a merge that cannot write leaves the project as it was, and no copy beside it', async () => {
  const dataDir = store()
  const before = Date.now()
  const recent = Array.from({ length: 2_500 }, (_, at) => round({ round: at, id: `k${at}`, ts: new Date(before).toISOString() }))
  const { slug, dir } = await project(dataDir, recent)
  const original = readFileSync(join(dir, 'rounds.jsonl'), 'utf8')

  const undo = diskFullFor('.merge')
  try {
    await assert.rejects(mergeIntoProject(dataDir, slug, theirs(), 0), { code: 'ENOSPC' })
  } finally {
    undo()
  }
  assert.equal(readFileSync(join(dir, 'rounds.jsonl'), 'utf8'), original)
  assert.equal(existsSync(join(dir, 'rounds.jsonl.merge')), false, 'the half-written copy was left behind')
  assert.equal(existsSync(join(dir, 'write.lock')), false, 'the lock was not let go')
  // And the same merge goes through once there is room again.
  const merged = await mergeIntoProject(dataDir, slug, theirs(), 0)
  assert.equal(merged?.added, 2)
})

test('a re-import waits while another process is writing to the project, and then replaces it whole', async () => {
  const dataDir = store()
  const { slug, dir } = await project(dataDir)
  const other = sleeper()
  try {
    writeFileSync(join(dir, 'write.lock'), String(other.pid))
    let done = false
    const importing = importProject(dataDir, 'app', 'app', [round({ session: 's7', id: 'n1' })], 0).then((result) => {
      done = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(done, false, 'the import did not wait for the other writer')
    assert.equal(lineCount(join(dir, 'rounds.jsonl')), 2)

    rmSync(join(dir, 'write.lock'))
    const result = await importing
    assert.equal(result.slug, slug)
    assert.equal(result.replaced, true)
    assert.equal(lineCount(join(dir, 'rounds.jsonl')), 1)
    assert.equal((JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { rounds: number }).rounds, 1)
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith('.import') || name === 'write.lock'),
      [],
      'a copy or the lock was left behind',
    )
  } finally {
    other.stop()
  }
})

/** `writeFile` failing as a full disk does, for files whose name ends with `suffix`, until undone. */
function writesFailFor(suffix: string): () => void {
  const real = fsp.writeFile
  const full = mock.method(fsp, 'writeFile', (async (file: Parameters<typeof real>[0], ...rest: unknown[]) => {
    if (String(file).endsWith(suffix)) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
    return (real as (...args: unknown[]) => Promise<void>)(file, ...rest)
  }) as typeof real)
  syncBuiltinESMExports()
  return () => {
    full.mock.restore()
    syncBuiltinESMExports()
  }
}

test('an import cut short while writing leaves the project it was replacing exactly as it was', async () => {
  const dataDir = store()
  const { dir } = await project(dataDir)
  const rounds = readFileSync(join(dir, 'rounds.jsonl'), 'utf8')
  const manifest = readFileSync(join(dir, 'manifest.json'), 'utf8')

  // The manifest is the second file written: the rounds beside it are already complete, and
  // still must not be moved over the old ones until it is too.
  const undo = writesFailFor('manifest.json.import')
  try {
    await assert.rejects(importProject(dataDir, 'app', 'app', [round({ session: 's7', id: 'n1' })], 0), {
      code: 'ENOSPC',
    })
  } finally {
    undo()
  }
  assert.equal(readFileSync(join(dir, 'rounds.jsonl'), 'utf8'), rounds)
  assert.equal(readFileSync(join(dir, 'manifest.json'), 'utf8'), manifest)
  assert.equal(existsSync(join(dir, 'write.lock')), false, 'the lock was not let go')
  assert.equal((await listStored(dataDir)).length, 1)

  // And the same import goes through once there is room, with nothing of the failed one in the way.
  const result = await importProject(dataDir, 'app', 'app', [round({ session: 's7', id: 'n1' })], 0)
  assert.equal(result.rounds, 1)
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.import')), [])
})

test('a project that fails to clear for any reason is reported by name, and the rest of the clear goes on', async () => {
  const dataDir = store()
  const first = await project(dataDir)
  const { slug: second } = await importProject(dataDir, 'api', 'api', [round({ session: 's5', id: 'm5' })], 0)
  const plan = await planClear(dataDir, { before: null })
  assert.equal(plan.projects.length, 2)

  // A file another program holds open, as Windows reports it, on the first project only.
  const done = await applyClear(dataDir, plan, (slug, work) =>
    slug === first.slug
      ? Promise.reject(Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${first.dir}'`), { code: 'EBUSY' }))
      : work(),
  )
  assert.deepEqual(done.failed, [{ project: 'app', error: `EBUSY: resource busy or locked, rmdir '${first.dir}'` }])
  assert.deepEqual(done.locked, [])
  assert.deepEqual(done.removed, ['api'])
  assert.equal(done.projects, 1)
  const left = (await listStored(dataDir)).map((one) => one.slug)
  assert.deepEqual(left, [first.slug])
  assert.equal(left.includes(second), false)
})
