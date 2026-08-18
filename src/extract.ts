import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

import type { HeadHistory } from './git.js'
import type { Patch, Round, RoundEvent, ToolCall } from './types.js'

/** Strings longer than this in a tool's input are truncated. */
const MAX_INPUT_STRING = 2000
/** How much of a truncated string is kept. */
const KEPT_INPUT_CHARS = 200

type Json = Record<string, unknown>

/** Best-effort character count of a content value, whatever shape it arrives in. */
export function contentChars(value: unknown): number {
  if (value == null) return 0
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + contentChars(item), 0)
  if (typeof value === 'object') {
    const block = value as Json
    if (typeof block.text === 'string') return block.text.length
    if ('content' in block) return contentChars(block.content)
    return JSON.stringify(block).length
  }
  return String(value).length
}

/** Flatten a content value to plain text, for user and assistant messages. */
function toText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map(toText)
      .filter((part) => part !== '')
      .join('\n')
  }
  if (typeof value === 'object') {
    const block = value as Json
    if (typeof block.text === 'string') return block.text
    if ('content' in block) return toText(block.content)
    return ''
  }
  return String(value)
}

/**
 * Shrink a tool's input so `Edit` and `Write` payloads do not dominate the output. Object
 * structure and every file path survive, since those are what identify what the tool acted on.
 */
export function truncateInput(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length <= MAX_INPUT_STRING) return value
    return `${value.slice(0, KEPT_INPUT_CHARS)}…(${value.length} chars)`
  }
  if (Array.isArray(value)) return value.map(truncateInput)
  if (value && typeof value === 'object') {
    const out: Json = {}
    for (const [key, item] of Object.entries(value as Json)) out[key] = truncateInput(item)
    return out
  }
  return value
}

function parseTs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function asInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Size of a tool's arguments, as compact JSON.
 *
 * Not `contentChars`, which follows a `content` key down to the string inside it: that is the right
 * reading for a message body and the wrong one for a `Write` call, where `content` is one argument
 * among several. What is wanted here is how big the whole call was before truncation.
 */
function inputChars(value: unknown): number {
  if (value === undefined) return 0
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

/**
 * Fold a result's structured patch into three counts.
 *
 * The patch arrives as unified-diff hunks, each carrying the file it applies to and its lines with
 * the usual `+`/`-`/` ` prefixes. Keeping the lines themselves would be keeping the diff, which is
 * the result body this store does not record; the counts are what says how large an edit was.
 *
 * A new file has no hunks to diff against, so it arrives with an empty patch and its whole content
 * instead. Folding that to zero would report the largest writes as the ones that changed nothing.
 */
export function foldPatch(result: unknown): Patch | null {
  if (!result || typeof result !== 'object') return null
  const r = result as Json
  const hunks = r.structuredPatch
  if (!Array.isArray(hunks)) return null

  const files = new Set<string>()
  const path = asText(r.filePath)
  if (path !== null) files.add(path)

  let added = 0
  let removed = 0
  for (const raw of hunks) {
    if (!raw || typeof raw !== 'object') continue
    const hunk = raw as Json
    const own = asText(hunk.filePath)
    if (own !== null) files.add(own)
    if (!Array.isArray(hunk.lines)) continue
    for (const line of hunk.lines) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }

  if (hunks.length === 0 && typeof r.content === 'string' && r.content !== '') {
    added = r.content.split('\n').length
  }

  return { files: files.size, added, removed }
}

/**
 * The failure signal the harness flag misses.
 *
 * `is_error` is set by the harness, so a command that ran and failed comes back false. The raw
 * result carries what actually happened. There is no exit code anywhere in the record — `stderr`
 * and `interrupted` are the whole of it.
 */
function resultSignal(result: unknown): { stderr_chars: number | null; interrupted: boolean | null } {
  if (!result || typeof result !== 'object') return { stderr_chars: null, interrupted: null }
  const r = result as Json
  return {
    stderr_chars: typeof r.stderr === 'string' ? r.stderr.length : null,
    interrupted: typeof r.interrupted === 'boolean' ? r.interrupted : null,
  }
}

/** Usage snapshot quality, compared lexicographically. Higher is more complete. */
type UsageScore = [number, number, number]

function betterUsage(next: UsageScore, current: UsageScore | null): boolean {
  if (current === null) return true
  for (let i = 0; i < next.length; i++) {
    if (next[i]! !== current[i]!) return next[i]! > current[i]!
  }
  return true
}

interface Builder {
  round: Round
  usage: UsageScore | null
  firstTs: number | null
  lastTs: number | null
  textParts: string[]
}

/** The input events waiting for the round they prompted. */
interface Pending {
  events: RoundEvent[]
  text: string[]
  /** Time the person took, measured when their message arrived rather than when the round is built. */
  wait: number | null
}

/**
 * Assemble rounds from one session file.
 *
 * The file is a flat, append-only record stream, so a round has to be reconstructed from records
 * that are neither contiguous nor complete on their own:
 *
 * - A round is one assistant `message.id`. Several records repeat that id, one per content block,
 *   and they must merge into a single round.
 * - Usage is message-level and repeated on those records, sometimes as a partial placeholder. The
 *   most complete snapshot wins, not the last one seen.
 * - The input that prompted a round (a user message, or the results of the previous round's tools)
 *   appears *before* it, so it buffers until the round it belongs to shows up.
 * - A tool's result frequently lands in a later round than the call, so calls are tracked for the
 *   whole session rather than per round.
 * - The input events that prompted a round precede it too, and buffer alongside that text. Handing
 *   them to the round they prompted is what lets `gen_ms` span the wait before the model spoke,
 *   which `ms` — the span of the round's own records — cannot see.
 */
export async function extractSession(
  file: string,
  sessionId: string,
  head: HeadHistory | null = null,
): Promise<Round[]> {
  const rounds: Round[] = []
  const builders: Builder[] = []
  const byMsgId = new Map<string, Builder>()
  const toolById = new Map<string, { tool: ToolCall; emittedTs: number | null }>()

  let pending: Pending = { events: [], text: [], wait: null }
  /** When the previous round last produced output, which is what a user message waits on. */
  let lastOutputTs: number | null = null
  let task = 0
  let taskUsed = false
  /** When the user turn that opened the current task arrived, which is what dates its commit. */
  let taskStart: number | null = null

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

    const message = record.message
    if (!message || typeof message !== 'object') continue
    const msg = message as Json
    const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null
    const ts = parseTs(timestamp)
    const sidechain = record.isSidechain === true

    if (record.type === 'assistant' && msg.role === 'assistant') {
      const id = msg.id
      if (typeof id !== 'string' || id === '' || id === '<synthetic>') continue
      if (msg.model === '<synthetic>') continue

      let builder = byMsgId.get(id)
      if (builder === undefined) {
        builder = {
          round: {
            session: sessionId,
            round: 0,
            task: task === 0 ? 1 : task,
            // The task's starting point, not this round's: the whole task is one piece of work and
            // a commit the agent made partway through it is a result, not a premise. `ts` is the
            // fallback for the rounds of a session that opens without a user turn, which have no
            // task start to date them by.
            commit: head === null ? null : head.at(taskStart ?? ts),
            agent: sidechain ? 'sub' : 'main',
            id,
            ts: timestamp,
            ms: null,
            gen_ms: null,
            wait_ms: pending.wait,
            first_input: null,
            model: typeof msg.model === 'string' ? msg.model : null,
            in_tokens: 0,
            in_uncached: 0,
            in_cache_write: 0,
            in_cache_write_5m: 0,
            in_cache_write_1h: 0,
            in_cache_read: 0,
            out_tokens: 0,
            mcp_server: null,
            mcp_tool: null,
            skill: null,
            user_text: pending.text.join('\n'),
            text: '',
            thinking_chars: 0,
            tools: [],
            events: pending.events,
          },
          usage: null,
          firstTs: ts,
          lastTs: ts,
          textParts: [],
        }
        pending = { events: [], text: [], wait: null }
        taskUsed = true
        byMsgId.set(id, builder)
        builders.push(builder)
        rounds.push(builder.round)
      } else {
        if (builder.round.model === null && typeof msg.model === 'string') {
          builder.round.model = msg.model
        }
        if (ts !== null) {
          if (builder.firstTs === null || ts < builder.firstTs) builder.firstTs = ts
          if (builder.lastTs === null || ts > builder.lastTs) builder.lastTs = ts
        }
      }

      applyUsage(builder, msg)

      // Attribution sits on the record rather than on the message, and only some records of a
      // round carry it, so the first one that names a server or skill wins.
      builder.round.mcp_server ??= asText(record.attributionMcpServer)
      builder.round.mcp_tool ??= asText(record.attributionMcpTool)
      builder.round.skill ??= asText(record.attributionSkill)

      const content = msg.content
      if (!Array.isArray(content)) continue
      for (const raw of content) {
        if (!raw || typeof raw !== 'object') continue
        const block = raw as Json
        if (block.type === 'thinking') {
          const chars = contentChars(block.thinking)
          builder.round.thinking_chars += chars
          if (timestamp !== null) {
            builder.round.events.push({ type: 'reasoning', ts: timestamp, chars })
          }
        } else if (block.type === 'text') {
          const text = toText(block.text)
          if (text !== '') builder.textParts.push(text)
          if (timestamp !== null) {
            builder.round.events.push({ type: 'text', ts: timestamp, chars: contentChars(block.text) })
          }
        } else if (block.type === 'tool_use') {
          const toolId = block.id
          if (typeof toolId !== 'string' || toolById.has(toolId)) continue
          const tool: ToolCall = {
            name: typeof block.name === 'string' ? block.name : null,
            id: toolId,
            input: truncateInput(block.input),
            input_chars: inputChars(block.input),
            result_chars: null,
            is_error: null,
            stderr_chars: null,
            interrupted: null,
            patch: null,
            emitted_at: timestamp,
            result_at: null,
            ms: null,
          }
          builder.round.tools.push(tool)
          toolById.set(toolId, { tool, emittedTs: ts })
          if (timestamp !== null) {
            builder.round.events.push({ type: 'tool_call', ts: timestamp, tool_call_id: toolId })
          }
        } else {
          continue
        }
        if (ts !== null && (lastOutputTs === null || ts > lastOutputTs)) lastOutputTs = ts
      }
      continue
    }

    if (msg.role !== 'user') continue

    const content = msg.content
    const blocks = Array.isArray(content) ? content : []
    const results = blocks.filter(
      (block): block is Json =>
        !!block && typeof block === 'object' && (block as Json).type === 'tool_result',
    )

    for (const block of results) {
      const toolId = block.tool_use_id
      if (typeof toolId !== 'string') continue
      const chars = contentChars(block.content)
      if (timestamp !== null) {
        pending.events.push({ type: 'tool_result', ts: timestamp, chars, tool_call_id: toolId })
      }
      const entry = toolById.get(toolId)
      if (entry === undefined) continue
      entry.tool.result_chars = chars
      entry.tool.is_error = block.is_error === true
      entry.tool.result_at = timestamp
      entry.tool.ms = entry.emittedTs !== null && ts !== null ? ts - entry.emittedTs : null
      // The harness flag says whether the call was accepted, not whether it worked. What the tool
      // actually did is on the record beside the block, not in the block itself.
      const raw = record.toolUseResult
      const signal = resultSignal(raw)
      entry.tool.stderr_chars = signal.stderr_chars
      entry.tool.interrupted = signal.interrupted
      entry.tool.patch = foldPatch(raw)
    }

    if (results.length > 0) continue

    // A real user turn. Consecutive user messages with no round between them, such as a
    // caveat followed by the prompt it introduces, belong to the same task.
    const text = toText(content)
    if (text !== '') pending.text.push(text)
    if (timestamp !== null) {
      pending.events.push({ type: 'user_message', ts: timestamp, chars: contentChars(content) })
      // Measured here rather than at round-build time, because by then the model has spoken and
      // `lastOutputTs` has moved on.
      if (pending.wait === null && lastOutputTs !== null && ts !== null) {
        pending.wait = ts - lastOutputTs
      }
    }
    if (!sidechain && (task === 0 || taskUsed)) {
      task += 1
      taskUsed = false
      taskStart = ts
    }
  }

  for (let i = 0; i < builders.length; i++) {
    const builder = builders[i]!
    builder.round.round = i
    builder.round.text = builder.textParts.join('\n')
    builder.round.ms =
      builder.firstTs !== null && builder.lastTs !== null ? builder.lastTs - builder.firstTs : null
    applyTiming(builder.round)
  }

  return rounds
}

/** Events are file-ordered, so the input ones sit ahead of the output ones. */
const INPUT_EVENTS = new Set<RoundEvent['type']>(['user_message', 'tool_result'])

/**
 * Fill in what the event stream says about the round's timing.
 *
 * `gen_ms` runs from the last thing that prompted the round to the last thing it produced, so it
 * covers the wait before the model said anything. That wait is the bulk of a round and sits outside
 * `ms`, which spans only the records the round itself wrote.
 */
function applyTiming(round: Round): void {
  let lastInput: number | null = null
  let lastOutput: number | null = null
  for (const event of round.events) {
    const at = parseTs(event.ts)
    if (at === null) continue
    if (INPUT_EVENTS.has(event.type)) {
      if (round.first_input === null) round.first_input = event.type as 'user_message' | 'tool_result'
      if (lastInput === null || at > lastInput) lastInput = at
    } else if (lastOutput === null || at > lastOutput) {
      lastOutput = at
    }
  }
  if (lastInput !== null && lastOutput !== null) round.gen_ms = lastOutput - lastInput
}

function applyUsage(builder: Builder, msg: Json): void {
  const usage = msg.usage
  if (!usage || typeof usage !== 'object') return
  const u = usage as Json
  const hasTokens = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'].some(
    (key) => typeof u[key] === 'number',
  )
  if (!hasTokens) return

  const uncached = asInt(u.input_tokens)
  const cacheWrite = asInt(u.cache_creation_input_tokens)
  const cacheRead = asInt(u.cache_read_input_tokens)
  // A cache write has two prices, and `cache_creation` is where the log says which kind it was.
  // Older records carry only the total; the 5-minute entry is the documented default, so an
  // unsplit total is charged there rather than at the dearer rate.
  const split = u.cache_creation
  const detail = split && typeof split === 'object' ? (split as Json) : {}
  let write1h = asInt(detail.ephemeral_1h_input_tokens)
  let write5m = asInt(detail.ephemeral_5m_input_tokens)
  if (write5m + write1h !== cacheWrite) {
    // The parts must add up to the total probez reports, whatever the record says.
    write1h = Math.min(write1h, cacheWrite)
    write5m = cacheWrite - write1h
  }
  const input = uncached + cacheWrite + cacheRead
  const output = asInt(u.output_tokens)
  const score: UsageScore = [output, input, msg.stop_reason != null ? 1 : 0]
  if (!betterUsage(score, builder.usage)) return

  builder.usage = score
  builder.round.in_tokens = input
  // The three are priced differently, and cache reads dominate the total by an order of magnitude,
  // so the sum on its own says almost nothing about what a round cost.
  builder.round.in_uncached = uncached
  builder.round.in_cache_write = cacheWrite
  builder.round.in_cache_write_5m = write5m
  builder.round.in_cache_write_1h = write1h
  builder.round.in_cache_read = cacheRead
  builder.round.out_tokens = output
}
