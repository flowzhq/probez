import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { AgentSource, RoundSource } from '../types.js'

/**
 * Which agents to collect from.
 *
 * `both` is the historic default and still means every agent probez knows, including Codex.
 * `all` is the same thing under a name that does not count them.
 */
export type SourceFilter = 'claude' | 'cursor' | 'codex' | 'both' | 'all'

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
export function pathFromCursorSlug(slug: string): string {
  const parts = slug.replace(/^-/, '').split('-').filter((part) => part !== '')
  const naive = `/${parts.join('/')}`
  const found = existingPath(parts, 0, [])
  if (found === null) return naive
  try {
    return realpathSync(found)
  } catch {
    return found
  }
}

function existingPath(parts: string[], i: number, chosen: string[]): string | null {
  if (i === parts.length) return chosen.length === 0 ? null : `/${chosen.join('/')}`
  for (let j = i + 1; j <= parts.length; j++) {
    const next = [...chosen, parts.slice(i, j).join('-')]
    if (!isDir(`/${next.join('/')}`)) continue
    const found = existingPath(parts, j, next)
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
  if (value === 'claude' || value === 'cursor' || value === 'codex') return value
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

export function isAgentSource(value: string): value is AgentSource {
  return value === 'claude-code' || value === 'cursor' || value === 'codex'
}

export function isRoundSource(value: string): value is RoundSource {
  return isAgentSource(value) || value === 'unknown'
}

/**
 * The names `source:` and `--source` accept, including `unknown` for data whose origin was not
 * determined. `claude` is the alias for the persisted value `claude-code`.
 */
export const SOURCE_ALIASES = ['claude', 'cursor', 'codex', 'unknown'] as const

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
  if (wanted === 'cursor' || wanted === 'codex' || wanted === 'unknown') return wanted
  return null
}

/** A round whose field is missing or unrecognised is unknown, not Claude. */
export function roundSourceOf(round: { source?: string }): RoundSource {
  return typeof round.source === 'string' && isRoundSource(round.source) ? round.source : 'unknown'
}

export function isSourceFilter(value: string): value is SourceFilter {
  return value === 'claude' || value === 'cursor' || value === 'codex' || value === 'both' || value === 'all'
}

/**
 * `--source` on a read command: a single agent to filter stored rounds to, or null for all of them.
 *
 * `both` and `all` are discovery spellings and mean "do not filter the store".
 */
export function storeSourceAlias(filter: SourceFilter): SourceAlias | null {
  if (filter === 'claude' || filter === 'cursor' || filter === 'codex') return filter
  return null
}
