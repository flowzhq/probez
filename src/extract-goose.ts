import { createReadStream } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { errorKindOf } from './errors.js'
import { applyTiming, inputChars, truncateInput } from './extract.js'
import type { HeadHistory } from './git.js'
import { canReadSqlite, openReadOnly } from './sqlite.js'
import type { Compaction, GooseRef, Patch, Round, RoundEvent, ToolCall } from './types.js'

type Json = Record<string, unknown>

/**
 * The first line of the JSONL copy probez makes of a Goose session.
 *
 * Goose keeps every session in one SQLite database (`sessions/sessions.db`) or, before that, a JSONL
 * file per session beside it — which Goose leaves in place after importing it into the database.
 * Neither is a copy probez can read the same way twice, so `collect` writes each session out as
 * JSONL — the session row, each message, then each usage-ledger row — and this reader reads only
 * that. The copy is what `sessions/` keeps.
 */
export const GOOSE_KIND = 'goose.session'

export function isGooseRecord(row: Record<string, unknown>): boolean {
  return row.kind === GOOSE_KIND
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

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return text
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/**
 * A message's `created`, in ms. Goose writes seconds, but tolerates milliseconds on read — anything
 * past ten billion — and so does this.
 */
function messageMs(value: unknown): number | null {
  const n = asNumber(value)
  if (n === null) return null
  return n > 10_000_000_000 ? n : n * 1000
}

/**
 * A session's `created_at` or `updated_at`, in ms. SQLite's own `CURRENT_TIMESTAMP` is
 * `YYYY-MM-DD HH:MM:SS` in UTC with no zone; a row Goose wrote itself carries RFC 3339.
 */
function timestampMs(value: unknown): number | null {
  if (typeof value === 'number') return messageMs(value)
  if (typeof value !== 'string' || value === '') return null
  const plain = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
  const ms = Date.parse(plain ? `${value.replace(' ', 'T')}Z` : value)
  return Number.isFinite(ms) ? ms : null
}

// ---------------------------------------------------------------------------------------------
// Reading Goose's own storage
// ---------------------------------------------------------------------------------------------

/** Whether Goose's database can be read by this Node, for the notice when it cannot. */
export async function canReadGooseDb(): Promise<boolean> {
  return canReadSqlite()
}

/** One Goose session as discovery sees it: where it ran, and how to tell it changed. */
export interface GooseListing {
  id: string
  parent: string | null
  workingDir: string
  ref: GooseRef
  /** Rows the session holds; grows whenever anything is added to it. */
  size: number
  /** Newest update to the session or anything in it, in ms. */
  mtimeMs: number
}

const DB_NAME = 'sessions.db'

/** The columns a database has, since each Goose version added some: `parent_session_id` from v15. */
function columnsOf(handle: { prepare(sql: string): { all(...p: unknown[]): Json[] } }, table: string): Set<string> {
  return new Set(handle.prepare(`select name from pragma_table_info('${table}')`).all().map((row) => String(row.name)))
}

async function listFromDb(db: string): Promise<GooseListing[]> {
  const handle = await openReadOnly(db)
  if (handle === null) return []
  try {
    const columns = columnsOf(handle, 'sessions')
    const hasLedger = columnsOf(handle, 'usage_ledger').size > 0
    const parent = columns.has('parent_session_id') ? 's.parent_session_id' : 'null'
    const ledger = hasLedger ? '(select count(*) from usage_ledger l where l.session_id = s.id)' : '0'
    const rows = handle
      .prepare(
        `select s.id, s.working_dir, s.updated_at, ${parent} as parent_id,
           (select count(*) from messages m where m.session_id = s.id) as messages,
           (select max(m.id) from messages m where m.session_id = s.id) as last_row,
           (select max(m.created_timestamp) from messages m where m.session_id = s.id) as last_message,
           ${ledger} as ledger
         from sessions s`,
      )
      .all()
    const out: GooseListing[] = []
    for (const row of rows) {
      const id = asText(row.id)
      const workingDir = asText(row.working_dir)
      if (id === null || workingDir === null) continue
      const times = [timestampMs(row.updated_at), messageMs(row.last_message)]
      out.push({
        id,
        parent: asText(row.parent_id),
        workingDir,
        ref: { db, session: id },
        // A compaction rewrites every message under new row ids without changing how many there
        // are, so the newest row id is part of the size too.
        size: (asNumber(row.messages) ?? 0) + (asNumber(row.ledger) ?? 0) + (asNumber(row.last_row) ?? 0),
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

async function firstLine(path: string): Promise<Json | null> {
  const stream = createReadStream(path, { encoding: 'utf8', end: 1024 * 1024 })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) return asObject(parseJson(line))
    return null
  } catch {
    return null
  } finally {
    lines.close()
    stream.destroy()
  }
}

/**
 * Sessions from the layout Goose used before its database: `sessions/<id>.jsonl`, opening with a
 * line of session metadata that names the `working_dir`, then one message per line.
 */
async function listFromLegacy(dir: string): Promise<GooseListing[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  const out: GooseListing[] = []
  for (const name of names.filter((n) => n.endsWith('.jsonl')).sort()) {
    const path = join(dir, name)
    const info = await stat(path).catch(() => null)
    if (info === null || !info.isFile() || info.size === 0) continue
    const header = await firstLine(path)
    const workingDir = asText(header?.working_dir)
    if (workingDir === null) continue
    const id = name.slice(0, -'.jsonl'.length)
    out.push({ id, parent: null, workingDir, ref: { legacy: path, session: id }, size: info.size, mtimeMs: info.mtimeMs })
  }
  return out
}

/**
 * Every session under a Goose sessions directory, from the database and from the older JSONL files.
 *
 * Goose imports the JSONL files into the database the first time it creates one, under the same id,
 * and leaves the files where they were. A session present in both is read from the database.
 */
export async function listGooseSessions(sessionsDir: string): Promise<GooseListing[]> {
  const fromDb = await listFromDb(join(sessionsDir, DB_NAME))
  const seen = new Set(fromDb.map((session) => session.id))
  const fromLegacy = (await listFromLegacy(sessionsDir)).filter((s) => !seen.has(s.id))
  return [...fromDb, ...fromLegacy]
}

interface Exported {
  session: Json
  messages: Json[]
  usage: Json[]
}

/** The model a session was configured with, for messages that do not name the one that answered. */
function configuredModel(modelConfig: unknown): string | null {
  return asText(asObject(parseJson(modelConfig))?.model_name)
}

async function exportFromDb(ref: GooseRef & { db: string }): Promise<Exported | null> {
  const handle = await openReadOnly(ref.db)
  if (handle === null) return null
  try {
    const session = handle.prepare('select * from sessions where id = ?').all(ref.session)[0]
    if (session === undefined) return null
    const messages = handle
      .prepare(
        `select id, message_id, role, content_json, created_timestamp, metadata_json
         from messages where session_id = ? order by created_timestamp, id`,
      )
      .all(ref.session)
    const usage =
      columnsOf(handle, 'usage_ledger').size === 0
        ? []
        : handle
            .prepare(
              `select id, created_timestamp, model, input_tokens, output_tokens, cache_read_tokens,
                 cache_write_tokens, cost_source, is_compaction
               from usage_ledger where session_id = ? order by created_timestamp, id`,
            )
            .all(ref.session)
    return {
      session: {
        id: session.id,
        working_dir: session.working_dir,
        parent: session.parent_session_id ?? null,
        session_type: session.session_type ?? null,
        name: session.name ?? null,
        provider: session.provider_name ?? null,
        model: configuredModel(session.model_config_json),
        created: timestampMs(session.created_at),
      },
      messages: messages.map((m) => ({
        id: asText(m.message_id) ?? `row-${String(m.id)}`,
        role: m.role,
        created: messageMs(m.created_timestamp),
        content: parseJson(m.content_json) ?? [],
        metadata: parseJson(m.metadata_json) ?? {},
      })),
      usage: usage.map((u) => ({
        id: `ledger-${String(u.id)}`,
        created: messageMs(u.created_timestamp),
        model: u.model ?? null,
        input_tokens: u.input_tokens ?? null,
        output_tokens: u.output_tokens ?? null,
        cache_read_tokens: u.cache_read_tokens ?? null,
        cache_write_tokens: u.cache_write_tokens ?? null,
        source: u.cost_source ?? null,
        compaction: u.is_compaction === 1,
      })),
    }
  } catch {
    return null
  } finally {
    handle.close()
  }
}

async function exportFromLegacy(ref: GooseRef & { legacy: string }): Promise<Exported | null> {
  let text: string
  try {
    text = await readFile(ref.legacy, 'utf8')
  } catch {
    return null
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  const header = asObject(parseJson(lines[0]))
  if (header === null) return null
  const messages: Json[] = []
  for (const [index, line] of lines.slice(1).entries()) {
    const message = asObject(parseJson(line))
    if (message === null) continue
    messages.push({
      id: asText(message.id) ?? `line-${index + 1}`,
      role: message.role,
      created: messageMs(message.created),
      content: message.content ?? [],
      metadata: message.metadata ?? {},
    })
  }
  return {
    session: {
      id: ref.session,
      working_dir: header.working_dir,
      parent: null,
      session_type: header.session_type ?? null,
      name: header.name ?? header.description ?? null,
      provider: header.provider_name ?? null,
      model: configuredModel(header.model_config),
      // Goose wrote no forks or imports in this layout, so there is no copied history to tell apart.
      created: null,
    },
    messages,
    usage: [],
  }
}

/**
 * Write one Goose session out as the JSONL copy this reader reads. False when the session can no
 * longer be found — deleted, or a database this Node cannot open — so the caller keeps whatever copy
 * it already has rather than replacing it with nothing.
 */
export async function exportGooseSession(ref: GooseRef, target: string): Promise<boolean> {
  const exported =
    ref.db !== undefined
      ? await exportFromDb({ ...ref, db: ref.db })
      : ref.legacy !== undefined
        ? await exportFromLegacy({ ...ref, legacy: ref.legacy })
        : null
  if (exported === null) return false
  const lines = [JSON.stringify({ kind: GOOSE_KIND, ...exported.session })]
  for (const message of exported.messages) lines.push(JSON.stringify({ kind: 'goose.message', ...message }))
  for (const usage of exported.usage) lines.push(JSON.stringify({ kind: 'goose.usage', ...usage }))
  await writeFile(target, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
  return true
}

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

/**
 * Extensions built into Goose itself, whose tools keep the `<extension>__<tool>` name Goose gives
 * them. Every other extension is an MCP server someone configured.
 */
const BUILT_IN = new Set([
  'developer',
  'todo',
  'analyze',
  'apps',
  'chatrecall',
  'code_execution',
  'extensionmanager',
  'platform',
  'scheduler',
  'summarize',
  'summon',
  'tom',
  'skills',
  'dynamic_task',
  'subagent',
])

/**
 * The name a tool call is stored under.
 *
 * Goose namespaces every tool by the extension serving it, `github__create_issue`, and every
 * extension that is not built in is an MCP server. Those are stored as `mcp__github__create_issue`,
 * the namespace probez already recognizes MCP tools by, so they count as MCP work rather than as
 * tools nothing knows. Built-in tools keep their names; `act.ts` has a row for each.
 */
export function gooseToolName(name: string): string {
  const split = name.indexOf('__')
  if (split <= 0) return name
  return BUILT_IN.has(name.slice(0, split)) ? name : `mcp__${name}`
}

function lineCount(text: unknown): number {
  return typeof text === 'string' && text !== '' ? text.split('\n').length : 0
}

/**
 * The size of an edit, from its own arguments: Goose's results carry no diff.
 *
 * `edit` replaces `before` with `after`, so the lines of each are what was removed and added;
 * `write` adds its whole content. The `text_editor` the developer extension had before those does
 * the same under `str_replace`, `insert` and `write`. Goose records the developer extension's tools
 * bare (`edit`, as a real 1.53 session does) or prefixed (`developer__edit`); both are read.
 */
function patchOf(name: string, input: Json): Patch | null {
  const files = typeof input.path === 'string' ? 1 : 0
  const tool = name.startsWith('developer__') ? name.slice('developer__'.length) : name
  let added = 0
  let removed = 0
  if (tool === 'edit') {
    added = lineCount(input.after)
    removed = lineCount(input.before)
  } else if (tool === 'write') {
    added = lineCount(input.content)
  } else if (tool === 'text_editor') {
    if (input.command === 'str_replace') {
      added = lineCount(input.new_str)
      removed = lineCount(input.old_str)
    } else if (input.command === 'insert') {
      added = lineCount(input.new_str)
    } else if (input.command === 'write') {
      added = lineCount(input.file_text)
    }
  }
  return added > 0 || removed > 0 ? { files, added, removed } : null
}

interface Result {
  text: string
  error: boolean
  /** The shell's stderr, which Goose's `shell` reports apart from stdout; null for other tools. */
  stderr: string | null
  exitCode: number | null
}

/** What a tool's result said, as text, and whether it said the call failed. */
function resultOf(toolResult: Json): Result {
  if (toolResult.status === 'error') {
    return { text: typeof toolResult.error === 'string' ? toolResult.error : '', error: true, stderr: null, exitCode: null }
  }
  const value = toolResult.value
  // Older sessions stored the content list bare; newer ones a `CallToolResult` around it.
  const result = asObject(value)
  const content = Array.isArray(value) ? value : Array.isArray(result?.content) ? (result!.content as unknown[]) : []
  const text = content
    .map((block) => asObject(block))
    .filter((block): block is Json => block !== null && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
  const structured = asObject(result?.structuredContent)
  return {
    text,
    error: result?.isError === true,
    stderr: typeof structured?.stderr === 'string' ? structured.stderr : null,
    exitCode: asNumber(structured?.exit_code),
  }
}

// ---------------------------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------------------------

/**
 * Goose's usage for one model call, split the way probez stores it.
 *
 * Goose normalizes every provider so `input_tokens` is the whole prompt, cache reads and writes
 * included; the cache fields are parts of it. The uncached part is what is left. There is one
 * cache-write figure with no retention split; like Codex's and OpenCode's, it is charged at the
 * 5-minute rate.
 */
function applyUsage(round: Round, usage: Json, names: { input: string; output: string; read: string; write: string }): void {
  const input = asNumber(usage[names.input])
  const output = asNumber(usage[names.output])
  const read = asNumber(usage[names.read]) ?? 0
  const write = asNumber(usage[names.write]) ?? 0
  if (input === null && output === null) return
  const total = Math.max(input ?? 0, read + write)
  round.in_tokens = total
  round.in_uncached = total - read - write
  round.in_cache_read = read
  round.in_cache_write = write
  round.in_cache_write_5m = write
  round.in_cache_write_1h = 0
  round.out_tokens = output ?? 0
}

const MESSAGE_USAGE = { input: 'inputTokens', output: 'outputTokens', read: 'cacheReadTokens', write: 'cacheWriteTokens' }
const LEDGER_USAGE = { input: 'input_tokens', output: 'output_tokens', read: 'cache_read_tokens', write: 'cache_write_tokens' }

interface Message {
  id: string
  role: string
  created: number | null
  content: Json[]
  metadata: Json
}

/**
 * Assemble rounds from the JSONL copy of a Goose session.
 *
 * A round is one model call. Goose stores what a call produced as several assistant messages —
 * streamed text, then one message per tool it asked for, each followed at once by that tool's
 * response — and puts the call's usage, `metadata.usage`, on the message holding the provider's
 * reply, which comes before the call's other tool requests. So a tool response followed by more
 * from the model is a new call only when that message is the reply itself: it carries usage, or
 * text. A further tool request of the same call carries neither. A session written before Goose
 * recorded usage per message has no such mark, and wrote each call as one message followed by its
 * responses; there every tool response followed by more from the model is a new call.
 *
 * A tool response holds the result of a call made in an earlier message. The result is the input
 * to the next round, the same convention every other source uses.
 *
 * A fork (`copy_session`) and an import from another agent both start a new session holding an
 * earlier history under its original times — so every copied message is older than the session
 * holding it. The copies are the original session's rounds, or another agent's that probez reads
 * from that agent; reading them here would count each call twice.
 *
 * Compaction keeps the old messages, hidden from the model, and adds a summary the model sees but
 * the person does not. The summary's own model call is recorded only in the usage ledger, marked as
 * compaction; it is counted from there, and its mark lands on the round after it.
 */
export async function extractGooseSession(
  file: string,
  sessionId: string,
  head: HeadHistory | null = null,
): Promise<Round[]> {
  let isSub = false
  let sessionCreated: number | null = null
  let sessionModel: string | null = null
  const messages: Message[] = []
  const compactions: Json[] = []

  const stream = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.trim() === '') continue
    const row = asObject(parseJson(line))
    if (row === null) continue
    if (row.kind === GOOSE_KIND) {
      isSub = asText(row.parent) !== null || row.session_type === 'sub_agent'
      sessionCreated = asNumber(row.created)
      sessionModel = asText(row.model)
    } else if (row.kind === 'goose.message') {
      const created = asNumber(row.created)
      if (sessionCreated !== null && created !== null && created < Math.floor(sessionCreated / 1000) * 1000) continue
      const content = Array.isArray(row.content) ? row.content.map(asObject).filter((c): c is Json => c !== null) : []
      messages.push({ id: String(row.id), role: String(row.role), created, content, metadata: asObject(row.metadata) ?? {} })
    } else if (row.kind === 'goose.usage' && row.compaction === true) {
      compactions.push(row)
    }
  }

  const hasUsage = messages.some((m) => asObject(m.metadata.usage) !== null)
  const rounds: Round[] = []
  const usedIds = new Set<string>()
  const toolsById = new Map<string, ToolCall>()
  let pendingEvents: RoundEvent[] = []
  let pendingText = ''
  let pendingWait: number | null = null
  let pendingCompaction: Compaction | null = null
  let lastOutput: number | null = null
  let task = 0
  let taskUsed = false
  let taskStart: number | null = null

  let current: Round | null = null
  let currentText: string[] = []
  let currentElapsed: number | null = null
  let currentEnd: number | null = null
  let currentHasUsage = false
  // Goose copies a call's thinking onto each tool request it splits the reply into.
  let currentThinking = new Set<string>()
  let afterToolResponse = false

  const uniqueId = (id: string): string => {
    let candidate = id
    for (let n = 1; usedIds.has(candidate); n += 1) candidate = `${id}#${n}`
    usedIds.add(candidate)
    return candidate
  }

  const blankRound = (id: string, model: string | null, began: number | null): Round => ({
    session: sessionId,
    round: rounds.length,
    task: task === 0 ? 1 : task,
    commit: head === null ? null : head.at(taskStart ?? began),
    agent: isSub ? 'sub' : 'main',
    id: uniqueId(id),
    ts: iso(began),
    ms: null,
    gen_ms: null,
    wait_ms: null,
    first_input: null,
    model,
    in_tokens: null,
    in_uncached: null,
    in_cache_write: null,
    in_cache_write_5m: null,
    in_cache_write_1h: null,
    in_cache_read: null,
    out_tokens: null,
    compaction: null,
    mcp_server: null,
    mcp_tool: null,
    skill: null,
    user_text: '',
    text: '',
    thinking_chars: 0,
    tools: [],
    events: [],
  })

  const close = (): void => {
    if (current === null) return
    const round = current
    round.text = currentText.join('\n')
    applyTiming(round)
    // Goose's timestamps are whole seconds; the call's own elapsed time is the measure that holds.
    if (currentElapsed !== null) {
      round.ms = currentElapsed
      round.gen_ms = currentElapsed
    } else if (round.ts !== null && currentEnd !== null) {
      round.ms = Math.max(0, currentEnd - Date.parse(round.ts))
    }
    if (currentEnd !== null && (lastOutput === null || currentEnd > lastOutput)) lastOutput = currentEnd
    rounds.push(round)
    current = null
    currentText = []
    currentElapsed = null
    currentEnd = null
    currentHasUsage = false
    currentThinking = new Set()
  }

  const open = (message: Message, model: string | null): Round => {
    const round = blankRound(message.id, model, message.created)
    round.wait_ms = pendingWait
    round.compaction = pendingCompaction
    round.user_text = pendingText
    round.events = pendingEvents
    pendingEvents = []
    pendingText = ''
    pendingWait = null
    pendingCompaction = null
    taskUsed = true
    current = round
    return round
  }

  const onCompaction = (row: Json): void => {
    close()
    const at = messageMs(row.created) ?? asNumber(row.created)
    const round = blankRound(String(row.id), asText(row.model) ?? sessionModel, at)
    applyUsage(round, row, LEDGER_USAGE)
    // The summary was asked for with whatever results had come back; a message the person typed
    // after it is rewritten to after the compaction, and so prompts the round after this one.
    round.events = pendingEvents
    pendingEvents = []
    applyTiming(round)
    rounds.push(round)
    pendingCompaction = {
      trigger: null,
      pre_tokens: round.in_tokens,
      post_tokens: round.out_tokens,
      dropped_tokens: null,
      ms: null,
      ts: iso(at),
    }
  }

  const onUser = (message: Message): void => {
    for (const block of message.content) {
      if (block.type !== 'toolResponse') continue
      afterToolResponse = true
      const tool = toolsById.get(String(block.id))
      if (tool === undefined) continue
      const { text, error, stderr, exitCode } = resultOf(asObject(block.toolResult) ?? {})
      tool.result_chars = text.length
      tool.is_error = error
      tool.stderr_chars = stderr === null ? null : stderr.length
      tool.interrupted = null
      tool.result_at = iso(message.created)
      const emitted = tool.emitted_at === null ? null : Date.parse(tool.emitted_at)
      tool.ms = emitted !== null && message.created !== null ? Math.max(0, message.created - emitted) : null
      tool.patch = error ? null : patchOf(tool.name ?? '', asObject(tool.input) ?? {})
      if (error) tool.error_kind = errorKindOf(text, tool.name ?? '', tool.input, exitCode)
      if (tool.result_at !== null) {
        pendingEvents.push({ type: 'tool_result', ts: tool.result_at, chars: text.length, tool_call_id: String(block.id) })
      }
    }
    // Text Goose adds on the person's behalf — a compaction summary, a per-turn context note — is
    // hidden from them or marked as such; it is not what they typed.
    if (message.metadata.userVisible === false || message.metadata.turnContext === true) return
    const text = message.content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n')
      .trim()
    if (text === '') return
    close()
    afterToolResponse = false
    pendingText = text
    const at = iso(message.created)
    if (at !== null) {
      pendingEvents.push({ type: 'user_message', ts: at, chars: text.length })
      if (pendingWait === null && lastOutput !== null && message.created !== null) pendingWait = message.created - lastOutput
    }
    if (task === 0 || taskUsed) {
      task += 1
      taskUsed = false
      taskStart = message.created
    }
  }

  const onAssistant = (message: Message): void => {
    const usage = asObject(message.metadata.usage)
    const inference = asObject(message.metadata.inference)
    // The continuation Goose writes after a compaction is its own text, not a model's. Its wording
    // is fixed, and only the one written for `/compact` says the person asked for it.
    if (message.metadata.userVisible === false && usage === null && inference === null) {
      const text = message.content.map((block) => (typeof block.text === 'string' ? block.text : '')).join('\n')
      if (pendingCompaction !== null && pendingCompaction.trigger === null && text.startsWith('Your context was compacted')) {
        pendingCompaction.trigger = text.includes("at the user's request") ? 'manual' : 'auto'
      }
      return
    }
    // A provider error is written as an assistant message, but no model answered it.
    const substantive = message.content.some((block) => block.type !== 'error' && block.type !== 'systemNotification')
    if (!substantive && usage === null) return

    const model = asText(inference?.resolvedModel) ?? asText(inference?.requestedModel) ?? sessionModel
    const hasText = message.content.some((block) => block.type === 'text' && asText(block.text) !== null)
    const startsCall =
      current === null ||
      (usage !== null && currentHasUsage) ||
      (afterToolResponse && (!hasUsage || usage !== null || hasText))
    if (startsCall) {
      close()
      open(message, model)
    }
    afterToolResponse = false
    const round = current!
    if (round.model === null && model !== null) round.model = model
    const at = iso(message.created)
    for (const block of message.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        if (block.text !== '') currentText.push(block.text)
        if (at !== null) round.events.push({ type: 'text', ts: at, chars: block.text.length })
      } else if (block.type === 'thinking') {
        const key = `${String(block.signature)}\u0000${String(block.thinking)}`
        if (currentThinking.has(key)) continue
        currentThinking.add(key)
        const chars = typeof block.thinking === 'string' ? block.thinking.length : 0
        round.thinking_chars += chars
        if (at !== null) round.events.push({ type: 'reasoning', ts: at, chars })
      } else if (block.type === 'toolRequest') {
        addTool(round, block, message.created)
      }
    }
    if (message.created !== null && (currentEnd === null || message.created > currentEnd)) currentEnd = message.created
    if (usage !== null) {
      applyUsage(round, usage, MESSAGE_USAGE)
      currentElapsed = asNumber(usage.elapsedMs)
      currentHasUsage = true
    }
  }

  const addTool = (round: Round, block: Json, created: number | null): void => {
    const call = asObject(block.toolCall) ?? {}
    const value = asObject(call.value) ?? {}
    const callId = asText(block.id) ?? `${round.id}#t${round.tools.length}`
    const raw = asText(value.name) ?? 'unknown'
    const input = asObject(value.arguments) ?? {}
    const failed = call.status === 'error'
    const tool: ToolCall = {
      name: gooseToolName(raw),
      id: callId,
      input: truncateInput(input),
      input_chars: inputChars(value.arguments),
      // A request Goose could not even parse never ran; its error is all the result there is.
      result_chars: failed ? (typeof call.error === 'string' ? call.error.length : 0) : null,
      is_error: failed ? true : null,
      error_kind: null,
      stderr_chars: null,
      // Until a response is read, a call has no result; one that never gets one was interrupted.
      interrupted: failed ? null : true,
      patch: null,
      emitted_at: iso(created),
      result_at: null,
      ms: null,
    }
    if (failed) tool.error_kind = errorKindOf(typeof call.error === 'string' ? call.error : '', tool.name ?? '', tool.input, null)
    round.tools.push(tool)
    toolsById.set(callId, tool)
    if (tool.emitted_at !== null) round.events.push({ type: 'tool_call', ts: tool.emitted_at, tool_call_id: callId })
  }

  let next = 0
  for (const message of messages) {
    // A compaction's model call ran before whatever was written after it.
    while (next < compactions.length && (messageMs(compactions[next]!.created) ?? Infinity) <= (message.created ?? -Infinity)) {
      onCompaction(compactions[next]!)
      next += 1
    }
    if (message.role === 'user') onUser(message)
    else if (message.role === 'assistant') onAssistant(message)
  }
  close()
  while (next < compactions.length) {
    onCompaction(compactions[next]!)
    next += 1
  }
  return rounds
}
