import { open, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'

import {
  defaultClaudeDir,
  defaultClineDirs,
  defaultCodexDir,
  defaultCopilotDir,
  defaultCursorDir,
  defaultGooseDir,
  defaultOpencodeDir,
  defaultPiDir,
  pathFromCursorSlug,
  wantsClaude,
  wantsCline,
  wantsCodex,
  wantsCopilot,
  wantsCursor,
  wantsGoose,
  wantsOpencode,
  wantsPi,
} from './agents/paths.js'
import type { SourceFilter } from './agents/paths.js'
import { listClineSessions } from './extract-cline.js'
import { canReadGooseDb, listGooseSessions } from './extract-goose.js'
import { canReadOpencodeDb, listOpencodeSessions } from './extract-opencode.js'
import type { AgentSource, Project, SessionFile } from './types.js'

export {
  defaultClaudeDir,
  defaultClineDirs,
  defaultCodexDir,
  defaultCopilotDir,
  defaultCursorDir,
  defaultGooseDir,
  defaultOpencodeDir,
  defaultPiDir,
}
export type { SourceFilter }

/** How much of a session file to scan for the record carrying `cwd`. */
const CWD_SCAN_BYTES = 256 * 1024

export interface DiscoverOptions {
  claudeDir: string
  cursorDir: string
  codexDir: string
  copilotDir: string
  piDir: string
  opencodeDir: string
  gooseDir: string
  /** Cline's data directories, each of which may hold SDK `sessions/` and legacy `tasks/`. */
  clineDirs: string[]
  source?: SourceFilter
}

/**
 * The agent names each project directory by replacing "/" with "-" in the working directory.
 * That encoding is lossy: "-Users-me-BizDev-Deck-Jul-26" could be ".../BizDev/Deck/Jul/26" or
 * ".../BizDev-Deck-Jul-26", and nothing in the name says which. So we never decode it. Every
 * session record carries the real `cwd`; read that instead and treat the name as an opaque key.
 */
async function readCwd(file: string): Promise<string | null> {
  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(CWD_SCAN_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, CWD_SCAN_BYTES, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    // The final line may be cut mid-record; parsing it would throw and is skipped below.
    for (const line of text.split('\n')) {
      if (!line.includes('"cwd"')) continue
      try {
        const record: unknown = JSON.parse(line)
        if (record && typeof record === 'object') {
          const cwd = (record as { cwd?: unknown }).cwd
          if (typeof cwd === 'string' && cwd) return cwd
        }
      } catch {
        // partial or malformed line
      }
    }
    return null
  } finally {
    await handle.close()
  }
}

/** Record one transcript as a session, named by its path relative to the project's root. */
async function addSession(
  path: string,
  root: string,
  source: AgentSource,
  out: SessionFile[],
): Promise<void> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return
    const rel = relative(root, path).replaceAll('\\', '/')
    out.push({
      id: rel.slice(0, -'.jsonl'.length),
      file: path,
      size: info.size,
      mtimeMs: info.mtimeMs,
      source,
    })
  } catch {
    // vanished between readdir and stat
  }
}

/**
 * Claude's transcripts: one file per session at the top of the project directory, and one file per
 * subagent under `<session>/subagents/`.
 *
 * Only that one nesting is followed. A session id is a path, so anything picked up here becomes a
 * session that has to be named, archived and read back — and the project directory holds other
 * things beside the transcripts, such as the memory directory. A file directly in the directory
 * keeps exactly the id it always had, since its path relative to the root is its own name.
 */
async function readClaudeSessions(dir: string, source: AgentSource): Promise<SessionFile[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const sessions: SessionFile[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const nested = join(dir, entry.name, 'subagents')
      for (const name of await readdir(nested).catch(() => [] as string[])) {
        if (!name.endsWith('.jsonl')) continue
        await addSession(join(nested, name), dir, source, sessions)
      }
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    await addSession(join(dir, entry.name), dir, source, sessions)
  }
  sessions.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return sessions
}

async function walkJsonl(dir: string, root: string, source: AgentSource, out: SessionFile[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkJsonl(path, root, source, out)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    await addSession(path, root, source, out)
  }
}

async function readNestedSessions(dir: string, source: AgentSource): Promise<SessionFile[]> {
  const sessions: SessionFile[] = []
  await walkJsonl(dir, dir, source, sessions)
  sessions.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return sessions
}

export async function discoverClaudeProjects(claudeDir: string): Promise<Project[]> {
  let entries
  try {
    entries = await readdir(claudeDir, { withFileTypes: true })
  } catch {
    return []
  }

  const projects: Project[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(claudeDir, entry.name)
    const sessions = await readClaudeSessions(dir, 'claude-code')
    if (sessions.length === 0) continue

    // Newest first: the most recent session is likeliest to carry a usable cwd.
    let path: string | null = null
    for (let i = sessions.length - 1; i >= 0 && path === null; i--) {
      path = await readCwd(sessions[i]!.file)
    }

    projects.push({
      key: entry.name,
      path,
      dir,
      sessions,
      lastActivity: sessions[sessions.length - 1]!.mtimeMs,
      sources: ['claude-code'],
    })
  }
  return projects
}

/**
 * The cwd a Codex rollout recorded on its `session_meta` line.
 *
 * Unlike Claude, Codex does not put `cwd` at the top of the JSON object — it lives on
 * `payload.cwd` — so the Claude scanner cannot find it. Only `session_meta` is trusted: a later
 * `turn_context` can name a different directory after a `cd`, which is not the project.
 */
async function readCodexCwd(file: string): Promise<string | null> {
  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(CWD_SCAN_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, CWD_SCAN_BYTES, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    for (const line of text.split('\n')) {
      if (!line.includes('"session_meta"') || !line.includes('"cwd"')) continue
      try {
        const record: unknown = JSON.parse(line)
        if (!record || typeof record !== 'object') continue
        const row = record as { type?: unknown; payload?: unknown }
        if (row.type !== 'session_meta' || !row.payload || typeof row.payload !== 'object') continue
        const cwd = (row.payload as { cwd?: unknown }).cwd
        if (typeof cwd === 'string' && cwd) return cwd
      } catch {
        // partial or malformed line
      }
    }
    return null
  } finally {
    await handle.close()
  }
}

async function walkRollouts(dir: string, root: string, out: SessionFile[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkRollouts(path, root, out)
      continue
    }
    if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) {
      continue
    }
    await addSession(path, root, 'codex', out)
  }
}

/**
 * Codex CLI rollouts: a global dated tree, one file per session, grouped by the cwd they recorded.
 *
 * There is no per-project folder to walk. Subagents are separate rollouts in the same tree, and
 * discovery does not try to nest them — the extractor reads `session_meta` for that.
 */
export async function discoverCodexProjects(codexDir: string): Promise<Project[]> {
  const sessions: SessionFile[] = []
  await walkRollouts(codexDir, codexDir, sessions)
  if (sessions.length === 0) return []

  const byPath = new Map<string, SessionFile[]>()
  for (const session of sessions) {
    const cwd = await readCodexCwd(session.file)
    if (cwd === null) continue
    const key = resolve(cwd)
    const bucket = byPath.get(key)
    if (bucket === undefined) byPath.set(key, [session])
    else bucket.push(session)
  }

  const projects: Project[] = []
  for (const [path, files] of byPath) {
    files.sort((a, b) => a.mtimeMs - b.mtimeMs)
    projects.push({
      key: basename(path),
      path,
      dir: codexDir,
      sessions: files,
      lastActivity: files[files.length - 1]!.mtimeMs,
      sources: ['codex'],
    })
  }
  return projects
}

/**
 * The `cwd:` line of a Copilot CLI session's `workspace.yaml`.
 *
 * The file is a small, flat `key: value` list with no nesting or quoting in practice, so a
 * line-regex read is enough and keeps probez's zero-dependency rule intact rather than pulling in
 * a YAML parser for one field.
 */
async function readCopilotCwd(dir: string): Promise<string | null> {
  let text: string
  try {
    text = await readFile(join(dir, 'workspace.yaml'), 'utf8')
  } catch {
    return null
  }
  const match = /^cwd:\s*(.+?)\s*$/m.exec(text)
  if (match === null) return null
  let cwd = match[1]!.trim()
  // A path with a character YAML treats specially can come out quoted rather than as a bare
  // scalar. Only the outer quotes are stripped — this is not a YAML parser, so an escape sequence
  // inside a double-quoted value is left as the writer wrote it rather than being decoded.
  if (cwd.length >= 2 && ((cwd[0] === '"' && cwd.at(-1) === '"') || (cwd[0] === "'" && cwd.at(-1) === "'"))) {
    cwd = cwd.slice(1, -1)
  }
  return cwd === '' ? null : cwd
}

/**
 * GitHub Copilot CLI sessions: a flat `session-state/` directory, one folder per session, each
 * holding `events.jsonl` and a `workspace.yaml` naming the cwd it ran in.
 *
 * There is no per-project folder to walk, the same shape Codex's dated tree has, so sessions are
 * grouped by that cwd exactly as `discoverCodexProjects` groups rollouts. A session whose
 * `workspace.yaml` is missing or unreadable cannot be placed and is skipped, rather than guessed at.
 */
export async function discoverCopilotProjects(copilotDir: string): Promise<Project[]> {
  let entries
  try {
    entries = await readdir(copilotDir, { withFileTypes: true })
  } catch {
    return []
  }

  const byPath = new Map<string, SessionFile[]>()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(copilotDir, entry.name)
    const file = join(dir, 'events.jsonl')
    const info = await stat(file).catch(() => null)
    if (info === null || !info.isFile()) continue
    const cwd = await readCopilotCwd(dir)
    if (cwd === null) continue
    const key = resolve(cwd)
    const session: SessionFile = { id: entry.name, file, size: info.size, mtimeMs: info.mtimeMs, source: 'copilot' }
    const bucket = byPath.get(key)
    if (bucket === undefined) byPath.set(key, [session])
    else bucket.push(session)
  }

  const projects: Project[] = []
  for (const [path, files] of byPath) {
    files.sort((a, b) => a.mtimeMs - b.mtimeMs)
    projects.push({
      key: basename(path),
      path,
      dir: copilotDir,
      sessions: files,
      lastActivity: files[files.length - 1]!.mtimeMs,
      sources: ['copilot'],
    })
  }
  return projects
}

/**
 * The `cwd` a Pi session's header recorded: always the first line, `{"type":"session",…,"cwd":…}`.
 *
 * Only the header is trusted. The folder name is the cwd with every separator turned into `-`,
 * which cannot be turned back, and a later system message's `cwd` section is prompt text.
 */
async function readPiCwd(file: string): Promise<string | null> {
  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(CWD_SCAN_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, CWD_SCAN_BYTES, 0)
    const first = buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0] ?? ''
    try {
      const record: unknown = JSON.parse(first)
      if (!record || typeof record !== 'object') return null
      const row = record as { type?: unknown; cwd?: unknown }
      return row.type === 'session' && typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : null
    } catch {
      return null
    }
  } finally {
    await handle.close()
  }
}

async function walkPiSessions(dir: string, out: SessionFile[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkPiSessions(path, out)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const info = await stat(path).catch(() => null)
    if (info === null || !info.isFile()) continue
    // The file name alone — `<timestamp>_<session-id>` — rather than the path under the root: the
    // folder in front of it is the whole cwd re-encoded, which says nothing the project does not.
    out.push({
      id: entry.name.slice(0, -'.jsonl'.length),
      file: path,
      size: info.size,
      mtimeMs: info.mtimeMs,
      source: 'pi',
    })
  }
}

/**
 * Pi coding-agent sessions: one folder per working directory, one JSONL file per session, each
 * opening with a header that names the cwd it ran in.
 *
 * Grouped by that recorded cwd, as Codex and Copilot sessions are, rather than by folder. A
 * session whose header cannot be read cannot be placed and is skipped rather than guessed at.
 */
export async function discoverPiProjects(piDir: string): Promise<Project[]> {
  const sessions: SessionFile[] = []
  await walkPiSessions(piDir, sessions)
  if (sessions.length === 0) return []

  const byPath = new Map<string, SessionFile[]>()
  for (const session of sessions) {
    const cwd = await readPiCwd(session.file)
    if (cwd === null) continue
    const key = resolve(cwd)
    const bucket = byPath.get(key)
    if (bucket === undefined) byPath.set(key, [session])
    else bucket.push(session)
  }

  const projects: Project[] = []
  for (const [path, files] of byPath) {
    files.sort((a, b) => a.mtimeMs - b.mtimeMs)
    projects.push({
      key: basename(path),
      path,
      dir: piDir,
      sessions: files,
      lastActivity: files[files.length - 1]!.mtimeMs,
      sources: ['pi'],
    })
  }
  return projects
}

let warnedNoSqlite = false

/**
 * OpenCode sessions: every project's in one data directory — a SQLite database from v1.14, JSON
 * files per message before that — grouped by the directory each session recorded.
 *
 * A session is not a file here, so `file` names the database (or the storage folder) and the
 * `opencode` reference names the session in it. `size` and `mtimeMs` are the session's own row
 * count and newest update rather than the file's, which is what lets `collect` re-read only the
 * sessions that changed in a database every session shares. A subagent's session — one OpenCode
 * started from another — is nested under its parent's id the way Claude's are, so it reads as one.
 *
 * Reading the database needs Node's built-in SQLite (22.13 and later). On an older Node the
 * database's sessions are skipped with a notice, and the older JSON storage is still read.
 */
export async function discoverOpencodeProjects(opencodeDir: string): Promise<Project[]> {
  const db = join(opencodeDir, 'opencode.db')
  if (!warnedNoSqlite && (await stat(db).catch(() => null)) !== null && !(await canReadOpencodeDb())) {
    warnedNoSqlite = true
    console.error(
      `probez: OpenCode sessions in ${db} need Node 22.13 or later to read (this is ${process.version}); skipped`,
    )
  }
  const listed = await listOpencodeSessions(opencodeDir)
  const byPath = new Map<string, SessionFile[]>()
  for (const entry of listed) {
    const key = resolve(entry.directory)
    const session: SessionFile = {
      id: entry.parent === null ? entry.id : `${entry.parent}/subagents/${entry.id}`,
      file: entry.ref.db ?? join(entry.ref.storage ?? opencodeDir, 'session'),
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      source: 'opencode',
      opencode: entry.ref,
    }
    const bucket = byPath.get(key)
    if (bucket === undefined) byPath.set(key, [session])
    else bucket.push(session)
  }

  const projects: Project[] = []
  for (const [path, files] of byPath) {
    files.sort((a, b) => a.mtimeMs - b.mtimeMs)
    projects.push({
      key: basename(path),
      path,
      dir: opencodeDir,
      sessions: files,
      lastActivity: files[files.length - 1]!.mtimeMs,
      sources: ['opencode'],
    })
  }
  return projects
}

let warnedGooseNoSqlite = false

/**
 * Goose sessions: every project's in one sessions directory — a SQLite database in current
 * versions, a JSONL file per session before that — grouped by the working directory each session
 * recorded.
 *
 * Handled as OpenCode's are: `file` names the database (or the legacy file) and the `goose`
 * reference names the session in it, `size` and `mtimeMs` are the session's own, and a subagent's
 * session — one Goose started from another, which it links by `parent_session_id` — is nested under
 * its parent's id.
 *
 * Reading the database needs Node's built-in SQLite (22.13 and later). On an older Node the
 * database's sessions are skipped with a notice, and any legacy JSONL files are still read.
 */
export async function discoverGooseProjects(gooseDir: string): Promise<Project[]> {
  const db = join(gooseDir, 'sessions.db')
  if (!warnedGooseNoSqlite && (await stat(db).catch(() => null)) !== null && !(await canReadGooseDb())) {
    warnedGooseNoSqlite = true
    console.error(`probez: Goose sessions in ${db} need Node 22.13 or later to read (this is ${process.version}); skipped`)
  }
  const listed = await listGooseSessions(gooseDir)
  const byPath = new Map<string, SessionFile[]>()
  for (const entry of listed) {
    const key = resolve(entry.workingDir)
    const session: SessionFile = {
      id: entry.parent === null ? entry.id : `${entry.parent}/subagents/${entry.id}`,
      file: entry.ref.db ?? entry.ref.legacy ?? db,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      source: 'goose',
      goose: entry.ref,
    }
    const bucket = byPath.get(key)
    if (bucket === undefined) byPath.set(key, [session])
    else bucket.push(session)
  }

  const projects: Project[] = []
  for (const [path, files] of byPath) {
    files.sort((a, b) => a.mtimeMs - b.mtimeMs)
    projects.push({
      key: basename(path),
      path,
      dir: gooseDir,
      sessions: files,
      lastActivity: files[files.length - 1]!.mtimeMs,
      sources: ['goose'],
    })
  }
  return projects
}

/**
 * Cline sessions, in either of the formats Cline writes (see `extract-cline.ts`), from every data
 * directory given, grouped by the working directory each recorded.
 *
 * Handled as OpenCode's and Goose's are: `file` names what holds the session and the `cline`
 * reference says how to export it; a subagent is nested under the session that started it.
 */
export async function discoverClineProjects(clineDirs: string[]): Promise<Project[]> {
  const listed = await listClineSessions(clineDirs)
  const byPath = new Map<string, SessionFile[]>()
  for (const entry of listed) {
    const key = resolve(entry.cwd)
    const session: SessionFile = {
      id: entry.id,
      file: entry.ref.kind === 'sdk' ? entry.ref.messages : join(entry.ref.dir, 'ui_messages.json'),
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      source: 'cline',
      cline: entry.ref,
    }
    const bucket = byPath.get(key)
    if (bucket === undefined) byPath.set(key, [session])
    else bucket.push(session)
  }

  const projects: Project[] = []
  for (const [path, files] of byPath) {
    files.sort((a, b) => a.mtimeMs - b.mtimeMs)
    projects.push({
      key: basename(path),
      path,
      dir: clineDirs[0] ?? '',
      sessions: files,
      lastActivity: files[files.length - 1]!.mtimeMs,
      sources: ['cline'],
    })
  }
  return projects
}

/**
 * Visual Studio's GitHub Copilot Chat sessions for one project: a MessagePack file per session
 * under `<project>/.vs/<solution>/copilot-chat/<hash>/sessions/`.
 *
 * Every other source has one directory under the user's home that lists every project it has ever
 * seen, so `discoverProjects` can walk it and find them all. This one does not — Visual Studio
 * writes the session inside the project it belongs to, and there is nowhere to list projects from
 * without walking the whole disk. So this is not called from `discoverProjects`; it is checked only
 * against a path the CLI has already resolved a target to. See `resolveTargets` in `cli.ts`.
 */
export async function discoverCopilotVsSessions(root: string): Promise<SessionFile[]> {
  let solutions
  try {
    solutions = await readdir(join(root, '.vs'), { withFileTypes: true })
  } catch {
    return []
  }

  const sessions: SessionFile[] = []
  for (const solution of solutions) {
    if (!solution.isDirectory()) continue
    const chatDir = join(root, '.vs', solution.name, 'copilot-chat')
    const hashes = await readdir(chatDir, { withFileTypes: true }).catch(() => [])
    for (const hash of hashes) {
      if (!hash.isDirectory()) continue
      const sessionsDir = join(chatDir, hash.name, 'sessions')
      const files = await readdir(sessionsDir, { withFileTypes: true }).catch(() => [])
      for (const file of files) {
        if (!file.isFile()) continue
        const path = join(sessionsDir, file.name)
        const info = await stat(path).catch(() => null)
        if (info === null) continue
        sessions.push({ id: `vs-${file.name}`, file: path, size: info.size, mtimeMs: info.mtimeMs, source: 'copilot', vs: true })
      }
    }
  }
  sessions.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return sessions
}

/**
 * Fold a target path's Visual Studio Copilot Chat sessions into whichever project already sits
 * there, or stand up a new one if none does.
 *
 * Called wherever a target has been narrowed to a concrete path — the CLI resolving what you named,
 * or the view server syncing a project it already has a stored path for — never as part of the
 * global sweep, for the reason `discoverCopilotVsSessions` gives.
 */
export async function mergeCopilotVsSessions(projects: Project[], targetPath: string): Promise<Project[]> {
  const sessions = await discoverCopilotVsSessions(targetPath)
  if (sessions.length === 0) return projects
  const newest = sessions[sessions.length - 1]!.mtimeMs

  const existing = projects.find((p) => p.path === targetPath)
  if (existing !== undefined) {
    existing.sessions = [...existing.sessions, ...sessions].sort((a, b) => a.mtimeMs - b.mtimeMs)
    existing.lastActivity = Math.max(existing.lastActivity, newest)
    if (!(existing.sources ?? []).includes('copilot')) existing.sources = [...(existing.sources ?? []), 'copilot']
    return projects
  }
  return [
    ...projects,
    {
      key: basename(targetPath),
      path: targetPath,
      dir: targetPath,
      sessions,
      lastActivity: newest,
      sources: ['copilot'],
    },
  ]
}

export async function discoverCursorProjects(cursorDir: string): Promise<Project[]> {
  let entries
  try {
    entries = await readdir(cursorDir, { withFileTypes: true })
  } catch {
    return []
  }

  const projects: Project[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const transcripts = join(cursorDir, entry.name, 'agent-transcripts')
    const sessions = await readNestedSessions(transcripts, 'cursor')
    if (sessions.length === 0) continue

    projects.push({
      key: entry.name,
      path: pathFromCursorSlug(entry.name),
      path_inferred: true,
      dir: transcripts,
      sessions,
      lastActivity: sessions[sessions.length - 1]!.mtimeMs,
      sources: ['cursor'],
    })
  }
  return projects
}

function mergeSources(a: AgentSource[] | undefined, b: AgentSource[] | undefined): AgentSource[] {
  const out: AgentSource[] = []
  for (const source of [...(a ?? []), ...(b ?? [])]) {
    if (!out.includes(source)) out.push(source)
  }
  return out
}

/**
 * Fold discoveries that name the same checkout into one project.
 *
 * A measured `cwd` outranks a path decoded from a Cursor slug. Sessions are concatenated; the
 * store hashes the path, so every agent that ran there lands in the same directory.
 */
export function mergeProjects(projects: Project[]): Project[] {
  const byPath = new Map<string, Project>()
  const noPath: Project[] = []

  for (const project of projects) {
    if (project.path === null) {
      noPath.push({
        ...project,
        sessions: [...project.sessions],
        sources: mergeSources(undefined, project.sources),
      })
      continue
    }
    const key = resolve(project.path)
    const existing = byPath.get(key)
    if (existing === undefined) {
      byPath.set(key, {
        ...project,
        path: key,
        sessions: [...project.sessions],
        sources: mergeSources(undefined, project.sources),
      })
      continue
    }

    existing.sessions.push(...project.sessions)
    existing.sessions.sort((a, b) => a.mtimeMs - b.mtimeMs)
    existing.lastActivity = Math.max(existing.lastActivity, project.lastActivity)
    existing.sources = mergeSources(existing.sources, project.sources)
    if (existing.path_inferred && !project.path_inferred) {
      existing.path = key
      existing.key = project.key
      existing.dir = project.dir
    }
    // A measured cwd outranks a slug decode, whichever side arrived first. The flag is false
    // rather than absent so a mixed project is not mistaken for a Cursor-only inferred one.
    existing.path_inferred = Boolean(existing.path_inferred) && Boolean(project.path_inferred)
  }

  const merged = [...byPath.values(), ...noPath]
  merged.sort((a, b) => b.lastActivity - a.lastActivity)
  return merged
}

/** Every project any requested agent has recorded, newest activity first. */
export async function discoverProjects(options: DiscoverOptions): Promise<Project[]> {
  const source = options.source ?? 'both'
  const found: Project[] = []
  if (wantsClaude(source)) found.push(...(await discoverClaudeProjects(options.claudeDir)))
  if (wantsCursor(source)) found.push(...(await discoverCursorProjects(options.cursorDir)))
  if (wantsCodex(source)) found.push(...(await discoverCodexProjects(options.codexDir)))
  if (wantsCopilot(source)) found.push(...(await discoverCopilotProjects(options.copilotDir)))
  if (wantsPi(source)) found.push(...(await discoverPiProjects(options.piDir)))
  if (wantsOpencode(source)) found.push(...(await discoverOpencodeProjects(options.opencodeDir)))
  if (wantsGoose(source)) found.push(...(await discoverGooseProjects(options.gooseDir)))
  if (wantsCline(source)) found.push(...(await discoverClineProjects(options.clineDirs)))
  return mergeProjects(found)
}

/**
 * Projects matching a target directory: the project rooted there, plus every project rooted
 * beneath it. Passing a workspace root therefore collects everything inside it.
 */
export function matchProjects(projects: Project[], target: string): Project[] {
  const root = resolve(target)
  const prefix = root.endsWith(sep) ? root : root + sep
  return projects.filter((p) => p.path !== null && (p.path === root || p.path.startsWith(prefix)))
}

/** Projects whose directory is named `name`, so a bare project name works as a target. */
export function matchByName(projects: Project[], name: string): Project[] {
  const wanted = name.toLowerCase()
  return projects.filter((p) => projectName(p).toLowerCase() === wanted)
}

/** What to call a project: the name the store was given for it, or the one its path gives it. */
export function projectName(project: Project): string {
  if (project.name !== undefined && project.name !== '') return project.name
  return project.path ? basename(project.path) : project.key
}

/**
 * Whether a project lives in a scratch directory. Harnesses that run an agent per test case create
 * a fresh temp directory each time, so one benchmark becomes dozens of one-question "projects".
 * They are real sessions, but not real work, and enough of them to skew any distribution measured later.
 */
export function isEphemeral(project: Project): boolean {
  if (project.path === null) return false
  const roots = [tmpdir(), '/private' + tmpdir(), '/tmp', '/private/tmp']
  return roots.some((root) => project.path === root || project.path!.startsWith(root + '/'))
}
