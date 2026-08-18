import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * A line of `.git/logs/HEAD`: two hashes, who moved it, when, and why.
 *
 * The name and email between the hashes and the timestamp are free text and may hold spaces, so the
 * timestamp is anchored to the end of the line instead of counted in from the front. The message
 * after the tab is not read: what HEAD pointed at is the fact, not the wording of the move.
 * Hashes are matched at 40 or 64 characters, since a SHA-256 repository writes the longer ones.
 */
const MOVE = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) .* (\d+) [+-]\d{4}$/

/** The all-zero hash git writes for "nothing was here", as before the first commit. */
const NOTHING = /^0+$/

/**
 * Where HEAD pointed, moment by moment.
 *
 * This is the one thing probez reads outside the agent's session files, and it is a read of a
 * single plain-text file: git's HEAD reflog, which records every commit, checkout, merge and reset
 * with the second it happened. Nothing is executed — there is no `git` subprocess here, and probez
 * works the same on a machine that has no git installed.
 */
export interface HeadHistory {
  /** The reflog this was read from, so an answer can say where it came from. */
  file: string
  /** How many moves it holds. */
  moves: number
  /**
   * The commit HEAD pointed at at that moment, or null when the reflog cannot say.
   *
   * Cannot say has three shapes, and they are all reported the same way because a wrong hash is
   * worse than none: the moment is before the repository's first commit, the reflog has been
   * expired past it (git prunes at 90 days by default), or there is no timestamp to ask about.
   */
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
export function parseHeadLog(text: string, file = ''): HeadHistory | null {
  const when: number[] = []
  const to: string[] = []
  /** What HEAD pointed at before the oldest move the log still holds. */
  let before: string | null = null

  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t')
    const move = MOVE.exec(tab === -1 ? line : line.slice(0, tab))
    if (move === null) continue
    const at = Number(move[3]) * 1000
    if (!Number.isFinite(at)) continue
    if (when.length === 0) before = NOTHING.test(move[1]!) ? null : move[1]!
    when.push(at)
    to.push(move[2]!)
  }

  if (when.length === 0) return null

  return {
    file,
    moves: when.length,
    at(ms) {
      if (ms === null) return null
      // The last move at or before the moment asked about: HEAD stayed where that move put it
      // until the next one. Binary search, because this is asked once per round.
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
      return found === -1 ? before : to[found]!
    },
  }
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
 * Read once per collect and asked about per round, rather than re-read: the file is small, and one
 * read is one thing to say about what probez opened.
 *
 * Every failure is null. A directory that is not a repository, a repository with reflogs turned
 * off, a path that no longer exists, a file that cannot be read — none of them are reasons to stop
 * collecting sessions, which is what the command was actually asked to do.
 */
export async function readHeadHistory(root: string | null): Promise<HeadHistory | null> {
  if (root === null || root === '') return null
  const dir = await gitDir(root)
  if (dir === null) return null
  const file = join(dir, 'logs', 'HEAD')
  const text = await readFile(file, 'utf8').catch(() => null)
  return text === null ? null : parseHeadLog(text, file)
}
