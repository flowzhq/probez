import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

import { isSubagent } from './agents/paths.js'
import { applyTiming, contentChars, inputChars, toText, truncateInput } from './extract.js'
import type { HeadHistory } from './git.js'
import type { Compaction, Patch, Round, RoundEvent, ToolCall } from './types.js'

type Json = Record<string, unknown>

const USER_MESSAGE_BEGIN = '## My request for Codex:'
const ENVIRONMENT_MARKERS = ['<environment_context>', '<user_instructions>', '<environments_instructions>']
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m
const CODEX_ENVELOPE = new Set(['session_meta', 'turn_context', 'response_item', 'event_msg', 'compacted'])

/**
 * Whether a JSONL row is a Codex rollout line rather than a Claude or Cursor record.
 *
 * Codex wraps every item in `{timestamp, type, payload}`. The `type` values it uses are not
 * Claude's `user`/`assistant`/`system`, so this is what `sniffSource` checks first — a Codex
 * line always has a `type`, and checking Claude's `type` first would swallow every rollout.
 */
export function isCodexRecord(row: Record<string, unknown>): boolean {
  return typeof row.type === 'string' && CODEX_ENVELOPE.has(row.type) && 'payload' in row
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function asIntOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function payloadOf(record: Json): Json {
  const raw = record.payload
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Json) : {}
}

function stampOf(record: Json): string | null {
  return typeof record.timestamp === 'string' ? record.timestamp : null
}

function parseTs(value: string | null): number | null {
  if (value === null) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Codex's `source` field names a subagent as a nested object, not a `subagents/` path.
 *
 * `isSubagent(sessionId)` still covers a rollout that somehow landed under that directory; the
 * metadata is what a dated-tree file actually carries.
 */
function agentOf(sessionId: string, meta: Json): 'main' | 'sub' {
  if (isSubagent(sessionId)) return 'sub'
  if (asText(meta.thread_source) === 'subagent') return 'sub'
  if (asText(meta.parent_thread_id) !== null) return 'sub'
  const source = meta.source
  if (source && typeof source === 'object' && !Array.isArray(source) && 'sub_agent' in source) {
    return 'sub'
  }
  return 'main'
}

function stripUserText(text: string): string {
  const marked = text.indexOf(USER_MESSAGE_BEGIN)
  const body = marked === -1 ? text : text.slice(marked + USER_MESSAGE_BEGIN.length)
  return body.trim()
}

function isEnvironmentUserText(text: string): boolean {
  if (text.includes(USER_MESSAGE_BEGIN)) return false
  return ENVIRONMENT_MARKERS.some((marker) => text.includes(marker))
}

function joinShell(parts: string[]): string {
  if (
    parts.length >= 3 &&
    (parts[0] === 'bash' || parts[0] === 'zsh' || parts[0] === 'sh') &&
    (parts[1] === '-lc' || parts[1] === '-c')
  ) {
    return parts.slice(2).join(' ')
  }
  return parts.join(' ')
}

function parseArguments(raw: unknown): Json {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Json
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Json
    return { value: parsed }
  } catch {
    return { raw }
  }
}

function pathFromPatch(text: string): string | null {
  const match = PATCH_FILE.exec(text)
  if (match === null) return null
  const path = match[1]!.trim()
  return path === '' ? null : path
}

function foldApplyPatch(text: string): Patch | null {
  const files = new Set<string>()
  let added = 0
  let removed = 0
  for (const line of text.split('\n')) {
    const named = PATCH_FILE.exec(line)
    if (named !== null) {
      files.add(named[1]!.trim())
      continue
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  if (files.size === 0 && added === 0 && removed === 0) return null
  return { files: files.size, added, removed }
}

/**
 * Shape a Codex tool's arguments the way `commandOf` and `pathOf` already know how to read.
 *
 * `command` arrives as an argv array more often than as a string. `apply_patch` names the file
 * inside the patch text, not as a `path` field. Neither is guessed at — the array is joined, the
 * patch header is copied onto `path`, and missing pieces stay missing.
 */
function normalizeInput(name: string, input: Json): unknown {
  const out: Json = { ...input }
  const command = out.command ?? out.cmd
  if (Array.isArray(command) && command.every((part) => typeof part === 'string')) {
    out.command = joinShell(command as string[])
  }
  if (typeof out.dir_path === 'string' && typeof out.path !== 'string') out.path = out.dir_path
  if (name === 'apply_patch' && typeof out.path !== 'string') {
    const patch = typeof out.input === 'string' ? out.input : typeof out.patch === 'string' ? out.patch : ''
    const path = pathFromPatch(patch)
    if (path !== null) out.path = path
  }
  return truncateInput(out)
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Json
    if (typeof record.content === 'string') return record.content
    if (typeof record.text === 'string') return record.text
    if (typeof record.output === 'string') return record.output
  }
  return toText(value)
}

function outputIsError(payload: Json, output: unknown): boolean {
  if (payload.success === false) return true
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const record = output as Json
    if (record.success === false) return true
    if (record.exit_code !== undefined && record.exit_code !== 0 && record.exit_code !== '0') {
      return true
    }
  }
  return false
}

function applyUsage(round: Round, info: Json): void {
  const last = info.last_token_usage
  const usage = last && typeof last === 'object' && !Array.isArray(last) ? (last as Json) : info
  const input = asIntOrNull(usage.input_tokens)
  const cached = asIntOrNull(usage.cached_input_tokens) ?? 0
  const written = asIntOrNull(usage.cache_write_input_tokens) ?? 0
  const output = asIntOrNull(usage.output_tokens)
  if (input === null && output === null && cached === 0 && written === 0) return

  const totalIn = input ?? 0
  const uncached = Math.max(0, totalIn - cached)
  round.in_uncached = uncached
  round.in_cache_read = cached
  round.in_cache_write = written
  round.in_cache_write_5m = written
  round.in_cache_write_1h = 0
  round.in_tokens = uncached + written + cached
  round.out_tokens = output
}

interface Open {
  round: Round
  textParts: string[]
}

/**
 * Assemble rounds from a Codex CLI rollout JSONL file.
 *
 * Codex writes two interleaved logs under one envelope: `response_item` is what the model saw and
 * produced, `event_msg` is what the TUI replayed. A round is one model burst — reasoning, tool
 * calls, and assistant prose — ending when a tool result arrives or the person speaks again.
 * Token counts, when the rollout recorded them, land on the round they followed. Missing fields
 * stay null rather than becoming a measured zero.
 */
export async function extractCodexSession(
  file: string,
  sessionId: string,
  head: HeadHistory | null = null,
): Promise<Round[]> {
  const rounds: Round[] = []
  const toolById = new Map<string, { tool: ToolCall; emittedTs: number | null }>()

  let agent: 'main' | 'sub' = isSubagent(sessionId) ? 'sub' : 'main'
  let model: string | null = null
  let open: Open | null = null
  let lastRound: Round | null = null
  let pendingEvents: RoundEvent[] = []
  let pendingText = ''
  let pendingWait: number | null = null
  let pendingCompaction: Compaction | null = null
  let lastOutputTs: number | null = null
  let task = 0
  let taskUsed = false
  let taskStart: number | null = null
  let index = 0
  let lastUserText: string | null = null

  const openRound = (timestamp: string | null, ts: number | null): Open => {
    const id = `${sessionId}#r${index}`
    const first = pendingEvents[0]?.type
    const round: Round = {
      session: sessionId,
      round: index,
      task: task === 0 ? 1 : task,
      commit: head === null ? null : head.at(taskStart ?? ts),
      agent,
      id,
      ts: timestamp,
      ms: null,
      gen_ms: null,
      wait_ms: pendingWait,
      first_input: first === 'user_message' || first === 'tool_result' ? first : null,
      model,
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
    index += 1
    return { round, textParts: [] }
  }

  const flush = (): void => {
    if (open === null) return
    open.round.text = open.textParts.join('\n')
    const times = open.round.events
      .map((event) => parseTs(event.ts))
      .filter((ms): ms is number => ms !== null)
    if (times.length >= 2) {
      open.round.ms = Math.max(...times) - Math.min(...times)
    } else {
      open.round.ms = 0
    }
    applyTiming(open.round)
    rounds.push(open.round)
    lastRound = open.round
    open = null
  }

  const applyLatestUsage = (info: Json): void => {
    const target = open !== null ? open.round : lastRound
    if (target !== null) applyUsage(target, info)
  }

  const noteOutput = (timestamp: string | null): void => {
    const ts = parseTs(timestamp)
    if (ts !== null && (lastOutputTs === null || ts > lastOutputTs)) lastOutputTs = ts
  }

  const onUser = (text: string, timestamp: string | null): void => {
    const query = stripUserText(text)
    if (query === '' || isEnvironmentUserText(query)) return
    if (query === lastUserText) return
    lastUserText = query
    flush()
    pendingText = query
    const ts = parseTs(timestamp)
    if (timestamp !== null) {
      pendingEvents.push({ type: 'user_message', ts: timestamp, chars: query.length })
      if (pendingWait === null && lastOutputTs !== null && ts !== null) {
        pendingWait = ts - lastOutputTs
      }
    }
    if (task === 0 || taskUsed) {
      task += 1
      taskUsed = false
      taskStart = ts
    }
  }

  const ensureOpen = (timestamp: string | null): Open => {
    if (open === null) open = openRound(timestamp, parseTs(timestamp))
    return open
  }

  const addTool = (
    name: string,
    callId: string,
    input: unknown,
    timestamp: string | null,
  ): void => {
    if (toolById.has(callId)) return
    const current = ensureOpen(timestamp)
    const tool: ToolCall = {
      name,
      id: callId,
      input: normalizeInput(name, parseArguments(input)),
      input_chars: inputChars(input),
      result_chars: null,
      is_error: null,
      stderr_chars: null,
      interrupted: null,
      patch: name === 'apply_patch' ? foldApplyPatch(patchText(parseArguments(input))) : null,
      emitted_at: timestamp,
      result_at: null,
      ms: null,
    }
    current.round.tools.push(tool)
    toolById.set(callId, { tool, emittedTs: parseTs(timestamp) })
    if (timestamp !== null) {
      current.round.events.push({ type: 'tool_call', ts: timestamp, tool_call_id: callId })
    }
    noteOutput(timestamp)
  }

  const stream = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })

  for await (const line of lines) {
    if (line.trim() === '') continue

    let record: Json
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object') continue
      record = parsed as Json
    } catch {
      continue
    }

    const kind = typeof record.type === 'string' ? record.type : ''
    const payload = payloadOf(record)
    const timestamp = stampOf(record)
    const inner = typeof payload.type === 'string' ? payload.type : ''

    if (kind === 'session_meta') {
      agent = agentOf(sessionId, payload)
      continue
    }

    if (kind === 'turn_context') {
      const named = asText(payload.model)
      if (named !== null) model = named
      continue
    }

    if (kind === 'compacted' || (kind === 'event_msg' && inner === 'context_compacted')) {
      pendingCompaction = {
        trigger: null,
        pre_tokens: null,
        post_tokens: null,
        dropped_tokens: null,
        ms: null,
        ts: timestamp,
      }
      continue
    }

    if (kind === 'event_msg' && inner === 'user_message') {
      const text = asText(payload.message) ?? toText(payload.content)
      if (text !== '') onUser(text, timestamp)
      continue
    }

    if (kind === 'event_msg' && inner === 'token_count') {
      const info = payload.info
      if (info && typeof info === 'object' && !Array.isArray(info)) {
        applyLatestUsage(info as Json)
      }
      continue
    }

    if (kind !== 'response_item') continue

    if (inner === 'message' && payload.role === 'user') {
      const text = toText(payload.content)
      if (text !== '') onUser(text, timestamp)
      continue
    }

    if (inner === 'reasoning') {
      const current = ensureOpen(timestamp)
      const chars = contentChars(payload.summary) + contentChars(payload.content)
      current.round.thinking_chars += chars
      if (timestamp !== null) current.round.events.push({ type: 'reasoning', ts: timestamp, chars })
      noteOutput(timestamp)
      continue
    }

    if (inner === 'message' && payload.role === 'assistant') {
      const current = ensureOpen(timestamp)
      const text = toText(payload.content)
      if (text !== '') current.textParts.push(text)
      if (timestamp !== null) {
        current.round.events.push({ type: 'text', ts: timestamp, chars: contentChars(payload.content) })
      }
      noteOutput(timestamp)
      continue
    }

    if (inner === 'function_call') {
      const name = asText(payload.name) ?? 'unknown'
      const callId = asText(payload.call_id) ?? asText(payload.id)
      if (callId === null) continue
      addTool(name, callId, payload.arguments, timestamp)
      continue
    }

    if (inner === 'local_shell_call') {
      const callId = asText(payload.call_id) ?? asText(payload.id)
      if (callId === null) continue
      const action = payload.action
      const command =
        action && typeof action === 'object' && !Array.isArray(action)
          ? (action as Json).command
          : undefined
      addTool('shell', callId, { command }, timestamp)
      continue
    }

    if (inner === 'function_call_output') {
      const callId = asText(payload.call_id)
      if (callId === null) continue
      const text = outputText(payload.output)
      const chars = text.length
      const ts = parseTs(timestamp)
      if (timestamp !== null) {
        pendingEvents.push({ type: 'tool_result', ts: timestamp, chars, tool_call_id: callId })
      }
      const entry = toolById.get(callId)
      if (entry !== undefined) {
        entry.tool.result_chars = chars
        entry.tool.is_error = outputIsError(payload, payload.output)
        entry.tool.result_at = timestamp
        entry.tool.ms = entry.emittedTs !== null && ts !== null ? ts - entry.emittedTs : null
        if (entry.tool.patch === null && entry.tool.name === 'apply_patch') {
          entry.tool.patch = foldApplyPatch(text)
        }
      }
      flush()
      continue
    }
  }

  flush()

  for (let i = 0; i < rounds.length; i++) rounds[i]!.round = i
  return rounds
}

function patchText(input: Json): string {
  if (typeof input.input === 'string') return input.input
  if (typeof input.patch === 'string') return input.patch
  return ''
}
