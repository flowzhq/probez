import { userInfo } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

import { readGitUserName } from './git.js'
import { cleanCommitter } from './import.js'
import type { Round } from './types.js'

export { cleanCommitter, MAX_COMMITTER } from './import.js'

/**
 * Who this machine's rounds belong to.
 *
 * A round collected here carries no name: it is this machine's, and the name is decided when it is
 * read or exported. That keeps every store written before this existed correct without a rebuild,
 * and lets the name be changed in Settings without rewriting a byte of the rounds.
 *
 * The name is the one typed in Settings, kept in `identity.json` beside the rates; failing that,
 * git's `user.name`, which is what most people already answer to in a commit; failing that, the
 * account name.
 */

export function identityFile(dataDir: string): string {
  return join(dataDir, 'identity.json')
}

/** The name typed in Settings, or null when nothing has been. */
export async function readChosenCommitter(dataDir: string): Promise<string | null> {
  try {
    const body = JSON.parse(await readFile(identityFile(dataDir), 'utf8')) as { name?: unknown }
    const name = cleanCommitter(body.name)
    return name === '' ? null : name
  } catch {
    return null
  }
}

/** Read once per run: git is a process to start, and the answer does not change while serving. */
let guessed: Promise<string> | null = null

async function guessCommitter(): Promise<string> {
  // Asked of git through `git.ts`, the one file here that may start it.
  const fromGit = cleanCommitter(await readGitUserName())
  if (fromGit !== '') return fromGit
  try {
    const name = cleanCommitter(userInfo().username)
    if (name !== '') return name
  } catch {
    // an account with no entry in the password database
  }
  return 'me'
}

/** Who this machine's own rounds are recorded as. */
export async function readCommitter(dataDir: string): Promise<string> {
  const chosen = await readChosenCommitter(dataDir)
  if (chosen !== null) return chosen
  guessed ??= guessCommitter()
  return guessed
}

/** Set the name, or clear it with an empty one so the guess comes back. */
export async function writeCommitter(dataDir: string, name: string): Promise<string> {
  const file = identityFile(dataDir)
  const target = `${file}.write`
  const clean = cleanCommitter(name)
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  await writeFile(target, JSON.stringify({ name: clean === '' ? null : clean }, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(target, file)
  return readCommitter(dataDir)
}

/** Who recorded a round: the name it carries, or this machine's when it carries none. */
export function committerOf(round: Round, local: string): string {
  return round.committer ?? local
}
