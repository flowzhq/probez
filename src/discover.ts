import { open, readdir, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

import type { Project, SessionFile } from './types.js'

/** How much of a session file to scan for the record carrying `cwd`. */
const CWD_SCAN_BYTES = 256 * 1024

export function defaultClaudeDir(): string {
  return join(homedir(), '.claude', 'projects')
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

async function readSessions(dir: string): Promise<SessionFile[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const sessions: SessionFile[] = []
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const file = join(dir, name)
    try {
      const info = await stat(file)
      if (!info.isFile()) continue
      sessions.push({
        id: name.slice(0, -'.jsonl'.length),
        file,
        size: info.size,
        mtimeMs: info.mtimeMs,
      })
    } catch {
      // vanished between readdir and stat
    }
  }
  sessions.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return sessions
}

/** Every project the agent has recorded, newest activity first. */
export async function discoverProjects(claudeDir: string): Promise<Project[]> {
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
    const sessions = await readSessions(dir)
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
    })
  }

  projects.sort((a, b) => b.lastActivity - a.lastActivity)
  return projects
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
