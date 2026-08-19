import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

import { applyTiming, contentChars, inputChars, toText, truncateInput } from './extract.js'
import type { HeadHistory } from './git.js'
import type { Round, RoundEvent, ToolCall } from './types.js'

type Json = Record<string, unknown>

function stampFromText(text: string): string | null {
  const match = /<timestamp>\s*([^<]+?)\s*<\/timestamp>/i.exec(text)
  if (match === null) return null
  const ms = Date.parse(match[1]!)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

function userQueryOf(text: string): string | null {
  const match = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i.exec(text)
  if (match === null) return null
  const query = match[1]!.trim()
  return query === '' ? null : query
}

function isSubagent(sessionId: string): boolean {
  return sessionId.includes('/subagents/') || sessionId.includes('\\subagents\\')
}

/**
 * Assemble rounds from a Cursor agent-transcript JSONL file.
 *
 * Cursor rows use `role` rather than Claude's `type`, have no `message.id`, no usage, and no
 * tool results. Each assistant row is one round. A `<user_query>` starts a task. Missing fields
 * stay null rather than being guessed at.
 */
export async function extractCursorSession(
  file: string,
  sessionId: string,
  head: HeadHistory | null = null,
): Promise<Round[]> {
  const rounds: Round[] = []
  const agent = isSubagent(sessionId) ? 'sub' : 'main'

  let pendingText = ''
  let pendingEvents: RoundEvent[] = []
  let lastStamp: string | null = null
  let task = 0
  let taskUsed = false
  let taskStart: number | null = null
  let index = 0

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

    if (record.type === 'turn_ended') continue

    const role = typeof record.role === 'string' ? record.role : typeof record.type === 'string' ? record.type : null
    const message = record.message
    if (!message || typeof message !== 'object') continue
    const msg = message as Json

    if (role === 'user') {
      const text = toText(msg.content)
      const stamp = stampFromText(text)
      if (stamp !== null) lastStamp = stamp
      const query = userQueryOf(text)
      if (query === null) continue

      pendingText = query
      if (lastStamp !== null) {
        pendingEvents = [{ type: 'user_message', ts: lastStamp, chars: query.length }]
      } else {
        pendingEvents = []
      }
      if (task === 0 || taskUsed) {
        task += 1
        taskUsed = false
        taskStart = lastStamp === null ? null : Date.parse(lastStamp)
      }
      continue
    }

    if (role !== 'assistant') continue

    const id = `${sessionId}#r${index}`
    const ts = lastStamp
    const tsMs = ts === null ? null : Date.parse(ts)
    const round: Round = {
      session: sessionId,
      round: index,
      task: task === 0 ? 1 : task,
      commit: head === null ? null : head.at(taskStart ?? tsMs),
      agent,
      id,
      ts,
      ms: null,
      gen_ms: null,
      wait_ms: null,
      first_input: pendingEvents.some((event) => event.type === 'user_message') ? 'user_message' : null,
      model: null,
      in_tokens: null,
      in_uncached: null,
      in_cache_write: null,
      in_cache_write_5m: null,
      in_cache_write_1h: null,
      in_cache_read: null,
      out_tokens: null,
      mcp_server: null,
      mcp_tool: null,
      skill: null,
      user_text: pendingText,
      text: '',
      thinking_chars: 0,
      tools: [],
      events: pendingEvents,
    }
    pendingText = ''
    pendingEvents = []
    taskUsed = true

    const content = msg.content
    const blocks = Array.isArray(content) ? content : []
    const textParts: string[] = []
    let toolSeq = 0
    for (const raw of blocks) {
      if (!raw || typeof raw !== 'object') continue
      const block = raw as Json
      if (block.type === 'thinking') {
        const chars = contentChars(block.thinking)
        round.thinking_chars += chars
        if (ts !== null) round.events.push({ type: 'reasoning', ts, chars })
      } else if (block.type === 'text') {
        const text = toText(block.text)
        if (text !== '') textParts.push(text)
        if (ts !== null) round.events.push({ type: 'text', ts, chars: contentChars(block.text) })
      } else if (block.type === 'tool_use') {
        const given = typeof block.id === 'string' && block.id !== '' ? block.id : null
        const toolId = given ?? `${id}#t${toolSeq}`
        toolSeq += 1
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
          emitted_at: ts,
          result_at: null,
          ms: null,
        }
        round.tools.push(tool)
        if (ts !== null) round.events.push({ type: 'tool_call', ts, tool_call_id: toolId })
      }
    }
    round.text = textParts.join('\n')
    applyTiming(round)
    rounds.push(round)
    index += 1
  }

  return rounds
}
