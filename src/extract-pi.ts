import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

import { errorKindOf } from './errors.js'
import { applyTiming, contentChars, inputChars, toText, truncateInput } from './extract.js'
import type { HeadHistory } from './git.js'
import type { Compaction, Patch, Round, RoundEvent, ToolCall } from './types.js'

type Json = Record<string, unknown>

/**
 * Whether a JSONL row is the header Pi writes as the first line of every session.
 *
 * `{"type":"session","version":3,"id":…,"cwd":…}`. Claude Code never writes a `session` type, and
 * Codex wraps everything in `payload`, so this is checked before the Claude fallback in
 * `sniffSource` — a Pi header has a string `type` and would otherwise be read as Claude's.
 *
 * `version` is deliberately not required: a v1 file, which Pi migrates only when it next opens the
 * session, has a header without one, and requiring it sent such a file to the Claude reader.
 */
export function isPiRecord(row: Record<string, unknown>): boolean {
  return row.type === 'session' && typeof row.cwd === 'string'
}

function asObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function asIntOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseTs(value: string | null): number | null {
  if (value === null) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/** A message's own timestamp, which Pi writes as epoch milliseconds rather than ISO. */
function messageTs(message: Json): string | null {
  const ms = asIntOrNull(message.timestamp)
  return ms === null ? null : new Date(ms).toISOString()
}

/**
 * Pi's usage, which is already split the way probez stores it.
 *
 * `input` is the uncached part alone — a call that read 742 tokens from the cache records
 * `input: 64, cacheRead: 742`, not 806 — so nothing is subtracted here, unlike Codex. `cacheWrite1h`
 * is the subset of `cacheWrite` written with one-hour retention, which is exactly the split the two
 * cache-write prices need. `reasoning`, when present, is already inside `output`.
 */
function applyUsage(round: Round, usage: Json): void {
  const input = asIntOrNull(usage.input)
  const output = asIntOrNull(usage.output)
  const cacheRead = asIntOrNull(usage.cacheRead)
  const cacheWrite = asIntOrNull(usage.cacheWrite)
  if (input === null && output === null && cacheRead === null && cacheWrite === null) return

  const written = cacheWrite ?? 0
  const write1h = Math.min(asIntOrNull(usage.cacheWrite1h) ?? 0, written)
  round.in_uncached = input ?? 0
  round.in_cache_read = cacheRead ?? 0
  round.in_cache_write = written
  round.in_cache_write_5m = written - write1h
  round.in_cache_write_1h = write1h
  round.in_tokens = round.in_uncached + written + round.in_cache_read
  round.out_tokens = output
}

/**
 * The size of an edit, from the display diff Pi's `edit` tool returns in `details.diff`.
 *
 * Every line of that diff carries a one-character prefix — `+` added, `-` removed, space for
 * context — followed by its line number, so counting prefixes is exact rather than a guess at what
 * the replacement changed.
 */
function foldEditDiff(details: Json | null, path: string | null): Patch | null {
  const diff = details === null ? null : asText(details.diff)
  if (diff === null) return null
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  if (added === 0 && removed === 0) return null
  return { files: path === null ? 0 : 1, added, removed }
}

/** A whole-file `write` adds every line it wrote; there is nothing to diff it against. */
function foldWrite(input: Json): Patch | null {
  const content = typeof input.content === 'string' ? input.content : null
  if (content === null || content === '') return null
  return { files: typeof input.path === 'string' ? 1 : 0, added: content.split('\n').length, removed: 0 }
}

interface Pending {
  tool: ToolCall
  emittedTs: number | null
  input: Json
}

/**
 * Assemble rounds from a Pi coding-agent session (`~/.pi/agent/sessions/--<cwd>--/<ts>_<id>.jsonl`).
 *
 * Pi writes one assistant message per model call, after the call has finished, carrying the whole
 * response — text, thinking and tool calls — and its usage. So a round is exactly one assistant
 * message, which is simpler than Claude Code, where one call streams into several records.
 *
 * The file is a tree: `/tree` and `/fork` branch from an earlier entry without starting a new
 * file, and an abandoned branch stays in it. Every entry is read in file order regardless of
 * branch, because every assistant message on any branch was a model call somebody paid for. The
 * file is append-only, so file order is the order the calls happened in.
 *
 * `/fork` and `/clone` are different: they start a new file seeded with a copy of the parent's
 * history. That copy is skipped, so each model call is a round in exactly one session.
 *
 * Not read: model calls Pi records outside an assistant message — a compaction's or a branch
 * summary's own `usage`, `usage` entries such as cache warming, and nested model work a tool
 * reports on its result. Each would need a round with no prompt and no output to hang on, so they
 * are left out rather than invented, and a session's total can sit below what Pi itself reports.
 */
export async function extractPiSession(
  file: string,
  sessionId: string,
  head: HeadHistory | null = null,
): Promise<Round[]> {
  const rounds: Round[] = []
  const toolById = new Map<string, Pending>()

  let pendingEvents: RoundEvent[] = []
  let pendingText = ''
  let pendingWait: number | null = null
  let pendingCompaction: Compaction | null = null
  let lastOutputTs: number | null = null
  let task = 0
  let taskUsed = false
  let taskStart: number | null = null
  /** When a forked session's own history begins; null for a session nobody forked. */
  let forkedAt: number | null = null

  const onUser =(text: string, timestamp: string | null, chars: number): void => {
    pendingText = text
    const ts = parseTs(timestamp)
    if (timestamp !== null) {
      pendingEvents.push({ type: 'user_message', ts: timestamp, chars })
      if (pendingWait === null && lastOutputTs !== null && ts !== null) pendingWait = ts - lastOutputTs
    }
    if (task === 0 || taskUsed) {
      task += 1
      taskUsed = false
      taskStart = ts
    }
  }

  const onToolResult = (message: Json, timestamp: string | null): void => {
    const callId = asText(message.toolCallId)
    if (callId === null) return
    const text = toText(message.content)
    const chars = contentChars(message.content)
    if (timestamp !== null) {
      pendingEvents.push({ type: 'tool_result', ts: timestamp, chars, tool_call_id: callId })
    }
    const entry = toolById.get(callId)
    if (entry === undefined) return
    const { tool } = entry
    tool.result_chars = chars
    tool.is_error = message.isError === true
    if (tool.is_error) tool.error_kind = errorKindOf(text, tool.name, tool.input, null)
    tool.result_at = timestamp
    const ts = parseTs(timestamp)
    tool.ms = entry.emittedTs !== null && ts !== null ? ts - entry.emittedTs : null
    if (tool.name === 'edit') {
      tool.patch = foldEditDiff(asObject(message.details), asText(entry.input.path))
    }
  }

  const onAssistant = (entryId: string, message: Json, timestamp: string | null): void => {
    const started = messageTs(message)
    const round: Round = {
      session: sessionId,
      round: rounds.length,
      task: task === 0 ? 1 : task,
      commit: head === null ? null : head.at(taskStart ?? parseTs(started ?? timestamp)),
      agent: 'main',
      id: entryId,
      ts: started ?? timestamp,
      ms: null,
      gen_ms: null,
      wait_ms: pendingWait,
      first_input: null,
      model: asText(message.model),
      in_tokens: null,
      in_uncached: null,
      in_cache_write: null,
      in_cache_write_5m: null,
      in_cache_write_1h: null,
      in_cache_read: null,
      out_tokens: null,
      compaction: pendingCompaction,
      mcp_server: null,
      mcp_tool: null,
      skill: null,
      user_text: pendingText,
      text: '',
      thinking_chars: 0,
      tools: [],
      events: pendingEvents,
    }
    pendingEvents = []
    pendingText = ''
    pendingWait = null
    pendingCompaction = null
    taskUsed = true

    // The message is written once the call has finished, so its parts share the entry's
    // timestamp. The message's own `timestamp` is when the call began.
    const textParts: string[] = []
    const content = Array.isArray(message.content) ? message.content : []
    for (const raw of content) {
      const block = asObject(raw)
      if (block === null) continue
      if (block.type === 'text') {
        const text = typeof block.text === 'string' ? block.text : ''
        if (text !== '') textParts.push(text)
        if (timestamp !== null) round.events.push({ type: 'text', ts: timestamp, chars: text.length })
      } else if (block.type === 'thinking') {
        const chars = typeof block.thinking === 'string' ? block.thinking.length : 0
        round.thinking_chars += chars
        if (timestamp !== null) round.events.push({ type: 'reasoning', ts: timestamp, chars })
      } else if (block.type === 'toolCall') {
        const callId = asText(block.id)
        if (callId === null || toolById.has(callId)) continue
        const name = asText(block.name) ?? 'unknown'
        const input = asObject(block.arguments) ?? {}
        const tool: ToolCall = {
          name,
          id: callId,
          input: truncateInput(input),
          input_chars: inputChars(block.arguments),
          result_chars: null,
          is_error: null,
          error_kind: null,
          stderr_chars: null,
          interrupted: null,
          patch: name === 'write' ? foldWrite(input) : null,
          emitted_at: timestamp,
          result_at: null,
          ms: null,
        }
        round.tools.push(tool)
        toolById.set(callId, { tool, emittedTs: parseTs(timestamp), input })
        if (timestamp !== null) round.events.push({ type: 'tool_call', ts: timestamp, tool_call_id: callId })
      }
    }
    round.text = textParts.join('\n')

    const usage = asObject(message.usage)
    if (usage !== null) applyUsage(round, usage)

    const begun = parseTs(started)
    const ended = parseTs(timestamp)
    round.ms = begun !== null && ended !== null ? Math.max(0, ended - begun) : null
    applyTiming(round)
    if (ended !== null && (lastOutputTs === null || ended > lastOutputTs)) lastOutputTs = ended
    rounds.push(round)
  }

  const stream = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })

  for await (const line of lines) {
    if (line.trim() === '') continue
    let entry: Json
    try {
      const parsed: unknown = JSON.parse(line)
      const object = asObject(parsed)
      if (object === null) continue
      entry = object
    } catch {
      continue
    }

    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : null

    if (entry.type === 'session') {
      if (asText(entry.parentSession) !== null) forkedAt = parseTs(timestamp)
      continue
    }
    // A fork or clone starts its file with a copy of the parent's entries, unchanged — same ids,
    // same timestamps, same usage — and those calls are already the parent session's rounds.
    // Everything the fork did itself was written after its header, so anything older is the
    // copy. Reading it would count each copied call twice, once per session.
    if (forkedAt !== null) {
      const at = parseTs(timestamp)
      if (at !== null && at < forkedAt) continue
    }

    if (entry.type === 'compaction') {
      pendingCompaction = {
        trigger: null,
        pre_tokens: asIntOrNull(entry.tokensBefore),
        post_tokens: null,
        dropped_tokens: null,
        ms: null,
        ts: timestamp,
      }
      continue
    }

    if (entry.type !== 'message') continue
    const message = asObject(entry.message)
    if (message === null) continue

    if (message.role === 'user') {
      const text = toText(message.content).trim()
      if (text !== '') onUser(text, timestamp, contentChars(message.content))
      continue
    }
    if (message.role === 'toolResult') {
      onToolResult(message, timestamp)
      continue
    }
    if (message.role === 'assistant') {
      const id = asText(entry.id) ?? `${sessionId}#r${rounds.length}`
      onAssistant(id, message, timestamp)
    }
  }

  return rounds
}
