import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * A line of `.git/logs/HEAD`: two hashes, who moved it, when, and why.
 *
 * The name and email between the hashes and the timestamp are free text and may hold spaces, so the
 * timestamp is anchored to the end of the line instead of counted in from the front. The message
 * after the tab is not read: what HEAD pointed at is the fact, not the wording of the move.
 * Hashes are matched at 40 or 64 characters, since a SHA-256 repository writes the longer ones.
 */
const MOVE = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) .* (\d+) [+-]\d{4}$/

/** A line of `git log --format=%H %ct`: one hash and the committer's clock, in whole seconds. */
const COMMIT = /^([0-9a-f]{40,64}) (\d+)$/

/** The all-zero hash git writes for "nothing was here", as before the first commit. */
const NOTHING = /^0+$/

/** How long `git log` is given before its answer stops being worth waiting for. */
const GIT_MS = 5_000

/**
 * Room for the history of a very large repository: one line is about 52 bytes, so this holds a
 * little over half a million commits. Past that the read fails and there is simply no timeline,
 * which is the same answer as a repository nobody can read.
 */
const GIT_BYTES = 32 * 1024 * 1024

/**
 * The last entry at or before a moment, in an ascending list of times, or -1 when the moment is
 * older than all of them. Shared by both sources below, which ask the same question of different
 * evidence.
 */
function lastAtOrBefore(when: number[], ms: number): number {
  let low = 0
  let high = when.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (when[mid]! <= ms) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return found
}

/**
 * Where HEAD pointed, from whichever evidence can say.
 *
 * The reflog first, because it is a record rather than an inference; the commit history only for
 * moments the reflog does not reach; and null when neither can say, which is an ordinary answer
 * rather than a failure. A wrong hash is worse than no hash: it reads as a fact about where work
 * started, and there is nothing in the record afterwards to mark it as a guess.
 */
export interface HeadHistory {
  /** The reflog an answer may have come from, empty when there was none to read. */
  file: string
  /** How many moves that reflog held. */
  moves: number
  /** How many commits the history behind it held, zero when it was never read. */
  commits: number
  /** The commit HEAD pointed at at that moment, or null when neither source can say. */
  at(ms: number | null): string | null
}

/**
 * Where HEAD pointed, moment by moment, as this clone recorded it.
 *
 * git's HEAD reflog is a single plain-text file listing every commit, checkout, merge and reset
 * with the second it happened. It is the exact answer where it reaches, because it is a record of
 * HEAD itself rather than an inference about it — but it reaches only so far. It covers this clone
 * and no other, so a fresh clone holds one line; and git expires it, at 90 days by default, so an
 * old task can fall off the front of a log that is still being written to.
 */
export interface HeadLog extends HeadHistory {
  /**
   * Whether the log still reaches back to the repository's first commit.
   *
   * True when the oldest line it holds came from the all-zero hash, which is git for "nothing was
   * here". Such a log can answer for every moment the repository has existed, and nothing else
   * needs to be consulted for it — which is how probez avoids starting `git` on most repositories.
   */
  complete: boolean
}

/**
 * When each commit was made, which is a weaker claim than the reflog's and a longer-lived one.
 *
 * The commit history says what existed by a moment, not what HEAD was pointing at, so it answers by
 * inference: the newest commit that had been made by then is where the work most likely started.
 * Two things make that an approximation rather than a fact, and both are worth knowing before
 * trusting a hash it produced. It is read along `--first-parent` from the current HEAD, so a task
 * done on a branch since deleted is dated against the line that survived rather than the one it ran
 * on. And a committer date is rewritten by a rebase or an amend, so a history that has been
 * replayed dates every task after the replay, not the work.
 *
 * It is consulted only where the reflog cannot reach.
 */
export interface CommitTimeline {
  /** How many commits it holds. */
  commits: number
  /** The newest commit made at or before that moment, or null when every commit is newer. */
  at(ms: number | null): string | null
}

/**
 * Read a reflog that is already in hand, which is also how this is tested without a repository.
 *
 * Entries are kept in file order rather than sorted. A reflog is append-only and git stamps each
 * line with the clock at the time, so file order is time order; a machine whose clock went
 * backwards mid-session would leave a log where the later line is still the later move, and taking
 * the file at its word is the reading that survives that.
 */
export function parseHeadLog(text: string, file = ''): HeadLog | null {
  const when: number[] = []
  const to: string[] = []
  /** Whether the oldest move still held is the one that created the repository. */
  let complete = false

  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t')
    const move = MOVE.exec(tab === -1 ? line : line.slice(0, tab))
    if (move === null) continue
    const at = Number(move[3]) * 1000
    if (!Number.isFinite(at)) continue
    if (when.length === 0) complete = NOTHING.test(move[1]!)
    when.push(at)
    to.push(move[2]!)
  }

  if (when.length === 0) return null

  return {
    file,
    moves: when.length,
    commits: 0,
    complete,
    at(ms) {
      if (ms === null) return null
      // The last move at or before the moment asked about: HEAD stayed where that move put it
      // until the next one.
      const found = lastAtOrBefore(when, ms)
      // Older than every move the log still holds. What HEAD pointed at then is a thing this file
      // does not record — the line that would have said so has expired, or was never written into
      // this clone — so it is not answered from here.
      return found === -1 ? null : to[found]!
    },
  }
}

/**
 * Read the output of `git log --format=%H %ct`, newest commit first.
 *
 * Sorted by time rather than kept in the order git printed. Reverse-chronological is what `git log`
 * means by order, but committer dates are not guaranteed to descend with it: a rebase restamps
 * them, and a machine whose clock was wrong writes whatever it believed. The search below needs
 * ascending time to be correct, so it is made ascending here rather than assumed.
 */
export function parseCommitLog(text: string): CommitTimeline | null {
  const made: { ms: number; hash: string }[] = []

  for (const line of text.split('\n')) {
    const commit = COMMIT.exec(line.trim())
    if (commit === null) continue
    const at = Number(commit[2]) * 1000
    if (!Number.isFinite(at)) continue
    made.push({ ms: at, hash: commit[1]! })
  }

  if (made.length === 0) return null
  made.sort((a, b) => a.ms - b.ms)
  const when = made.map((commit) => commit.ms)
  const to = made.map((commit) => commit.hash)

  return {
    commits: when.length,
    at(ms) {
      if (ms === null) return null
      const found = lastAtOrBefore(when, ms)
      // Older than every commit in the repository: there was no tree to start from yet.
      return found === -1 ? null : to[found]!
    },
  }
}

/**
 * The commit history of the repository at a path, or null when there is not one to be had.
 *
 * This is the one place probez starts `git`, and it is a read: `log` with a format, no pager, no
 * locks, and nothing written. It runs only when the reflog cannot cover the repository on its own
 * — see `readHeadHistory` — which on a repository that still holds its own first commit is never.
 *
 * The command is argv and is spawned with no shell, so a path with a space, a quote or a `$(…)` in
 * it is a path. `-C` takes the directory that follows it as a directory whatever it looks like, so
 * a project directory named like a flag cannot become one.
 *
 * Every failure is null: no git on the machine, a path that is not a repository, a non-zero exit, a
 * history too large for the buffer, a command that took too long. None of them are reasons to stop
 * collecting sessions, which is what the command was actually asked to do, and probez works the
 * same on a machine with no git installed as it did before this read existed.
 */
export async function readCommitLog(root: string): Promise<CommitTimeline | null> {
  const out = await run(
    'git',
    ['-C', root, '--no-pager', 'log', '--first-parent', '--format=%H %ct', 'HEAD'],
    {
      timeout: GIT_MS,
      maxBuffer: GIT_BYTES,
      encoding: 'utf8',
      // `GIT_OPTIONAL_LOCKS=0` keeps a read from taking the index lock, so collecting cannot
      // interrupt whatever the person is doing in that checkout. `GIT_TERMINAL_PROMPT=0` means a
      // repository configured to ask for something fails instead of waiting on an answer that is
      // never coming.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    },
  ).catch(() => null)
  return out === null ? null : parseCommitLog(out.stdout)
}

/**
 * The git directory governing a path, walking up the way git itself does.
 *
 * `.git` is a directory in a normal checkout and a file holding `gitdir: <path>` in a worktree or a
 * submodule. Following the pointer is what makes a worktree report its own HEAD rather than the
 * main checkout's, which are different commits and the whole point of having one.
 */
async function gitDir(start: string): Promise<string | null> {
  let dir = resolve(start)
  for (;;) {
    const dot = join(dir, '.git')
    const info = await stat(dot).catch(() => null)
    if (info?.isDirectory() === true) return dot
    if (info?.isFile() === true) {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dot, 'utf8').catch(() => ''))
      if (pointer === null) return null
      const target = pointer[1]!
      return isAbsolute(target) ? target : resolve(dir, target)
    }
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/**
 * The HEAD history of the repository a project sits in, or null when it does not sit in one.
 *
 * Read once per collect and asked about per round, rather than re-read: the reflog is a small file,
 * and the history behind it costs a process, so one read of each is one thing to say about what
 * probez opened.
 *
 * The reflog is read first and on its own terms. A reflog that still holds the repository's first
 * commit can answer for every moment that repository has existed, so nothing else is consulted and
 * no `git` process starts — which is the usual case, and the reason this stays a read of one text
 * file for most projects. It is only a log that has been expired, or a clone that arrived with one
 * line in it, that leaves moments unaccounted for, and only then is the commit history asked.
 *
 * Every failure is null. A directory that is not a repository, a repository with reflogs turned
 * off, a path that no longer exists, a file that cannot be read, a `git` that is not installed —
 * none of them are reasons to stop collecting sessions.
 */
export async function readHeadHistory(root: string | null): Promise<HeadHistory | null> {
  if (root === null || root === '') return null
  const dir = await gitDir(root)
  if (dir === null) return null

  const file = join(dir, 'logs', 'HEAD')
  const text = await readFile(file, 'utf8').catch(() => null)
  const reflog = text === null ? null : parseHeadLog(text, file)

  // Nothing the history could add: the log covers the repository from its first commit onward.
  const timeline = reflog?.complete === true ? null : await readCommitLog(root)
  if (reflog === null && timeline === null) return null

  return {
    file: reflog?.file ?? '',
    moves: reflog?.moves ?? 0,
    commits: timeline?.commits ?? 0,
    at(ms) {
      return reflog?.at(ms) ?? timeline?.at(ms) ?? null
    },
  }
}
