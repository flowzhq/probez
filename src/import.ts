import type { Patch, Round, RoundEvent, ToolCall } from './types.js'

/**
 * Reading a project someone else exported.
 *
 * Everything here treats its input as hostile. An export arrives by email or chat, so it is a file
 * of arbitrary JSON written by a machine that is not yours: every field is checked, every string is
 * bounded, and nothing in it is allowed to decide where anything is written. The sender's own
 * `dir` and `slug` are read for their *names* and never for their paths.
 *
 * What it cannot do is verify the contents. An imported round says whatever the sender's agent said,
 * and probez will show it to you as faithfully as it shows your own. That is the point of the
 * feature and also its whole risk: see SECURITY.md.
 */

/** Longest string kept from any single field. Prompts are long; nothing here is a megabyte. */
const MAX_STRING = 200_000

/**
 * Control characters, except the tab and newline that real prose contains.
 *
 * `probez round` prints imported prompts and commands straight to a terminal, and a terminal reads
 * escape sequences as instructions: a project named with a `\u001b[2J` clears the screen, and a
 * carriage return rewrites the line above. Anything from a file someone sent has these removed —
 * they carry no meaning in a prompt, and leaving them in would let the sender write to your
 * terminal rather than merely be quoted on it.
 */
// eslint-disable-next-line no-control-regex
export const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
/** Most tool calls or events kept from one round. Real rounds have single digits. */
const MAX_LIST = 5_000

export class ImportError extends Error {}

function str(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_STRING).replace(CONTROL, '') : ''
}

function strOrNull(value: unknown): string | null {
  const text = str(value)
  return text === '' ? null : text
}

function tokenField(value: unknown): number | null {
  if (value === null || value === undefined) return null
  return numOrNull(value)
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, MAX_LIST) : []
}

/**
 * A commit hash, or null for anything that is not one.
 *
 * Kept, because where the sender's work started is a fact about the task they exported and it is
 * shown as faithfully as the rest of it. Shape-checked rather than merely stripped, because this
 * one field is printed in a fixed-width column and read as an identifier: a hash is hex and either
 * 40 or 64 characters, and anything else in that slot is a sender writing prose into a table.
 */
function commitOf(value: unknown): string | null {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) ? value : null
}

function patchOf(value: unknown): Patch | null {
  if (!value || typeof value !== 'object') return null
  const p = value as Record<string, unknown>
  return { files: num(p.files), added: num(p.added), removed: num(p.removed) }
}

function toolOf(value: unknown): ToolCall {
  const t = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    name: strOrNull(t.name),
    id: strOrNull(t.id),
    // Kept as parsed JSON, never evaluated and never used as a path — it is rendered as text.
    input: t.input,
    input_chars: num(t.input_chars),
    result_chars: numOrNull(t.result_chars),
    is_error: boolOrNull(t.is_error),
    stderr_chars: numOrNull(t.stderr_chars),
    interrupted: boolOrNull(t.interrupted),
    patch: patchOf(t.patch),
    emitted_at: strOrNull(t.emitted_at),
    result_at: strOrNull(t.result_at),
    ms: numOrNull(t.ms),
  }
}

const EVENT_TYPES = new Set<RoundEvent['type']>([
  'user_message',
  'tool_result',
  'reasoning',
  'text',
  'tool_call',
])

function eventOf(value: unknown): RoundEvent | null {
  if (!value || typeof value !== 'object') return null
  const e = value as Record<string, unknown>
  const type = e.type
  if (typeof type !== 'string' || !EVENT_TYPES.has(type as RoundEvent['type'])) return null
  const ts = strOrNull(e.ts)
  if (ts === null) return null
  const event: RoundEvent = { type: type as RoundEvent['type'], ts }
  if (typeof e.chars === 'number') event.chars = num(e.chars)
  const id = strOrNull(e.tool_call_id)
  if (id !== null) event.tool_call_id = id
  return event
}

/**
 * One record from the file, as a round of the current schema.
 *
 * Null when it is not a round at all. A record missing `session` or `id` has no identity, and
 * without identity it cannot be de-duplicated against the rest of the file.
 */
export function normalizeRound(value: unknown): Round | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const r = value as Record<string, unknown>
  // Both of these are printed and both are typed back at probez as command arguments, so they go
  // through the same strip as everything else rather than round-tripping raw.
  const session = str(r.session).slice(0, 200)
  const id = str(r.id).slice(0, 200)
  if (typeof r.session !== 'string' || session === '') return null
  if (typeof r.id !== 'string' || id === '') return null

  const uncached = tokenField(r.in_uncached)
  const cacheRead = tokenField(r.in_cache_read)
  const cacheWrite = tokenField(r.in_cache_write)
  const outTokens = tokenField(r.out_tokens)

  // Null on every field is Cursor (or any agent that never recorded usage). A number on any of
  // them is Claude's split, which is recomputed so the parts still sum to the total.
  const known =
    uncached !== null || cacheRead !== null || cacheWrite !== null || outTokens !== null

  let write1h = tokenField(r.in_cache_write_1h)
  let write5m = tokenField(r.in_cache_write_5m)
  if (known) {
    const write = cacheWrite ?? 0
    write1h = write1h ?? 0
    write5m = write5m ?? 0
    if (write5m + write1h !== write) {
      write1h = Math.min(write1h, write)
      write5m = write - write1h
    }
  }

  const first = r.first_input
  return {
    session,
    round: num(r.round),
    task: num(r.task),
    commit: commitOf(r.commit),
    agent: r.agent === 'sub' ? 'sub' : 'main',
    id,
    ts: strOrNull(r.ts),
    ms: numOrNull(r.ms),
    gen_ms: numOrNull(r.gen_ms),
    wait_ms: numOrNull(r.wait_ms),
    first_input:
      first === 'user_message' || first === 'tool_result' ? (first as 'user_message' | 'tool_result') : null,
    model: strOrNull(r.model),
    in_tokens: known ? (uncached ?? 0) + (cacheWrite ?? 0) + (cacheRead ?? 0) : null,
    in_uncached: known ? (uncached ?? 0) : null,
    in_cache_write: known ? (cacheWrite ?? 0) : null,
    in_cache_write_5m: known ? (write5m ?? 0) : null,
    in_cache_write_1h: known ? (write1h ?? 0) : null,
    in_cache_read: known ? (cacheRead ?? 0) : null,
    out_tokens: known ? (outTokens ?? 0) : null,
    mcp_server: strOrNull(r.mcp_server),
    mcp_tool: strOrNull(r.mcp_tool),
    skill: strOrNull(r.skill),
    user_text: str(r.user_text),
    text: str(r.text),
    thinking_chars: num(r.thinking_chars),
    tools: list(r.tools).map(toolOf),
    events: list(r.events)
      .map(eventOf)
      .filter((event): event is RoundEvent => event !== null),
  }
}

/** A round that predates the token split cannot be priced, and inventing the split would be a lie. */
function hasTokenSplit(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return (
    r.in_uncached === null ||
    r.in_cache_read === null ||
    r.in_cache_write === null ||
    typeof r.in_uncached === 'number' ||
    typeof r.in_cache_read === 'number' ||
    typeof r.in_cache_write === 'number'
  )
}

export interface Parsed {
  /** What the sender called the project, when the file says. */
  name: string | null
  /** The sender's own identity for it, which is what makes re-importing an update replace. */
  source: string | null
  rounds: Round[]
  /** Records that were not rounds at all. */
  skipped: number
}

/**
 * Read either export format.
 *
 * The format is decided by what the file *is* rather than by what it is called: an attachment
 * arrives with whatever extension the mail client felt like, and a bundle that has been renamed
 * `.jsonl` is still a bundle.
 */
export function parseExport(text: string): Parsed {
  const trimmed = text.trimStart()
  if (trimmed === '') throw new ImportError('that file is empty')

  return trimmed.startsWith('{') && !trimmed.slice(1).trimStart().startsWith('"session"')
    ? parseBundle(trimmed)
    : parseLines(text)
}

function parseBundle(text: string): Parsed {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // A bundle is one JSON document; a truncated download is the usual reason it will not parse.
    throw new ImportError('that file starts like a bundle but is not valid JSON — is it complete?')
  }
  if (!body || typeof body !== 'object') throw new ImportError('that file is not a probez export')
  const bundle = body as Record<string, unknown>
  const raw = bundle.rounds
  if (!Array.isArray(raw)) {
    throw new ImportError('that file has no `rounds` — a bundle export carries them under that key')
  }

  const manifest = (bundle.manifest ?? {}) as Record<string, unknown>
  return {
    name: strOrNull(manifest.project),
    // `path` and `key` name the project on the sender's machine. Read for identity only: nothing
    // here ever opens them, and the store directory is derived from a hash rather than from a path.
    source: strOrNull(manifest.slug) ?? strOrNull(manifest.path) ?? strOrNull(manifest.key),
    ...collect(raw),
  }
}

function parseLines(text: string): Parsed {
  const raw: unknown[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      raw.push(JSON.parse(line))
    } catch {
      raw.push(null)
    }
  }
  if (raw.length === 0) throw new ImportError('that file has no records in it')
  return { name: null, source: null, ...collect(raw) }
}

function collect(raw: unknown[]): { rounds: Round[]; skipped: number } {
  let priced = 0
  const rounds: Round[] = []
  const seen = new Set<string>()
  let skipped = 0

  for (const record of raw) {
    const round = normalizeRound(record)
    if (round === null) {
      skipped += 1
      continue
    }
    if (hasTokenSplit(record)) priced += 1
    // The same round twice is one round. An export is already de-duplicated; a concatenated pair
    // of them is not, and that is a thing people do.
    const key = `${round.session}\0${round.id}`
    if (seen.has(key)) continue
    seen.add(key)
    rounds.push(round)
  }

  if (rounds.length === 0) throw new ImportError('no rounds in that file')
  if (priced === 0) {
    throw new ImportError(
      'that export predates probez recording how input tokens split, so nothing in it can be priced. ' +
        'Ask for one exported from probez 0.3 or later.',
    )
  }
  return { rounds, skipped }
}
