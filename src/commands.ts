/**
 * Command names this machine knows and probez does not.
 *
 * `bash.ts` ships a table of commands general enough to mean the same thing on anybody's machine:
 * `grep` is a search wherever it runs. A repository's own script is not like that. probez only ever
 * sees a command's last path segment, so a repository's own `bin/check` is recorded as `check` —
 * a name far too generic for a shared table, where it would silently relabel every unrelated
 * `check` on every other machine. The alternative to naming it here is leaving it in `other`, which is what probez
 * did before this file existed and is still what happens when nobody names it.
 *
 * So this is the local half of that table: a file beside `pricing.json` and `reader.json`, holding
 * names that mean something *here*. It is merged over the shipped table rather than under it, so a
 * name can also correct one probez ships — a `make` that only ever runs tests, say.
 *
 * It classifies and nothing else. A name here cannot make probez run anything, read anything
 * outside its own data directory, or send anything anywhere; the worst a wrong entry can do is put
 * some rounds in the wrong column, which `analyze --unclassified` and the coverage line already
 * exist to make visible.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { COMMAND_KINDS } from './bash.js'
import type { CommandKind } from './bash.js'

export interface CommandKinds {
  schema_version: number
  /** Command name as probez records it — the last path segment — to the kind of work it does. */
  commands: Record<string, CommandKind>
}

export const COMMANDS_VERSION = 1

/** Beside `pricing.json` and `reader.json`: a setting, not a project. */
export function commandsFile(dataDir: string): string {
  return join(dataDir, 'commands.json')
}

/** The same shape a command name has to have in the shipped table: no paths, no spaces but one. */
const NAME = /^[A-Za-z0-9._+-]+( [A-Za-z0-9._+-]+)?$/

/** Enough to name a repository's scripts several times over, and not enough to be a data file. */
const MAX_COMMANDS = 500

export function isCommandKind(value: string): value is CommandKind {
  return (COMMAND_KINDS as string[]).includes(value)
}

/**
 * What this machine calls things, or nothing.
 *
 * Nothing is the ordinary case and not an error: probez ships with no such file. A file that exists
 * but does not parse is nothing too — a half-written config must not become a taxonomy — and one
 * bad entry is dropped rather than taking the rest of the file with it, because a typo in the
 * eleventh line should not silently un-name the ten above it.
 */
export async function readCommandKinds(dataDir: string): Promise<Record<string, CommandKind>> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(commandsFile(dataDir), 'utf8'))
  } catch {
    return {}
  }
  const held = (raw as { commands?: unknown } | null)?.commands
  if (held === null || typeof held !== 'object' || Array.isArray(held)) return {}

  const out: Record<string, CommandKind> = {}
  let taken = 0
  for (const [name, kind] of Object.entries(held as Record<string, unknown>)) {
    if (taken >= MAX_COMMANDS) break
    if (!NAME.test(name)) continue
    if (typeof kind !== 'string' || !isCommandKind(kind)) continue
    out[name.toLowerCase()] = kind
    taken += 1
  }
  return out
}

export async function writeCommandKinds(
  dataDir: string,
  commands: Record<string, CommandKind>,
): Promise<Record<string, CommandKind>> {
  const checked: Record<string, CommandKind> = {}
  let taken = 0
  for (const [name, kind] of Object.entries(commands)) {
    if (taken >= MAX_COMMANDS) break
    const clean = name.trim().toLowerCase()
    if (!NAME.test(clean)) throw new CommandsError(`"${name}" is not a command name`)
    if (!isCommandKind(kind)) {
      throw new CommandsError(`"${kind}" is not a kind. One of: ${COMMAND_KINDS.join(', ')}`)
    }
    checked[clean] = kind
    taken += 1
  }
  const body: CommandKinds = { schema_version: COMMANDS_VERSION, commands: checked }
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  await writeFile(commandsFile(dataDir), JSON.stringify(body, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  })
  return checked
}

export class CommandsError extends Error {}
