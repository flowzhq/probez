import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, win32 } from 'node:path'

import type { AgentSource, RoundSource } from '../types.js'

/**
 * Which agents to collect from.
 *
 * `both` is the historic default and still means every agent probez knows, including Codex,
 * Copilot, Pi, OpenCode, Goose and Cline. `all` is the same thing under a name that does not count them.
 */
export type SourceFilter = 'claude' | 'cursor' | 'codex' | 'copilot' | 'pi' | 'opencode' | 'goose' | 'cline' | 'both' | 'all'

export function defaultClaudeDir(): string {
  return join(homedir(), '.claude', 'projects')
}

export function defaultCursorDir(): string {
  return join(homedir(), '.cursor', 'projects')
}

/**
 * Codex CLI rollouts, under `$CODEX_HOME/sessions` when that is set, otherwise `~/.codex/sessions`.
 *
 * The files themselves sit in a dated tree (`YYYY/MM/DD/rollout-*.jsonl`), not one folder per
 * project. Discovery walks that tree and groups by the `cwd` each rollout recorded.
 */
export function defaultCodexDir(): string {
  const override = process.env.CODEX_HOME?.trim()
  const home = override !== undefined && override !== '' ? override : join(homedir(), '.codex')
  return join(home, 'sessions')
}

/**
 * GitHub Copilot CLI sessions, under `$COPILOT_HOME/session-state` when that is set, otherwise
 * `~/.copilot/session-state`.
 *
 * One directory per session (`<id>/events.jsonl`), each carrying its own `workspace.yaml` with the
 * cwd it ran in — no per-project folder to walk, the same shape Codex's dated tree has. Discovery
 * groups by that cwd.
 */
export function defaultCopilotDir(): string {
  const override = process.env.COPILOT_HOME?.trim()
  const home = override !== undefined && override !== '' ? override : join(homedir(), '.copilot')
  return join(home, 'session-state')
}

/**
 * Pi coding-agent sessions: `$PI_CODING_AGENT_SESSION_DIR` when that is set, otherwise `sessions`
 * under `$PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent/sessions` — the same precedence Pi itself
 * applies.
 *
 * One folder per working directory (`--<cwd>--/`), named by an encoding that cannot be reversed,
 * so discovery ignores the folder name and reads the `cwd` each session's header recorded.
 */
export function defaultPiDir(): string {
  const sessions = process.env.PI_CODING_AGENT_SESSION_DIR?.trim()
  if (sessions !== undefined && sessions !== '') return sessions
  const override = process.env.PI_CODING_AGENT_DIR?.trim()
  const agent = override !== undefined && override !== '' ? override : join(homedir(), '.pi', 'agent')
  return join(agent, 'sessions')
}

/**
 * OpenCode's data directory: `$XDG_DATA_HOME/opencode`, otherwise `~/.local/share/opencode` — on
 * Windows too, where OpenCode uses the same XDG layout rather than `%APPDATA%`.
 *
 * It holds `opencode.db` (v1.14 and later) and, from earlier versions, `storage/`. Every session of
 * every project is in there; discovery groups them by the directory each session recorded.
 */
export function defaultOpencodeDir(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim()
  const data = xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.local', 'share')
  return join(data, 'opencode')
}

/**
 * Goose's sessions directory, which is where Goose itself puts it: `$GOOSE_PATH_ROOT/data/sessions`
 * when that is set to an absolute path; otherwise `%APPDATA%\Block\goose\data\sessions` on Windows;
 * otherwise `$XDG_DATA_HOME/goose/sessions`, or `~/.local/share/goose/sessions` — on macOS too,
 * since Goose uses the XDG layout there rather than `~/Library`.
 *
 * It holds `sessions.db` and, from versions before it, a `<id>.jsonl` file per session. Every
 * session of every project is in there; discovery groups them by the directory each recorded.
 */
export function defaultGooseDir(): string {
  const root = process.env.GOOSE_PATH_ROOT?.trim()
  if (root !== undefined && root !== '' && isAbsolute(root)) return join(root, 'data', 'sessions')
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim()
    const roaming = appData !== undefined && appData !== '' ? appData : join(homedir(), 'AppData', 'Roaming')
    return join(roaming, 'Block', 'goose', 'data', 'sessions')
  }
  const xdg = process.env.XDG_DATA_HOME?.trim()
  const data = xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.local', 'share')
  return join(data, 'goose', 'sessions')
}

/** The extension id Cline's VS Code extension stores its data under. */
const CLINE_EXTENSION = 'saoudrizwan.claude-dev'

/** Editors built on VS Code that Cline's extension runs in, by the folder each keeps its data in. */
const VSCODE_EDITORS = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf']

/**
 * Cline's data directories. Each can hold `sessions/` — the SDK sessions Cline's CLI and current
 * extension write — and `tasks/`, the legacy tasks the extension wrote before the SDK.
 *
 * The first is Cline's own: `$CLINE_DATA_DIR`, else `$CLINE_DIR/data`, else `~/.cline/data`, the
 * same precedence Cline applies. Then the extension's storage in each VS Code-family editor —
 * `<config>/<editor>/User/globalStorage/saoudrizwan.claude-dev`, where `<config>` is `%APPDATA%` on
 * Windows, `~/Library/Application Support` on macOS and `$XDG_CONFIG_HOME` or `~/.config` elsewhere —
 * which holds the legacy tasks of every window that ran the extension before the SDK.
 */
export function defaultClineDirs(): string[] {
  const explicit = process.env.CLINE_DATA_DIR?.trim()
  const clineDir = process.env.CLINE_DIR?.trim()
  const own =
    explicit !== undefined && explicit !== ''
      ? explicit
      : clineDir !== undefined && clineDir !== ''
        ? join(clineDir, 'data')
        : join(homedir(), '.cline', 'data')
  let config: string
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim()
    config = appData !== undefined && appData !== '' ? appData : join(homedir(), 'AppData', 'Roaming')
  } else if (process.platform === 'darwin') {
    config = join(homedir(), 'Library', 'Application Support')
  } else {
    const xdg = process.env.XDG_CONFIG_HOME?.trim()
    config = xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.config')
  }
  return [own, ...VSCODE_EDITORS.map((editor) => join(config, editor, 'User', 'globalStorage', CLINE_EXTENSION))]
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Cursor names a project folder by replacing `/` with `-` in the working directory, then dropping
 * the leading `-` that an absolute path would otherwise keep. The reverse is lossy: a dash in a
 * directory name and a path separator look the same.
 *
 * When a partition of the slug names a directory that still exists, that path wins — so
 * `…-flowz-agentic-sdlc` becomes `…/flowz-agentic-sdlc` rather than `…/flowz/agentic/sdlc`.
 * Nothing on disk keeps the slash-everywhere reading. Discovery still marks `path_inferred`.
 */
export function pathFromCursorSlug(slug: string, platform: NodeJS.Platform = process.platform): string {
  const parts = slug.replace(/^-/, '').split('-').filter((part) => part !== '')
  // On Windows the slug opens with the drive letter, its colon dropped: `c-Users-me-repo` is
  // `C:\Users\me\repo`. Read as a POSIX path it named `/c/Users/me/repo`, which exists nowhere, so
  // no Cursor project on Windows ever met the same checkout from another agent.
  if (platform === 'win32' && parts.length > 0 && /^[a-zA-Z]$/.test(parts[0]!)) {
    const drive = `${parts[0]!.toUpperCase()}:`
    // Empty pieces are kept here: `C--Users` is one folder with a dash in its name, and dropping the
    // piece between the dashes would read it as two folders.
    const rest = slug.replace(/^-/, '').split('-').slice(1)
    const found = existingPath(rest, 0, [], `${drive}/`)
    return win32.normalize(found ?? `${drive}/${parts.slice(1).join('/')}`)
  }
  const naive = `/${parts.join('/')}`
  const found = existingPath(parts, 0, [])
  if (found === null) return naive
  try {
    return realpathSync(found)
  } catch {
    return found
  }
}

function existingPath(parts: string[], i: number, chosen: string[], root = '/'): string | null {
  if (i === parts.length) return chosen.length === 0 ? null : `${root}${chosen.join('/')}`
  for (let j = i + 1; j <= parts.length; j++) {
    const segment = parts.slice(i, j).join('-')
    // A folder is never named by nothing, and `a//b` would otherwise pass for `a/b` on disk.
    if (segment === '' || segment.startsWith('-') || segment.endsWith('-')) continue
    const next = [...chosen, segment]
    if (!isDir(`${root}${next.join('/')}`)) continue
    const found = existingPath(parts, j, next, root)
    if (found !== null) return found
  }
  return null
}

/**
 * What separates a subagent from the session that spawned it, in a session id.
 *
 * Claude and Cursor write a subagent's transcript to a `subagents/` directory beside that session,
 * and a session id is the transcript's path relative to the project's transcript root — so this one
 * separator is what tells the two kinds of session apart for those agents. Codex names a subagent
 * on `session_meta` instead, which the extractor reads.
 */
const SUBAGENT_SEPARATOR = /[/\\]subagents[/\\]/

/**
 * The parts of a session id that identify it, with the plumbing dropped.
 *
 * `<uuid>` is one part. `<uuid>/subagents/agent-<id>` is two: the session, then the subagent. The
 * separator and the `agent-` prefix Claude puts on the file name say only that this is a subagent,
 * which the shape of the answer already says, so neither is kept.
 */
export function sessionSegments(id: string): string[] {
  return id.split(SUBAGENT_SEPARATOR).map((part, i) => (i === 0 ? part : part.replace(/^agent-/, '')))
}

/** Whether a session id names a subagent's run rather than one someone opened. */
export function isSubagent(id: string): boolean {
  return SUBAGENT_SEPARATOR.test(id)
}

/**
 * The session a subagent ran under, or null for a session nobody delegated.
 *
 * Read from the id rather than from the transcript, so it costs nothing and answers the same way
 * for both agents. A record that names its parent — Claude's `sessionId` — agrees with it.
 */
export function parentSession(id: string): string | null {
  if (!isSubagent(id)) return null
  return id.split(SUBAGENT_SEPARATOR)[0] ?? ''
}

/**
 * A session id as a file name under `sessions/`.
 *
 * Cursor ids are relative paths (`uuid/subagents/sub-uuid`). Written as-is they would create
 * directories, and a `..` segment would climb out of the store. Flattening to a single name keeps
 * every copy next to the rest.
 */
export function safeSessionFilename(id: string): string {
  return `${id.replaceAll(/[/\\]/g, '__')}.jsonl`
}

/** Original session id from an archived copy's file name, when state does not still know it. */
export function sessionIdFromFilename(name: string): string {
  const stem = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : name
  return stem.replaceAll('__', '/')
}

export function parseSourceFilter(value: string | undefined): SourceFilter {
  if (value === undefined || value === 'both' || value === 'all') return value === 'all' ? 'all' : 'both'
  if (
    value === 'claude' ||
    value === 'cursor' ||
    value === 'codex' ||
    value === 'copilot' ||
    value === 'pi' ||
    value === 'opencode' ||
    value === 'goose' ||
    value === 'cline'
  ) {
    return value
  }
  return 'both'
}

function wantsEvery(source: SourceFilter): boolean {
  return source === 'both' || source === 'all'
}

export function wantsClaude(source: SourceFilter): boolean {
  return wantsEvery(source) || source === 'claude'
}

export function wantsCursor(source: SourceFilter): boolean {
  return wantsEvery(source) || source === 'cursor'
}

export function wantsCodex(source: SourceFilter): boolean {
  return wantsEvery(source) || source === 'codex'
}

export function wantsCopilot(source: SourceFilter): boolean {
  return wantsEvery(source) || source === 'copilot'
}

export function wantsPi(source: SourceFilter): boolean {
  return wantsEvery(source) || source === 'pi'
}

export function wantsOpencode(source: SourceFilter): boolean {
  return wantsEvery(source) || source === 'opencode'
}

export function wantsGoose(source: SourceFilter): boolean {
  return wantsEvery(source) || source === 'goose'
}

export function wantsCline(source: SourceFilter): boolean {
  return wantsEvery(source) || source === 'cline'
}

export function isAgentSource(value: string): value is AgentSource {
  return (
    value === 'claude-code' ||
    value === 'cursor' ||
    value === 'codex' ||
    value === 'copilot' ||
    value === 'pi' ||
    value === 'opencode' ||
    value === 'goose' ||
    value === 'cline'
  )
}

export function isRoundSource(value: string): value is RoundSource {
  return isAgentSource(value) || value === 'unknown'
}

/**
 * The names `source:` and `--source` accept, including `unknown` for data whose origin was not
 * determined. `claude` is the alias for the persisted value `claude-code`.
 */
export const SOURCE_ALIASES = ['claude', 'cursor', 'codex', 'copilot', 'pi', 'opencode', 'goose', 'cline', 'unknown'] as const

export type SourceAlias = (typeof SOURCE_ALIASES)[number]

export function isSourceAlias(value: string): value is SourceAlias {
  return (SOURCE_ALIASES as readonly string[]).includes(value)
}

/** How a persisted source is written in the query language and the CLI. */
export function aliasOfSource(source: RoundSource): SourceAlias {
  return source === 'claude-code' ? 'claude' : source
}

/**
 * The persisted value for a CLI/query alias, or null when the word is not a source.
 *
 * `claude` and `claude-code` both name Claude Code, so a query cannot silently match nothing
 * because the person typed the name the flag uses rather than the name the store writes.
 */
export function sourceFromAlias(value: string): RoundSource | null {
  const wanted = value.toLowerCase()
  if (wanted === 'claude' || wanted === 'claude-code') return 'claude-code'
  if (
    wanted === 'cursor' ||
    wanted === 'codex' ||
    wanted === 'copilot' ||
    wanted === 'pi' ||
    wanted === 'opencode' ||
    wanted === 'goose' ||
    wanted === 'cline' ||
    wanted === 'unknown'
  ) {
    return wanted
  }
  return null
}

/** A round whose field is missing or unrecognised is unknown, not Claude. */
export function roundSourceOf(round: { source?: string }): RoundSource {
  return typeof round.source === 'string' && isRoundSource(round.source) ? round.source : 'unknown'
}

export function isSourceFilter(value: string): value is SourceFilter {
  return (
    value === 'claude' ||
    value === 'cursor' ||
    value === 'codex' ||
    value === 'copilot' ||
    value === 'pi' ||
    value === 'opencode' ||
    value === 'goose' ||
    value === 'cline' ||
    value === 'both' ||
    value === 'all'
  )
}

/**
 * `--source` on a read command: a single agent to filter stored rounds to, or null for all of them.
 *
 * `both` and `all` are discovery spellings and mean "do not filter the store".
 */
export function storeSourceAlias(filter: SourceFilter): SourceAlias | null {
  if (
    filter === 'claude' ||
    filter === 'cursor' ||
    filter === 'codex' ||
    filter === 'copilot' ||
    filter === 'pi' ||
    filter === 'opencode' ||
    filter === 'goose' ||
    filter === 'cline'
  ) {
    return filter
  }
  return null
}
