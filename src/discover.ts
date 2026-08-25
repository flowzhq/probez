import { open, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'

import {
  defaultClaudeDir,
  defaultCursorDir,
  pathFromCursorSlug,
  wantsClaude,
  wantsCursor,
} from './agents/paths.js'
import type { SourceFilter } from './agents/paths.js'
import type { AgentSource, Project, SessionFile } from './types.js'

export { defaultClaudeDir, defaultCursorDir }
export type { SourceFilter }

/** How much of a session file to scan for the record carrying `cwd`. */
const CWD_SCAN_BYTES = 256 * 1024

export interface DiscoverOptions {
  claudeDir: string
  cursorDir: string
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
 * Fold Claude and Cursor discoveries that name the same checkout into one project.
 *
 * A measured `cwd` outranks a path decoded from a Cursor slug. Sessions are concatenated; the
 * store hashes the path, so both agents land in the same directory.
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

/** Every project either agent has recorded, newest activity first. */
export async function discoverProjects(options: DiscoverOptions): Promise<Project[]> {
  const source = options.source ?? 'both'
  const found: Project[] = []
  if (wantsClaude(source)) found.push(...(await discoverClaudeProjects(options.claudeDir)))
  if (wantsCursor(source)) found.push(...(await discoverCursorProjects(options.cursorDir)))
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
