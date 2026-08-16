import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

import { extractSession } from './extract.js'
import type { Project, Round, SessionFile } from './types.js'

const SCHEMA_VERSION = 2

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
  project: string
  path: string | null
  key: string
  source_dir: string | null
  sessions: number
  rounds: number
  tasks: number
  in_tokens: number
  in_uncached: number
  in_cache_write: number
  in_cache_read: number
  out_tokens: number
  first_ts: string | null
  last_ts: string | null
  collected_at: string | null
}

interface Manifest {
  schema_version?: number
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
  in_cache_read?: number
  out_tokens?: number
  first_ts?: string | null
  last_ts?: string | null
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
  return {
    slug,
    dir,
    project: manifest.project ?? slug,
    path: manifest.path ?? null,
    key: manifest.key ?? slug,
    source_dir: manifest.source_dir ?? null,
    sessions: manifest.sessions ?? 0,
    rounds: manifest.rounds ?? 0,
    tasks: manifest.tasks ?? 0,
    in_tokens: manifest.in_tokens ?? 0,
    in_uncached: manifest.in_uncached ?? 0,
    in_cache_write: manifest.in_cache_write ?? 0,
    in_cache_read: manifest.in_cache_read ?? 0,
    out_tokens: manifest.out_tokens ?? 0,
    first_ts: manifest.first_ts ?? null,
    last_ts: manifest.last_ts ?? null,
    collected_at: manifest.collected_at ?? null,
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

interface State {
  schema_version: number
  sessions: Record<string, { size: number; mtimeMs: number }>
}

export function defaultDataDir(): string {
  return process.env.PROBEZ_DATA_DIR || join(homedir(), '.probez')
}

/**
 * Stable directory name for a project: readable basename plus a hash of the absolute path, so the
 * same project always lands in the same place and two repos sharing a basename never collide.
 */
export function slugFor(project: Project): string {
  const source = project.path ?? project.key
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 8)
  const name = (project.path ? basename(project.path) : project.key).replace(/[^A-Za-z0-9._-]/g, '-')
  return `${name || 'project'}-${hash}`
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

/** Bumped when a change to `classify.ts` would give the same rounds different labels. */
export const ANALYZER_VERSION = 1

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
const DIR_MODE = 0o700
const FILE_MODE = 0o600
/** Any bit granting group or other access. */
const SHARED_BITS = 0o077

/**
 * Tighten one path if it is readable by anyone but its owner.
 *
 * probez distils the agent's `0600` logs into `rounds.jsonl`, so writing that extract at the
 * default `0644` would publish, to every local account, what the source deliberately kept private.
 * New stores are created owner-only; this repairs the ones written before that was true. It only
 * ever removes access, never grants it, and only inside the data directory.
 */
async function tighten(path: string, mode: number): Promise<void> {
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
 * Every round recorded for a project, in the order it was collected. The read commands sort and
 * filter across the whole set, so this holds it in memory rather than streaming. A store is a few
 * megabytes even after months of sessions.
 */
export async function readRounds(project: Project, dataDir: string): Promise<Round[]> {
  return readRoundsIn(projectDir(dataDir, project))
}

/** The same read, addressed by the store directory itself, which is all a slug resolves to. */
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

/**
 * The sessions a rebuild has to read: the ones still in the agent's directory, plus the ones only
 * this store still has.
 *
 * Agents prune old sessions, which is the whole reason `sessions/` exists. Rebuilding from the
 * agent's directory alone would quietly drop every round belonging to a session that has since been
 * pruned — the store would come back smaller than it went in.
 */
async function withArchived(live: SessionFile[], sessionsDir: string): Promise<SessionFile[]> {
  const out = [...live]
  const known = new Set(live.map((session) => session.id))
  for (const name of await readdir(sessionsDir).catch(() => [] as string[])) {
    if (!name.endsWith('.jsonl')) continue
    const id = name.slice(0, -'.jsonl'.length)
    if (known.has(id)) continue
    const file = join(sessionsDir, name)
    const info = await stat(file).catch(() => null)
    if (info === null) continue
    out.push({ id, file, size: info.size, mtimeMs: info.mtimeMs })
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
  options: { full?: boolean } = {},
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
  const sources = outdated ? await withArchived(project.sessions, sessionsDir) : project.sessions
  // Rebuilding needs something to rebuild from. Discovery never yields a project with no sessions,
  // so this only guards a caller that built a `Project` by hand: with nothing to read, the old
  // rounds are all there is, and keeping them at the version they were written for beats replacing
  // them with nothing.
  const rebuild = outdated && sources.length > 0
  const version = outdated && !rebuild ? (stored?.schema_version ?? SCHEMA_VERSION) : SCHEMA_VERSION
  const state =
    (options.full || rebuild ? null : stored) ??
    ({ schema_version: version, sessions: {} } as State)

  const stale = sources.filter((session) => {
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

  let newRounds = 0
  for (const session of stale) {
    const rounds = await extractSession(session.file, session.id)
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
    const archived = join(sessionsDir, `${session.id}.jsonl`)
    if (session.file !== archived) await copyFile(session.file, archived)
    state.sessions[session.id] = { size: session.size, mtimeMs: session.mtimeMs }
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

  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        schema_version: version,
        project: summary.project,
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
        in_cache_read: summary.in_cache_read,
        out_tokens: summary.out_tokens,
        first_ts: summary.first_ts,
        last_ts: summary.last_ts,
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
    new_rounds: newRounds,
    read_sessions: stale.length,
    skipped_sessions: sources.length - stale.length,
    rebuilt: rebuild,
  }
}
