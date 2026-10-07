import { createReadStream } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { errorKindOf } from './errors.js'
import { foldApplyPatch, pathFromPatch } from './extract-codex.js'
import { applyTiming, inputChars, truncateInput } from './extract.js'
import type { HeadHistory } from './git.js'
import type { ClineRef, Compaction, Patch, Round, RoundEvent, ToolCall } from './types.js'

type Json = Record<string, unknown>

/**
 * Cline keeps sessions in two formats, and a machine can hold both at once.
 *
 * - **SDK sessions**, which Cline's CLI and the current VS Code extension write under
 *   `<data>/sessions/<id>/`: a manifest `<id>.json` naming the working directory, the conversation
 *   `<id>.messages.json` (Cline's documented "messages contract v1"), and a `<agent>.messages.json`
 *   beside them for each subagent.
 * - **Legacy tasks**, which the extension wrote before the SDK — and still writes from a window
 *   running its legacy bundle — under `<data>/tasks/<id>/`: `ui_messages.json`, the event log the
 *   chat view renders, with one `api_req_started` entry per model call carrying its usage, and
 *   `task_metadata.json`, which records the model and provider in use over time.
 *
 * Neither is read in place. `collect` writes each session out as JSONL — a header line naming what
 * the reader needs, then one line per message or event — and this reader reads only that copy.
 */
export const CLINE_SESSION_KIND = 'cline.session'
export const CLINE_TASK_KIND = 'cline.task'

export function isClineRecord(row: Record<string, unknown>): boolean {
  return row.kind === CLINE_SESSION_KIND || row.kind === CLINE_TASK_KIND
}

/**
 * The text Cline appends after the history it converts when a legacy task is resumed in the SDK.
 * Everything up to it is a converted copy of the legacy task, with no timestamps and the task's
 * lifetime totals stamped on one message.
 */
export const LEGACY_RESUME_WARNING =
  'Warning: this is a legacy conversation, which means tool names may have changed. Please use the most up-to-date tools you are aware of.'

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

async function readJson(path: string): Promise<unknown> {
  try {
    return parseJson(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

function timeMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function lineCount(text: unknown): number {
  return typeof text === 'string' && text !== '' ? text.split('\n').length : 0
}

// ---------------------------------------------------------------------------------------------
// Listing what is on disk
// ---------------------------------------------------------------------------------------------

/** One Cline session as discovery sees it. */
export interface ClineListing {
  id: string
  /** The session that started this one, for a subagent. */
  parent: string | null
  cwd: string
  ref: ClineRef
  size: number
  mtimeMs: number
}

async function fileInfo(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  const info = await stat(path).catch(() => null)
  return info !== null && info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null
}

async function dirNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
}

function isMigratedLegacy(metadata: Json | null): boolean {
  return metadata?.legacyTask === true || metadata?.migratedFromLegacyTask === true
}

/**
 * SDK sessions under `<data>/sessions`. A session's id is its folder's; a subagent's messages sit in
 * its root session's folder as `<agent>.messages.json` and are nested under the root's id.
 */
async function listSdkSessions(dataDir: string, legacyIds: Set<string>): Promise<ClineListing[]> {
  const root = join(dataDir, 'sessions')
  const out: ClineListing[] = []
  for (const id of await dirNames(root)) {
    const dir = join(root, id)
    const manifest = asObject(await readJson(join(dir, `${id}.json`)))
    const cwd = asText(manifest?.cwd) ?? asText(manifest?.workspace_root)
    if (manifest === null || cwd === null) continue
    const manifestInfo = await fileInfo(join(dir, `${id}.json`))
    const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.messages.json')).sort()
    for (const name of names) {
      const stem = name.slice(0, -'.messages.json'.length)
      const file = join(dir, name)
      const info = await fileInfo(file)
      if (info === null) continue
      const main = stem === id
      // A resumed legacy task keeps its legacy id. Its converted history is left to the legacy
      // task while that still exists, so the two are told apart by name.
      const migrated = main && isMigratedLegacy(asObject(manifest.metadata))
      const sessionId = main ? (migrated && legacyIds.has(id) ? `${id}-resumed` : id) : `${id}/subagents/${stem}`
      out.push({
        id: sessionId,
        parent: main ? null : id,
        cwd,
        ref: { kind: 'sdk', manifest: join(dir, `${id}.json`), messages: file, legacyCovered: migrated && legacyIds.has(id) },
        size: info.size + (manifestInfo?.size ?? 0),
        mtimeMs: Math.max(info.mtimeMs, manifestInfo?.mtimeMs ?? 0),
      })
    }
  }
  return out
}

/** The working directory Cline's environment details name, for a legacy task with no history entry. */
const ENVIRONMENT_CWD = /# Current Working Directory \(([^)\n]+)\)/

async function legacyHistory(dataDir: string): Promise<Map<string, Json>> {
  const items = await readJson(join(dataDir, 'state', 'taskHistory.json'))
  const out = new Map<string, Json>()
  if (Array.isArray(items)) {
    for (const item of items) {
      const record = asObject(item)
      const id = asText(record?.id)
      if (record !== null && id !== null) out.set(id, record)
    }
  }
  return out
}

/**
 * Legacy tasks under `<data>/tasks`. The working directory is the one the history entry recorded;
 * a task without one — the entry pruned, or written before the field existed — is placed by the
 * environment details Cline sent with the first request, and skipped when neither names one.
 */
async function listLegacyTasks(dataDir: string): Promise<ClineListing[]> {
  const root = join(dataDir, 'tasks')
  const history = await legacyHistory(dataDir)
  const out: ClineListing[] = []
  for (const id of await dirNames(root)) {
    const dir = join(root, id)
    const ui = await fileInfo(join(dir, 'ui_messages.json'))
    if (ui === null) continue
    const item = history.get(id) ?? null
    let cwd = asText(item?.cwdOnTaskInitialization)
    if (cwd === null) {
      const api = await readFile(join(dir, 'api_conversation_history.json'), 'utf8').catch(() => '')
      const match = ENVIRONMENT_CWD.exec(api.slice(0, 200_000).replace(/\\\\/g, '\\'))
      cwd = match === null ? null : match[1]!.trim()
    }
    if (cwd === null || cwd === '') continue
    const metadata = await fileInfo(join(dir, 'task_metadata.json'))
    out.push({
      id,
      parent: null,
      cwd,
      ref: { kind: 'legacy', dir, modelId: asText(item?.modelId) ?? undefined },
      size: ui.size + (metadata?.size ?? 0),
      mtimeMs: Math.max(ui.mtimeMs, metadata?.mtimeMs ?? 0),
    })
  }
  return out
}

/**
 * Every Cline session under the given data directories, in either format. A legacy task that was
 * resumed in the SDK appears in both; see `listSdkSessions` for how the two are kept apart.
 */
export async function listClineSessions(dataDirs: string[]): Promise<ClineListing[]> {
  const legacy: ClineListing[] = []
  for (const dir of dataDirs) legacy.push(...(await listLegacyTasks(dir)))
  const legacyIds = new Set(legacy.map((task) => task.id))
  const sdk: ClineListing[] = []
  for (const dir of dataDirs) sdk.push(...(await listSdkSessions(dir, legacyIds)))
  // The same session found under two data directories is one session; the first found is read.
  const seen = new Set<string>()
  return [...sdk, ...legacy].filter((session) => (seen.has(session.id) ? false : (seen.add(session.id), true)))
}

// ---------------------------------------------------------------------------------------------
// Exporting a session to the JSONL copy
// ---------------------------------------------------------------------------------------------

async function exportSdk(ref: ClineRef & { kind: 'sdk' }): Promise<string[] | null> {
  const file = asObject(await readJson(ref.messages))
  if (file === null || !Array.isArray(file.messages)) return null
  const manifest = asObject(await readJson(ref.manifest)) ?? {}
  const metadata = asObject(manifest.metadata) ?? {}
  const fork = asObject(metadata.fork)
  const imported = asObject(metadata.importedFrom)
  const header = {
    kind: CLINE_SESSION_KIND,
    id: manifest.session_id ?? file.sessionId ?? null,
    cwd: manifest.cwd ?? null,
    agent: file.agent ?? null,
    subagent: manifest.is_subagent === true || (file.agent !== undefined && file.agent !== 'lead'),
    model: manifest.model ?? metadata.model ?? null,
    provider: manifest.provider ?? metadata.provider ?? null,
    forked_at: timeMs(fork?.forkedAt),
    imported_at: timeMs(imported?.importedAt),
    legacy_migrated: isMigratedLegacy(metadata),
    legacy_covered: ref.legacyCovered === true,
  }
  const lines = [JSON.stringify(header)]
  for (const message of file.messages) {
    const record = asObject(message)
    if (record !== null) lines.push(JSON.stringify({ kind: 'cline.message', ...record }))
  }
  return lines
}

async function exportLegacy(ref: ClineRef & { kind: 'legacy' }): Promise<string[] | null> {
  const ui = await readJson(join(ref.dir, 'ui_messages.json'))
  if (!Array.isArray(ui)) return null
  const metadata = asObject(await readJson(join(ref.dir, 'task_metadata.json'))) ?? {}
  const usage = Array.isArray(metadata.model_usage) ? metadata.model_usage : []
  const header = {
    kind: CLINE_TASK_KIND,
    model_usage: usage
      .map((entry) => asObject(entry))
      .filter((entry): entry is Json => entry !== null)
      .map((entry) => ({ ts: entry.ts ?? null, model: entry.model_id ?? null, provider: entry.model_provider_id ?? null })),
    model: ref.modelId ?? null,
  }
  const lines = [JSON.stringify(header)]
  for (const message of ui) {
    const record = asObject(message)
    if (record !== null) lines.push(JSON.stringify({ kind: 'cline.ui', ...record }))
  }
  for (const result of legacyResults(await readJson(join(ref.dir, 'api_conversation_history.json')))) {
    lines.push(JSON.stringify({ kind: 'cline.result', ...result }))
  }
  return lines
}

/** Every legacy tool result opens `[<tool> for '<target>'] Result:`, or `[<tool>] Result:`. */
const RESULT_HEADER = /^\[([a-z_]+)(?: for '([\s\S]*?)')?\] Result:\n?/
/** Cline's own wording for a tool that failed, and for one the person refused. */
const TOOL_FAILED = 'The tool execution failed with the following error:'
const TOOL_DENIED = 'The user denied this operation.'

interface LegacyResult {
  name: string
  chars: number
  error: boolean
  /** The start of the result, enough to tell what kind of failure it was. */
  head: string
}

/**
 * The tool results the legacy extension sent back to the model, in order, from its API history.
 *
 * The chat log names what each tool was asked to do but, for most tools, not what came back; the
 * API history holds the result itself. Each is a text block — or, with native tool calls, a
 * `tool_result` block holding the same text — that opens with a header naming the tool. Only the
 * name, size, a few hundred characters and whether it failed are kept.
 */
function legacyResults(history: unknown): LegacyResult[] {
  if (!Array.isArray(history)) return []
  const out: LegacyResult[] = []
  for (const message of history) {
    const record = asObject(message)
    if (record?.role !== 'user' || !Array.isArray(record.content)) continue
    for (const raw of record.content) {
      const block = asObject(raw)
      if (block === null) continue
      let text = ''
      if (block.type === 'text' && typeof block.text === 'string') text = block.text
      else if (block.type === 'tool_result') {
        text =
          typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((part) => (typeof asObject(part)?.text === 'string' ? (asObject(part)!.text as string) : '')).join('\n')
              : ''
      }
      const header = RESULT_HEADER.exec(text)
      if (header === null) continue
      const body = text.slice(header[0].length)
      out.push({
        name: header[1]!,
        chars: body.length,
        error: block.is_error === true || body.includes(TOOL_FAILED) || body.trimStart().startsWith(TOOL_DENIED),
        head: body.slice(0, 500),
      })
    }
  }
  return out
}

/** The name a legacy tool's result header uses for a tool as the chat log names it. */
function resultName(tool: ToolCall): string {
  const name = tool.name ?? ''
  return name.startsWith('mcp__') ? 'use_mcp_tool' : name
}

/**
 * Give each legacy tool the result the API history holds for it.
 *
 * Both list the task's tools in the order they ran, but neither is complete — the chat log has
 * entries no result answers, the history results for tools the log shows differently — so each tool
 * takes the next result of the same name within a few places, and a tool none matches keeps what
 * the log said. A wrong result is worse than none.
 */
function attachLegacyResults(tools: ToolCall[], results: LegacyResult[]): void {
  let next = 0
  for (const tool of tools) {
    const wanted = resultName(tool)
    let found = -1
    for (let k = next; k < Math.min(results.length, next + 4); k += 1) {
      if (results[k]!.name === wanted) {
        found = k
        break
      }
    }
    if (found === -1) continue
    const result = results[found]!
    next = found + 1
    tool.result_chars = result.chars
    if (result.error) {
      tool.is_error = true
      tool.error_kind = errorKindOf(result.head, tool.name, tool.input)
      tool.patch = null
    } else if (tool.is_error !== true) {
      tool.is_error = false
    }
  }
}

/**
 * Write one Cline session out as the JSONL copy this reader reads. False when it can no longer be
 * read, so the caller keeps whatever copy it already has.
 */
export async function exportClineSession(ref: ClineRef, target: string): Promise<boolean> {
  const lines = ref.kind === 'sdk' ? await exportSdk(ref) : await exportLegacy(ref)
  if (lines === null) return false
  await writeFile(target, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
  return true
}

// ---------------------------------------------------------------------------------------------
// Shared round building
// ---------------------------------------------------------------------------------------------

interface Usage {
  /** The whole prompt, cache included. */
  input: number
  output: number
  read: number
  write: number
}

function applyUsage(round: Round, usage: Usage): void {
  const input = Math.max(usage.input, usage.read + usage.write)
  round.in_tokens = input
  round.in_uncached = input - usage.read - usage.write
  round.in_cache_read = usage.read
  round.in_cache_write = usage.write
  // Neither format splits the cache write by retention; like Codex's, it is charged at 5 minutes.
  round.in_cache_write_5m = usage.write
  round.in_cache_write_1h = 0
  round.out_tokens = usage.output
}

class Builder {
  readonly rounds: Round[] = []
  private pendingEvents: RoundEvent[] = []
  private pendingText = ''
  private pendingWait: number | null = null
  private pendingCompaction: Compaction | null = null
  private lastOutput: number | null = null
  private lastInput: number | null = null
  private task = 0
  private taskUsed = false
  private taskStart: number | null = null
  private ids = new Set<string>()
  current: Round | null = null
  private text: string[] = []
  private end: number | null = null

  constructor(
    private readonly sessionId: string,
    private readonly head: HeadHistory | null,
    private readonly sub: boolean,
  ) {}

  private uniqueId(id: string): string {
    let candidate = id
    for (let n = 1; this.ids.has(candidate); n += 1) candidate = `${id}#${n}`
    this.ids.add(candidate)
    return candidate
  }

  /** A message the person typed: it starts a task, and prompts the next round. */
  typed(text: string, at: number | null): void {
    this.close()
    this.pendingText = text
    if (at !== null) {
      this.pendingEvents.push({ type: 'user_message', ts: iso(at)!, chars: text.length })
      if (this.pendingWait === null && this.lastOutput !== null) this.pendingWait = at - this.lastOutput
      this.lastInput = at
    }
    if (this.task === 0 || this.taskUsed) {
      this.task += 1
      this.taskUsed = false
      this.taskStart = at
    }
  }

  /** A tool's result, which prompts whichever model call comes next. */
  result(tool: ToolCall, at: number | null): void {
    if (at === null) return
    this.pendingEvents.push({ type: 'tool_result', ts: iso(at)!, chars: tool.result_chars ?? 0, tool_call_id: tool.id ?? undefined })
    this.lastInput = at
  }

  compaction(mark: Compaction): void {
    this.pendingCompaction = mark
  }

  /** Start a round for one model call. `began` is when it was asked for, if known. */
  open(id: string, model: string | null, began: number | null, agent?: 'main' | 'sub'): Round {
    this.close()
    const start = began ?? this.lastInput
    const round: Round = {
      session: this.sessionId,
      round: this.rounds.length,
      task: this.task === 0 ? 1 : this.task,
      commit: this.head === null ? null : this.head.at(this.taskStart ?? start),
      agent: agent ?? (this.sub ? 'sub' : 'main'),
      id: this.uniqueId(id),
      ts: iso(start),
      ms: null,
      gen_ms: null,
      wait_ms: this.pendingWait,
      first_input: null,
      model,
      in_tokens: null,
      in_uncached: null,
      in_cache_write: null,
      in_cache_write_5m: null,
      in_cache_write_1h: null,
      in_cache_read: null,
      out_tokens: null,
      compaction: this.pendingCompaction,
      mcp_server: null,
      mcp_tool: null,
      skill: null,
      user_text: this.pendingText,
      text: '',
      thinking_chars: 0,
      tools: [],
      events: this.pendingEvents,
    }
    this.pendingEvents = []
    this.pendingText = ''
    this.pendingWait = null
    this.pendingCompaction = null
    this.taskUsed = true
    this.current = round
    return round
  }

  /** Something the open round produced, at `at`. */
  output(at: number | null): void {
    if (at !== null && (this.end === null || at > this.end)) this.end = at
  }

  say(text: string, at: number | null): void {
    if (this.current === null) return
    if (text !== '') this.text.push(text)
    if (at !== null) this.current.events.push({ type: 'text', ts: iso(at)!, chars: text.length })
    this.output(at)
  }

  think(chars: number, at: number | null): void {
    if (this.current === null) return
    this.current.thinking_chars += chars
    if (at !== null) this.current.events.push({ type: 'reasoning', ts: iso(at)!, chars })
    this.output(at)
  }

  tool(tool: ToolCall, at: number | null): void {
    if (this.current === null) return
    this.current.tools.push(tool)
    if (at !== null && tool.id !== null) this.current.events.push({ type: 'tool_call', ts: iso(at)!, tool_call_id: tool.id })
    this.output(at)
  }

  close(): void {
    const round = this.current
    if (round === null) return
    round.text = this.text.join('\n')
    applyTiming(round)
    const began = round.ts === null ? null : Date.parse(round.ts)
    if (began !== null && this.end !== null) round.ms = Math.max(0, this.end - began)
    if (this.end !== null && (this.lastOutput === null || this.end > this.lastOutput)) this.lastOutput = this.end
    this.rounds.push(round)
    this.current = null
    this.text = []
    this.end = null
  }

  /** A round standing for usage Cline recorded apart from any one call's messages. */
  aggregate(id: string, model: string | null, at: number | null, usage: Usage, agent: 'main' | 'sub'): void {
    this.close()
    const round = this.open(id, model, at, agent)
    // An aggregate prompts nothing and is prompted by nothing; whatever was pending waits for the
    // next real call.
    this.pendingEvents = round.events
    this.pendingText = round.user_text
    this.pendingWait = round.wait_ms
    this.pendingCompaction = round.compaction
    round.events = []
    round.user_text = ''
    round.wait_ms = null
    round.compaction = null
    applyUsage(round, usage)
    this.rounds.push(round)
    this.current = null
  }
}

function blankTool(name: string, id: string, input: Json, at: number | null): ToolCall {
  return {
    name,
    id,
    input: truncateInput(input),
    input_chars: inputChars(input),
    result_chars: null,
    is_error: null,
    error_kind: null,
    stderr_chars: null,
    interrupted: null,
    patch: null,
    emitted_at: iso(at),
    result_at: null,
    ms: null,
  }
}

// ---------------------------------------------------------------------------------------------
// SDK sessions
// ---------------------------------------------------------------------------------------------

/**
 * A tool's input as `commandOf` and `pathOf` read it. `run_commands` takes a list of commands —
 * strings, or `{command, args}` — which are joined a line each, the separator the shell parser
 * already splits on; `read_files` and `apply_patch` name their file inside the input.
 */
function normalizeSdkInput(name: string, raw: unknown): Json {
  const input: Json = asObject(raw) ?? (raw === undefined ? {} : { value: raw })
  if (name === 'run_commands') {
    // A real session's model sent the list encoded as a string, `"[\"type sum.js\"]"`.
    let commands = input.commands
    if (typeof commands === 'string' && commands.trimStart().startsWith('[')) {
      const parsed = parseJson(commands)
      if (Array.isArray(parsed)) commands = parsed
    }
    const list = Array.isArray(raw) ? raw : Array.isArray(commands) ? commands : [commands ?? input.command ?? input.cmd ?? raw]
    const lines = list
      .map((entry) => {
        if (typeof entry === 'string') return entry
        const record = asObject(entry)
        if (record === null || typeof record.command !== 'string') return null
        const args = Array.isArray(record.args) ? record.args.filter((a): a is string => typeof a === 'string') : []
        return [record.command, ...args].join(' ')
      })
      .filter((line): line is string => line !== null && line !== '')
    if (lines.length > 0) return { ...input, command: lines.join('\n') }
  }
  if (name === 'read_files' && typeof input.path !== 'string') {
    const list = input.files ?? input.paths ?? input.file_paths
    const first = Array.isArray(list) ? list[0] : list
    const path = typeof first === 'string' ? first : asText(asObject(first)?.path)
    if (path !== null) return { ...input, path }
  }
  if (name === 'apply_patch' && typeof input.path !== 'string') {
    const text = typeof raw === 'string' ? raw : typeof input.input === 'string' ? input.input : ''
    const path = pathFromPatch(text)
    if (path !== null) return { ...input, path }
  }
  return input
}

/** The size of an edit, from its own input: `editor` replaces `old_text` with `new_text`. */
function sdkPatch(name: string, input: Json, raw: unknown): Patch | null {
  if (name === 'editor') {
    const files = typeof input.path === 'string' ? 1 : 0
    const added = lineCount(input.new_text)
    const removed = input.insert_line === undefined || input.insert_line === null ? lineCount(input.old_text) : 0
    return added > 0 || removed > 0 ? { files, added, removed } : null
  }
  if (name === 'apply_patch') {
    const text = typeof raw === 'string' ? raw : typeof input.input === 'string' ? input.input : ''
    return foldApplyPatch(text)
  }
  return null
}

interface SdkResult {
  text: string
  /** Whether any part of the call failed: `is_error` on the block, or `success: false` on an entry. */
  failed: boolean
  /** A command's stderr, which Cline appends after a `[stderr]` line; null when none was reported. */
  stderr: string | null
  exitCode: number | null
}

const EXIT_CODE = /exited with code (-?\d+)/
const STDERR = /\n\[stderr\]\n([\s\S]*)$/

/**
 * What a tool result said. The contract says `is_error` is the one error signal, but a real CLI
 * session reports a failed command only per entry: each command in a `run_commands` call answers
 * `{query, result, error, success}`, and `result` carries the exit status and stderr as text.
 * A result can also arrive as that list encoded into a string.
 */
function sdkResult(block: Json): SdkResult {
  let content = block.content
  if (typeof content === 'string' && content.trimStart().startsWith('[')) {
    const parsed = parseJson(content)
    if (Array.isArray(parsed)) content = parsed
  }
  if (!Array.isArray(content)) {
    const text = typeof content === 'string' ? content : content === undefined || content === null ? '' : JSON.stringify(content)
    return { text, failed: block.is_error === true, stderr: null, exitCode: null }
  }
  const texts: string[] = []
  const stderr: string[] = []
  let failed = block.is_error === true
  let exitCode: number | null = null
  for (const item of content) {
    if (typeof item === 'string') {
      texts.push(item)
      continue
    }
    const record = asObject(item)
    if (record === null) continue
    const text =
      typeof record.result === 'string'
        ? record.result
        : typeof record.text === 'string'
          ? record.text
          : typeof record.error === 'string'
            ? record.error
            : JSON.stringify(record)
    texts.push(text)
    if (record.success === false) failed = true
    const err = STDERR.exec(text)
    if (err !== null) stderr.push(err[1]!)
    const code = EXIT_CODE.exec(typeof record.error === 'string' ? record.error : text)
    if (code !== null && exitCode === null) exitCode = Number(code[1])
  }
  return { text: texts.join('\n'), failed, stderr: stderr.length > 0 ? stderr.join('\n') : null, exitCode }
}

/** What the person typed: Cline wraps it as `<user_input mode="act">…</user_input>`. */
const USER_INPUT = /^<user_input\b[^>]*>([\s\S]*)<\/user_input>$/

function typedText(text: string): string {
  const trimmed = text.trim()
  const wrapped = USER_INPUT.exec(trimmed)
  return wrapped === null ? trimmed : wrapped[1]!.trim()
}

function containsWarning(content: unknown[]): boolean {
  return content.some((block) => typeof asObject(block)?.text === 'string' && (asObject(block)!.text as string).includes(LEGACY_RESUME_WARNING))
}

/**
 * Rounds from an SDK session copy.
 *
 * A round is one model call. The contract Cline documents puts each call's `modelInfo` on its
 * assistant message and the call's `metrics` on the last assistant message of it, so a call's
 * messages run until the one carrying metrics, and an assistant message after that — or after
 * anything the person or a tool sent — is the next call. `inputTokens` is the whole prompt, cache
 * included; Cline normalizes every provider to that.
 *
 * History another session holds is skipped: a fork's copy of the session it came from (older than
 * the fork), an import from Claude Code, Codex or OpenCode (older than the import; probez reads
 * those agents directly), and a resumed legacy task's converted history, up to the warning Cline
 * appends after it, whenever the legacy task itself is still there to be read instead. When it is
 * not, the converted history is read: it is all that is left, and the task's lifetime usage sits on
 * its last assistant message as one round.
 */
function readSdk(header: Json, messages: Json[], builder: Builder): void {
  const cutoff = Math.max(asNumber(header.forked_at) ?? -Infinity, asNumber(header.imported_at) ?? -Infinity)
  let past = !Number.isFinite(cutoff)
  let skipping = header.legacy_migrated === true && header.legacy_covered === true
  const sessionModel = asText(header.model)
  const tools = new Map<string, { tool: ToolCall; raw: unknown; input: Json }>()
  let hasMetrics = false
  let afterUser = true

  for (const message of messages) {
    const content = Array.isArray(message.content) ? message.content : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : []
    if (skipping) {
      if (containsWarning(content)) skipping = false
      continue
    }
    const at = asNumber(message.ts)
    if (!past) {
      if (at === null || at < cutoff) continue
      past = true
    }
    if (asObject(message.metadata)?.displayOnly === true) continue

    if (message.role === 'user') {
      for (const block of content.map(asObject)) {
        if (block?.type !== 'tool_result') continue
        const entry = tools.get(String(block.tool_use_id))
        if (entry === undefined) continue
        const { text, failed, stderr, exitCode } = sdkResult(block)
        const tool = entry.tool
        tool.result_chars = text.length
        tool.is_error = failed
        tool.stderr_chars = stderr === null ? null : stderr.length
        tool.interrupted = null
        tool.result_at = iso(at)
        const emitted = tool.emitted_at === null ? null : Date.parse(tool.emitted_at)
        tool.ms = emitted !== null && at !== null ? Math.max(0, at - emitted) : null
        if (tool.is_error) tool.error_kind = errorKindOf(text, tool.name, tool.input, exitCode)
        else tool.patch = sdkPatch(tool.name ?? '', entry.input, entry.raw)
        builder.result(tool, at)
      }
      const text = content
        .map(asObject)
        .filter((block): block is Json => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .filter((text) => !text.includes(LEGACY_RESUME_WARNING) && !text.trimStart().startsWith('<SYSTEM_NOTICE>'))
        .map(typedText)
        .join('\n')
        .trim()
      if (text !== '') builder.typed(text, at)
      afterUser = true
      continue
    }
    if (message.role !== 'assistant') continue

    const info = asObject(message.modelInfo)
    const model = asText(info?.id) ?? sessionModel
    if (builder.current === null || hasMetrics || afterUser) {
      builder.open(String(message.id ?? `msg-${builder.rounds.length}`), model, null)
      hasMetrics = false
    }
    afterUser = false
    const round = builder.current!
    if (round.model === null && model !== null) round.model = model
    for (const block of content.map(asObject)) {
      if (block === null) continue
      if (block.type === 'text' && typeof block.text === 'string') builder.say(block.text, at)
      else if (block.type === 'thinking') builder.think(typeof block.thinking === 'string' ? block.thinking.length : 0, at)
      else if (block.type === 'tool_use') {
        const name = asText(block.name) ?? 'unknown'
        const id = asText(block.id) ?? `${round.id}#t${round.tools.length}`
        const input = normalizeSdkInput(name, block.input)
        const tool = blankTool(name, id, input, at)
        tool.input_chars = inputChars(block.input)
        // Until its result is read, a call has none; one that never gets one was interrupted.
        tool.interrupted = true
        tools.set(id, { tool, raw: block.input, input })
        builder.tool(tool, at)
      }
    }
    builder.output(at)
    const metrics = asObject(message.metrics)
    if (metrics !== null) {
      applyUsage(round, {
        input: asNumber(metrics.inputTokens) ?? 0,
        output: asNumber(metrics.outputTokens) ?? 0,
        read: asNumber(metrics.cacheReadTokens) ?? 0,
        write: asNumber(metrics.cacheWriteTokens) ?? 0,
      })
      hasMetrics = true
    }
  }
  builder.close()
}

// ---------------------------------------------------------------------------------------------
// Legacy tasks
// ---------------------------------------------------------------------------------------------

/**
 * Providers whose legacy handler reported `tokensIn` as the whole prompt, cache reads included —
 * read from each handler in Cline v3.49. Every other provider reported the uncached part with the
 * cache beside it, which is also what Cline itself assumes when it migrates a legacy task. A
 * provider that reports no cache at all reads the same either way.
 */
const INPUT_INCLUDES_CACHE = new Set(['openai', 'lmstudio', 'xai', 'zai', 'doubao', 'fireworks', 'qwen', 'litellm', 'oca', 'hicap'])

function legacyUsage(info: Json, provider: string | null): Usage | null {
  const input = asNumber(info.tokensIn)
  const output = asNumber(info.tokensOut)
  const read = asNumber(info.cacheReads) ?? 0
  const write = asNumber(info.cacheWrites) ?? 0
  if (input === null && output === null && read === 0 && write === 0) return null
  const tokensIn = input ?? 0
  const whole = provider !== null && INPUT_INCLUDES_CACHE.has(provider) ? tokensIn : tokensIn + read + write
  return { input: whole, output: output ?? 0, read, write }
}

/** The legacy tool names a chat-view tool event maps to. */
const LEGACY_TOOLS: Record<string, string> = {
  readFile: 'read_file',
  editedExistingFile: 'replace_in_file',
  newFileCreated: 'write_to_file',
  fileDeleted: 'delete_file',
  listFilesTopLevel: 'list_files',
  listFilesRecursive: 'list_files',
  listCodeDefinitionNames: 'list_code_definition_names',
  searchFiles: 'search_files',
  webFetch: 'web_fetch',
  webSearch: 'web_search',
  summarizeTask: 'summarize_task',
  useSkill: 'use_skill',
}

/**
 * The size of a legacy edit: a `replace_in_file` diff is SEARCH/REPLACE blocks, whose lines are
 * what was removed and added; a new file adds its whole content.
 */
function legacyPatch(name: string, info: Json): Patch | null {
  const files = typeof info.path === 'string' ? 1 : 0
  if (name === 'write_to_file') {
    const added = lineCount(info.content)
    return added > 0 ? { files, added, removed: 0 } : null
  }
  if (name !== 'replace_in_file' || typeof info.diff !== 'string') return null
  let added = 0
  let removed = 0
  let side: 'search' | 'replace' | null = null
  for (const line of info.diff.split('\n')) {
    if (/^-{3,} SEARCH/.test(line)) side = 'search'
    else if (/^={3,}$/.test(line)) side = 'replace'
    else if (/^\+{3,} REPLACE/.test(line)) side = null
    else if (side === 'search') removed += 1
    else if (side === 'replace') added += 1
  }
  return added > 0 || removed > 0 ? { files, added, removed } : null
}

/**
 * Rounds from a legacy task copy.
 *
 * A round is one `api_req_started` event: Cline logs one per model call and fills in its usage when
 * the call ends. Everything logged after it — text, reasoning, the tools it asked for — is that
 * call's, until the next one. Commands and MCP calls log their output too; other tools do not, so
 * their results are unknown unless an error was logged against them.
 *
 * The model and provider are not on the call; `task_metadata.json` records each change of model,
 * and a call is credited to the one in use when it started. The provider decides how `tokensIn` is
 * read (see `INPUT_INCLUDES_CACHE`).
 *
 * Cline also logs usage that belongs to no single call: `deleted_api_reqs`, the calls a checkpoint
 * restore removed from the log, and `subagent_usage`, a batch of subagents' calls. Each is one round
 * holding that usage, so the task's total is Cline's own.
 */
function readLegacy(header: Json, events: Json[], builder: Builder): void {
  const changes = (Array.isArray(header.model_usage) ? header.model_usage : [])
    .map(asObject)
    .filter((entry): entry is Json => entry !== null)
    .sort((a, b) => (asNumber(a.ts) ?? 0) - (asNumber(b.ts) ?? 0))
  const fallbackModel = asText(header.model)
  const inUse = (at: number | null): { model: string | null; provider: string | null } => {
    let chosen: Json | undefined = changes[0]
    for (const change of changes) if (at !== null && (asNumber(change.ts) ?? Infinity) <= at) chosen = change
    return { model: asText(chosen?.model) ?? fallbackModel, provider: asText(chosen?.provider) }
  }

  // Assigned from `addTool`, so TypeScript must not narrow it to its initial `null`.
  let lastTool = null as ToolCall | null
  const tools: ToolCall[] = []
  const results: LegacyResult[] = []
  const addTool = (name: string, input: Json, at: number | null): ToolCall | null => {
    if (builder.current === null) return null
    const tool = blankTool(name, `${builder.current.id}#t${builder.current.tools.length}`, input, at)
    builder.tool(tool, at)
    lastTool = tool
    tools.push(tool)
    return tool
  }
  const finishTool = (text: string, at: number | null): void => {
    const tool = lastTool
    if (tool === null) return
    tool.result_chars = (tool.result_chars ?? 0) + text.length
    tool.result_at = iso(at)
    const emitted = tool.emitted_at === null ? null : Date.parse(tool.emitted_at)
    tool.ms = emitted !== null && at !== null ? Math.max(0, at - emitted) : null
    builder.result(tool, at)
  }

  for (const event of events) {
    if (event.kind === 'cline.result') {
      results.push({ name: String(event.name), chars: asNumber(event.chars) ?? 0, error: event.error === true, head: String(event.head ?? '') })
      continue
    }
    if (event.partial === true) continue
    const at = asNumber(event.ts)
    const kind = event.type === 'say' ? asText(event.say) : asText(event.ask)
    const text = typeof event.text === 'string' ? event.text : ''
    switch (kind) {
      case 'task':
      case 'user_feedback':
      case 'user_feedback_diff':
        if (text.trim() !== '') builder.typed(text.trim(), at)
        break
      case 'api_req_started': {
        const info = asObject(parseJson(text)) ?? {}
        const { model, provider } = inUse(at)
        const round = builder.open(`api-${at ?? builder.rounds.length}`, model, at)
        const usage = legacyUsage(info, provider)
        if (usage !== null) applyUsage(round, usage)
        lastTool = null
        break
      }
      case 'api_req_finished': {
        // Early versions logged usage on a separate event after the call.
        const usage = legacyUsage(asObject(parseJson(text)) ?? {}, inUse(at).provider)
        if (builder.current !== null && builder.current.in_tokens === null && usage !== null) applyUsage(builder.current, usage)
        break
      }
      case 'text':
      case 'completion_result':
        if (event.type === 'say' || text !== '') builder.say(text, at)
        break
      case 'plan_mode_respond':
      case 'act_mode_respond':
        builder.say(asText(asObject(parseJson(text))?.response) ?? text, at)
        break
      case 'reasoning':
        builder.think(text.length, at)
        break
      case 'tool': {
        const info = asObject(parseJson(text)) ?? {}
        const name = LEGACY_TOOLS[String(info.tool)] ?? String(info.tool ?? 'unknown')
        const input: Json = {}
        for (const key of ['path', 'regex', 'filePattern']) if (typeof info[key] === 'string') input[key] = info[key]
        const tool = addTool(name, input, at)
        if (tool !== null) tool.patch = legacyPatch(name, info)
        break
      }
      case 'command':
        // Asked for approval, then logged again when it runs: one call.
        if (lastTool?.name === 'execute_command' && lastTool.result_at === null && (lastTool.input as Json).command === text) break
        addTool('execute_command', { command: text }, at)
        break
      case 'command_output':
        if (lastTool?.name === 'execute_command') finishTool(text, at)
        break
      case 'use_mcp_server': {
        const info = asObject(parseJson(text)) ?? {}
        const server = asText(info.serverName) ?? 'unknown'
        const name = info.type === 'access_mcp_resource' ? 'access_mcp_resource' : `mcp__${server}__${asText(info.toolName) ?? 'unknown'}`
        addTool(name, { server, uri: info.uri ?? null }, at)
        break
      }
      case 'mcp_server_response':
        if (lastTool !== null && lastTool.name?.startsWith('mcp__')) finishTool(text, at)
        break
      case 'browser_action_launch':
        addTool('browser_action', { action: 'launch', url: text }, at)
        break
      case 'browser_action': {
        const info = asObject(parseJson(text)) ?? {}
        addTool('browser_action', { action: info.action ?? null }, at)
        break
      }
      case 'browser_action_result':
        if (lastTool?.name === 'browser_action') finishTool(text, at)
        break
      case 'followup':
        addTool('ask_followup_question', {}, at)
        break
      case 'new_task':
        addTool('new_task', {}, at)
        break
      case 'error':
      case 'diff_error': {
        const tool = lastTool
        if (tool !== null && tool.is_error !== true && builder.current?.tools.includes(tool)) {
          tool.is_error = true
          tool.error_kind = errorKindOf(text, tool.name, tool.input)
        }
        break
      }
      case 'deleted_api_reqs':
      case 'subagent_usage': {
        const { model, provider } = inUse(at)
        const usage = legacyUsage(asObject(parseJson(text)) ?? {}, provider)
        if (usage !== null) builder.aggregate(`${kind}-${at ?? builder.rounds.length}`, kind === 'subagent_usage' ? null : model, at, usage, kind === 'subagent_usage' ? 'sub' : 'main')
        lastTool = null
        break
      }
      case 'compaction': {
        const info = asObject(parseJson(text)) ?? {}
        if (info.status !== 'completed') break
        builder.compaction({
          trigger: asText(info.mode),
          pre_tokens: asNumber(info.tokensBefore),
          post_tokens: asNumber(info.tokensAfter),
          dropped_tokens: null,
          ms: null,
          ts: iso(at),
        })
        break
      }
      default:
        if (builder.current !== null) builder.output(at)
    }
  }
  builder.close()
  attachLegacyResults(tools, results)
}

// ---------------------------------------------------------------------------------------------

/** Assemble rounds from the JSONL copy of a Cline session, in either format. */
export async function extractClineSession(
  file: string,
  sessionId: string,
  head: HeadHistory | null = null,
): Promise<Round[]> {
  let header: Json | null = null
  const rows: Json[] = []
  const stream = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.trim() === '') continue
    const row = asObject(parseJson(line))
    if (row === null) continue
    if (header === null && isClineRecord(row)) header = row
    else rows.push(row)
  }
  if (header === null) return []
  const sub = header.subagent === true || sessionId.includes('/subagents/')
  const builder = new Builder(sessionId, head, sub)
  if (header.kind === CLINE_SESSION_KIND) readSdk(header, rows, builder)
  else readLegacy(header, rows, builder)
  return builder.rounds
}
