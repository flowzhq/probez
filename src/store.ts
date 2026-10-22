import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'

import { isAgentSource, isRoundSource, safeSessionFilename, sessionIdFromFilename } from './agents/paths.js'
import {
  type CopilotVsCall,
  defaultCopilotVsLogDir,
  harvestCopilotVsLogs,
  readCopilotVsUsage,
} from './copilot-vs-log.js'
import { applyCursorUsage, readCursorUsage } from './cursor-usage.js'
import { readToolResults } from './result.js'
import { extractCodexSession, isCodexRecord } from './extract-codex.js'
import { exportClineSession, extractClineSession, isClineRecord } from './extract-cline.js'
import { exportGooseSession, extractGooseSession, isGooseRecord } from './extract-goose.js'
import { exportOpencodeSession, extractOpencodeSession, isOpencodeRecord } from './extract-opencode.js'
import { extractPiSession, isPiRecord } from './extract-pi.js'
import { extractCopilotSession, isCopilotRecord } from './extract-copilot.js'
import { extractCopilotVsSession } from './extract-copilot-vs.js'
import { extractCursorSession } from './extract-cursor.js'
import { extractSession } from './extract.js'
import { readHeadHistory } from './git.js'
import { allDarkened, CONTROL, normalizeRound } from './import.js'
import type { AgentSource, Project, Round, RoundSource, SessionFile } from './types.js'

/**
 * The shape of what the store writes.
 *
 * Exported so a test that builds a store by hand builds the current one: a fixture with a version
 * number typed into it is a fixture that silently stops being read the next time this moves.
 */
export const SCHEMA_VERSION = 10

export interface Summary {
  project: string
  path: string | null
  slug: string
  dir: string
  sessions: number
  rounds: number
  tasks: number
  in_tokens: number
  in_uncached: number
  in_cache_write: number
  in_cache_write_5m: number
  in_cache_write_1h: number
  in_cache_read: number
  out_tokens: number
  first_ts: string | null
  last_ts: string | null
  tools: Array<{ name: string; calls: number }>
  collected_at: string | null
}

export interface CollectResult extends Summary {
  new_rounds: number
  read_sessions: number
  skipped_sessions: number
  /** Of those, the ones `--since` put outside the window rather than ones already up to date. */
  skipped_by_window: number
  /** Whether the store was written from scratch because it predated the current schema. */
  rebuilt: boolean
}

/**
 * A project as the store knows it, read back from its own manifest.
 *
 * Every command until now has started from the agent's directory and worked forwards, because
 * collecting is the only thing you can do with a project that has never been collected. Reading is
 * the other direction: what is already recorded is recorded whether or not `~/.claude` still holds
 * the sessions it came from. `slugFor` is one-way, so this is the only way back.
 */
export interface StoredProject {
  slug: string
  dir: string
  /** What to call it: the name someone chose, or the one its path gave it. */
  project: string
  /** Whether that name was chosen here rather than derived, which is what makes it revertible. */
  renamed: boolean
  path: string | null
  key: string
  source_dir: string | null
  sessions: number
  rounds: number
  tasks: number
  in_tokens: number
  in_uncached: number
  in_cache_write: number
  in_cache_write_5m: number
  in_cache_write_1h: number
  in_cache_read: number
  out_tokens: number
  first_ts: string | null
  last_ts: string | null
  collected_at: string | null
  /** When this arrived as an export, or null when it was collected on this machine. */
  imported_at: string | null
  /**
   * When this arrived darkened, or null when what it holds is as it was recorded.
   *
   * Set from the rounds on the way in rather than taken from the sender's manifest, so it says what
   * the file actually contains rather than what it claimed to.
   */
  darkened_at: string | null
  /** Which agents contributed sessions. Absent on stores written before sources were recorded. */
  sources: AgentSource[]
  /** When another machine's export was last merged in, or null when everything here was collected here. */
  merged_at: string | null
  /** Whose merged-in work this project holds, beside this machine's own. Empty when none. */
  committers: string[]
}

interface Manifest {
  schema_version?: number
  /** Set only on a project that arrived as a file. Absent means it was collected here. */
  imported_at?: string | null
  /** Set only on a project whose every round arrived darkened. Absent means it arrived as recorded. */
  darkened_at?: string | null
  /**
   * The name someone gave this project, which outranks `project`.
   *
   * They are two fields rather than one because `project` is derived — every collect recomputes it
   * from the directory the agent ran in — so a rename written there would last until the next
   * collect and no longer. Clearing this is what puts the derived name back.
   */
  name?: string | null
  project?: string
  path?: string | null
  key?: string
  source_dir?: string | null
  collected_at?: string | null
  sessions?: number
  rounds?: number
  tasks?: number
  in_tokens?: number
  in_uncached?: number
  in_cache_write?: number
  in_cache_write_5m?: number
  in_cache_write_1h?: number
  in_cache_read?: number
  out_tokens?: number
  first_ts?: string | null
  last_ts?: string | null
  sources?: AgentSource[]
  merged_at?: string | null
  committers?: string[]
}

/** Longest name a project may be given. A label, not a description. */
export const MAX_NAME = 80

/**
 * A name as it will be stored and printed.
 *
 * Nothing here decides a path — `slugFor` and `importSlug` already settled where the project lives,
 * and renaming never moves it — so the only rules are the ones that keep a name printable. Control
 * characters go for the reason they go on the way in from an import: `probez projects` prints this
 * straight to a terminal, and a terminal obeys escape sequences.
 */
export function cleanName(raw: string): string {
  return raw.replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)
}

/**
 * A slug names a directory, and it arrives from a URL, so it is checked rather than trusted. Only
 * the shape `slugFor` produces is accepted: no separators, no dots, nothing that could climb out of
 * the store.
 */
export function isSlug(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && !value.startsWith('.') && !value.includes('..')
}

export function storedDir(dataDir: string, slug: string): string {
  return join(dataDir, 'projects', slug)
}

function asStored(slug: string, dir: string, manifest: Manifest): StoredProject | null {
  if (manifest.schema_version !== SCHEMA_VERSION) return null
  const chosen = cleanName(manifest.name ?? '')
  return {
    slug,
    dir,
    project: chosen === '' ? (manifest.project ?? slug) : chosen,
    renamed: chosen !== '',
    path: manifest.path ?? null,
    key: manifest.key ?? slug,
    source_dir: manifest.source_dir ?? null,
    sessions: manifest.sessions ?? 0,
    rounds: manifest.rounds ?? 0,
    tasks: manifest.tasks ?? 0,
    in_tokens: manifest.in_tokens ?? 0,
    in_uncached: manifest.in_uncached ?? 0,
    in_cache_write: manifest.in_cache_write ?? 0,
    in_cache_write_5m: manifest.in_cache_write_5m ?? 0,
    in_cache_write_1h: manifest.in_cache_write_1h ?? 0,
    in_cache_read: manifest.in_cache_read ?? 0,
    out_tokens: manifest.out_tokens ?? 0,
    first_ts: manifest.first_ts ?? null,
    last_ts: manifest.last_ts ?? null,
    collected_at: manifest.collected_at ?? null,
    imported_at: manifest.imported_at ?? null,
    darkened_at: manifest.darkened_at ?? null,
    sources: (manifest.sources ?? []).filter(isAgentSource),
    merged_at: manifest.merged_at ?? null,
    committers: (manifest.committers ?? []).filter((one) => typeof one === 'string'),
  }
}

/**
 * Every project in the store, most recently active first.
 *
 * A directory whose manifest is missing, unreadable or of another schema is skipped rather than
 * thrown on. A store is written by a long-running command that can be interrupted, so a half-written
 * project is a state the reader should survive, not a reason to show nothing.
 */
export async function listStored(dataDir: string): Promise<StoredProject[]> {
  const root = join(dataDir, 'projects')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const found: StoredProject[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSlug(entry.name)) continue
    const dir = join(root, entry.name)
    const manifest = await readJson<Manifest>(join(dir, 'manifest.json'))
    if (manifest === null) continue
    const stored = asStored(entry.name, dir, manifest)
    if (stored !== null) found.push(stored)
  }
  found.sort((a, b) => (b.last_ts ?? '').localeCompare(a.last_ts ?? ''))
  return found
}

/** One stored project by slug, or null when nothing of that name has been collected. */
export async function findStored(dataDir: string, slug: string): Promise<StoredProject | null> {
  if (!isSlug(slug)) return null
  const dir = storedDir(dataDir, slug)
  const manifest = await readJson<Manifest>(join(dir, 'manifest.json'))
  return manifest === null ? null : asStored(slug, dir, manifest)
}

interface SessionState {
  size: number
  mtimeMs: number
  source?: RoundSource
}

interface State {
  schema_version: number
  sessions: Record<string, SessionState>
}

export function defaultDataDir(): string {
  return process.env.PROBEZ_DATA_DIR || join(homedir(), '.probez')
}

/**
 * Stable directory name for a project: readable basename plus a hash of the absolute path, so the
 * same project always lands in the same place and two repos sharing a basename never collide.
 */
export function slugFor(project: Project): string {
  // A project read back out of the store already knows where it lives; only a discovered one has
  // to be hashed into a name.
  if (project.slug !== undefined) return project.slug
  const source = project.path ?? project.key
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 8)
  const name = (project.path ? basename(project.path) : project.key).replace(/[^A-Za-z0-9._-]/g, '-')
  return `${name || 'project'}-${hash}`
}

/**
 * Where an imported project lives.
 *
 * Deliberately not `slugFor`. That hashes the directory an agent ran in, so importing a colleague's
 * copy of a repo you also have — same name, same path — would land on your own store and overwrite
 * it. Hashing the sender's identity for it under a separate namespace means an import can never
 * collide with something collected here, and re-importing a newer export of the same project
 * replaces it rather than making a second copy.
 */
export function importSlug(name: string, source: string): string {
  const hash = createHash('sha256').update(`probez-import\u0000${source}`).digest('hex').slice(0, 8)
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').slice(0, 40)
  return `${safe || 'imported'}-${hash}`
}

export function projectDir(dataDir: string, project: Project): string {
  return join(dataDir, 'projects', slugFor(project))
}

/**
 * Where the analysis of a project's rounds is cached.
 *
 * A sibling of `rounds.jsonl`, and only ever a cache. `analyze` recomputes from the rounds every
 * time it runs, so nothing it prints can be stale; this file exists so the next stage has something
 * to read without re-deriving the taxonomy. Its first line is a header naming the analyzer and how
 * many rounds it saw, which is what lets a reader notice the rounds have moved on since.
 */
export function analysisFile(dataDir: string, project: Project): string {
  return join(projectDir(dataDir, project), 'analysis.jsonl')
}

/** Bumped when a change to `act.ts` or `classify.ts` would give the same rounds different labels. */
export const ANALYZER_VERSION = 3

export interface AnalysisHeader {
  schema_version: number
  analyzer_version: number
  analyzed_at: string
  rounds: number
  /** Rounds that carried no label, so a reader knows the file is complete rather than truncated. */
  toolless: number
}

/**
 * Replace the cached analysis wholesale. Recomputing is cheap, so there is no incremental path.
 *
 * Written under the project's lock, and only while the project still has rounds. Every caller
 * writes this after the collect or merge that produced its rounds has let the lock go, and a
 * delete or a clear can land in between: writing then would bring back a project folder holding
 * nothing but this file. A trim landing there is harmless, since the header's count no longer
 * matches the rounds and readers ignore it.
 */
export async function writeAnalysis(
  file: string,
  header: Omit<AnalysisHeader, 'schema_version' | 'analyzer_version' | 'analyzed_at'>,
  records: unknown[],
  waitMs?: number,
): Promise<void> {
  const lines = [
    JSON.stringify({
      schema_version: SCHEMA_VERSION,
      analyzer_version: ANALYZER_VERSION,
      analyzed_at: new Date().toISOString(),
      ...header,
    }),
    ...records.map((record) => JSON.stringify(record)),
  ]
  const dir = dirname(file)
  await withProjectLock(dir, async () => {
    if ((await stat(join(dir, 'rounds.jsonl')).catch(() => null)) === null) return
    await writeFile(file, lines.join('\n') + '\n', { encoding: 'utf8', mode: FILE_MODE })
    await tighten(file, FILE_MODE)
  }, false, waitMs)
}

/** Owner-only, the mode the agent already uses for the session files probez reads. */
export const DIR_MODE = 0o700
export const FILE_MODE = 0o600
/** Any bit granting group or other access. */
const SHARED_BITS = 0o077

/**
 * Tighten one path if it is readable by anyone but its owner.
 *
 * probez distils the agent's `0600` logs into `rounds.jsonl`, so writing that extract at the
 * default `0644` would publish, to every local account, what the source deliberately kept private.
 * New stores are created owner-only; this repairs the ones written before that was true. It only
 * ever removes access, never grants it, and only inside the data directory.
 *
 * Exported because `writeFile`'s `mode` applies only when it creates the file: anything that
 * rewrites a store file in place has to call this after, or a store somebody once loosened stays
 * loose. The search index is one of those, and `test/cli.test.ts` checks it.
 */
export async function tighten(path: string, mode: number): Promise<void> {
  try {
    const info = await stat(path)
    if ((info.mode & SHARED_BITS) !== 0) await chmod(path, mode)
  } catch {
    // absent or not ours to change; the next collect tries again
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** A round whose source field is missing or unrecognised is unknown, not Claude. */
function asStoredRound(round: Round): Round {
  return isRoundSource(round.source ?? '') ? round : { ...round, source: 'unknown' }
}

/**
 * Stream rounds.jsonl once, calling back with each parsed round.
 *
 * A visitor that returns a promise is waited for before the next line is read, which is how a
 * rewrite keeps its writes in step with its reading: each batch is on disk, or has failed and
 * stopped the read, before the next is gathered. That failure is the visitor's own, and is thrown
 * as it is rather than read as anything about the file. A visitor that throws as it is called is
 * taken, as it always has been, as a line that held no round it could use.
 */
export async function eachRound(
  file: string,
  visit: (round: Round) => void | Promise<void>,
): Promise<void> {
  let stream
  try {
    stream = createReadStream(file, { encoding: 'utf8' })
  } catch {
    return
  }
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let failed: { error: unknown } | null = null
  try {
    for await (const line of lines) {
      if (line.trim() === '') continue
      let pending: void | Promise<void>
      try {
        pending = visit(asStoredRound(JSON.parse(line) as Round))
      } catch {
        // a torn line from an interrupted write; skip it
        continue
      }
      if (pending === undefined) continue
      try {
        await pending
      } catch (error) {
        failed = { error }
        break
      }
    }
  } catch (error) {
    // A file that does not exist yet has no rounds. Any other failure is not the same thing: a
    // caller that rewrites the file from what it read would otherwise replace it with nothing.
    if (!isMissing(error)) throw error
  }
  if (failed !== null) throw failed.error
}

/** The file is not there, as opposed to there and unreadable. */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Every non-blank line of a rounds file, with the position that names it.
 *
 * That position is what the search index calls a round, and it is counted over *lines* rather than
 * over rounds that parsed. The difference only shows up on a torn line from an interrupted write,
 * and it is the whole reason this exists: counting successful parses would mean the index could
 * only say which round it meant by parsing every line again, which is the one thing the index is
 * for avoiding. A line that does not parse keeps its position and is recorded as matching nothing.
 */
export async function eachRoundLine(
  file: string,
  visit: (at: number, line: string, offset: number, bytes: number) => void | Promise<void>,
): Promise<void> {
  let stream
  try {
    stream = createReadStream(file, { encoding: 'utf8' })
  } catch {
    return
  }
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let at = 0
  // Where each line begins, so the index can record it and a later read can seek straight to it
  // instead of walking the file again. Counted in bytes rather than characters, because that is
  // what a file position is and a prompt is full of characters that are not one byte.
  let offset = 0
  let failed: { error: unknown } | null = null
  try {
    for await (const line of lines) {
      const bytes = Buffer.byteLength(line, 'utf8')
      if (line.trim() !== '') {
        const pending = visit(at, line, offset, bytes)
        if (pending !== undefined) {
          try {
            await pending
          } catch (error) {
            failed = { error }
            break
          }
        }
        at += 1
      }
      offset += bytes + 1
    }
  } catch (error) {
    // See `eachRound`: only a missing file reads as an empty one.
    if (!isMissing(error)) throw error
  }
  // See `eachRound`: the visitor's own failure, waited for in step with the reading.
  if (failed !== null) throw failed.error
}

/**
 * The rounds at these positions, and no others.
 *
 * The point of the search index: a query that matched four hundred of fifty thousand rounds reads
 * four hundred of them off disk, and `JSON.parse` — which is nearly all of what reading a store
 * costs — never sees the rest.
 */
export async function readRoundsAt(dir: string, wanted: Set<number>): Promise<Map<number, Round>> {
  const found = new Map<number, Round>()
  if (wanted.size === 0) return found
  await eachRoundLine(join(dir, 'rounds.jsonl'), (at, line) => {
    if (!wanted.has(at)) return
    try {
      found.set(at, asStoredRound(JSON.parse(line) as Round))
    } catch {
      // a torn line from an interrupted write; the index already records it as matching nothing
    }
  })
  return found
}

/**
 * The rounds at these byte ranges, read without touching the rest of the file.
 *
 * The other half of what the index buys. `readRoundsAt` still walks every line to count its way to
 * the ones it wants, which on a forty-megabyte store is most of the cost of the query; this seeks
 * to each one, so a search that matched four hundred rounds reads four hundred rounds' worth of
 * bytes. Ranges are read in file order and coalesced, so what reaches the disk is a handful of
 * sequential reads rather than one per hit.
 */
export async function readRoundsAtOffsets(
  dir: string,
  ranges: Array<{ at: number; offset: number; bytes: number }>,
): Promise<Map<number, Round>> {
  const found = new Map<number, Round>()
  if (ranges.length === 0) return found
  const file = join(dir, 'rounds.jsonl')
  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    return found
  }
  try {
    const ordered = [...ranges].sort((a, b) => a.offset - b.offset)
    for (const one of ordered) {
      if (one.bytes <= 0) continue
      const buffer = Buffer.allocUnsafe(one.bytes)
      const read = await handle.read(buffer, 0, one.bytes, one.offset)
      if (read.bytesRead !== one.bytes) continue
      try {
        found.set(one.at, asStoredRound(JSON.parse(buffer.toString('utf8')) as Round))
      } catch {
        // the file moved under the index; the caller's staleness check catches it next time
      }
    }
  } finally {
    await handle.close()
  }
  return found
}

/**
 * Every round recorded for a project, in the order it was collected. The read commands sort and
 * filter across the whole set, so this holds it in memory rather than streaming. A store is a few
 * megabytes even after months of sessions.
 */
export async function readRounds(project: Project, dataDir: string): Promise<Round[]> {
  return readRoundsIn(projectDir(dataDir, project))
}

/** `readResultsIn` for a project the CLI has already resolved. */
export async function readResults(
  project: Project,
  dataDir: string,
  ids: ReadonlySet<string>,
): Promise<Map<string, string>> {
  return readResultsIn(projectDir(dataDir, project), ids)
}

/** The same read, addressed by the store directory itself, which is all a slug resolves to. */
/**
 * Result bodies for a named set of calls, out of the session copies `collect` archived.
 *
 * `rounds.jsonl` keeps a result's size and not its text, which is what makes browsing cheap. Some
 * questions need the text anyway — whether a path a later call opened was one an earlier call's
 * output named is not answerable from inputs alone — so this is the way back to it, and it stays
 * opt-in for the reason the extract dropped the bodies in the first place.
 *
 * Every archived session is read once, and each is asked only for the ids it happens to hold, so
 * this costs one pass over the copies rather than one per call. A project with no `sessions/`
 * directory returns nothing: an import carries the rounds probez normalized and not the logs
 * behind them, which is a real answer and not a failure.
 */
export async function readResultsIn(
  dir: string,
  ids: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (ids.size === 0) return out
  const sessions = join(dir, 'sessions')
  const files = await readdir(sessions).catch(() => [])
  for (const name of files) {
    if (!name.endsWith('.jsonl')) continue
    for (const [id, body] of await readToolResults(join(sessions, name), ids)) out.set(id, body)
  }
  return out
}

export async function readRoundsIn(dir: string): Promise<Round[]> {
  const rounds: Round[] = []
  await eachRound(join(dir, 'rounds.jsonl'), (round) => {
    rounds.push(round)
  })
  return rounds
}

/**
 * Merge Cursor hook usage from the data-dir sidecar onto stored rounds.
 *
 * Redistributes each event across tool-using rounds in the matching task. Returns how many usage
 * events were attached. Rewrites `rounds.jsonl` and drops cached analysis when anything changes.
 */
export async function mergeCursorUsageIntoProject(dir: string, dataDir: string): Promise<number> {
  const events = await readCursorUsage(dataDir)
  if (events.length === 0) return 0

  const roundsFile = join(dir, 'rounds.jsonl')
  const rounds = await readRoundsIn(dir)
  if (rounds.length === 0) return 0

  const before = rounds.map((round) => JSON.stringify(round))
  const applied = applyCursorUsage(rounds, events)
  if (applied === 0) return 0

  const after = rounds.map((round) => JSON.stringify(round))
  let changed = false
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) {
      changed = true
      break
    }
  }
  if (!changed) return 0

  const target = `${roundsFile}.usage`
  await writeFile(target, after.join('\n') + '\n', { encoding: 'utf8', mode: FILE_MODE })
  await rename(target, roundsFile)
  await tighten(roundsFile, FILE_MODE)
  await rm(join(dir, 'analysis.jsonl'), { force: true })
  return applied
}

export async function summarize(project: Project, dataDir: string): Promise<Summary> {
  const dir = projectDir(dataDir, project)
  const tally = newTally()
  const toolCalls = new Map<string, number>()

  await eachRound(join(dir, 'rounds.jsonl'), (round) => {
    countRound(tally, round)
    for (const tool of round.tools ?? []) {
      if (typeof tool.name !== 'string') continue
      toolCalls.set(tool.name, (toolCalls.get(tool.name) ?? 0) + 1)
    }
  })

  const manifest = await readJson<{ collected_at?: string }>(join(dir, 'manifest.json'))

  return {
    project: project.path ? basename(project.path) : project.key,
    path: project.path,
    slug: slugFor(project),
    dir,
    ...tallied(tally),
    tools: [...toolCalls.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, calls]) => ({ name, calls })),
    collected_at: manifest?.collected_at ?? null,
  }
}

/** How much of an archived copy to read before deciding which agent wrote it. */
const SNIFF_BYTES = 64 * 1024

/**
 * Which agent wrote an archived session, for the one case the store cannot simply look up.
 *
 * Normally the source is recorded beside the size and mtime. It is missing only for a copy whose
 * state entry is gone, and the id cannot settle it: Claude and Cursor name a subagent's transcript
 * for the path it sits at, so a `/` in the id says a subagent wrote it and nothing about which
 * agent did. The records themselves are unambiguous — Codex lines are typed envelopes with a
 * `payload`, Copilot lines are typed envelopes with a `data` and a dotted `type`, Claude rows are
 * typed and carry a `sessionId`, Cursor rows carry a `role` and nothing else — so read one. Codex
 * and Copilot are checked first because every one of their lines has a `type`, which is also how
 * Claude rows announce themselves.
 *
 * Format detection is the legitimate way to recover a source. Guessing from missing tokens, a
 * model name or a tool is not. When the file is not a transcript of any known agent, the answer
 * is `unknown` rather than Claude.
 */
export async function sniffSource(file: string): Promise<RoundSource> {
  const handle = await open(file, 'r').catch(() => null)
  if (handle === null) return 'unknown'
  let text: string
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0)
    text = buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
  // The last line may be cut mid-record; parsing it throws and is skipped below.
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (!record || typeof record !== 'object') continue
    const row = record as Record<string, unknown>
    if (isCodexRecord(row)) return 'codex'
    if (isCopilotRecord(row)) return 'copilot'
    if (isPiRecord(row)) return 'pi'
    if (isOpencodeRecord(row)) return 'opencode'
    if (isGooseRecord(row)) return 'goose'
    if (isClineRecord(row)) return 'cline'
    if (typeof row.type === 'string' || typeof row.sessionId === 'string') return 'claude-code'
    if (typeof row.role === 'string') return 'cursor'
  }
  return 'unknown'
}

/**
 * The sessions a rebuild has to read: the ones still in the agent's directory, plus the ones only
 * this store still has.
 *
 * Agents prune old sessions, which is the whole reason `sessions/` exists. Rebuilding from the
 * agent's directory alone would quietly drop every round belonging to a session that has since been
 * pruned — the store would come back smaller than it went in.
 */
async function withArchived(
  live: SessionFile[],
  sessionsDir: string,
  stored: State | null,
): Promise<SessionFile[]> {
  const out = [...live]
  const known = new Set(live.map((session) => session.id))
  const liveFiles = new Set(live.map((session) => safeSessionFilename(session.id)))
  const idByFile = new Map<string, string>()
  if (stored !== null) {
    for (const id of Object.keys(stored.sessions)) {
      idByFile.set(safeSessionFilename(id), id)
    }
  }
  for (const name of await readdir(sessionsDir).catch(() => [] as string[])) {
    if (!name.endsWith('.jsonl')) continue
    if (liveFiles.has(name)) continue
    const id = idByFile.get(name) ?? sessionIdFromFilename(name)
    if (known.has(id)) continue
    const file = join(sessionsDir, name)
    const info = await stat(file).catch(() => null)
    if (info === null) continue
    const recorded = stored?.sessions[id]?.source
    const source: RoundSource =
      recorded !== undefined && isRoundSource(recorded) ? recorded : await sniffSource(file)
    out.push({ id, file, size: info.size, mtimeMs: info.mtimeMs, source })
    known.add(id)
  }
  return out
}

/* One writer per project, across processes. ---------------------------------------------------- */

/**
 * A writer gave up waiting for the project's lock. Its own class so the view can hand the sentence
 * to the page — which process, which file to delete — instead of a bare 500.
 */
export class ProjectLocked extends Error {}

/** Beside the rounds it guards, so a project removed takes its lock with it. */
const LOCK_FILE = 'write.lock'
const LOCK_POLL_MS = 50
/** A lock file with no pid in it yet is one being written; this long after, it never will be. */
const LOCK_UNWRITTEN_MS = 10_000
/**
 * How long a writer waits before saying who it is waiting for. Long enough for a full rebuild of a
 * big project; short enough that a lock held by a pid some other program has since been given is
 * reported rather than waited on forever.
 */
const LOCK_WAIT_MS = 5 * 60_000

/**
 * Run `work` as the only writer to this project's files.
 *
 * Collect appends to `rounds.jsonl`, and a merge or a trim rewrites it beside and moves the copy
 * over. A rewrite that read the file before an append and moved its copy over after loses those
 * rounds for good, because collect has already marked their sessions read. The view's own queue
 * (`exclusive` in viewdata.ts) only covers its process, and `probez collect`, `probez import
 * --into` and a second `probez view` are each a process of their own. So the lock is a file:
 * created exclusively, holding the pid that made it, and taken over once that pid is gone, so a
 * crash or a Ctrl-C cannot leave a project locked for good. A pid that is not gone but was handed to
 * another program cannot be told apart from a writer, so waiting has a deadline, and the error says
 * which pid and which file.
 *
 * Not re-entrant: a writer called from inside another's `work` would wait for itself. Each public
 * writer takes it once, at the top, and never calls another while holding it.
 *
 * `create` is for collect, the one writer that makes a project. Every other writer finding no
 * directory runs unlocked, finds nothing to write to, and says so.
 *
 * `waitMs` is for a writer with something better to do than wait: a cache that someone else's
 * write is about to make stale anyway can give up at once, and leave rebuilding it to them.
 */
export async function withProjectLock<T>(
  dir: string,
  work: () => Promise<T>,
  create = false,
  waitMs = LOCK_WAIT_MS,
): Promise<T> {
  const file = join(dir, LOCK_FILE)
  const deadline = Date.now() + waitMs
  let held: BigIntStats | null = null
  for (;;) {
    try {
      const handle = await open(file, 'wx', FILE_MODE)
      try {
        await handle.writeFile(String(process.pid), 'utf8')
        held = await handle.stat({ bigint: true })
      } finally {
        await handle.close()
      }
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        if (!create) break
        await mkdir(dir, { recursive: true, mode: DIR_MODE })
        continue
      }
      // On Windows a lock file another writer has just removed lingers until its last handle
      // closes, and creating it meanwhile fails with EPERM rather than EEXIST. It is a lock on its
      // way out, not a fault, so it is waited on like a held one; there is nothing to take over.
      const leaving = code === 'EPERM' && process.platform === 'win32'
      if (code !== 'EEXIST' && !leaving) throw error
      if (!leaving && (await takeOver(file))) continue
      if (Date.now() >= deadline) {
        const holder = (await readFile(file, 'utf8').catch(() => '')).trim() || 'unknown'
        throw new ProjectLocked(
          `${dir} is still being written by process ${holder} after ${waitMs / 60_000} minutes. ` +
            `If no probez is running, delete ${file} and try again.`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
    }
  }
  try {
    return await work()
  } finally {
    if (held !== null) await release(file, held)
  }
}

/**
 * Remove the lock this writer made, and only that one.
 *
 * Whatever is at the path now may not be it. A delete moves the directory aside with its lock in
 * it, and a collect waiting on the project makes the folder again and takes a lock of its own there
 * before the delete returns; removing by path would hand that collect's project to the next writer
 * while it is still writing. The pid cannot tell the two apart, since one process can be waiting on
 * its own lock, so the file itself is compared. While the file is this writer's nobody else can
 * replace it, so nothing can change between the check and the removal.
 */
async function release(file: string, mine: BigIntStats): Promise<void> {
  const now = await stat(file, { bigint: true }).catch(() => null)
  if (now === null) return
  if (now.dev !== mine.dev || now.ino !== mine.ino || now.birthtimeNs !== mine.birthtimeNs) return
  await rm(file, { force: true })
}

/**
 * Remove the lock if whoever holds it is gone, and say whether it did.
 *
 * Checking and removing are two steps, and two waiters that both found the same dead pid could
 * otherwise both remove: the first its stale lock, the second the fresh one the first had made by
 * then, and both would write. So a takeover is itself exclusive, through a second file that lives
 * only for the moment it takes. Holding it, nothing can replace the lock under the check: the
 * lock is only ever removed by its live owner, who is not dead, or by whoever holds this.
 */
async function takeOver(file: string): Promise<boolean> {
  const guard = `${file}.takeover`
  try {
    await (await open(guard, 'wx', FILE_MODE)).close()
  } catch (error) {
    // The project went while this waited, most likely to a delete. Trying again finds that out the
    // way the first attempt would have.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    // Another waiter is checking. One that died doing it left this behind; it takes milliseconds.
    const info = await stat(guard).catch(() => null)
    if (info !== null && Date.now() - info.mtimeMs > LOCK_UNWRITTEN_MS) await rm(guard, { force: true })
    return false
  }
  try {
    if ((await abandonedBy(file)) === null) return false
    await rm(file, { force: true })
    return true
  } finally {
    await rm(guard, { force: true })
  }
}

/** The lock file's contents when whoever wrote it is gone, or null while it is still held. */
async function abandonedBy(file: string): Promise<string | null> {
  const [text, info] = await Promise.all([
    readFile(file, 'utf8').catch(() => null),
    stat(file).catch(() => null),
  ])
  // Released between the failed create and here: free, and the next attempt takes it.
  if (text === null || info === null) return null
  const pid = Number(text)
  if (!Number.isInteger(pid) || pid <= 0) {
    return Date.now() - info.mtimeMs > LOCK_UNWRITTEN_MS ? text : null
  }
  try {
    process.kill(pid, 0)
    return null
  } catch (error) {
    // EPERM is a process that exists and is not ours to signal: alive, and still holding it.
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? null : text
  }
}

/**
 * Normalize a project's sessions into its store.
 *
 * Session files are append-only, so an unchanged size and mtime means there is nothing new to read.
 * Anything that did change is re-parsed whole and appended through a `session+id` filter, which
 * costs milliseconds, drops what is already recorded, and makes the whole command idempotent. That
 * is also why `--full` repairs a store rather than duplicating it.
 *
 * A store from an older schema is the one case appending cannot serve, and is rebuilt instead.
 */
export async function collectProject(
  project: Project,
  dataDir: string,
  options: { full?: boolean; since?: number; copilotVsLogDir?: string } = {},
): Promise<CollectResult> {
  return withProjectLock(projectDir(dataDir, project), () => collectUnlocked(project, dataDir, options), true)
}

async function collectUnlocked(
  project: Project,
  dataDir: string,
  options: { full?: boolean; since?: number; copilotVsLogDir?: string },
): Promise<CollectResult> {
  const dir = projectDir(dataDir, project)
  const roundsFile = join(dir, 'rounds.jsonl')
  const sessionsDir = join(dir, 'sessions')
  await mkdir(sessionsDir, { recursive: true, mode: DIR_MODE })
  // Stores written before probez set a mode are still world-readable, so repair them on the way in.
  for (const path of [dataDir, join(dataDir, 'projects'), dir, sessionsDir]) {
    await tighten(path, DIR_MODE)
  }

  const stored = await readJson<State>(join(dir, 'state.json'))
  // A store written against an older schema cannot be brought forward by appending. The rounds
  // already in the file are the old shape, and the `session+id` filter below would drop every
  // replacement as a duplicate of the record it was meant to replace. So the file is rebuilt.
  const outdated = stored !== null && stored.schema_version !== SCHEMA_VERSION
  const sources = outdated ? await withArchived(project.sessions, sessionsDir, stored) : project.sessions
  // Rebuilding needs something to rebuild from. Discovery never yields a project with no sessions,
  // so this only guards a caller that built a `Project` by hand: with nothing to read, the old
  // rounds are all there is, and keeping them at the version they were written for beats replacing
  // them with nothing.
  const rebuild = outdated && sources.length > 0
  // `--since` narrows one run to the sessions the agent has written to lately, so a first collect
  // on a machine with years of history does not have to read all of it. It is a window on *this*
  // run and nothing else: a skipped session never enters `state`, so a later collect with no
  // window reads it then. Never applied to a rebuild — that writes a new `rounds.jsonl` from what
  // it reads, and a window there would silently drop everything outside it.
  const windowed =
    options.since === undefined || rebuild
      ? sources
      : sources.filter((session) => session.mtimeMs >= options.since!)
  const skippedByWindow = sources.length - windowed.length
  const version = outdated && !rebuild ? (stored?.schema_version ?? SCHEMA_VERSION) : SCHEMA_VERSION
  const state =
    (options.full || rebuild ? null : stored) ??
    ({ schema_version: version, sessions: {} } as State)

  const stale = windowed.filter((session) => {
    const seen = state.sessions[session.id]
    return seen === undefined || seen.size !== session.size || seen.mtimeMs !== session.mtimeMs
  })

  // Only the sessions being re-read need de-duplication keys, so this stays proportional to what
  // changed rather than to the whole history. A rebuild writes a new file, so it starts with none.
  const staleIds = new Set(stale.map((session) => session.id))
  const seenKeys = new Set<string>()
  if (stale.length > 0 && !rebuild) {
    await eachRound(roundsFile, (round) => {
      if (staleIds.has(round.session)) seenKeys.add(`${round.session}\u0000${round.id}`)
    })
  }

  // Written beside the real file and moved over it at the end, so an interrupted rebuild leaves the
  // old store intact rather than half of a new one.
  const target = rebuild ? `${roundsFile}.rebuild` : roundsFile
  if (rebuild) {
    await rm(target, { force: true })
    // Created empty rather than left to the first append below. A project whose sessions normalize
    // to no rounds at all — one opened for a question the model never answered in — appends
    // nothing, and the move at the end had nothing to move: it failed with ENOENT and left the
    // project pinned to the old schema, so every later collect repeated the same failure. An empty
    // rebuild is a real answer, and it has to land on the store like any other.
    await writeFile(target, '', { encoding: 'utf8', mode: FILE_MODE })
  }

  // Read once for the whole project rather than per session: it is one file, and every session
  // here ran in the same checkout. A project that is not in a repository comes back null and every
  // round it yields is recorded with no commit, which is the honest answer rather than a failure.
  const head = stale.length > 0 ? await readHeadHistory(project.path) : null

  // Visual Studio's Copilot Chat sessions carry no usage; its log does, for as long as Visual
  // Studio keeps the log. Copied into the data directory before any session is read, so a session
  // read now gets what the log holds today, and one rebuilt after the log is gone still gets it.
  let copilotVsCalls: CopilotVsCall[] = []
  if (stale.some((session) => session.vs === true)) {
    await harvestCopilotVsLogs(options.copilotVsLogDir ?? defaultCopilotVsLogDir(), dataDir)
    copilotVsCalls = await readCopilotVsUsage(dataDir)
  }

  let newRounds = 0
  for (const listed of stale) {
    // An OpenCode or Goose session lives in a database every session shares, and a Cline session is
    // spread over several files, so each is exported to its own JSONL copy first and read from that.
    // A session that can no longer be exported — deleted, or a database this Node cannot open —
    // keeps the copy it has, and is read from that if there is one.
    let session = listed
    if (listed.opencode !== undefined || listed.goose !== undefined || listed.cline !== undefined) {
      const archived = join(sessionsDir, safeSessionFilename(listed.id))
      const exported =
        listed.opencode !== undefined
          ? await exportOpencodeSession(listed.opencode, archived)
          : listed.goose !== undefined
            ? await exportGooseSession(listed.goose, archived)
            : await exportClineSession(listed.cline!, archived)
      if (!exported && (await stat(archived).catch(() => null)) === null) continue
      session = { ...listed, file: archived }
    }
    const rounds =
      session.source === 'cursor'
        ? await extractCursorSession(session.file, session.id, head)
        : session.source === 'codex'
          ? await extractCodexSession(session.file, session.id, head)
          : session.source === 'copilot'
            ? session.vs === true
              ? await extractCopilotVsSession(session.file, session.id, head, copilotVsCalls)
              : await extractCopilotSession(session.file, session.id, head)
            : session.source === 'pi'
              ? await extractPiSession(session.file, session.id, head)
              : session.source === 'opencode'
                ? await extractOpencodeSession(session.file, session.id, head)
                : session.source === 'goose'
                  ? await extractGooseSession(session.file, session.id, head)
                  : session.source === 'cline'
                    ? await extractClineSession(session.file, session.id, head)
                    : await extractSession(session.file, session.id, head)
    // Cursor transcripts have no usage. Hook events under the data dir are merged here so a
    // rebuild still picks them up. Claude and Codex rounds already carry their own counts and
    // applyCursorUsage redistributes onto tool-using rounds (or parks prose-only as outside).
    if (session.source === 'cursor') {
      applyCursorUsage(rounds, await readCursorUsage(dataDir))
    }
    const lines: string[] = []
    for (const round of rounds) {
      const key = `${round.session}\u0000${round.id}`
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      // Stamped here rather than inside each extractor, so Claude, Cursor and Codex cannot drift
      // about what the field means, and an extractor does not have to know `AgentSource`.
      lines.push(JSON.stringify({ ...round, source: session.source }))
    }
    if (lines.length > 0) {
      await appendFile(target, lines.join('\n') + '\n', { encoding: 'utf8', mode: FILE_MODE })
      newRounds += lines.length
    }
    // The raw copy is what keeps every field probez does not normalize re-derivable locally. A
    // rebuild may be reading that copy already, in which case there is nothing to copy.
    const archived = join(sessionsDir, safeSessionFilename(session.id))
    if (session.file !== archived) await copyFile(session.file, archived)
    state.sessions[session.id] = {
      size: session.size,
      mtimeMs: session.mtimeMs,
      source: session.source,
    }
  }

  if (rebuild) {
    // Rounds merged in from another machine have no session here to be re-read from, so the copy
    // kept beside them is put back after the rest. See `mergeIntoProject`. Each goes through the
    // same normalizing an import does, which is what brings a round of an older shape up to this
    // one, and the copy is rewritten in that shape so the next rebuild starts from it.
    const mergedFile = join(dir, MERGED_FILE)
    const copyTarget = `${mergedFile}.rebuild`
    await rm(copyTarget, { force: true })
    let toRounds: string[] = []
    let toCopy: string[] = []
    let copied = 0
    // Waited for in step with the reading, for the reason `clearOne` gives.
    const flush = async (): Promise<void> => {
      const rounds = toRounds.length === 0 ? null : toRounds.join('\n') + '\n'
      const copies = toCopy.length === 0 ? null : toCopy.join('\n') + '\n'
      toRounds = []
      toCopy = []
      if (rounds !== null) await appendFile(target, rounds, { encoding: 'utf8', mode: FILE_MODE })
      if (copies !== null) await appendFile(copyTarget, copies, { encoding: 'utf8', mode: FILE_MODE })
    }
    await eachRound(mergedFile, (stored) => {
      const round = normalizeRound(stored)
      if (round === null) return
      const line = JSON.stringify(round)
      toCopy.push(line)
      copied += 1
      const key = `${round.session}\u0000${round.id}`
      if (!seenKeys.has(key)) {
        seenKeys.add(key)
        toRounds.push(line)
      }
      return toCopy.length >= 2000 ? flush() : undefined
    })
    await flush()
    if (copied > 0) await rename(copyTarget, mergedFile)
    await rename(target, roundsFile)
    // The analysis beside it was computed from rounds that no longer exist in this shape.
    await rm(join(dir, 'analysis.jsonl'), { force: true })
  }

  // Hook events often arrive after the transcript was already collected. Re-merge onto stored
  // Cursor rounds so a later collect (with nothing stale) still attaches usage.
  await mergeCursorUsageIntoProject(dir, dataDir)

  state.schema_version = version
  await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n', {
    encoding: 'utf8',
    mode: FILE_MODE,
  })

  const summary = await summarize(project, dataDir)
  summary.collected_at = new Date().toISOString()

  // `project` is derived from the directory and recomputed here every time, so a name someone chose
  // has to be carried across or every collect would quietly undo their rename. The manifest keeps
  // both: the derived name in `project`, so clearing the override has something to fall back to.
  const named = await readJson<Manifest>(join(dir, 'manifest.json'))
  const chosen = cleanName(named?.name ?? '')
  const derived = summary.project

  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        schema_version: version,
        name: chosen === '' ? null : chosen,
        project: derived,
        path: project.path,
        key: project.key,
        source_dir: project.dir,
        collected_at: summary.collected_at,
        sessions: summary.sessions,
        rounds: summary.rounds,
        tasks: summary.tasks,
        in_tokens: summary.in_tokens,
        in_uncached: summary.in_uncached,
        in_cache_write: summary.in_cache_write,
        in_cache_write_5m: summary.in_cache_write_5m,
        in_cache_write_1h: summary.in_cache_write_1h,
        in_cache_read: summary.in_cache_read,
        out_tokens: summary.out_tokens,
        first_ts: summary.first_ts,
        last_ts: summary.last_ts,
        sources: (project.sources ?? [...new Set(project.sessions.map((session) => session.source))]).filter(
          isAgentSource,
        ),
        // Collecting knows nothing of what was merged in, so it carries the record of it across.
        merged_at: named?.merged_at ?? null,
        committers: named?.committers ?? [],
      },
      null,
      2,
    ) + '\n',
    { encoding: 'utf8', mode: FILE_MODE },
  )

  // Files created before probez set a mode keep it until told otherwise. The session copies inherit
  // the agent's mode, which is already owner-only, but a store written against a looser source is
  // repaired here too rather than left to be discovered.
  for (const file of [roundsFile, join(dir, 'state.json'), join(dir, 'manifest.json')]) {
    await tighten(file, FILE_MODE)
  }
  for (const name of await readdir(sessionsDir).catch(() => [])) {
    await tighten(join(sessionsDir, name), FILE_MODE)
  }

  return {
    ...summary,
    // What to call it on the way out, which is not always what the manifest derives.
    project: chosen === '' ? derived : chosen,
    new_rounds: newRounds,
    read_sessions: stale.length,
    skipped_sessions: sources.length - stale.length,
    skipped_by_window: skippedByWindow,
    rebuilt: rebuild,
  }
}

export interface ImportResult {
  slug: string
  dir: string
  project: string
  rounds: number
  sessions: number
  tasks: number
  /** Records in the file that were not rounds, so a partly-wrong file says so. */
  skipped: number
  /** Whether this replaced a project of the same origin rather than adding one. */
  replaced: boolean
  /** Whether every round in the file arrived darkened, so the import says so on the way in. */
  darkened: boolean
}

/**
 * Write a project that arrived as a file.
 *
 * The rounds are re-serialised from the normalised objects rather than copied through, so whatever
 * the file contained, what lands on disk is this schema and nothing else. The store keeps no
 * session copies for an import — there were none to send — which is why a later schema change
 * leaves an imported project at its own version rather than rebuilding it from nothing.
 */
export async function importProject(
  dataDir: string,
  name: string,
  source: string,
  rounds: Round[],
  skipped: number,
): Promise<ImportResult> {
  const slug = importSlug(name, source)
  const dir = storedDir(dataDir, slug)
  // Under the project's lock, like every other writer of these files: a re-import replaces the
  // rounds and the manifest, and a trim, merge or sync working on the same project from another
  // process would otherwise move its own copy over the import, or rebuild a cache from the rounds
  // it replaced. `create` because a first import is what makes the project.
  return withProjectLock(dir, () => importUnlocked(dataDir, dir, slug, name, rounds, skipped), true)
}

async function importUnlocked(
  dataDir: string,
  dir: string,
  slug: string,
  name: string,
  rounds: Round[],
  skipped: number,
): Promise<ImportResult> {
  const before = await readJson<Manifest>(join(dir, 'manifest.json'))
  const replaced = before !== null

  await mkdir(dir, { recursive: true, mode: DIR_MODE })
  for (const path of [dataDir, join(dataDir, 'projects'), dir]) await tighten(path, DIR_MODE)

  const tally = newTally()
  for (const round of rounds) countRound(tally, round)
  const totals = tallied(tally)
  const now = new Date().toISOString()
  const manifest = {
    schema_version: SCHEMA_VERSION,
    // A newer export of a project you have already renamed is still the project you renamed.
    // The sender's name goes back in `project`; what you called it here survives the replacement.
    name: cleanName(before?.name ?? '') || null,
    project: name,
    // No path and no source directory: this project was never run on this machine, and
    // recording the sender's would invite something here to go looking for it.
    path: null,
    key: slug,
    source_dir: null,
    collected_at: now,
    imported_at: now,
    darkened_at: allDarkened(rounds) ? now : null,
    ...totals,
    sources: [...tally.sources],
    // Who recorded it, as its rounds say, so the Committer chip can offer their names.
    committers: [...tally.committers].sort(),
  }

  // Both files are written whole beside the real ones before either is moved over, so an import
  // cut short while writing leaves the project as it was. What is left is the moment between the
  // two renames; the rounds go first, so a project caught there has its new rounds and, at worst,
  // the manifest of the export they replaced, which the next import of the file puts right.
  const files = [
    { real: join(dir, 'rounds.jsonl'), text: rounds.map((round) => JSON.stringify(round)).join('\n') + '\n' },
    { real: join(dir, 'manifest.json'), text: JSON.stringify(manifest, null, 2) + '\n' },
  ]
  for (const { real, text } of files) {
    const target = `${real}.import`
    await rm(target, { force: true })
    await writeFile(target, text, { encoding: 'utf8', mode: FILE_MODE })
  }
  for (const { real } of files) {
    await rename(`${real}.import`, real)
    await tighten(real, FILE_MODE)
  }
  // Any analysis and index beside it described the rounds this just replaced.
  await rm(join(dir, 'analysis.jsonl'), { force: true })
  await rm(join(dir, 'search.jsonl'), { force: true })

  return {
    slug,
    dir,
    project: name,
    darkened: allDarkened(rounds),
    rounds: totals.rounds,
    sessions: totals.sessions,
    tasks: totals.tasks,
    skipped,
    replaced,
  }
}

/** Where the rounds merged in from other machines are kept, beside the store's own file. */
export const MERGED_FILE = 'merged.jsonl'

export interface MergeResult {
  slug: string
  project: string
  /** Rounds in the file that were new here. */
  added: number
  /** Rounds already merged from an earlier export whose copy in this one says something different. */
  updated: number
  /** Rounds this machine already collected itself, which its own copy outranks. */
  kept: number
  /** Records in the file that were not rounds. */
  skipped: number
  /** Whose work the file holds, by rounds. */
  committers: Array<{ name: string; rounds: number }>
  /** The project's totals after the merge. */
  rounds: number
  sessions: number
}

/** The identity `collect` de-duplicates on. */
function keyOf(round: Round): string {
  return `${round.session}\u0000${round.id}`
}

/**
 * A round as text with its keys in order, so two copies of one round compare equal however each
 * was put together: one read back off disk, one just normalized out of somebody's file.
 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : inner,
  )
}

/**
 * Rewrite a rounds file a line at a time, with each accepted round in place of the stored copy it
 * matches and the rest of them at the end.
 *
 * Streamed in batches, the way a trim is, because these files run to hundreds of megabytes and a
 * merge is not a reason to hold one whole. Written beside and moved over, so an interrupted merge
 * leaves the file as it was. A line that is not a round — torn by an interrupted write — is kept as
 * it is, since this is not the place to decide it is rubbish.
 */
async function rewriteWith(file: string, accepted: Map<string, Round>, visit: (round: Round) => void): Promise<void> {
  const target = `${file}.merge`
  await rm(target, { force: true })
  await appendFile(target, '', { encoding: 'utf8', mode: FILE_MODE })
  const placed = new Set<string>()
  let batch: string[] = []
  // Waited for in step with the reading, for the reason `clearOne` gives.
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    const text = batch.join('\n') + '\n'
    batch = []
    await appendFile(target, text, { encoding: 'utf8', mode: FILE_MODE })
  }
  const put = (round: Round | null, line: string): Promise<void> | undefined => {
    if (round !== null) visit(round)
    batch.push(line)
    return batch.length >= 2000 ? flush() : undefined
  }
  try {
    await eachRoundLine(file, (_at, line) => {
      let round: Round
      try {
        round = asStoredRound(JSON.parse(line) as Round)
      } catch {
        return put(null, line)
      }
      const arriving = accepted.get(keyOf(round))
      if (arriving === undefined) return put(round, line)
      placed.add(keyOf(round))
      return put(arriving, JSON.stringify(arriving))
    })
    for (const [key, round] of accepted) if (!placed.has(key)) await put(round, JSON.stringify(round))
    await flush()
  } catch (error) {
    // The original is untouched; only the half-written copy beside it needs to go.
    await rm(target, { force: true }).catch(() => undefined)
    throw error
  }
  await rename(target, file)
  await tighten(file, FILE_MODE)
}

/**
 * Add another machine's export of a project to the one collected here.
 *
 * The other half of `importProject`. An import is somebody else's project, kept apart; a merge is
 * the same project worked on from two machines, read as one. Every incoming round is named for
 * who recorded it, so the two can still be told apart and filtered.
 *
 * Rounds are matched on `session+id`, the identity `collect` already de-duplicates on. A round
 * already merged is replaced only when the new copy says something different, so merging the same
 * file twice writes nothing at all, and merging a newer export brings only what changed. A round
 * this machine collected itself is never replaced: its own copy is the one with session files
 * behind it.
 *
 * The merged rounds go into `rounds.jsonl` with the rest, so every reader sees them without knowing
 * about merging, and a copy is kept in `merged.jsonl`, because a schema rebuild writes the rounds
 * file afresh from the session copies and merged rounds have none.
 *
 * Two passes over the file rather than one: the first only decides what changes, so a merge that
 * changes nothing never writes, and neither pass holds the store's rounds in memory.
 */
export async function mergeIntoProject(
  dataDir: string,
  slug: string,
  incoming: Round[],
  skipped: number,
): Promise<MergeResult | null> {
  const dir = ownDir(dataDir, slug)
  if (dir === null) return null
  return withProjectLock(dir, () => mergeUnlocked(dir, slug, incoming, skipped))
}

async function mergeUnlocked(
  dir: string,
  slug: string,
  incoming: Round[],
  skipped: number,
): Promise<MergeResult | null> {
  const manifestFile = join(dir, 'manifest.json')
  const manifest = await readJson<Manifest>(manifestFile)
  if (manifest === null) return null

  const roundsFile = join(dir, 'rounds.jsonl')
  const arriving = new Map<string, Round>()
  for (const round of incoming) arriving.set(keyOf(round), round)

  const accepted = new Map<string, Round>()
  const present = new Set<string>()
  let kept = 0
  let updated = 0
  await eachRound(roundsFile, (round) => {
    const key = keyOf(round)
    const next = arriving.get(key)
    if (next === undefined || present.has(key)) return
    present.add(key)
    if (round.committer === undefined) kept += 1
    else if (canonical(round) !== canonical(next)) {
      accepted.set(key, next)
      updated += 1
    }
  })
  let added = 0
  for (const [key, round] of arriving) {
    if (present.has(key)) continue
    accepted.set(key, round)
    added += 1
  }

  const by = new Map<string, number>()
  for (const round of arriving.values()) {
    if (round.committer !== undefined) by.set(round.committer, (by.get(round.committer) ?? 0) + 1)
  }
  const report = (rounds: number, sessions: number, project: string): MergeResult => ({
    slug,
    project,
    added,
    updated,
    kept,
    skipped,
    committers: [...by.entries()].sort((a, b) => b[1] - a[1]).map(([name, rounds]) => ({ name, rounds })),
    rounds,
    sessions,
  })

  if (accepted.size === 0) {
    const stored = asStored(slug, dir, manifest)
    return report(manifest.rounds ?? 0, manifest.sessions ?? 0, stored?.project ?? slug)
  }

  const tally = newTally()
  // The copy first. A merge cut short after it leaves rounds a rebuild still puts back, and that
  // merging again repairs; cut short after the rounds instead, they would look merged, a second
  // merge would find nothing to do, and the next rebuild would drop them.
  await rewriteWith(join(dir, MERGED_FILE), accepted, () => undefined)
  await rewriteWith(roundsFile, accepted, (round) => countRound(tally, round))
  // The analysis and the index beside it were computed from the rounds before these arrived.
  await rm(join(dir, 'analysis.jsonl'), { force: true })
  await rm(join(dir, 'search.jsonl'), { force: true })

  const next: Manifest = {
    ...manifest,
    ...tallied(tally),
    sources: [...new Set([...(manifest.sources ?? []).filter(isAgentSource), ...tally.sources])],
    merged_at: new Date().toISOString(),
    committers: [...tally.committers].sort(),
  }
  const target = `${manifestFile}.merge`
  await writeFile(target, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: FILE_MODE })
  await rename(target, manifestFile)
  await tighten(manifestFile, FILE_MODE)

  const stored = asStored(slug, dir, next)
  return report(next.rounds ?? 0, next.sessions ?? 0, stored?.project ?? slug)
}

/**
 * The counts a manifest carries, taken a round at a time.
 *
 * One accumulator for every writer of a manifest — collect's summary, an import, a merge, a trim —
 * so the totals for the same rounds are the same whichever of them wrote them last.
 */
interface Tally {
  sessions: Set<string>
  tasks: Set<string>
  rounds: number
  in_tokens: number
  in_uncached: number
  in_cache_write: number
  in_cache_write_5m: number
  in_cache_write_1h: number
  in_cache_read: number
  out_tokens: number
  first_ts: string | null
  last_ts: string | null
  /** The agents behind the rounds. */
  sources: Set<AgentSource>
  /** The names merged-in rounds carry. This machine's own carry none. */
  committers: Set<string>
}

function newTally(): Tally {
  return {
    sessions: new Set(),
    tasks: new Set(),
    rounds: 0,
    in_tokens: 0,
    in_uncached: 0,
    in_cache_write: 0,
    in_cache_write_5m: 0,
    in_cache_write_1h: 0,
    in_cache_read: 0,
    out_tokens: 0,
    first_ts: null,
    last_ts: null,
    sources: new Set(),
    committers: new Set(),
  }
}

function countRound(tally: Tally, round: Round): void {
  tally.rounds += 1
  tally.sessions.add(round.session)
  tally.tasks.add(`${round.session}\u0000${round.task}`)
  tally.in_tokens += round.in_tokens || 0
  tally.in_uncached += round.in_uncached || 0
  tally.in_cache_write += round.in_cache_write || 0
  tally.in_cache_write_5m += round.in_cache_write_5m || 0
  tally.in_cache_write_1h += round.in_cache_write_1h || 0
  tally.in_cache_read += round.in_cache_read || 0
  tally.out_tokens += round.out_tokens || 0
  if (typeof round.ts === 'string') {
    if (tally.first_ts === null || round.ts < tally.first_ts) tally.first_ts = round.ts
    if (tally.last_ts === null || round.ts > tally.last_ts) tally.last_ts = round.ts
  }
  if (isAgentSource(round.source ?? '')) tally.sources.add(round.source as AgentSource)
  if (round.committer !== undefined) tally.committers.add(round.committer)
}

/** A tally as the fields of a manifest. */
function tallied(tally: Tally): {
  sessions: number
  rounds: number
  tasks: number
  in_tokens: number
  in_uncached: number
  in_cache_write: number
  in_cache_write_5m: number
  in_cache_write_1h: number
  in_cache_read: number
  out_tokens: number
  first_ts: string | null
  last_ts: string | null
} {
  return {
    sessions: tally.sessions.size,
    rounds: tally.rounds,
    tasks: tally.tasks.size,
    in_tokens: tally.in_tokens,
    in_uncached: tally.in_uncached,
    in_cache_write: tally.in_cache_write,
    in_cache_write_5m: tally.in_cache_write_5m,
    in_cache_write_1h: tally.in_cache_write_1h,
    in_cache_read: tally.in_cache_read,
    out_tokens: tally.out_tokens,
    first_ts: tally.first_ts,
    last_ts: tally.last_ts,
  }
}

/* Renaming and removing: the two things done to a project rather than to what is in it. ---------- */

/**
 * The store directory a slug names, or null when it names nothing this store may touch.
 *
 * `isSlug` already refuses anything with a separator in it, so this is the second of two checks
 * rather than the only one. Both are here because the argument arrives from a URL and the operations
 * below delete a directory: a path that resolves outside `projects/` is not one probez wrote, and
 * cheap certainty is worth more than the line it costs.
 */
function ownDir(dataDir: string, slug: string): string | null {
  if (!isSlug(slug)) return null
  const root = resolve(join(dataDir, 'projects'))
  const dir = resolve(storedDir(dataDir, slug))
  return dir.startsWith(root + sep) ? dir : null
}

/**
 * Give a project a name of your own.
 *
 * The name is a label and nothing else: it does not move the project, does not change its slug, and
 * is not what any URL or file on disk is addressed by. `slugFor` hashes the path an agent ran in, so
 * a project that could be renamed into a different directory could also be renamed on top of
 * another one — this deliberately cannot.
 *
 * An empty name is a revert rather than an error: it clears the override and puts back the name the
 * project's own path gives it.
 */
export async function renameProject(
  dataDir: string,
  slug: string,
  name: string,
): Promise<StoredProject | null> {
  const dir = ownDir(dataDir, slug)
  if (dir === null) return null
  return withProjectLock(dir, () => renameUnlocked(dir, slug, name))
}

async function renameUnlocked(dir: string, slug: string, name: string): Promise<StoredProject | null> {
  const file = join(dir, 'manifest.json')
  const manifest = await readJson<Manifest>(file)
  if (manifest === null) return null

  const chosen = cleanName(name)
  const next: Manifest = { ...manifest, name: chosen === '' ? null : chosen }
  // Written beside and moved over, so an interrupted rename cannot leave a project without the
  // manifest that is the only thing making it readable.
  const target = `${file}.rename`
  await writeFile(target, JSON.stringify(next, null, 2) + '\n', {
    encoding: 'utf8',
    mode: FILE_MODE,
  })
  await rename(target, file)
  await tighten(file, FILE_MODE)
  return asStored(slug, dir, next)
}

export interface RemoveResult {
  slug: string
  project: string
  dir: string
  /** What went with it, so the report can say what was actually given up. */
  rounds: number
  sessions: number
}

/**
 * Remove a project from the store, and everything probez recorded for it.
 *
 * This is the one operation that destroys data, and there is no undo: `rounds.jsonl`, the session
 * copies beside it, the analysis cache and the manifest all go. What is *not* touched is the agent's
 * own session files — probez has only ever read those — so a project removed by mistake comes back
 * with `probez collect`, minus any session the agent has since pruned. That gap is the reason this
 * asks before it runs rather than after.
 */
export async function removeProject(
  dataDir: string,
  slug: string,
): Promise<RemoveResult | null> {
  const dir = ownDir(dataDir, slug)
  if (dir === null) return null
  await sweepRemovals(dataDir)
  // Locked like any other write, so a collect or a merge underway finishes before the directory
  // goes, rather than recreating part of it afterwards.
  return withProjectLock(dir, () => removeUnlocked(dataDir, slug, dir))
}

/**
 * Take a project's directory away in one step, then delete it.
 *
 * The lock file lives inside the directory, so deleting in place unlinks it partway through: a
 * writer in another process polling for the lock takes it there and writes into a folder that is
 * still going, and either loses its work to the rest of the delete or leaves the delete unable to
 * finish. Moved aside first, the directory is simply not there to anyone waiting. The new name
 * starts with a dot, which `isSlug` refuses, so nothing that lists projects ever sees it.
 *
 * Once moved, the project is gone as far as anyone can tell, so a delete of the moved copy that
 * fails or is cut short does not fail the removal. What it left is taken by `sweepRemovals` on
 * the next removal or clear, since nothing that lists projects would ever find it.
 */
async function removeProjectDir(dir: string): Promise<void> {
  const aside = join(dirname(dir), `${REMOVING}${basename(dir)}-${randomUUID()}`)
  try {
    await rename(dir, aside)
  } catch (error) {
    if (isMissing(error)) return
    // Windows refuses to move a folder while another program holds a file in it open. Deleting in
    // place is what this did before, and is still better than leaving the project behind.
    await rm(dir, { recursive: true, force: true })
    return
  }
  await rm(aside, { recursive: true, force: true }).catch(() => undefined)
}

const REMOVING = '.removing-'

/**
 * Finish removals that did not: a Ctrl-C partway through, or a file another program held open.
 *
 * Each one was a project already moved out of the list, so nothing writes to it and nothing
 * else would remove it. One still being deleted by another process is safe to take as well,
 * because both deletes skip what is already gone. Whatever still cannot go waits for the next.
 */
async function sweepRemovals(dataDir: string): Promise<void> {
  const root = join(dataDir, 'projects')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(REMOVING)) continue
    await rm(join(root, entry.name), { recursive: true, force: true }).catch(() => undefined)
  }
}

async function removeUnlocked(dataDir: string, slug: string, dir: string): Promise<RemoveResult | null> {
  const stored = await findStored(dataDir, slug)
  if (stored === null) return null
  await removeProjectDir(dir)
  return {
    slug,
    project: stored.project,
    dir,
    rounds: stored.rounds,
    sessions: stored.sessions,
  }
}

/* Clearing: the two operations that destroy more than one project. ---------------------------- */

/**
 * What a clear would remove, worked out before anything is removed.
 *
 * Split in two on purpose. `removeProject` could be called in a loop and be done with it, but then
 * the only way to find out what a clear would take is to let it take it — and every surface here
 * has to say what is about to go before it goes: the command shows this and waits for an answer,
 * and the view shows the same figures in the panel that asks. One plan, computed once, so what you
 * are shown and what happens cannot come apart.
 */
export interface ClearPlan {
  /**
   * The cutoff, as epoch milliseconds. Null clears everything, whatever its age.
   *
   * A *session* is the unit either way: one whose last round is older than this goes entirely —
   * its rounds and the archived copy beside them — and one with any round newer stays whole. That
   * keeps a long-lived project's recent work while still reclaiming the archived transcripts,
   * which are the great majority of what a store weighs, and it never leaves a session half
   * trimmed for `trails --deep` to read back inconsistently.
   */
  before: number | null
  projects: ClearPlanProject[]
  totals: {
    projects: number
    /** Of those, the ones nothing would survive in, which go entirely. */
    whole: number
    sessions: number
    rounds: number
    bytes: number
  }
}

export interface ClearPlanProject {
  slug: string
  project: string
  dir: string
  /** How many sessions would go. */
  sessions: number
  /**
   * Which ones, for a trim. Empty when the whole project goes, because then nothing has to be
   * named — the directory is removed entire — and an imported project has no session state to
   * name them from anyway.
   */
  ids: string[]
  /** Rounds in those sessions. */
  rounds: number
  /** What would actually be freed: the files that get deleted. */
  bytes: number
  /** True when nothing would survive, so the project is removed rather than trimmed. */
  whole: boolean
  /**
   * A directory this probez cannot read: a manifest of another schema, or none at all. Only a
   * clear of everything plans these, and always whole, since there is nothing to trim them by.
   */
  unreadable?: true
}

/** Every byte under a directory, for saying what a removal actually frees. */
async function dirSize(dir: string): Promise<number> {
  let total = 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += await dirSize(path)
    else total += await stat(path).then((info) => info.size).catch(() => 0)
  }
  return total
}

async function fileSize(path: string): Promise<number> {
  return stat(path).then((info) => info.size).catch(() => 0)
}

/**
 * When each session was last active.
 *
 * From the rounds, which is the honest answer: a session is as old as the newest work in it. A
 * session the store has an archived copy of but no rounds for — an extraction that yielded nothing,
 * or a copy left by an older probez — is dated by what `state.json` recorded of the agent's own
 * file instead, so it can be cleared rather than accumulating forever with no way to name its age.
 */
async function sessionAges(dir: string): Promise<Map<string, number>> {
  const last = new Map<string, number>()
  await eachRound(join(dir, 'rounds.jsonl'), (round) => {
    if (typeof round.ts !== 'string') return
    const at = Date.parse(round.ts)
    if (Number.isNaN(at)) return
    const seen = last.get(round.session)
    if (seen === undefined || at > seen) last.set(round.session, at)
  })
  const state = await readJson<State>(join(dir, 'state.json'))
  for (const [id, one] of Object.entries(state?.sessions ?? {})) {
    if (!last.has(id)) last.set(id, one.mtimeMs)
  }
  return last
}

/**
 * Every directory under `projects/` that `listStored` passes over, as a whole removal.
 *
 * Mostly projects collected by an older probez. `collect` rebuilds those from their session copies,
 * but only while the agent's own transcripts still exist; once the agent has pruned them, nothing
 * rebuilds the project, nothing lists it, and without this nothing could remove it either. It also
 * catches a first collect that died before it wrote a manifest.
 */
async function unreadableProjects(dataDir: string, readable: Set<string>): Promise<ClearPlanProject[]> {
  const entries = await readdir(join(dataDir, 'projects'), { withFileTypes: true }).catch(() => [])
  const found: ClearPlanProject[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || readable.has(entry.name)) continue
    const dir = ownDir(dataDir, entry.name)
    if (dir === null) continue
    const manifest = await readJson<Manifest>(join(dir, 'manifest.json'))
    found.push({
      slug: entry.name,
      project: manifest?.project ?? entry.name,
      dir,
      sessions: manifest?.sessions ?? 0,
      ids: [],
      rounds: manifest?.rounds ?? 0,
      bytes: await dirSize(dir),
      whole: true,
      unreadable: true,
    })
  }
  return found
}

/**
 * Work out what a clear would take.
 *
 * Reads and writes nothing. Every count in it comes from the store as it stands, so a plan shown to
 * someone is a plan of what is there now — and `applyClear` reads the store again rather than
 * trusting these numbers, so a store that moved in between is trimmed correctly and merely reported
 * approximately.
 */
export async function planClear(
  dataDir: string,
  options: { before?: number | null; slug?: string } = {},
): Promise<ClearPlan> {
  const before = options.before ?? null
  const stored = await listStored(dataDir)
  const wanted = options.slug === undefined ? stored : stored.filter((row) => row.slug === options.slug)
  const projects: ClearPlanProject[] = []

  for (const row of wanted) {
    if (ownDir(dataDir, row.slug) === null) continue

    if (before === null) {
      projects.push({
        slug: row.slug,
        project: row.project,
        dir: row.dir,
        // The manifest's count, not the state's: an import has rounds and no state at all, and
        // reporting nought sessions for a project plainly full of them is worse than no count.
        sessions: row.sessions,
        ids: [],
        rounds: row.rounds,
        bytes: await dirSize(row.dir),
        whole: true,
      })
      continue
    }

    const ages = await sessionAges(row.dir)
    const doomed = new Set([...ages.entries()].filter(([, at]) => at < before).map(([id]) => id))
    if (doomed.size === 0) continue

    let rounds = 0
    await eachRound(join(row.dir, 'rounds.jsonl'), (round) => {
      if (doomed.has(round.session)) rounds += 1
    })

    const whole = doomed.size === ages.size
    let bytes = 0
    if (whole) {
      bytes = await dirSize(row.dir)
    } else {
      for (const id of doomed) {
        bytes += await fileSize(join(row.dir, 'sessions', safeSessionFilename(id)))
      }
      // Both are derived from the rounds and are rebuilt on the next analyze or collect, so what
      // they take back is real but temporary. Counted, because it is freed.
      bytes += await fileSize(join(row.dir, 'analysis.jsonl'))
      bytes += await fileSize(join(row.dir, 'search.jsonl'))
    }

    projects.push({
      slug: row.slug,
      project: row.project,
      dir: row.dir,
      sessions: doomed.size,
      ids: whole ? [] : [...doomed],
      rounds,
      bytes,
      whole,
    })
  }

  // Everything means everything, including what this probez can no longer read. A window cannot
  // date these and a name cannot reach them, so only a clear of everything takes them.
  if (before === null && options.slug === undefined) {
    projects.push(...(await unreadableProjects(dataDir, new Set(stored.map((row) => row.slug)))))
  }

  return {
    before,
    projects,
    totals: {
      projects: projects.length,
      whole: projects.filter((one) => one.whole).length,
      sessions: projects.reduce((sum, one) => sum + one.sessions, 0),
      rounds: projects.reduce((sum, one) => sum + one.rounds, 0),
      bytes: projects.reduce((sum, one) => sum + one.bytes, 0),
    },
  }
}

export interface ClearResult {
  projects: number
  /** Of those, removed entirely rather than trimmed. */
  whole: number
  sessions: number
  rounds: number
  bytes: number
  /** What went entirely, by name, so a report can say rather than count. */
  removed: string[]
  /**
   * What was left as it was because another writer held it past the wait, by name. The rest of
   * the clear goes on without it, and a clear run again later takes it.
   */
  locked: string[]
  /**
   * What could not be cleared for any other reason — a file another program holds open, a full
   * disk — by name, with what went wrong. Like a locked one it is passed over rather than ending
   * the clear; unlike one, waiting will not fix it on its own.
   */
  failed: Array<{ project: string; error: string }>
}

/**
 * Carry out a plan.
 *
 * Every project is reached through `ownDir`, the same fence `removeProject` uses: the slug must
 * have the shape `slugFor` produces and the path it resolves to must be under
 * `<data-dir>/projects/`. Nothing outside the store is reachable from here, whatever a plan says.
 *
 * Trimming a project rewrites `rounds.jsonl` beside itself and moves the new file over the old one,
 * so an interrupted clear leaves the store as it was rather than half of it. The two derived files
 * are deleted rather than updated — they are cheaper to rebuild than to repair, and a stale index
 * is the one thing worse than no index.
 *
 * What is never touched, here as everywhere: the agent's own session files. A session cleared by
 * mistake comes back with `probez collect`, minus whatever the agent has pruned since.
 */
export async function applyClear(
  dataDir: string,
  plan: ClearPlan,
  guard: <T>(slug: string, work: () => Promise<T>) => Promise<T> = (_slug, work) => work(),
): Promise<ClearResult> {
  const result: ClearResult = {
    projects: 0,
    whole: 0,
    sessions: 0,
    rounds: 0,
    bytes: 0,
    removed: [],
    locked: [],
    failed: [],
  }
  await sweepRemovals(dataDir)
  // Each project in turn, and each through `guard`: the view passes its own per-project queue, so
  // a clear waits for a sync or a merge it started on the same project rather than racing it.
  //
  // One project that cannot be cleared is passed over rather than ending the clear, whatever the
  // reason. The projects before it are already gone, with no undo, so stopping there would leave
  // the rest untouched and the report of what went thrown away with the error. Every project's
  // trim moves a whole new file over its rounds, so the one that failed is either as it was or
  // trimmed, and the report says which projects to look at.
  for (const one of plan.projects) {
    try {
      await guard(one.slug, () => clearOne(dataDir, plan.before, one, result))
    } catch (error) {
      if (error instanceof ProjectLocked) result.locked.push(one.project)
      else result.failed.push({ project: one.project, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

/** Take one project's share of a clear, adding what went to `result`. */
async function clearOne(
  dataDir: string,
  before: number | null,
  one: ClearPlanProject,
  result: ClearResult,
): Promise<void> {
  const dir = ownDir(dataDir, one.slug)
  if (dir === null) return

  const removed = (rounds: number, project: string): void => {
    result.projects += 1
    result.whole += 1
    result.sessions += one.sessions
    result.rounds += rounds
    result.bytes += one.bytes
    result.removed.push(project)
  }

  // `removeProject` reads the manifest to report what went, and these have none it can read.
  // The plan's figures are all there is, and the fence above is the same one it applies.
  if (one.whole && one.unreadable === true) {
    if (!(await stat(dir).then(() => true, () => false))) return
    await withProjectLock(dir, () => removeProjectDir(dir))
    removed(one.rounds, one.project)
    return
  }

  // Everything means everything, whatever arrived since the plan was shown.
  if (before === null) {
    const gone = await removeProject(dataDir, one.slug)
    if (gone !== null) removed(gone.rounds, gone.project)
    return
  }

  // A window is decided again here, under the lock, from what is on disk now. The plan was made
  // before waiting for any sync or merge running on this project, and what those added is newer
  // than the window: a session that gained a recent round is no longer old, and a project that
  // gained one is no longer one to remove whole.
  const outcome = await withProjectLock(
    dir,
    async (): Promise<{ whole: RemoveResult } | { dropped: number; sessions: number } | null> => {
      const ages = await sessionAges(dir)
      const doomed = new Set([...ages.entries()].filter(([, at]) => at < before).map(([id]) => id))
      if (doomed.size === 0) return null
      if (doomed.size === ages.size) {
        const gone = await removeUnlocked(dataDir, one.slug, dir)
        return gone === null ? null : { whole: gone }
      }

      const roundsFile = join(dir, 'rounds.jsonl')
      const target = `${roundsFile}.trim`
      await rm(target, { force: true })

      let kept: string[] = []
      let dropped = 0
      // Written out in batches rather than held whole: a project's rounds are the one thing here
      // that can be tens of megabytes, and the point of this command is a store that got too big.
      //
      // Each batch is waited for before the next line is read, and that is load-bearing three ways.
      // Appends never overlap, so they land in file order, which is the order `rounds.jsonl` is read
      // back in. A failed one (a full disk, a file another program holds) stops the read and
      // is thrown from here, rather than left a rejected promise nobody is listening to, which would
      // take the whole process down. And the read cannot outrun the disk, so no more than one batch
      // is ever held, however large the project.
      const flush = async (): Promise<void> => {
        if (kept.length === 0) return
        const batch = kept.join('\n') + '\n'
        kept = []
        await appendFile(target, batch, { encoding: 'utf8', mode: FILE_MODE })
      }
      try {
        await eachRound(roundsFile, (round) => {
          if (doomed.has(round.session)) {
            dropped += 1
            return
          }
          kept.push(JSON.stringify(round))
          return kept.length >= 2000 ? flush() : undefined
        })
        await flush()
      } catch (error) {
        // The original is untouched; only the half-written copy beside it needs to go.
        await rm(target, { force: true }).catch(() => undefined)
        throw error
      }

      // Nothing left after all: removed rather than left with an empty file.
      const survived = await fileSize(target)
      if (survived === 0) {
        await rm(target, { force: true })
        const gone = await removeUnlocked(dataDir, one.slug, dir)
        return gone === null ? null : { whole: gone }
      }

      await rename(target, roundsFile)
      await tighten(roundsFile, FILE_MODE)

      for (const id of doomed) {
        await rm(join(dir, 'sessions', safeSessionFilename(id)), { force: true })
      }
      // Merged rounds have a copy of their own, which a rebuild puts back; a session cleared from
      // the rounds has to go from there too, or the next rebuild would quietly undo the clear.
      await dropSessions(join(dir, MERGED_FILE), doomed)

      // The state is what tells the next collect a session is already read. A session that is no
      // longer here has not been read, and saying otherwise would mean it never came back.
      const state = await readJson<State>(join(dir, 'state.json'))
      if (state !== null) {
        for (const id of doomed) delete state.sessions[id]
        await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n', {
          encoding: 'utf8',
          mode: FILE_MODE,
        })
        // `mode` above applies only when the file is created, and this one already existed. A store
        // that was once left world-readable would otherwise stay that way through a trim.
        await tighten(join(dir, 'state.json'), FILE_MODE)
      }

      await rm(join(dir, 'analysis.jsonl'), { force: true })
      await rm(join(dir, 'search.jsonl'), { force: true })
      await refreshManifest(dataDir, one.slug, dir)
      return { dropped, sessions: doomed.size }
    },
  )
  if (outcome === null) return
  if ('whole' in outcome) {
    removed(outcome.whole.rounds, outcome.whole.project)
    return
  }
  result.projects += 1
  result.sessions += outcome.sessions
  result.rounds += outcome.dropped
  result.bytes += one.bytes
}

/** Take these sessions' rounds out of a rounds file, streamed, leaving it untouched if it has none. */
async function dropSessions(file: string, doomed: ReadonlySet<string>): Promise<void> {
  let found = false
  await eachRound(file, (round) => {
    if (doomed.has(round.session)) found = true
  })
  if (!found) return
  const target = `${file}.trim`
  await rm(target, { force: true })
  await appendFile(target, '', { encoding: 'utf8', mode: FILE_MODE })
  let kept: string[] = []
  // Waited for in step with the reading, for the reason `clearOne` gives.
  const flush = async (): Promise<void> => {
    if (kept.length === 0) return
    const batch = kept.join('\n') + '\n'
    kept = []
    await appendFile(target, batch, { encoding: 'utf8', mode: FILE_MODE })
  }
  try {
    await eachRound(file, (round) => {
      if (doomed.has(round.session)) return
      kept.push(JSON.stringify(round))
      return kept.length >= 2000 ? flush() : undefined
    })
    await flush()
  } catch (error) {
    await rm(target, { force: true }).catch(() => undefined)
    throw error
  }
  await rename(target, file)
  await tighten(file, FILE_MODE)
}

/**
 * Recount a manifest from the rounds that are left.
 *
 * A trimmed project whose manifest still claimed the old totals would report a session count and a
 * token bill for work that is no longer in the store, and every share drawn from it would be wrong.
 * Everything that is not a count — the chosen name, the path, where it came from — is carried
 * across untouched.
 */
async function refreshManifest(dataDir: string, slug: string, dir: string): Promise<void> {
  const manifest = await readJson<Manifest>(join(dir, 'manifest.json'))
  if (manifest === null) return
  // Which agents and whose work are still in it, read back off the rounds that survived. A trim can
  // take the last Codex session out of a project two agents worked in, and a manifest that went on
  // listing Codex would offer the view a source filter with nothing behind it.
  const tally = newTally()
  await eachRound(join(dir, 'rounds.jsonl'), (round) => countRound(tally, round))
  const next: Manifest = {
    ...manifest,
    ...tallied(tally),
    sources: [...tally.sources],
    committers: [...tally.committers].sort(),
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(next, null, 2) + '\n', {
    encoding: 'utf8',
    mode: FILE_MODE,
  })
  await tighten(join(dir, 'manifest.json'), FILE_MODE)
}
