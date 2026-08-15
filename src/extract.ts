import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

import type { Round, ToolCall } from './types.js'

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

/**
 * Assemble rounds from one session file.
 *
 * The file is a flat, append-only record stream, so a round has to be reconstructed from records
 * that are neither contiguous nor complete on their own:
 *
 * - A round is one assistant `message.id`. Several records repeat that id — one per content block —
 *   and they must merge into a single round.
 * - Usage is message-level and repeated on those records, sometimes as a partial placeholder. The
 *   most complete snapshot wins, not the last one seen.
 * - The input that prompted a round (a user message, or the results of the previous round's tools)
 *   appears *before* it, so it buffers until the round it belongs to shows up.
 * - A tool's result frequently lands in a later round than the call, so calls are tracked for the
 *   whole session rather than per round.
 */
export async function extractSession(file: string, sessionId: string): Promise<Round[]> {
  const rounds: Round[] = []
  const builders: Builder[] = []
  const byMsgId = new Map<string, Builder>()
  const toolById = new Map<string, { tool: ToolCall; emittedTs: number | null }>()

  let pendingText: string[] = []
  let task = 0
  let taskUsed = false

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
            agent: sidechain ? 'sub' : 'main',
            id,
            ts: timestamp,
            ms: null,
            model: typeof msg.model === 'string' ? msg.model : null,
            in_tokens: 0,
            out_tokens: 0,
            user_text: pendingText.join('\n'),
            text: '',
            thinking_chars: 0,
            tools: [],
          },
          usage: null,
          firstTs: ts,
          lastTs: ts,
          textParts: [],
        }
        pendingText = []
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

      const content = msg.content
      if (!Array.isArray(content)) continue
      for (const raw of content) {
        if (!raw || typeof raw !== 'object') continue
        const block = raw as Json
        if (block.type === 'thinking') {
          builder.round.thinking_chars += contentChars(block.thinking)
        } else if (block.type === 'text') {
          const text = toText(block.text)
          if (text !== '') builder.textParts.push(text)
        } else if (block.type === 'tool_use') {
          const toolId = block.id
          if (typeof toolId !== 'string' || toolById.has(toolId)) continue
          const tool: ToolCall = {
            name: typeof block.name === 'string' ? block.name : null,
            input: truncateInput(block.input),
            result_chars: null,
            is_error: null,
            ms: null,
          }
          builder.round.tools.push(tool)
          toolById.set(toolId, { tool, emittedTs: ts })
        }
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
      const entry = toolById.get(toolId)
      if (entry === undefined) continue
      entry.tool.result_chars = contentChars(block.content)
      entry.tool.is_error = block.is_error === true
      entry.tool.ms = entry.emittedTs !== null && ts !== null ? ts - entry.emittedTs : null
    }

    if (results.length > 0) continue

    // A real user turn. Consecutive user messages with no round between them — a caveat followed
    // by the prompt it introduces, say — belong to the same task.
    const text = toText(content)
    if (text !== '') pendingText.push(text)
    if (!sidechain && (task === 0 || taskUsed)) {
      task += 1
      taskUsed = false
    }
  }

  for (let i = 0; i < builders.length; i++) {
    const builder = builders[i]!
    builder.round.round = i
    builder.round.text = builder.textParts.join('\n')
    builder.round.ms =
      builder.firstTs !== null && builder.lastTs !== null ? builder.lastTs - builder.firstTs : null
  }

  return rounds
}

function applyUsage(builder: Builder, msg: Json): void {
  const usage = msg.usage
  if (!usage || typeof usage !== 'object') return
  const u = usage as Json
  const hasTokens = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'].some(
    (key) => typeof u[key] === 'number',
  )
  if (!hasTokens) return

  const input = asInt(u.input_tokens) + asInt(u.cache_creation_input_tokens) + asInt(u.cache_read_input_tokens)
  const output = asInt(u.output_tokens)
  const score: UsageScore = [output, input, msg.stop_reason != null ? 1 : 0]
  if (!betterUsage(score, builder.usage)) return

  builder.usage = score
  builder.round.in_tokens = input
  builder.round.out_tokens = output
}
