import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
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

import { isAgentSource, safeSessionFilename, sessionIdFromFilename } from './agents/paths.js'
import { readToolResults } from './result.js'
import { extractCursorSession } from './extract-cursor.js'
import { extractSession } from './extract.js'
import { readHeadHistory } from './git.js'
import { CONTROL } from './import.js'
import type { AgentSource, Project, Round, SessionFile } from './types.js'

const SCHEMA_VERSION = 6

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
  /** Which agents contributed sessions. Absent on stores written before sources were recorded. */
  sources: AgentSource[]
}

interface Manifest {
  schema_version?: number
  /** Set only on a project that arrived as a file. Absent means it was collected here. */
  imported_at?: string | null
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
    sources: (manifest.sources ?? []).filter(isAgentSource),
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
  source?: AgentSource
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

/** Replace the cached analysis wholesale. Recomputing is cheap, so there is no incremental path. */
export async function writeAnalysis(
  file: string,
  header: Omit<AnalysisHeader, 'schema_version' | 'analyzer_version' | 'analyzed_at'>,
  records: unknown[],
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
  await mkdir(dirname(file), { recursive: true, mode: DIR_MODE })
  await writeFile(file, lines.join('\n') + '\n', { encoding: 'utf8', mode: FILE_MODE })
  await tighten(file, FILE_MODE)
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

/** Stream rounds.jsonl once, calling back with each parsed round. */
export async function eachRound(file: string, visit: (round: Round) => void): Promise<void> {
  let stream
  try {
    stream = createReadStream(file, { encoding: 'utf8' })
  } catch {
    return
  }
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (line.trim() === '') continue
      try {
        visit(JSON.parse(line) as Round)
      } catch {
        // a torn line from an interrupted write; skip it
      }
    }
  } catch {
    // file does not exist yet
  }
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
  visit: (at: number, line: string, offset: number, bytes: number) => void,
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
  try {
    for await (const line of lines) {
      const bytes = Buffer.byteLength(line, 'utf8')
      if (line.trim() !== '') {
        visit(at, line, offset, bytes)
        at += 1
      }
      offset += bytes + 1
    }
  } catch {
    // file does not exist yet
  }
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
      found.set(at, JSON.parse(line) as Round)
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
        found.set(one.at, JSON.parse(buffer.toString('utf8')) as Round)
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

export async function summarize(project: Project, dataDir: string): Promise<Summary> {
  const dir = projectDir(dataDir, project)
  const sessions = new Set<string>()
  const tasksBySession = new Map<string, Set<number>>()
  const toolCalls = new Map<string, number>()
  let rounds = 0
  let inTokens = 0
  let uncached = 0
  let cacheWrite = 0
  let write5m = 0
  let write1h = 0
  let cacheRead = 0
  let outTokens = 0
  let first: string | null = null
  let last: string | null = null

  await eachRound(join(dir, 'rounds.jsonl'), (round) => {
    rounds += 1
    sessions.add(round.session)
    inTokens += round.in_tokens || 0
    uncached += round.in_uncached || 0
    cacheWrite += round.in_cache_write || 0
    write5m += round.in_cache_write_5m || 0
    write1h += round.in_cache_write_1h || 0
    cacheRead += round.in_cache_read || 0
    outTokens += round.out_tokens || 0
    let tasks = tasksBySession.get(round.session)
    if (tasks === undefined) {
      tasks = new Set()
      tasksBySession.set(round.session, tasks)
    }
    tasks.add(round.task)
    if (typeof round.ts === 'string') {
      if (first === null || round.ts < first) first = round.ts
      if (last === null || round.ts > last) last = round.ts
    }
    for (const tool of round.tools ?? []) {
      if (typeof tool.name !== 'string') continue
      toolCalls.set(tool.name, (toolCalls.get(tool.name) ?? 0) + 1)
    }
  })

  const manifest = await readJson<{ collected_at?: string }>(join(dir, 'manifest.json'))
  let tasks = 0
  for (const set of tasksBySession.values()) tasks += set.size

  return {
    project: project.path ? basename(project.path) : project.key,
    path: project.path,
    slug: slugFor(project),
    dir,
    sessions: sessions.size,
    rounds,
    tasks,
    in_tokens: inTokens,
    in_uncached: uncached,
    in_cache_write: cacheWrite,
    in_cache_write_5m: write5m,
    in_cache_write_1h: write1h,
    in_cache_read: cacheRead,
    out_tokens: outTokens,
    first_ts: first,
    last_ts: last,
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
 * state entry is gone, and the id cannot settle it: both agents name a subagent's transcript for
 * the path it sits at, so a `/` in the id says a subagent wrote it and nothing about which agent
 * did. The records themselves are unambiguous — Claude rows are typed and carry a `sessionId`,
 * Cursor rows carry a `role` and nothing else — so read one.
 */
async function sniffSource(file: string): Promise<AgentSource> {
  const handle = await open(file, 'r').catch(() => null)
  if (handle === null) return 'claude-code'
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
    if (typeof row.type === 'string' || typeof row.sessionId === 'string') return 'claude-code'
    if (typeof row.role === 'string') return 'cursor'
  }
  return 'claude-code'
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
    const source: AgentSource =
      recorded !== undefined && isAgentSource(recorded) ? recorded : await sniffSource(file)
    out.push({ id, file, size: info.size, mtimeMs: info.mtimeMs, source })
    known.add(id)
  }
  return out
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
  options: { full?: boolean; since?: number } = {},
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
  if (rebuild) await rm(target, { force: true })

  // Read once for the whole project rather than per session: it is one file, and every session
  // here ran in the same checkout. A project that is not in a repository comes back null and every
  // round it yields is recorded with no commit, which is the honest answer rather than a failure.
  const head = stale.length > 0 ? await readHeadHistory(project.path) : null

  let newRounds = 0
  for (const session of stale) {
    const rounds =
      session.source === 'cursor'
        ? await extractCursorSession(session.file, session.id, head)
        : await extractSession(session.file, session.id, head)
    const lines: string[] = []
    for (const round of rounds) {
      const key = `${round.session}\u0000${round.id}`
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      lines.push(JSON.stringify(round))
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
    await rename(target, roundsFile)
    // The analysis beside it was computed from rounds that no longer exist in this shape.
    await rm(join(dir, 'analysis.jsonl'), { force: true })
  }

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
        sources: project.sources ?? [...new Set(project.sessions.map((session) => session.source))],
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
  const before = await readJson<Manifest>(join(dir, 'manifest.json'))
  const replaced = before !== null

  await mkdir(dir, { recursive: true, mode: DIR_MODE })
  for (const path of [dataDir, join(dataDir, 'projects'), dir]) await tighten(path, DIR_MODE)

  // Written beside and moved over, so an interrupted import cannot leave half a project behind.
  const target = join(dir, 'rounds.jsonl.import')
  await rm(target, { force: true })
  await writeFile(target, rounds.map((round) => JSON.stringify(round)).join('\n') + '\n', {
    encoding: 'utf8',
    mode: FILE_MODE,
  })
  await rename(target, join(dir, 'rounds.jsonl'))
  // Any analysis beside it described the rounds this just replaced.
  await rm(join(dir, 'analysis.jsonl'), { force: true })

  const sessions = new Set<string>()
  const tasks = new Set<string>()
  let inTokens = 0
  let uncached = 0
  let cacheWrite = 0
  let write5m = 0
  let write1h = 0
  let cacheRead = 0
  let outTokens = 0
  let first: string | null = null
  let last: string | null = null
  for (const round of rounds) {
    sessions.add(round.session)
    tasks.add(`${round.session} ${round.task}`)
    inTokens += round.in_tokens || 0
    uncached += round.in_uncached || 0
    cacheWrite += round.in_cache_write || 0
    write5m += round.in_cache_write_5m || 0
    write1h += round.in_cache_write_1h || 0
    cacheRead += round.in_cache_read || 0
    outTokens += round.out_tokens || 0
    if (typeof round.ts === 'string') {
      if (first === null || round.ts < first) first = round.ts
      if (last === null || round.ts > last) last = round.ts
    }
  }

  const now = new Date().toISOString()
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
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
        sessions: sessions.size,
        rounds: rounds.length,
        tasks: tasks.size,
        in_tokens: inTokens,
        in_uncached: uncached,
        in_cache_write: cacheWrite,
        in_cache_write_5m: write5m,
        in_cache_write_1h: write1h,
        in_cache_read: cacheRead,
        out_tokens: outTokens,
        first_ts: first,
        last_ts: last,
      },
      null,
      2,
    ) + '\n',
    { encoding: 'utf8', mode: FILE_MODE },
  )

  for (const file of [join(dir, 'rounds.jsonl'), join(dir, 'manifest.json')]) {
    await tighten(file, FILE_MODE)
  }

  return {
    slug,
    dir,
    project: name,
    rounds: rounds.length,
    sessions: sessions.size,
    tasks: tasks.size,
    skipped,
    replaced,
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
  const stored = await findStored(dataDir, slug)
  if (stored === null) return null
  await rm(dir, { recursive: true, force: true })
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
export async function applyClear(dataDir: string, plan: ClearPlan): Promise<ClearResult> {
  const result: ClearResult = { projects: 0, whole: 0, sessions: 0, rounds: 0, bytes: 0, removed: [] }

  for (const one of plan.projects) {
    const dir = ownDir(dataDir, one.slug)
    if (dir === null) continue

    if (one.whole) {
      const gone = await removeProject(dataDir, one.slug)
      if (gone === null) continue
      result.projects += 1
      result.whole += 1
      result.sessions += one.sessions
      result.rounds += gone.rounds
      result.bytes += one.bytes
      result.removed.push(gone.project)
      continue
    }

    const doomed = new Set(one.ids)
    const roundsFile = join(dir, 'rounds.jsonl')
    const target = `${roundsFile}.trim`
    await rm(target, { force: true })

    let kept: string[] = []
    let dropped = 0
    // Written out in batches rather than held whole: a project's rounds are the one thing here
    // that can be tens of megabytes, and the point of this command is a store that got too big.
    //
    // Two things about this are load-bearing. The buffer is taken and reset in the same tick, so a
    // round arriving while a write is in flight cannot be swallowed by the reset. And the writes
    // are chained rather than awaited together, because appends that overlap land in whatever order
    // the filesystem finishes them and `rounds.jsonl` is read back in file order.
    let writing: Promise<void> = Promise.resolve()
    const flush = (): void => {
      if (kept.length === 0) return
      const batch = kept.join('\n') + '\n'
      kept = []
      writing = writing.then(() =>
        appendFile(target, batch, { encoding: 'utf8', mode: FILE_MODE }),
      )
    }
    await eachRound(roundsFile, (round) => {
      if (doomed.has(round.session)) {
        dropped += 1
        return
      }
      kept.push(JSON.stringify(round))
      if (kept.length >= 2000) flush()
    })
    flush()
    await writing

    // A project whose rounds all turned out to be doomed after all — the store moved since the
    // plan was made — is removed rather than left with an empty file.
    const survived = await fileSize(target)
    if (survived === 0) {
      await rm(target, { force: true })
      const gone = await removeProject(dataDir, one.slug)
      if (gone !== null) {
        result.projects += 1
        result.whole += 1
        result.sessions += one.sessions
        result.rounds += gone.rounds
        result.bytes += one.bytes
        result.removed.push(gone.project)
      }
      continue
    }

    await rename(target, roundsFile)
    await tighten(roundsFile, FILE_MODE)

    for (const id of doomed) {
      await rm(join(dir, 'sessions', safeSessionFilename(id)), { force: true })
    }

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

    result.projects += 1
    result.sessions += doomed.size
    result.rounds += dropped
    result.bytes += one.bytes
  }

  return result
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
  const summary = await summarize(
    { key: manifest.key ?? slug, path: manifest.path ?? null, dir: '', sessions: [], lastActivity: 0, slug },
    dataDir,
  )
  const next: Manifest = {
    ...manifest,
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
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(next, null, 2) + '\n', {
    encoding: 'utf8',
    mode: FILE_MODE,
  })
  await tighten(join(dir, 'manifest.json'), FILE_MODE)
}
