import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ASK_MEANING, ASKS, isAsk } from './question.js'
import { readerName, readerShortName, runReader } from './reader.js'
import type { Ask, Question } from './question.js'
import type { ReaderConfig } from './reader.js'

/**
 * One model's reading of one question.
 *
 * `question.ts` says what the agent was after with one rule and one table, and that is deliberate:
 * nothing is scored and nothing executes, so `kind` is a measurement anyone can check. The price is
 * that it can only ever answer in six words plus `other`. A reading is the other thing a person
 * wants from the same eleven calls — the sentence — and it comes from a model rather than from a
 * rule, so it is kept apart from the measurement rather than folded into it:
 *
 * - It sits *beside* `kind` and never replaces it. Where the two disagree, both are shown, because
 *   a disagreement is information about the rule and hiding it would waste that.
 * - Nothing derived from a reading enters a share, a tally or a filter. Every number probez prints
 *   stays re-derivable from the rounds alone.
 * - It is asked for one question at a time, by a person, and cached. Collecting, analyzing and
 *   browsing never produce one.
 *
 * The prompt carries the calls and nothing else: no prompts the person typed, no bodies any tool
 * returned. That is the same evidence `probez question` puts on screen, and it is what makes
 * handing a question to an outside program a bounded thing to do.
 */

export interface Reading {
  schema_version: number
  /** What the agent was trying to learn, as one sentence. */
  asked: string
  /** The model's read of which of the six it was, or null when it named nothing in the table. */
  kind: Ask | null
  /** Why it read the calls that way, in a clause. */
  why: string
  /** The reader that answered, as it was written in the config. */
  by: string
  /** When it answered. */
  at: string
  /** Digest of the calls it was shown, so a reading can say it is about calls that have changed. */
  evidence: string
}

export const READING_VERSION = 1

/** Longest sentence worth keeping. A reading is a line in a table, not a paragraph. */
const MAX_ASKED = 300
const MAX_WHY = 300

// ---------------------------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------------------------

/**
 * The calls, one per line, and nothing else.
 *
 * This is both what the model is shown and what the digest is taken over, so a cached reading goes
 * stale exactly when the evidence behind it moves and not when the wording around it does.
 */
export function evidenceOf(question: Question): string {
  return question.calls
    .map((call) => {
      const asked = call.probes.length === 0 ? '—' : call.probes.join(' ')
      const where = call.sites.length === 0 ? '—' : call.sites.join(' ')
      return `${call.ref}\t${call.verb}\t${call.scope}\tasked: ${asked}\tin: ${where}\tran: ${call.text}`
    })
    .join('\n')
}

/** The digest a reading carries, so it can say whether it is still about these calls. */
export function digestOf(question: Question): string {
  return createHash('sha256').update(evidenceOf(question)).digest('hex').slice(0, 16)
}

/**
 * What is sent to the reader.
 *
 * Written to be legible to a person as well as to a model, because `probez explain --prompt` prints
 * exactly this and running nothing is a supported way to use the command.
 */
export function promptFor(question: Question): string {
  const kinds = ASKS.map((kind) => `  ${kind}: ${ASK_MEANING[kind]}`).join('\n')
  return [
    'A coding agent made the tool calls below while trying to find out one thing about a codebase.',
    'Say what it was trying to find out.',
    '',
    'Each line is one call: the round it was made in, what it did, how wide it reached, the words it',
    'searched for, the places it named, and the command as it was run. These calls are all you have;',
    'nothing the person typed and nothing any tool returned is included. Do not guess beyond them.',
    '',
    'Answer with one JSON object and nothing else:',
    '',
    '  {',
    '    "asked": "the question the agent was answering, as one sentence a developer would ask",',
    '    "kind": "one of the words below, or other",',
    '    "why": "the evidence in these calls for that kind, in one clause"',
    '  }',
    '',
    'kind is one of:',
    kinds,
    '',
    `Calls (${question.calls.length}):`,
    evidenceOf(question),
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------------------------
// Reading what came back
// ---------------------------------------------------------------------------------------------

export class ReadingError extends Error {}

/** The balanced object starting at `from`, or null if it never closes. Strings and escapes count. */
function objectAt(text: string, from: number): string | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(from, i + 1)
    }
  }
  return null
}

/** Fields a CLI wraps its answer in when it reports the run as well as the answer. */
const WRAPPERS = ['result', 'response', 'text', 'output', 'content', 'message']

/**
 * Every object in what the reader printed, wrappers opened.
 *
 * A reader may print prose around its JSON, and one that was configured with its own `--output-format
 * json` prints the answer as a *string field* of a report about the run. Both are ordinary ways to
 * have a working setup, so both are read rather than refused.
 *
 * Exported for `asking.ts`, which reads a different answer out of the same kind of program and must
 * be forgiving of it in exactly the same ways. Two copies of this would be two sets of readers that
 * work.
 */
export function* objectsIn(text: string, depth = 0): Generator<Record<string, unknown>> {
  if (depth > 2) return
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    const body = objectAt(text, i)
    if (body === null) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const record = parsed as Record<string, unknown>
    yield record
    for (const wrapper of WRAPPERS) {
      const inner = record[wrapper]
      if (typeof inner === 'string' && inner.includes('{')) yield* objectsIn(inner, depth + 1)
    }
  }
}

/**
 * One line of somebody else's output, bounded.
 *
 * Cut on a word rather than on a character: a `why` that ends "systematically read through the
 * core implementation files to map the hi" reads as a bug in probez, and the ellipsis is what says
 * the sentence went on rather than that it broke off. Exported for `asking.ts`, beside `objectsIn`.
 */
export function trim(value: unknown, cap: number): string {
  if (typeof value !== 'string') return ''
  const one = value.trim().replace(/\s+/g, ' ')
  if (one.length <= cap) return one
  const cut = one.slice(0, cap)
  const space = cut.lastIndexOf(' ')
  return `${(space > cap / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/**
 * The reading in whatever the reader printed.
 *
 * A `kind` outside the table becomes null rather than the closest guess — the same bargain
 * `question.ts` makes, and for the same reason: a wrong kind is worse than a named hole. An answer
 * with no sentence in it is a failure, and the message quotes what did come back, because a reader
 * that is answering in prose or refusing outright is the thing a person needs to see.
 */
export function parseReading(stdout: string, by: string, evidence: string): Reading {
  for (const record of objectsIn(stdout)) {
    const asked = trim(record.asked, MAX_ASKED)
    if (asked === '') continue
    const kind = trim(record.kind, 40).toLowerCase()
    return {
      schema_version: READING_VERSION,
      asked,
      kind: isAsk(kind) ? kind : null,
      why: trim(record.why, MAX_WHY),
      by,
      at: new Date().toISOString(),
      evidence,
    }
  }
  const said = stdout.trim().replace(/\s+/g, ' ').slice(0, 200)
  throw new ReadingError(
    said === ''
      ? `\`${by}\` answered with nothing`
      : `\`${by}\` did not answer with the JSON asked for. It said: ${said}`,
  )
}

// ---------------------------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------------------------

/** Readings live beside the rounds they are about, so deleting a project takes them with it. */
export function readingsFile(dir: string): string {
  return join(dir, 'readings.json')
}

/**
 * What addresses one reading.
 *
 * `at` and not `ref`, because a round can start two questions at once and `question.ts` names `at`
 * as the field that addresses one exactly. The task is part of it because `at` is a position
 * *within a task*, so it is only unique once the task is named — the same reason a round id carries
 * its task.
 */
export function readingKey(session: string, task: number, at: number): string {
  return `${session}#${task}.${at}`
}

export interface Readings {
  schema_version: number
  readings: Record<string, Reading>
}

function asReading(value: unknown): Reading | null {
  if (value === null || typeof value !== 'object') return null
  const one = value as Record<string, unknown>
  const asked = trim(one.asked, MAX_ASKED)
  if (asked === '') return null
  const kind = typeof one.kind === 'string' && isAsk(one.kind) ? one.kind : null
  return {
    schema_version: READING_VERSION,
    asked,
    kind,
    why: trim(one.why, MAX_WHY),
    by: trim(one.by, 200),
    at: trim(one.at, 40),
    evidence: trim(one.evidence, 64),
  }
}

/** Every reading held for a project. An unreadable or absent file is an empty set, not an error. */
export async function readReadings(dir: string): Promise<Record<string, Reading>> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(readingsFile(dir), 'utf8'))
  } catch {
    return {}
  }
  const held = (raw as { readings?: unknown } | null)?.readings
  if (held === null || typeof held !== 'object') return {}
  const out: Record<string, Reading> = {}
  for (const [key, value] of Object.entries(held as Record<string, unknown>)) {
    const one = asReading(value)
    if (one !== null) out[key] = one
  }
  return out
}

/**
 * Add one reading to a project's file.
 *
 * Read-modify-write of the whole file: it holds one short record per question a person has asked
 * about by hand, so it stays small, and one writer at a time is what "a person clicked explain"
 * means.
 */
export async function saveReading(dir: string, key: string, reading: Reading): Promise<void> {
  const readings = await readReadings(dir)
  readings[key] = reading
  const body: Readings = { schema_version: READING_VERSION, readings }
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(readingsFile(dir), JSON.stringify(body, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  })
}

/** Whether a reading is about calls that have since changed. Shown, never silently dropped. */
export function isStale(reading: Reading, question: Question): boolean {
  return reading.evidence !== '' && reading.evidence !== digestOf(question)
}

export interface Explained {
  reading: Reading
  /** False when the answer came out of the file, so a caller can say it ran nothing. */
  asked: boolean
  stale: boolean
}

/**
 * The reading for one question: the cached one, or a new one from the reader.
 *
 * The single path both the command and the view take, so that clicking *explain* and typing
 * `probez explain` cannot come to answer differently. A stale cached reading is returned as stale
 * rather than re-asked on its own: spending someone's tokens is a thing they ask for.
 */
export async function explainQuestion(
  dir: string,
  config: ReaderConfig,
  question: Question,
  options: { again?: boolean } = {},
): Promise<Explained> {
  const key = readingKey(question.session, question.task, question.at)
  const held = (await readReadings(dir))[key]
  if (held !== undefined && options.again !== true) {
    return { reading: held, asked: false, stale: isStale(held, question) }
  }
  const stdout = await runReader(config, promptFor(question))
  const reading = parseReading(stdout, readerShortName(config), digestOf(question))
  await saveReading(dir, key, reading)
  return { reading, asked: true, stale: false }
}
