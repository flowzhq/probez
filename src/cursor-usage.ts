/**
 * Cursor IDE token usage, collected from the official `stop` / `afterAgentResponse` hooks.
 *
 * Transcripts never carry usage. Hooks do: cumulative tokens for one parent-agent turn. Those
 * events are kept under the data directory and merged onto Cursor rounds at collect time. Claude
 * and Codex extractors are untouched; this module only writes usage onto Cursor rounds.
 *
 * Cursor's `input_tokens` already includes cache read and cache write. Uncached is derived by
 * subtraction so the five-way split still sums the way pricing expects — the same identity Claude
 * and Codex write, not a second formula layered on top.
 *
 * Event→task join is temporal: task timestamps are the user-turn start (minute-rounded), while
 * `recorded_at` is when the stop hook fired (turn end). Matching picks the latest task that started
 * at or before the event, within {@link MAX_CURSOR_USAGE_TASK_DELTA_MS}. `generation_id` is only
 * for deduplicating stop vs afterAgentResponse, not for joining rounds.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { isSubagent, sessionSegments } from './agents/paths.js'
import { classifyCall } from './classify.js'
import type { Round } from './types.js'

/** Same modes as the store: usage must not be world-readable. */
const DIR_MODE = 0o700
const FILE_MODE = 0o600

/**
 * How far after a task's first timestamp a stop-hook event may fall and still join that task.
 *
 * Task `ts` is the user prompt time; the hook fires when the agent turn ends. Long tool-heavy turns
 * need headroom (minutes), but events from a later day must not attach to ancient tasks.
 */
export const MAX_CURSOR_USAGE_TASK_DELTA_MS = 30 * 60 * 1000

export interface CursorUsageEvent {
  conversation_id: string
  generation_id: string | null
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  /** When probez recorded the event. */
  recorded_at: string
  hook_event_name: string | null
  transcript_path: string | null
}

export type CursorUsageParse =
  | { ok: true; event: CursorUsageEvent }
  | { ok: false; reason: string }

function asIntOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n) && n >= 0) return Math.round(n)
  }
  return null
}

function asStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' ? null : text
}

/**
 * Validate a Cursor hook payload and normalize it into a usage event.
 *
 * Accepts `stop` and `afterAgentResponse` (same token fields for one generation). Other hook
 * names are refused so tool hooks cannot land in the usage file by accident. A payload with no
 * token fields at all is refused rather than stored as a measured zero.
 */
export function parseCursorHookPayload(raw: unknown): CursorUsageParse {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'hook payload must be a JSON object' }
  }
  const row = raw as Record<string, unknown>
  const hook = asStringOrNull(row.hook_event_name)
  if (hook !== null && hook !== 'stop' && hook !== 'afterAgentResponse') {
    return { ok: false, reason: `ignoring hook event ${hook}` }
  }

  const conversation =
    asStringOrNull(row.conversation_id) ?? asStringOrNull(row.conversationId)
  if (conversation === null) {
    return { ok: false, reason: 'missing conversation_id' }
  }

  const input = asIntOrNull(row.input_tokens) ?? asIntOrNull(row.inputTokens)
  const output = asIntOrNull(row.output_tokens) ?? asIntOrNull(row.outputTokens)
  const cacheRead = asIntOrNull(row.cache_read_tokens) ?? asIntOrNull(row.cacheReadTokens)
  const cacheWrite = asIntOrNull(row.cache_write_tokens) ?? asIntOrNull(row.cacheWriteTokens)
  if (input === null && output === null && cacheRead === null && cacheWrite === null) {
    return { ok: false, reason: 'no token fields in payload' }
  }

  return {
    ok: true,
    event: {
      conversation_id: conversation,
      generation_id: asStringOrNull(row.generation_id) ?? asStringOrNull(row.generationId),
      model: asStringOrNull(row.model) ?? asStringOrNull(row.model_id) ?? asStringOrNull(row.modelId),
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      recorded_at: new Date().toISOString(),
      hook_event_name: hook,
      transcript_path: asStringOrNull(row.transcript_path) ?? asStringOrNull(row.transcriptPath),
    },
  }
}

/** Where Cursor hook usage events are appended. */
export function cursorUsageFile(dataDir: string): string {
  return join(dataDir, 'cursor-usage.jsonl')
}

export async function appendCursorUsage(dataDir: string, event: CursorUsageEvent): Promise<string> {
  const file = cursorUsageFile(dataDir)
  await mkdir(dirname(file), { recursive: true, mode: DIR_MODE })
  await appendFile(file, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: FILE_MODE })
  return file
}

function eventFromStored(value: unknown): CursorUsageEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const conversation = asStringOrNull(row.conversation_id)
  if (conversation === null) return null
  const input = asIntOrNull(row.input_tokens)
  const output = asIntOrNull(row.output_tokens)
  const cacheRead = asIntOrNull(row.cache_read_tokens)
  const cacheWrite = asIntOrNull(row.cache_write_tokens)
  if (input === null && output === null && cacheRead === null && cacheWrite === null) return null
  return {
    conversation_id: conversation,
    generation_id: asStringOrNull(row.generation_id),
    model: asStringOrNull(row.model),
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    recorded_at: asStringOrNull(row.recorded_at) ?? new Date(0).toISOString(),
    hook_event_name: asStringOrNull(row.hook_event_name),
    transcript_path: asStringOrNull(row.transcript_path),
  }
}

export async function readCursorUsage(dataDir: string): Promise<CursorUsageEvent[]> {
  const file = cursorUsageFile(dataDir)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return []
  }
  const out: CursorUsageEvent[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const event = eventFromStored(JSON.parse(line))
      if (event !== null) out.push(event)
    } catch {
      // skip corrupt lines
    }
  }
  return out
}

/**
 * Deduplicate by generation_id when present (stop and afterAgentResponse share one), else by
 * conversation + recorded_at. Last write wins.
 */
export function dedupeCursorUsage(events: CursorUsageEvent[]): CursorUsageEvent[] {
  const byKey = new Map<string, CursorUsageEvent>()
  for (const event of events) {
    const key =
      event.generation_id !== null
        ? `g:${event.generation_id}`
        : `c:${event.conversation_id}\0${event.recorded_at}`
    byKey.set(key, event)
  }
  return [...byKey.values()].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at))
}

/** Whether a stored session id belongs to this Cursor conversation. */
export function sessionMatchesConversation(sessionId: string, conversationId: string): boolean {
  if (sessionId === conversationId) return true
  if (sessionId.startsWith(`${conversationId}/`)) return true
  return sessionSegments(sessionId)[0] === conversationId
}

/** Clear recorded usage so a task can be re-attributed. Model is left alone. */
export function clearRoundUsage(round: Round): void {
  round.in_tokens = null
  round.in_uncached = null
  round.in_cache_write = null
  round.in_cache_write_5m = null
  round.in_cache_write_1h = null
  round.in_cache_read = null
  round.out_tokens = null
}

/**
 * Split a non-negative integer across weights, preserving the exact total (largest-remainder).
 * Empty weights or a non-positive sum yield zeros.
 */
export function distributeByWeight(total: number, weights: number[]): number[] {
  const n = weights.length
  if (n === 0) return []
  if (!Number.isFinite(total) || total <= 0) return weights.map(() => 0)
  const sumW = weights.reduce((a, b) => a + b, 0)
  if (!(sumW > 0)) return weights.map(() => 0)

  const exact = weights.map((w) => (total * w) / sumW)
  const floors = exact.map((x) => Math.floor(x))
  let rem = Math.round(total) - floors.reduce((a, b) => a + b, 0)
  const order = exact
    .map((x, i) => ({ i, frac: x - floors[i]! }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
  const out = [...floors]
  for (let k = 0; k < rem; k++) {
    const slot = order[k % order.length]
    if (slot !== undefined) out[slot.i]! += 1
  }
  return out
}

function roundWorkWeight(round: Round): number {
  const tools = round.tools ?? []
  if (tools.length === 0) return 0
  let weight = 0
  const perCall = 1 / tools.length
  for (const tool of tools) {
    for (const label of classifyCall(tool)) weight += label.weight * perCall
  }
  return weight
}

function hasTools(round: Round): boolean {
  return (round.tools ?? []).length > 0
}

function parseTimeMs(value: string | null | undefined): number | null {
  if (value == null || value === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** Earliest round timestamp in a task — the user-turn start Cursor stamps on the transcript. */
export function taskFirstTs(rounds: Round[]): string | null {
  let first: string | null = null
  for (const round of rounds) {
    if (typeof round.ts !== 'string' || round.ts === '') continue
    if (first === null || round.ts < first) first = round.ts
  }
  return first
}

export interface CursorTaskMatch {
  task: number
  first_ts: string
  rounds: Round[]
  /** `recorded_at - first_ts`, always ≥ 0 for a successful match. */
  delta_ms: number
}

/**
 * Pick the Cursor parent-agent task a usage event belongs to.
 *
 * Among main-session tasks for `conversation_id` with `first_ts <= recorded_at` and
 * `recorded_at - first_ts <= MAX_CURSOR_USAGE_TASK_DELTA_MS`, choose the greatest `first_ts`,
 * then the higher task number. Token presence is ignored. Returns null when nothing qualifies —
 * the authoritative event stays in the sidecar unattached.
 */
export function matchCursorUsageTask(
  event: CursorUsageEvent,
  rounds: Round[],
  maxDeltaMs: number = MAX_CURSOR_USAGE_TASK_DELTA_MS,
): CursorTaskMatch | null {
  const eventMs = parseTimeMs(event.recorded_at)
  if (eventMs === null) return null

  const byTask = new Map<number, Round[]>()
  for (const round of rounds) {
    if (!sessionMatchesConversation(round.session, event.conversation_id)) continue
    if (isSubagent(round.session)) continue
    if (round.source !== 'cursor' && round.source !== undefined) continue
    const list = byTask.get(round.task) ?? []
    list.push(round)
    byTask.set(round.task, list)
  }

  let best: CursorTaskMatch | null = null
  for (const [task, group] of byTask) {
    const firstTs = taskFirstTs(group)
    if (firstTs === null) continue
    const firstMs = parseTimeMs(firstTs)
    if (firstMs === null || firstMs > eventMs) continue
    const delta = eventMs - firstMs
    if (delta > maxDeltaMs) continue
    if (
      best === null ||
      firstTs > best.first_ts ||
      (firstTs === best.first_ts && task > best.task)
    ) {
      best = { task, first_ts: firstTs, rounds: group, delta_ms: delta }
    }
  }
  return best
}

/**
 * Map a Cursor hook usage event onto the five-way token split probez already prices.
 *
 * Cursor: input includes cache. Uncached = input − read − write (clamped). Write has no 5m/1h
 * split in the hook, so the whole write is priced as 5-minute the way Codex writes do.
 */
export function applyUsageToRound(round: Round, event: CursorUsageEvent): void {
  applyUsageParts(round, usagePartsOf(event), event.model)
}

interface UsageParts {
  uncached: number | null
  read: number | null
  write: number | null
  output: number | null
}

function usagePartsOf(event: CursorUsageEvent): UsageParts {
  const read = event.cache_read_tokens
  const write = event.cache_write_tokens
  const output = event.output_tokens
  const input = event.input_tokens

  if (input !== null) {
    const r = read ?? 0
    const w = write ?? 0
    return {
      uncached: Math.max(0, input - r - w),
      read: r,
      write: w,
      output,
    }
  }
  if ((read !== null && read > 0) || (write !== null && write > 0)) {
    return {
      uncached: 0,
      read: read ?? 0,
      write: write ?? 0,
      output,
    }
  }
  return {
    uncached: null,
    read: null,
    write: null,
    output,
  }
}

function applyUsageParts(round: Round, parts: UsageParts, model: string | null): void {
  const hasIn = parts.uncached !== null || parts.read !== null || parts.write !== null
  if (hasIn) {
    const uncached = parts.uncached ?? 0
    const read = parts.read ?? 0
    const write = parts.write ?? 0
    round.in_uncached = uncached
    round.in_cache_read = read
    round.in_cache_write = write
    round.in_cache_write_5m = write
    round.in_cache_write_1h = 0
    round.in_tokens = uncached + write + read
  }

  if (parts.output !== null) round.out_tokens = parts.output
  else if (round.in_tokens !== null && round.out_tokens == null) round.out_tokens = 0

  if (model !== null && round.model == null) round.model = model
}

function applyEventWithinTask(group: Round[], event: CursorUsageEvent): void {
  const classified = group.filter(hasTools)
  if (classified.length === 0) {
    // No category to attach to: keep session totals; categoryTally counts these as outside Tokens.
    applyUsageToRound(group[group.length - 1]!, event)
    return
  }

  if (classified.length === 1) {
    applyUsageToRound(classified[0]!, event)
    return
  }

  const weightsRaw = classified.map(roundWorkWeight)
  const weightSum = weightsRaw.reduce((a, b) => a + b, 0)
  const weights = weightSum > 0 ? weightsRaw : classified.map(() => 1)
  const parts = usagePartsOf(event)
  const uncachedParts =
    parts.uncached === null ? null : distributeByWeight(parts.uncached, weights)
  const readParts = parts.read === null ? null : distributeByWeight(parts.read, weights)
  const writeParts = parts.write === null ? null : distributeByWeight(parts.write, weights)
  const outputParts = parts.output === null ? null : distributeByWeight(parts.output, weights)

  for (let i = 0; i < classified.length; i++) {
    applyUsageParts(
      classified[i]!,
      {
        uncached: uncachedParts === null ? null : uncachedParts[i]!,
        read: readParts === null ? null : readParts[i]!,
        write: writeParts === null ? null : writeParts[i]!,
        output: outputParts === null ? null : outputParts[i]!,
      },
      event.model,
    )
  }
}

/**
 * Attach each usage event to a Cursor parent-agent task by temporal join, then within-task rules.
 *
 * Within a matched task:
 * 1. Exact: one tool-using round gets the full event.
 * 2. Task-level: split across tool-using rounds by classify weights (same weights categoryTally
 *    uses), preserving integer totals.
 * 3. Outside: no tool-using rounds → last round keeps session totals; categories see Outside Tokens.
 *
 * Events that fail the temporal window stay in the sidecar only. Before applying, usage is cleared
 * on matching Cursor main rounds for every conversation in `events`, so collect/merge is idempotent.
 * Subagent sessions and Claude/Codex rounds are never written.
 */
export function applyCursorUsage(rounds: Round[], events: CursorUsageEvent[]): number {
  const unique = dedupeCursorUsage(events)
  if (unique.length === 0) return 0

  const conversations = new Set(unique.map((event) => event.conversation_id))
  for (const round of rounds) {
    if (round.source !== 'cursor' && round.source !== undefined) continue
    if (isSubagent(round.session)) continue
    let matched = false
    for (const conversation of conversations) {
      if (sessionMatchesConversation(round.session, conversation)) {
        matched = true
        break
      }
    }
    if (matched) clearRoundUsage(round)
  }

  let applied = 0
  for (const event of unique) {
    const match = matchCursorUsageTask(event, rounds)
    if (match === null) continue
    applyEventWithinTask(match.rounds, event)
    applied += 1
  }
  return applied
}

/** Snippet for `~/.cursor/hooks.json` that pipes the stop hook into probez. */
export function cursorHooksInstallSnippet(command: string): string {
  return (
    JSON.stringify(
      {
        version: 1,
        hooks: {
          stop: [{ command }],
        },
      },
      null,
      2,
    ) + '\n'
  )
}

export function defaultCursorHooksPath(): string {
  return join(homedir(), '.cursor', 'hooks.json')
}

/**
 * Merge a stop→probez hook into an existing hooks.json without removing other hooks.
 */
export async function installCursorHooks(
  hooksPath: string,
  command: string,
): Promise<'created' | 'updated' | 'unchanged'> {
  let existing: { version?: number; hooks?: Record<string, unknown[]> } = { version: 1, hooks: {} }
  let hadFile = false
  try {
    const text = await readFile(hooksPath, 'utf8')
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as typeof existing
      hadFile = true
    }
  } catch {
    // create fresh
  }
  if (!existing.hooks || typeof existing.hooks !== 'object') existing.hooks = {}
  const stop = Array.isArray(existing.hooks.stop) ? [...existing.hooks.stop] : []
  const already = stop.some(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      typeof (entry as { command?: unknown }).command === 'string' &&
      /\bprobez\b/.test(String((entry as { command: string }).command)) &&
      /\bhook\b/.test(String((entry as { command: string }).command)),
  )
  if (already) return 'unchanged'
  stop.push({ command })
  existing.version = existing.version ?? 1
  existing.hooks.stop = stop
  await mkdir(dirname(hooksPath), { recursive: true, mode: DIR_MODE })
  await writeFile(hooksPath, JSON.stringify(existing, null, 2) + '\n', {
    encoding: 'utf8',
    mode: FILE_MODE,
  })
  return hadFile ? 'updated' : 'created'
}
