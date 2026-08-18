import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { parseHeadLog, readHeadHistory } from '../src/git.js'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const ZERO = '0'.repeat(40)

/** Seconds since the epoch, as git writes them. */
const at = (unix: number): number => unix * 1000

/** A reflog with three moves, an hour apart, starting from an empty repository. */
const LOG = [
  `${ZERO} ${A} Someone Else <who@example.com> 1000 +0300\tcommit (initial): first`,
  `${A} ${B} Someone Else <who@example.com> 2000 +0300\tcommit: second`,
  `${B} ${C} Someone Else <who@example.com> 3000 -0800\tcheckout: moving from main to work`,
  '',
].join('\n')

test('a moment resolves to the commit HEAD was on then, not the next one', () => {
  const head = parseHeadLog(LOG)
  assert.ok(head)
  assert.equal(head.moves, 3)
  // On the second at 2000, and still on it at 2999.
  assert.equal(head.at(at(2000)), B)
  assert.equal(head.at(at(2999)), B)
  assert.equal(head.at(at(3000)), C)
})

test('after the last move HEAD is still where it was left', () => {
  const head = parseHeadLog(LOG)
  assert.equal(head?.at(at(99999)), C)
})

test('before the first commit there is no commit to name', () => {
  // The oldest move came from the all-zero hash, which is git for "nothing was here".
  const head = parseHeadLog(LOG)
  assert.equal(head?.at(at(1)), null)
})

test('before the oldest move kept, HEAD was whatever that move came from', () => {
  // What a pruned reflog looks like: the initial commit's line has expired away.
  const head = parseHeadLog(LOG.split('\n').slice(1).join('\n'))
  assert.equal(head?.at(at(1500)), A)
})

test('a round with no timestamp gets no commit rather than a guess', () => {
  assert.equal(parseHeadLog(LOG)?.at(null), null)
})

test('names with spaces do not shift the timestamp', () => {
  const head = parseHeadLog(`${ZERO} ${A} A Person With Names <a b@example.com> 1000 +0000\tcommit: x`)
  assert.equal(head?.at(at(1000)), A)
})

test('sha-256 hashes are read at their own length', () => {
  const long = 'f'.repeat(64)
  const head = parseHeadLog(`${'0'.repeat(64)} ${long} X <x@example.com> 500 +0000\tcommit: x`)
  assert.equal(head?.at(at(500)), long)
})

test('a log with nothing parseable is no history at all', () => {
  assert.equal(parseHeadLog(''), null)
  assert.equal(parseHeadLog('not a reflog\nnor this one\n'), null)
})

const scratch = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'probez-git-')))

test('a checkout is found by walking up from a subdirectory', async () => {
  const root = scratch()
  mkdirSync(join(root, '.git', 'logs'), { recursive: true })
  writeFileSync(join(root, '.git', 'logs', 'HEAD'), LOG)
  const deep = join(root, 'src', 'nested')
  mkdirSync(deep, { recursive: true })

  const head = await readHeadHistory(deep)
  assert.equal(head?.at(at(2500)), B)
  assert.equal(head?.file, join(root, '.git', 'logs', 'HEAD'))
})

test('a worktree reports its own HEAD, not the main checkout it points at', async () => {
  const root = scratch()
  const real = join(root, 'main', '.git', 'worktrees', 'side')
  mkdirSync(join(real, 'logs'), { recursive: true })
  writeFileSync(join(real, 'logs', 'HEAD'), `${A} ${C} X <x@example.com> 4000 +0000\tcheckout: side`)
  const tree = join(root, 'side')
  mkdirSync(tree, { recursive: true })
  writeFileSync(join(tree, '.git'), `gitdir: ${real}\n`)

  const head = await readHeadHistory(tree)
  assert.equal(head?.at(at(5000)), C)
})

test('no repository, no reflog and no path are all the same answer', async () => {
  assert.equal(await readHeadHistory(null), null)
  assert.equal(await readHeadHistory(''), null)
  // A directory under the system temp root, which is not a checkout.
  assert.equal(await readHeadHistory(scratch()), null)

  // A repository that keeps no HEAD reflog, which is what `core.logAllRefUpdates=false` leaves.
  const bare = scratch()
  mkdirSync(join(bare, '.git'), { recursive: true })
  assert.equal(await readHeadHistory(bare), null)
})
