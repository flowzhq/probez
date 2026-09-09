import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { parseCommitLog, parseHeadLog, readCommitLog, readHeadHistory } from '../src/git.js'

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

test('before the oldest move kept there is nothing the reflog can say', () => {
  // What a pruned reflog looks like: the initial commit's line has expired away. HEAD was on
  // something at 1500, and this file no longer records what — which is not the same as it having
  // been on the hash the oldest surviving line happens to have come from.
  const head = parseHeadLog(LOG.split('\n').slice(1).join('\n'))
  assert.equal(head?.at(at(1500)), null)
})

test('a log is complete only when it still holds the repository first commit', () => {
  assert.equal(parseHeadLog(LOG)?.complete, true)
  assert.equal(parseHeadLog(LOG.split('\n').slice(1).join('\n'))?.complete, false)
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

/** `git log --format=%H %ct` output: newest commit first, as git prints it. */
const HISTORY = [`${C} 3000`, `${B} 2000`, `${A} 1000`, ''].join('\n')

test('a moment resolves to the newest commit that had been made by then', () => {
  const made = parseCommitLog(HISTORY)
  assert.ok(made)
  assert.equal(made.commits, 3)
  assert.equal(made.at(at(2000)), B)
  assert.equal(made.at(at(2999)), B)
  assert.equal(made.at(at(3000)), C)
  assert.equal(made.at(at(99999)), C)
})

test('before the first commit there was no tree to start from', () => {
  assert.equal(parseCommitLog(HISTORY)?.at(at(999)), null)
})

test('a commit with no timestamp to place it gets no commit rather than a guess', () => {
  assert.equal(parseCommitLog(HISTORY)?.at(null), null)
})

test('committer dates are ordered by time, not by the order git printed them', () => {
  // What a rebase leaves: the newest commit carries the oldest committer date.
  const made = parseCommitLog([`${C} 1000`, `${B} 3000`, `${A} 2000`].join('\n'))
  assert.equal(made?.at(at(1000)), C)
  assert.equal(made?.at(at(2000)), A)
  assert.equal(made?.at(at(3000)), B)
})

test('sha-256 commits are read at their own length', () => {
  const long = 'e'.repeat(64)
  assert.equal(parseCommitLog(`${long} 500`)?.at(at(500)), long)
})

test('a history with nothing parseable is no timeline at all', () => {
  assert.equal(parseCommitLog(''), null)
  assert.equal(parseCommitLog('fatal: not a git repository\n'), null)
})

/** Whether this machine has a git to run, since the reads below are of a real repository. */
const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** A repository with three commits an hour apart, at the seconds this file has been using. */
function repoWithHistory(): { root: string; hashes: string[] } {
  const root = scratch()
  const git = (args: string[], unix?: number): string =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'X',
        GIT_AUTHOR_EMAIL: 'x@example.com',
        GIT_COMMITTER_NAME: 'X',
        GIT_COMMITTER_EMAIL: 'x@example.com',
        ...(unix === undefined
          ? {}
          : { GIT_AUTHOR_DATE: `@${unix} +0000`, GIT_COMMITTER_DATE: `@${unix} +0000` }),
      },
    })

  git(['init', '-q'])
  const hashes: string[] = []
  for (const [i, unix] of [1000, 2000, 3000].entries()) {
    writeFileSync(join(root, 'file.txt'), `${i}\n`)
    git(['add', 'file.txt'])
    git(['commit', '-q', '-m', `commit ${i}`], unix)
    hashes.push(git(['rev-parse', 'HEAD']).trim())
  }
  return { root, hashes }
}

test('a repository that is not one, and a path that is not there, have no timeline', { skip: !hasGit }, async () => {
  assert.equal(await readCommitLog(scratch()), null)
  assert.equal(await readCommitLog(join(scratch(), 'nowhere')), null)
})

test('a pruned reflog is answered from the commit history behind it', { skip: !hasGit }, async () => {
  const { root, hashes } = repoWithHistory()
  const reflog = join(root, '.git', 'logs', 'HEAD')
  // Expire the log down to its last move, which is what git does at 90 days. The moments before it
  // are now outside anything the reflog records.
  const last = readFileSync(reflog, 'utf8').split('\n').filter(Boolean).at(-1)!
  writeFileSync(reflog, `${last}\n`)

  const head = await readHeadHistory(root)
  assert.ok(head)
  assert.equal(head.moves, 1)
  assert.equal(head.commits, 3)
  // The reflog cannot reach these; the history can.
  assert.equal(head.at(at(1500)), hashes[0])
  assert.equal(head.at(at(2500)), hashes[1])
  // Older than the repository itself is still nobody's answer.
  assert.equal(head.at(at(500)), null)
})

test('a reflog that reaches the first commit is never asked to run git', { skip: !hasGit }, async () => {
  const { root } = repoWithHistory()
  const head = await readHeadHistory(root)
  assert.ok(head)
  // `commits` is zero because the history was never read: the reflog covers the repository whole.
  assert.equal(head.commits, 0)
  assert.equal(head.at(at(500)), null)
})

test('the reflog answers even where the history would say something else', () => {
  // A checkout moves HEAD backwards; the commit history knows nothing of that and would name the
  // newest commit instead. What HEAD actually pointed at is the reflog's to say.
  const head = parseHeadLog(LOG)
  assert.equal(head?.at(at(3500)), C)
  assert.equal(parseCommitLog(HISTORY)?.at(at(3500)), C)
})
