import { createReadStream } from 'node:fs'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { errorKindOf } from './errors.js'
import { applyTiming, inputChars, truncateInput } from './extract.js'
import type { HeadHistory } from './git.js'
import { canReadSqlite, openReadOnly } from './sqlite.js'
import type { Compaction, OpencodeRef, Patch, Round, RoundEvent, ToolCall } from './types.js'

type Json = Record<string, unknown>

/**
 * The first line of the JSONL copy probez makes of an OpenCode session.
 *
 * OpenCode keeps every session in one SQLite database (`opencode.db`, from v1.14) or, before that,
 * spread over a JSON file per message and per part under `storage/`. Neither is a file probez can
 * archive per session, so `collect` writes each session out as JSONL — the session row, then each
 * message with its parts — and this reader reads only that. The copy is what `sessions/` keeps.
 */
export const OPENCODE_KIND = 'opencode.session'

export function isOpencodeRecord(row: Record<string, unknown>): boolean {
  return row.kind === OPENCODE_KIND
}

function asObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString()
}

function parseJson(text: unknown): Json | null {
  if (typeof text !== 'string') return asObject(text)
  try {
    return asObject(JSON.parse(text))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Reading OpenCode's own storage
// ---------------------------------------------------------------------------------------------

/** Whether OpenCode's database can be read by this Node, for the notice when it cannot. */
export async function canReadOpencodeDb(): Promise<boolean> {
  return canReadSqlite()
}

/** One OpenCode session as discovery sees it: where it ran, and how to tell it changed. */
export interface OpencodeListing {
  id: string
  parent: string | null
  directory: string
  ref: OpencodeRef
  /** Rows the session holds; grows whenever anything is added to it. */
  size: number
  /** Newest update to the session or anything in it, in ms. */
  mtimeMs: number
}

async function listFromDb(db: string): Promise<OpencodeListing[]> {
  const handle = await openReadOnly(db)
  if (handle === null) return []
  try {
    const rows = handle
      .prepare(
        `select s.id, s.parent_id, s.directory, s.time_updated,
           (select count(*) from message m where m.session_id = s.id) as messages,
           (select count(*) from part p where p.session_id = s.id) as parts,
           (select max(m.time_updated) from message m where m.session_id = s.id) as message_updated,
           (select max(p.time_updated) from part p where p.session_id = s.id) as part_updated
         from session s`,
      )
      .all()
    const out: OpencodeListing[] = []
    for (const row of rows) {
      const id = asText(row.id)
      const directory = asText(row.directory)
      if (id === null || directory === null) continue
      const times = [row.time_updated, row.message_updated, row.part_updated].map(asNumber)
      out.push({
        id,
        parent: asText(row.parent_id),
        directory,
        ref: { db, session: id },
        size: (asNumber(row.messages) ?? 0) + (asNumber(row.parts) ?? 0),
        mtimeMs: Math.max(0, ...times.filter((t): t is number => t !== null)),
      })
    }
    return out
  } catch {
    return []
  } finally {
    handle.close()
  }
}

async function jsonFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  return names.filter((name) => name.endsWith('.json')).sort()
}

async function readJsonFile(path: string): Promise<Json | null> {
  try {
    return parseJson(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Sessions from the layout OpenCode used before its database: `storage/session/<project>/<id>.json`,
 * `storage/message/<session>/<id>.json` and `storage/part/<message>/<id>.json`.
 */
async function listFromStorage(storage: string): Promise<OpencodeListing[]> {
  const out: OpencodeListing[] = []
  const projects = await readdir(join(storage, 'session'), { withFileTypes: true }).catch(() => [])
  for (const project of projects) {
    if (!project.isDirectory()) continue
    for (const name of await jsonFiles(join(storage, 'session', project.name))) {
      const path = join(storage, 'session', project.name, name)
      const info = await readJsonFile(path)
      const id = asText(info?.id)
      const directory = asText(info?.directory)
      if (info === null || id === null || directory === null) continue
      let size = 0
      let mtimeMs = (await stat(path).catch(() => null))?.mtimeMs ?? 0
      const messages = join(storage, 'message', id)
      for (const message of await jsonFiles(messages)) {
        size += 1
        const at = await stat(join(messages, message)).catch(() => null)
        if (at !== null) mtimeMs = Math.max(mtimeMs, at.mtimeMs)
        const parts = await stat(join(storage, 'part', message.slice(0, -'.json'.length))).catch(() => null)
        if (parts !== null) mtimeMs = Math.max(mtimeMs, parts.mtimeMs)
      }
      out.push({
        id,
        parent: asText(info.parentID),
        directory,
        ref: { storage, session: id },
        size,
        mtimeMs,
      })
    }
  }
  return out
}

/**
 * Every session under an OpenCode data directory, from the database and from the older JSON layout.
 *
 * A session present in both — a JSON copy left behind by the migration to the database — is read
 * from the database, which is where OpenCode has kept writing to it since.
 */
export async function listOpencodeSessions(dataDir: string): Promise<OpencodeListing[]> {
  const fromDb = await listFromDb(join(dataDir, 'opencode.db'))
  const seen = new Set(fromDb.map((session) => session.id))
  const fromStorage = (await listFromStorage(join(dataDir, 'storage'))).filter((s) => !seen.has(s.id))
  return [...fromDb, ...fromStorage]
}

interface Exported {
  session: Json
  messages: Array<{ id: string; created: number | null; data: Json }>
  parts: Array<{ id: string; message: string; created: number | null; data: Json }>
}

async function exportFromDb(ref: OpencodeRef & { db: string }): Promise<Exported | null> {
  const handle = await openReadOnly(ref.db)
  if (handle === null) return null
  try {
    const session = handle.prepare('select * from session where id = ?').all(ref.session)[0]
    if (session === undefined) return null
    const messages = handle
      .prepare('select id, time_created, data from message where session_id = ? order by time_created, id')
      .all(ref.session)
    const parts = handle
      .prepare('select id, message_id, time_created, data from part where session_id = ? order by id')
      .all(ref.session)
    return {
      session: {
        id: session.id,
        directory: session.directory,
        parent: session.parent_id ?? null,
        title: session.title,
        version: session.version,
        created: asNumber(session.time_created),
      },
      messages: messages.map((m) => ({ id: String(m.id), created: asNumber(m.time_created), data: parseJson(m.data) ?? {} })),
      parts: parts.map((p) => ({ id: String(p.id), message: String(p.message_id), created: asNumber(p.time_created), data: parseJson(p.data) ?? {} })),
    }
  } catch {
    return null
  } finally {
    handle.close()
  }
}

async function exportFromStorage(ref: OpencodeRef & { storage: string }): Promise<Exported | null> {
  const projects = await readdir(join(ref.storage, 'session'), { withFileTypes: true }).catch(() => [])
  let info: Json | null = null
  for (const project of projects) {
    info = await readJsonFile(join(ref.storage, 'session', project.name, `${ref.session}.json`))
    if (info !== null) break
  }
  if (info === null) return null
  const messages: Exported['messages'] = []
  const parts: Exported['parts'] = []
  for (const name of await jsonFiles(join(ref.storage, 'message', ref.session))) {
    const data = await readJsonFile(join(ref.storage, 'message', ref.session, name))
    if (data === null) continue
    const id = asText(data.id) ?? name.slice(0, -'.json'.length)
    messages.push({ id, created: asNumber(asObject(data.time)?.created), data })
    for (const partName of await jsonFiles(join(ref.storage, 'part', id))) {
      const part = await readJsonFile(join(ref.storage, 'part', id, partName))
      if (part === null) continue
      parts.push({ id: asText(part.id) ?? partName.slice(0, -'.json'.length), message: id, created: null, data: part })
    }
  }
  messages.sort((a, b) => (a.created ?? 0) - (b.created ?? 0) || (a.id < b.id ? -1 : 1))
  parts.sort((a, b) => (a.id < b.id ? -1 : 1))
  return {
    session: {
      id: info.id,
      directory: info.directory,
      parent: info.parentID ?? null,
      title: info.title,
      version: info.version,
      created: asNumber(asObject(info.time)?.created),
    },
    messages,
    parts,
  }
}

/**
 * Write one OpenCode session out as the JSONL copy this reader reads. False when the session can
 * no longer be found — deleted, or a database this Node cannot open — so the caller keeps whatever
 * copy it already has rather than replacing it with nothing.
 */
export async function exportOpencodeSession(ref: OpencodeRef, target: string): Promise<boolean> {
  const exported =
    ref.db !== undefined
      ? await exportFromDb({ ...ref, db: ref.db })
      : ref.storage !== undefined
        ? await exportFromStorage({ ...ref, storage: ref.storage })
        : null
  if (exported === null) return false
  const lines = [JSON.stringify({ kind: OPENCODE_KIND, ...exported.session })]
  const byMessage = new Map<string, Exported['parts']>()
  for (const part of exported.parts) {
    const list = byMessage.get(part.message)
    if (list === undefined) byMessage.set(part.message, [part])
    else list.push(part)
  }
  for (const message of exported.messages) {
    lines.push(JSON.stringify({ kind: 'opencode.message', id: message.id, created: message.created, data: message.data }))
    for (const part of byMessage.get(message.id) ?? []) {
      lines.push(JSON.stringify({ kind: 'opencode.part', id: part.id, message: message.id, created: part.created, data: part.data }))
    }
  }
  await writeFile(target, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
  return true
}

// ---------------------------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------------------------

/**
 * OpenCode's step usage, which is split the way probez stores it.
 *
 * OpenCode subtracts the cache from `input` itself (`input = inputTokens - cache.read -
 * cache.write`), so `input` is the uncached part. It also takes reasoning out of `output` and
 * keeps it as `reasoning`, then bills it at the output rate — so both go into `out_tokens`, or a
 * reasoning model's output would be undercounted. There is one cache-write figure with no
 * retention split; like Codex's, it is charged at the 5-minute rate.
 */
function applyUsage(round: Round, tokens: Json): void {
  const input = asNumber(tokens.input)
  const output = asNumber(tokens.output)
  const reasoning = asNumber(tokens.reasoning) ?? 0
  const cache = asObject(tokens.cache) ?? {}
  const read = asNumber(cache.read) ?? 0
  const write = asNumber(cache.write) ?? 0
  if (input === null && output === null && read === 0 && write === 0) return
  round.in_uncached = input ?? 0
  round.in_cache_read = read
  round.in_cache_write = write
  round.in_cache_write_5m = write
  round.in_cache_write_1h = 0
  round.in_tokens = round.in_uncached + write + read
  round.out_tokens = (output ?? 0) + reasoning
}

/**
 * The size of an edit, from the counts OpenCode's `edit` and `write` tools report on their result.
 *
 * Both record `filediff` with `additions` and `deletions` in the result's metadata; `write` also
 * carries the whole content, which stands in when the counts are missing.
 */
function patchOf(name: string, state: Json): Patch | null {
  const metadata = asObject(state.metadata) ?? {}
  const diff = asObject(metadata.filediff)
  const input = asObject(state.input) ?? {}
  const files = typeof input.filePath === 'string' ? 1 : 0
  if (diff !== null) {
    const added = asNumber(diff.additions) ?? 0
    const removed = asNumber(diff.deletions) ?? 0
    if (added > 0 || removed > 0) return { files, added, removed }
  }
  if (name === 'write' && typeof input.content === 'string' && input.content !== '') {
    return { files, added: input.content.split('\n').length, removed: 0 }
  }
  return null
}

interface Part {
  id: string
  created: number | null
  data: Json
}

interface Message {
  id: string
  created: number | null
  data: Json
  parts: Part[]
}

/**
 * Assemble rounds from the JSONL copy of an OpenCode session.
 *
 * A round is one model call. OpenCode brackets each call in an assistant message with a
 * `step-start` part and a `step-finish` part carrying that call's own token counts, and an
 * assistant message can hold several steps — so a round is a step, not a message. A message with
 * no `step-finish` at all (one that failed before the model answered) is one round on the
 * message's own counts.
 *
 * A tool part holds both the call and its result. The call belongs to the step that made it; the
 * result is the input to the next one, the same convention every other source uses.
 *
 * A fork starts with a copy of the session it forked from; see the reading loop for how the copy
 * is told apart and left to the original.
 *
 * Compaction is a model call OpenCode records as an ordinary assistant message, so it is counted
 * like any other. The user message that asks for it carries a `compaction` part, which marks the
 * round after it.
 */
export async function extractOpencodeSession(
  file: string,
  sessionId: string,
  head: HeadHistory | null = null,
): Promise<Round[]> {
  let isSub = false
  let sessionCreated: number | null = null
  const messages: Message[] = []
  const byId = new Map<string, Message>()

  const stream = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.trim() === '') continue
    let row: Json
    try {
      const parsed = asObject(JSON.parse(line))
      if (parsed === null) continue
      row = parsed
    } catch {
      continue
    }
    if (row.kind === OPENCODE_KIND) {
      isSub = asText(row.parent) !== null
      sessionCreated = asNumber(row.created)
    } else if (row.kind === 'opencode.message') {
      const id = asText(row.id)
      if (id === null) continue
      // A fork copies the history it forked from into the new session under new ids, but with the
      // original times — so every copied message is older than the session holding it, and every
      // message the fork made itself is newer. The copies are the original session's rounds;
      // reading them here would count each of those calls twice. OpenCode records no link to the
      // session forked from, so the time is the only mark a copy carries.
      if (sessionCreated !== null && (asNumber(row.created) ?? Infinity) < sessionCreated) continue
      const message: Message = { id, created: asNumber(row.created), data: asObject(row.data) ?? {}, parts: [] }
      messages.push(message)
      byId.set(id, message)
    } else if (row.kind === 'opencode.part') {
      const owner = byId.get(String(row.message))
      if (owner === undefined) continue
      owner.parts.push({ id: String(row.id), created: asNumber(row.created), data: asObject(row.data) ?? {} })
    }
  }

  const rounds: Round[] = []
  let pendingEvents: RoundEvent[] = []
  let pendingText = ''
  let pendingWait: number | null = null
  let pendingCompaction: Compaction | null = null
  let lastOutput: number | null = null
  let task = 0
  let taskUsed = false
  let taskStart: number | null = null

  const onUser = (message: Message): void => {
    const created = message.created ?? asNumber(asObject(message.data.time)?.created)
    for (const part of message.parts) {
      if (part.data.type === 'compaction') {
        pendingCompaction = {
          trigger: part.data.auto === true ? 'auto' : part.data.auto === false ? 'manual' : null,
          pre_tokens: null,
          post_tokens: null,
          dropped_tokens: null,
          ms: null,
          ts: iso(part.created ?? created),
        }
      }
    }
    // Text OpenCode injects on the person's behalf — a file's contents, a reminder — is marked
    // `synthetic`; it is not what they typed.
    const text = message.parts
      .filter((part) => part.data.type === 'text' && part.data.synthetic !== true)
      .map((part) => (typeof part.data.text === 'string' ? part.data.text : ''))
      .join('\n')
      .trim()
    if (text === '') return
    pendingText = text
    const at = iso(created)
    if (at !== null) {
      pendingEvents.push({ type: 'user_message', ts: at, chars: text.length })
      if (pendingWait === null && lastOutput !== null && created !== null) pendingWait = created - lastOutput
    }
    if (task === 0 || taskUsed) {
      task += 1
      taskUsed = false
      taskStart = created
    }
  }

  const newRound = (id: string, model: string | null, began: number | null): Round => {
    const round: Round = {
      session: sessionId,
      round: rounds.length,
      task: task === 0 ? 1 : task,
      commit: head === null ? null : head.at(taskStart ?? began),
      agent: isSub ? 'sub' : 'main',
      id,
      ts: iso(began),
      ms: null,
      gen_ms: null,
      wait_ms: pendingWait,
      first_input: null,
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
    return round
  }

  const finish = (round: Round, textParts: string[], ended: number | null): void => {
    round.text = textParts.join('\n')
    const began = round.ts === null ? null : Date.parse(round.ts)
    round.ms = began !== null && ended !== null ? Math.max(0, ended - began) : null
    applyTiming(round)
    if (ended !== null && (lastOutput === null || ended > lastOutput)) lastOutput = ended
    rounds.push(round)
  }

  const onAssistant = (message: Message): void => {
    // The summary a compaction asks for is itself a model call, and the compaction is not over
    // until it returns: the mark goes on the round after it, filled in from what the summary saw.
    const compacting = message.data.summary === true ? pendingCompaction : null
    if (compacting !== null) pendingCompaction = null
    const before = rounds.length
    onAssistantRounds(message)
    if (compacting !== null) {
      const summary = rounds.slice(before)
      const first = summary[0]
      const last = summary[summary.length - 1]
      compacting.pre_tokens = first?.in_tokens ?? null
      compacting.post_tokens = last?.out_tokens ?? null
      const began = first?.ts ? Date.parse(first.ts) : null
      const ended = last?.ts && last.ms !== null ? Date.parse(last.ts) + last.ms : null
      compacting.ms = began !== null && ended !== null ? ended - began : null
      pendingCompaction = compacting
    }
  }

  const onAssistantRounds = (message: Message): void => {
    const model = asText(message.data.modelID)
    const time = asObject(message.data.time) ?? {}
    const messageStart = asNumber(time.created) ?? message.created
    const steps: Part[][] = [[]]
    for (const part of message.parts) {
      if (part.data.type === 'step-start' && steps[steps.length - 1]!.length > 0) steps.push([])
      steps[steps.length - 1]!.push(part)
    }
    const finished = message.parts.some((part) => part.data.type === 'step-finish')

    for (const [index, parts] of steps.entries()) {
      const startPart = parts.find((part) => part.data.type === 'step-start')
      const finishPart = parts.find((part) => part.data.type === 'step-finish')
      // Content after the last finish belongs to a call that never completed; it still happened.
      if (finished && finishPart === undefined && parts.every((p) => p.data.type === 'step-start')) continue
      const began = index === 0 ? messageStart : (startPart?.created ?? messageStart)
      const round = newRound(finishPart?.id ?? `${message.id}#${index}`, model, began)
      const textParts: string[] = []
      for (const part of parts) {
        const data = part.data
        const at = iso(part.created)
        if (data.type === 'text' && data.synthetic !== true) {
          const text = typeof data.text === 'string' ? data.text : ''
          if (text !== '') textParts.push(text)
          if (at !== null) round.events.push({ type: 'text', ts: at, chars: text.length })
        } else if (data.type === 'reasoning') {
          const chars = typeof data.text === 'string' ? data.text.length : 0
          round.thinking_chars += chars
          if (at !== null) round.events.push({ type: 'reasoning', ts: at, chars })
        } else if (data.type === 'tool') {
          addTool(round, data, part.created)
        }
      }
      const tokens = asObject(finishPart?.data.tokens) ?? (finished ? null : asObject(message.data.tokens))
      if (tokens !== null) applyUsage(round, tokens)
      const ended = finishPart?.created ?? asNumber(time.completed) ?? null
      finish(round, textParts, ended)
    }
  }

  const addTool = (round: Round, data: Json, created: number | null): void => {
    const state = asObject(data.state) ?? {}
    const name = asText(data.tool) ?? 'unknown'
    const callId = asText(data.callID) ?? `${round.id}#t${round.tools.length}`
    const input = asObject(state.input) ?? {}
    const times = asObject(state.time) ?? {}
    const start = asNumber(times.start) ?? created
    const end = asNumber(times.end)
    const status = asText(state.status)
    const body = status === 'error' ? (typeof state.error === 'string' ? state.error : '') : typeof state.output === 'string' ? state.output : ''
    const tool: ToolCall = {
      name,
      id: callId,
      input: truncateInput(input),
      input_chars: inputChars(state.input),
      result_chars: status === 'completed' || status === 'error' ? body.length : null,
      is_error: status === 'completed' ? false : status === 'error' ? true : null,
      error_kind: null,
      stderr_chars: null,
      // A call still pending or running when the session was written never got its result.
      interrupted: status === 'pending' || status === 'running' ? true : null,
      patch: status === 'completed' ? patchOf(name, state) : null,
      emitted_at: iso(start),
      result_at: iso(end),
      ms: start !== null && end !== null ? Math.max(0, end - start) : null,
    }
    if (tool.is_error === true) tool.error_kind = errorKindOf(body, name, tool.input, null)
    round.tools.push(tool)
    if (tool.emitted_at !== null) round.events.push({ type: 'tool_call', ts: tool.emitted_at, tool_call_id: callId })
    if (tool.result_at !== null && tool.result_chars !== null) {
      pendingEvents.push({ type: 'tool_result', ts: tool.result_at, chars: tool.result_chars, tool_call_id: callId })
    }
  }

  for (const message of messages) {
    if (message.data.role === 'user') onUser(message)
    else if (message.data.role === 'assistant') onAssistant(message)
  }
  return rounds
}
