/**
 * The query language, and what it reads a round as.
 *
 * Every read command until now addressed the round stream through a fixed hole: `--tool`,
 * `--category`, `--session`, one flag per field and no way to combine two of them with an `or` or
 * to ask for anything that is not on the list. This is the other direction — one grammar over the
 * whole record, so a question that crosses two levels can be written down.
 *
 * Three properties are load-bearing, and each of them is a constraint on this file rather than a
 * feature of it:
 *
 * 1. **Parsing never throws.** A search box is typed into one character at a time, which means the
 *    parser spends most of its life looking at `cost:>`, `"unclosed`, and `categor`. Every one of
 *    those yields a tree plus a `Diagnostic` carrying the span it is about, and an atom that cannot
 *    be read yet is *neutral* — it matches everything — so a list narrows as a query is completed
 *    instead of blanking out halfway through a word.
 *
 * 2. **The field table is the only place a field is described.** `FIELDS` is what validates a
 *    query, what the help prints, what the view's typeahead offers, and what the agentic mode is
 *    shown. Six copies of a field list is six chances for one of them to be wrong.
 *
 * 3. **Nothing here knows what a result looks like.** This parses, and it says whether one round
 *    matches. Rolling matches up into sessions, tasks and shares is `search.ts`, and printing them
 *    is the CLI's and the view's business.
 *
 * The shape is the one Sentry and Honeycomb settled on — bare words are free text, `key:value`
 * filters, `-` negates, adjacency means and — because it is the shape people can already type, and
 * because it is the shape a typeahead can complete. It is deliberately not SQL: a language with a
 * `FROM` clause is a poor fit for a box in a header, and hand-rolling a SQL engine under a
 * no-dependencies rule buys aggregation nobody asked for at the price of a parser nobody can
 * complete for you.
 */

import { COMMAND_KINDS, subCommands } from './bash.js'
import type { Command } from './bash.js'
import { CATEGORIES, TARGETS } from './classify.js'
import type { Label } from './classify.js'
import { aliasOfSource, roundSourceOf, SOURCE_ALIASES } from './agents/paths.js'
import { costOf } from './pricing.js'
import type { Pricing } from './pricing.js'
import type { Round } from './types.js'

// ---------------------------------------------------------------------------------------------
// What a query addresses
// ---------------------------------------------------------------------------------------------

/**
 * What the results are counted as.
 *
 * Matching always happens on rounds, because a round is the only thing the store records; the
 * entity says what the matched rounds are then grouped into. `in:sessions "flaky test"` is
 * therefore "sessions containing a round that mentions a flaky test", which is what someone typing
 * it means, and not "sessions whose own text mentions it" — a session has no text of its own.
 */
export type Entity = 'rounds' | 'tasks' | 'sessions' | 'projects' | 'questions' | 'trails'

export const ENTITIES: Entity[] = [
  'rounds',
  'tasks',
  'sessions',
  'projects',
  'questions',
  'trails',
]

export function isEntity(value: string): value is Entity {
  return (ENTITIES as string[]).includes(value)
}

// ---------------------------------------------------------------------------------------------
// The field table
// ---------------------------------------------------------------------------------------------

/**
 * How a field's values are read and compared.
 *
 * `number`, `money` and `duration` are one comparison with three ways of writing the operand, and
 * they are kept apart because the suffix `m` cannot mean the same thing in all three: a duration's
 * `m` is minutes and a count's is millions. Reading the suffix against the field's own kind is what
 * lets `gen:>2m` and `input:>2m` both be the obvious thing.
 */
export type FieldKind = 'text' | 'enum' | 'number' | 'money' | 'duration' | 'time'

/** Which part of a round a field addresses. The help prints one block per group. */
export type FieldGroup = 'where' | 'what' | 'cost' | 'when' | 'plain'

export const FIELD_GROUPS: Array<{ id: FieldGroup; title: string }> = [
  { id: 'where', title: 'Where it sits' },
  { id: 'what', title: 'What it did' },
  { id: 'cost', title: 'What it came to' },
  { id: 'when', title: 'When' },
  { id: 'plain', title: 'Yes or no' },
]

export interface Field {
  key: string
  kind: FieldKind
  group: FieldGroup
  /**
   * How a text value is compared. Three of these are not a choice: `tool`, `command` and `session`
   * are already matched a particular way by the flags this language compiles, and a filter that
   * quietly started meaning something else would be a silent change to documented behaviour.
   *
   * - `exact`   the whole name, case-insensitively. What `--tool` has always meant.
   * - `command` the name, or the name followed by a space, so `git` matches `git commit` the way
   *             the tools table already prints it.
   * - `session` the id, or a prefix of it that does not cross a `/`, so a short id is typeable and
   *             naming a session still means that session and not the subagents beneath it.
   * - `loose`   anywhere in the value, so `model:opus` finds `claude-opus-5`.
   */
  match?: 'exact' | 'command' | 'session' | 'loose'
  /** One line, printed in the help, shown in the typeahead, and sent to the reader. */
  says: string
  /** Every value this field can take, for enums. Validation and suggestion read the same list. */
  values?: string[]
  /** What a bare `key:value` compares against, for the help's examples. */
  example?: string
}

/**
 * What a round can be asked about.
 *
 * Note `in:` is the entity selector, not the input-token count. The collision is real — `in_tokens`
 * is what the round schema calls that field — and it is resolved in favour of the selector because
 * `in:sessions` is the more frequently typed of the two and reads as English. The counts are
 * `input:` and `output:`, which are also what the columns are called on screen.
 */
export const FIELDS: Field[] = [
  // Identity: where a round sits.
  { key: 'project', kind: 'text', group: 'where', match: 'loose', says: 'the project, by name or slug', example: 'probez' },
  { key: 'session', kind: 'text', group: 'where', match: 'session', says: 'the session, by any prefix of its id', example: '504799b8' },
  { key: 'task', kind: 'number', group: 'where', says: 'the task number within its session', example: '3' },
  { key: 'round', kind: 'number', group: 'where', says: 'the round number within its session', example: '12' },
  { key: 'commit', kind: 'text', group: 'where', match: 'loose', says: 'the commit the task started from', example: '9e4e660' },
  { key: 'model', kind: 'text', group: 'where', match: 'loose', says: 'the model that answered', example: 'opus' },
  { key: 'agent', kind: 'enum', group: 'where', says: 'who ran it: main agent or subagent, not which product', values: ['main', 'sub'] },
  { key: 'source', kind: 'enum', group: 'where', says: 'which product wrote it: claude, cursor, or codex (claude matches persisted claude-code)', values: [...SOURCE_ALIASES] },
  { key: 'skill', kind: 'text', group: 'where', match: 'loose', says: 'the skill the work was attributed to', example: 'code-review' },
  { key: 'mcp', kind: 'text', group: 'where', match: 'loose', says: 'the MCP server the work was attributed to', example: 'github' },

  // What the round did.
  { key: 'tool', kind: 'text', group: 'what', match: 'exact', says: 'a tool the round called', example: 'Bash' },
  { key: 'command', kind: 'text', group: 'what', match: 'command', says: 'a shell command it ran; "git" also matches "git commit"', example: 'grep' },
  { key: 'kind', kind: 'enum', group: 'what', says: 'the kind of command it ran', values: [...COMMAND_KINDS] },
  { key: 'category', kind: 'enum', group: 'what', says: 'the kind of work it did', values: CATEGORIES.map((c) => c.id) },
  { key: 'target', kind: 'enum', group: 'what', says: 'what it worked on', values: [...TARGETS] },

  // What it came to.
  { key: 'cost', kind: 'money', group: 'cost', says: 'what the round cost, in dollars', example: '>0.50' },
  { key: 'ms', kind: 'duration', group: 'cost', says: 'wall time the round spanned', example: '>30s' },
  { key: 'gen', kind: 'duration', group: 'cost', says: 'time from the prompt to the last output', example: '>2m' },
  { key: 'wait', kind: 'duration', group: 'cost', says: 'time spent waiting on a person', example: '>10m' },
  { key: 'input', kind: 'number', group: 'cost', says: 'input tokens', example: '>100k' },
  { key: 'output', kind: 'number', group: 'cost', says: 'output tokens', example: '>2k' },
  { key: 'cached', kind: 'number', group: 'cost', says: 'input tokens served from the prompt cache', example: '>50k' },
  { key: 'thinking', kind: 'number', group: 'cost', says: 'characters of reasoning', example: '>1k' },
  { key: 'calls', kind: 'number', group: 'cost', says: 'tool calls the round made', example: '>5' },
  { key: 'errors', kind: 'number', group: 'cost', says: 'tool calls the harness reported as failed', example: '>0' },
  { key: 'files', kind: 'number', group: 'cost', says: 'files a file-editing tool touched', example: '>3' },
  { key: 'added', kind: 'number', group: 'cost', says: 'lines added', example: '>200' },
  { key: 'removed', kind: 'number', group: 'cost', says: 'lines removed', example: '>200' },

  // When.
  { key: 'since', kind: 'time', group: 'when', says: 'rounds at or after this point', example: '7d' },
  { key: 'before', kind: 'time', group: 'when', says: 'rounds strictly before this point', example: '2026-08-01' },

  // Yes-or-no.
  {
    key: 'is',
    kind: 'enum',
    group: 'plain',
    says: 'a plain property of the round',
    values: ['error', 'quiet', 'compacted', 'interrupted', 'sub', 'main', 'asked'],
  },
  {
    key: 'has',
    kind: 'enum',
    group: 'plain',
    says: 'something the round carries',
    values: ['patch', 'thinking', 'text', 'tools', 'skill', 'mcp', 'commit'],
  },
]

/** What each `is:` and `has:` value stands for, since a single word never explains itself. */
export const PROPERTY_MEANING: Record<string, string> = {
  error: 'a tool call the harness reported as failed',
  quiet: 'stderr written, or the call cut short, while the harness reported no error',
  compacted: 'the harness compacted the context immediately before this round',
  interrupted: 'a tool call was cut short rather than running to completion',
  sub: 'a subagent ran it',
  main: 'the main agent ran it',
  asked: 'a person prompted it, not the previous round\'s tool results',
  patch: 'a file-editing tool changed lines',
  thinking: 'reasoning content',
  text: 'assistant prose',
  tools: 'at least one tool call',
  skill: 'a skill the work was attributed to',
  mcp: 'an MCP server the work was attributed to',
  commit: 'the commit its task started from',
}

const BY_KEY = new Map<string, Field>(FIELDS.map((field) => [field.key, field]))

export function fieldFor(key: string): Field | null {
  return BY_KEY.get(key) ?? null
}

/** Directives, which shape the answer rather than filtering it. Reserved as keys either way. */
const DIRECTIVES = new Set(['in', 'sort', 'limit'])

/** Every key the language accepts, for typeahead and for the near-miss hint. */
export function keys(): string[] {
  return [...FIELDS.map((field) => field.key), ...DIRECTIVES].sort()
}

/** Fields worth sorting by: the ones that are a magnitude rather than a name. */
export const SORTABLE = [
  'cost', 'ms', 'gen', 'wait', 'input', 'output', 'cached', 'thinking',
  'calls', 'errors', 'files', 'added', 'removed', 'ts', 'rounds',
]

// ---------------------------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------------------------

/** Where something is in the query text, so a diagnostic can be underlined rather than described. */
export interface Span {
  from: number
  to: number
}

export interface Diagnostic {
  message: string
  at: Span
  /** What to type instead, when there is an obvious answer. */
  hint?: string
}

export type Op = 'has' | 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'range'

export type Node =
  /** Matches everything: an empty query, and any atom too incomplete to mean anything yet. */
  | { kind: 'all' }
  /** Matches nothing: a field filter whose value is real but names something that cannot exist. */
  | { kind: 'none'; at: Span }
  | { kind: 'and'; nodes: Node[] }
  | { kind: 'or'; nodes: Node[] }
  | { kind: 'not'; node: Node }
  | { kind: 'term'; text: string; phrase: boolean; at: Span }
  | {
      kind: 'field'
      key: string
      op: Op
      /** The value as written, which is what a text field compares and what `print` puts back. */
      value: string
      /** The operand for a number, money, duration or time field. Null for text and enums. */
      low: number | null
      /** The upper bound of an `a..b` range. Null everywhere else. */
      high: number | null
      at: Span
    }

export interface Query {
  /** The query as it was written, so a result can say what produced it. */
  text: string
  node: Node
  /**
   * What the matched rounds are counted as.
   *
   * Written into the query as `in:sessions`, or set afterwards by a caller that carries it
   * separately — the view keeps it in the URL beside the query, because a tab on the results page
   * must not rewrite the words somebody typed into the bar.
   */
  entity: Entity
  sort: { key: string; desc: boolean } | null
  limit: number | null
  diagnostics: Diagnostic[]
}

// ---------------------------------------------------------------------------------------------
// Reading the text
// ---------------------------------------------------------------------------------------------

type Token =
  | { type: 'word'; text: string; phrase: boolean; at: Span }
  | { type: 'not'; at: Span }
  | { type: 'or'; at: Span }
  | { type: 'open'; at: Span }
  | { type: 'close'; at: Span }

const SPACE = /\s/

/**
 * Split the query into tokens, keeping every span.
 *
 * A quoted run is one token whatever is inside it, including spaces, colons and parentheses, which
 * is what makes it possible to search for a path or a command line verbatim. An unclosed quote runs
 * to the end of the text and is reported rather than dropped: someone mid-way through typing
 * `"src/act` should be searching for `src/act`, not for nothing.
 */
function lex(text: string, diagnostics: Diagnostic[]): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < text.length) {
    const ch = text[i]!
    if (SPACE.test(ch)) {
      i += 1
      continue
    }
    if (ch === '(') {
      tokens.push({ type: 'open', at: { from: i, to: i + 1 } })
      i += 1
      continue
    }
    if (ch === ')') {
      tokens.push({ type: 'close', at: { from: i, to: i + 1 } })
      i += 1
      continue
    }
    // A `-` is negation only where an atom can begin. Everywhere else it is part of a word, so
    // `--full`, `2026-08-01` and `some-file.ts` survive intact.
    if (ch === '-' && i + 1 < text.length && !SPACE.test(text[i + 1]!) && text[i + 1] !== ')') {
      tokens.push({ type: 'not', at: { from: i, to: i + 1 } })
      i += 1
      continue
    }

    const from = i
    // A quote around the *whole* token makes it free text; a quote after a `key:` quotes only the
    // value. Without that distinction `command:"git commit"` reads as a phrase to search for
    // rather than as the field it plainly is, and quoting a value with a space in it — the one
    // reason to quote a value at all — would not work anywhere.
    const phrase = text[from] === '"'
    let value = ''
    let open = false
    while (i < text.length) {
      const at = text[i]!
      if (at === '"') {
        open = !open
        i += 1
        continue
      }
      if (!open && (SPACE.test(at) || at === '(' || at === ')')) break
      value += at
      i += 1
    }
    if (open) {
      diagnostics.push({
        message: 'that quote is never closed',
        at: { from, to: i },
        hint: 'add a closing "',
      })
    }
    if (!phrase && (value === 'OR' || value === 'or')) {
      tokens.push({ type: 'or', at: { from, to: i } })
      continue
    }
    tokens.push({ type: 'word', text: value, phrase, at: { from, to: i } })
  }

  return tokens
}

// ---------------------------------------------------------------------------------------------
// Reading a value
// ---------------------------------------------------------------------------------------------

/** How many milliseconds a duration suffix is worth. `m` is minutes here and millions elsewhere. */
const DURATION: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/** How much a count suffix multiplies by. */
const MAGNITUDE: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 }

/** A number with its unit read against the field it was written for, or null if it is not one. */
function magnitude(raw: string, kind: FieldKind): number | null {
  const text = raw.trim().toLowerCase()
  if (text === '') return null
  if (kind === 'duration') {
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(text)
    if (match === null) return null
    return Number(match[1]) * (match[2] === undefined ? 1 : DURATION[match[2]]!)
  }
  const match = /^\$?(\d+(?:\.\d+)?)([kmb])?$/.exec(text)
  if (match === null) return null
  return Number(match[1]) * (match[2] === undefined ? 1 : MAGNITUDE[match[2]]!)
}

/**
 * A point in time, as an epoch millisecond.
 *
 * Relative first, because `7d` is what someone types and `2026-08-19T00:00:00Z` is what they would
 * have to work out. `now` is passed in rather than read here so that a parse is a pure function of
 * its inputs, which is what makes the tests able to assert on a window.
 */
function moment(raw: string, now: number): number | null {
  const text = raw.trim().toLowerCase()
  const relative = /^(\d+(?:\.\d+)?)(m|h|d|w)$/.exec(text)
  if (relative !== null) {
    const unit = relative[2] === 'w' ? 604_800_000 : DURATION[relative[2]!]!
    return now - Number(relative[1]) * unit
  }
  if (text === 'today') return new Date(new Date(now).toISOString().slice(0, 10)).getTime()
  if (text === 'yesterday') {
    return new Date(new Date(now).toISOString().slice(0, 10)).getTime() - 86_400_000
  }
  const stamp = Date.parse(raw.length === 10 ? `${raw}T00:00:00Z` : raw)
  return Number.isNaN(stamp) ? null : stamp
}

/** Characters that can lead a comparison, longest first so `>=` is read before `>`. */
const OPS: Array<[string, Op]> = [
  ['>=', 'gte'],
  ['<=', 'lte'],
  ['>', 'gt'],
  ['<', 'lt'],
]

/**
 * The edit distance between two short words, capped: past two edits it is not a typo, it is a
 * different word, and there is no point counting further.
 */
function near(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i]
    for (let j = 1; j <= b.length; j += 1) {
      row.push(
        Math.min(
          previous[j]! + 1,
          row[j - 1]! + 1,
          previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
        ),
      )
    }
    previous = row
  }
  return previous[b.length]!
}

/** The closest of `options` to `word`, when one of them is close enough to be worth suggesting. */
function didYouMean(word: string, options: string[]): string | null {
  let best: string | null = null
  let score = 3
  for (const option of options) {
    const distance = near(word.toLowerCase(), option.toLowerCase())
    if (distance < score) {
      score = distance
      best = option
    }
  }
  return best
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

export interface ParseOptions {
  /** What `since:` and `before:` are relative to. Defaults to now. */
  now?: number
}

/**
 * Read a query.
 *
 * Never throws and never returns nothing: whatever comes in, a `Query` comes out, carrying however
 * many diagnostics it took to get there. That is the whole contract, and everything downstream is
 * written to it — the view underlines the spans, the CLI prints a caret line, and both then run the
 * tree they were given.
 */
export function parse(text: string, options: ParseOptions = {}): Query {
  const now = options.now ?? Date.now()
  const diagnostics: Diagnostic[] = []
  const tokens = lex(text, diagnostics)

  let entity: Entity = 'rounds'
  let sort: Query['sort'] = null
  let limit: number | null = null
  let at = 0

  const peek = (): Token | undefined => tokens[at]

  /** `key:value`, or null when this word is not one. */
  const split = (word: string): { key: string; rest: string } | null => {
    const colon = word.indexOf(':')
    if (colon <= 0) return null
    return { key: word.slice(0, colon).toLowerCase(), rest: word.slice(colon + 1) }
  }

  const directive = (key: string, value: string, span: Span): void => {
    if (value === '') {
      diagnostics.push({ message: `\`${key}:\` needs a value`, at: span })
      return
    }
    if (key === 'in') {
      if (isEntity(value)) {
        entity = value
        return
      }
      const meant = didYouMean(value, ENTITIES)
      diagnostics.push({
        message: `\`in:${value}\` is not something to count`,
        at: span,
        hint: meant ?? ENTITIES.join(' · '),
      })
      return
    }
    if (key === 'limit') {
      const count = Number(value)
      if (Number.isInteger(count) && count >= 0) limit = count
      else diagnostics.push({ message: `\`limit:${value}\` is not a whole number`, at: span })
      return
    }
    // `sort:cost` puts the most expensive first, because that is what every table here already
    // does and because the interesting end of a magnitude is the big one. `+` asks for the other.
    const ascending = value.startsWith('+')
    const key2 = (ascending ? value.slice(1) : value.startsWith('-') ? value.slice(1) : value)
      .toLowerCase()
    if (!SORTABLE.includes(key2)) {
      const meant = didYouMean(key2, SORTABLE)
      diagnostics.push({
        message: `\`sort:${key2}\` is not something to sort by`,
        at: span,
        hint: meant ?? SORTABLE.join(' · '),
      })
      return
    }
    sort = { key: key2, desc: !ascending }
  }

  const field = (key: string, rest: string, span: Span): Node => {
    const spec = fieldFor(key)!

    if (rest === '' || rest === '>' || rest === '<' || rest === '>=' || rest === '<=') {
      // Mid-typing. Neutral rather than empty, so the list narrows as the value arrives instead of
      // going blank the moment the colon is typed.
      diagnostics.push({ message: `\`${key}:\` needs a value`, at: span })
      return { kind: 'all' }
    }

    // A bare `*` asks whether the field is set at all, which is the only question a text field with
    // no value can be asked and the one worth having for `skill:*` and `mcp:*`.
    if (rest === '*') return { kind: 'field', key, op: 'has', value: '*', low: null, high: null, at: span }

    if (spec.kind === 'enum') {
      let value = rest.toLowerCase()
      // `claude` is the CLI alias; `claude-code` is what the store writes. Both must name the
      // same rounds, or a query that parses cleanly would match nothing.
      if (key === 'source' && value === 'claude-code') value = 'claude'
      if (!(spec.values ?? []).includes(value)) {
        const meant = didYouMean(value, spec.values ?? [])
        diagnostics.push({
          message: `\`${key}:${rest}\` is not one of the ${key} values`,
          at: span,
          hint: meant ?? (spec.values ?? []).join(' · '),
        })
        // Named a value this field cannot take, so it matches nothing. Unlike an unfinished atom,
        // this is a complete thought that happens to be wrong, and answering it with everything
        // would read as the filter having been ignored.
        return { kind: 'none', at: span }
      }
      return { kind: 'field', key, op: 'eq', value, low: null, high: null, at: span }
    }

    if (spec.kind === 'text') {
      return { kind: 'field', key, op: 'eq', value: rest, low: null, high: null, at: span }
    }

    if (spec.kind === 'time') {
      const when = moment(rest, now)
      if (when === null) {
        diagnostics.push({
          message: `\`${key}:${rest}\` is not a time`,
          at: span,
          hint: 'try 7d, 3h, today, or 2026-08-01',
        })
        return { kind: 'all' }
      }
      return {
        kind: 'field',
        key,
        op: key === 'since' ? 'gte' : 'lt',
        value: rest,
        low: when,
        high: null,
        at: span,
      }
    }

    // A number, a price or a duration: one comparison, three ways of writing the operand.
    const range = rest.split('..')
    if (range.length === 2) {
      const low = magnitude(range[0]!, spec.kind)
      const high = magnitude(range[1]!, spec.kind)
      if (low === null || high === null) {
        diagnostics.push({ message: `\`${key}:${rest}\` is not a range`, at: span, hint: 'try 1..10' })
        return { kind: 'all' }
      }
      return { kind: 'field', key, op: 'range', value: rest, low, high, at: span }
    }
    let op: Op = 'eq'
    let operand = rest
    for (const [mark, found] of OPS) {
      if (operand.startsWith(mark)) {
        op = found
        operand = operand.slice(mark.length)
        break
      }
    }
    const value = magnitude(operand, spec.kind)
    if (value === null) {
      diagnostics.push({
        message: `\`${key}:${rest}\` is not a number`,
        at: span,
        hint: spec.kind === 'duration' ? 'try 30s, 2m, or 1500' : spec.kind === 'money' ? 'try 0.50' : 'try 100 or 100k',
      })
      return { kind: 'all' }
    }
    return { kind: 'field', key, op, value: rest, low: value, high: null, at: span }
  }

  const atom = (): Node => {
    const token = peek()
    if (token === undefined) return { kind: 'all' }

    if (token.type === 'open') {
      at += 1
      const inner = or()
      const next = peek()
      if (next !== undefined && next.type === 'close') at += 1
      else diagnostics.push({ message: 'that bracket is never closed', at: token.at, hint: 'add a )' })
      return inner
    }
    if (token.type === 'close') {
      at += 1
      diagnostics.push({ message: 'a ) with no ( before it', at: token.at })
      return { kind: 'all' }
    }
    if (token.type === 'or') {
      // A leading or dangling `OR`. Skip it; the tree either side is still worth running.
      at += 1
      diagnostics.push({ message: '`OR` needs something on both sides', at: token.at })
      return { kind: 'all' }
    }
    if (token.type === 'not') {
      at += 1
      return { kind: 'not', node: atom() }
    }

    at += 1
    const parts = token.phrase ? null : split(token.text)
    if (parts === null) {
      if (token.text === '') return { kind: 'all' }
      return { kind: 'term', text: token.text, phrase: token.phrase, at: token.at }
    }
    if (DIRECTIVES.has(parts.key)) {
      directive(parts.key, parts.rest, token.at)
      return { kind: 'all' }
    }
    if (fieldFor(parts.key) !== null) return field(parts.key, parts.rest, token.at)

    // Not a field. Free text with a colon in it is ordinary — a URL, a `file.ts:12`, a `git log`
    // format string — so the whole word searches as written. A key that is *nearly* a field is
    // worth saying something about, because it is far more likely to be a typo than a search.
    const meant = didYouMean(parts.key, keys())
    if (meant !== null) {
      diagnostics.push({
        message: `there is no \`${parts.key}:\` field, so this is being searched for as text`,
        at: token.at,
        hint: `did you mean ${meant}:?`,
      })
    }
    return { kind: 'term', text: token.text, phrase: false, at: token.at }
  }

  const and = (): Node => {
    const nodes: Node[] = []
    while (true) {
      const token = peek()
      if (token === undefined || token.type === 'close' || token.type === 'or') break
      nodes.push(atom())
    }
    const real = nodes.filter((node) => node.kind !== 'all')
    if (real.length === 0) return { kind: 'all' }
    if (real.length === 1) return real[0]!
    return { kind: 'and', nodes: real }
  }

  const or = (): Node => {
    const nodes: Node[] = [and()]
    while (true) {
      const token = peek()
      if (token === undefined || token.type !== 'or') break
      at += 1
      nodes.push(and())
    }
    if (nodes.length === 1) return nodes[0]!
    return { kind: 'or', nodes }
  }

  const node = or()
  // In the order they sit in the text, not the order they were noticed: the lexer reports an
  // unclosed quote before the parser has looked at anything, and a list of carets that jumps
  // backwards up the line is hard to read against the one line they all point at.
  diagnostics.sort((a, b) => a.at.from - b.at.from || a.at.to - b.at.to)
  return { text, node, entity, sort, limit, diagnostics }
}

/**
 * The query a tree stands for, written back out.
 *
 * Round-trips: `parse(print(parse(q)))` has the same tree as `parse(q)`. That is what lets the view
 * hold the query as chips and hand back something typeable, and what lets the agentic mode show
 * exactly the query it is about to run.
 */
export function print(query: Query): string {
  const quote = (value: string): string =>
    value === '' || /[\s()"]/.test(value) ? `"${value.replace(/"/g, '')}"` : value

  const write = (node: Node, inside: boolean): string => {
    switch (node.kind) {
      case 'all':
        return ''
      case 'none':
        return 'is:nothing'
      case 'term':
        return quote(node.text)
      case 'field':
        return `${node.key}:${node.op === 'has' ? '*' : quote(node.value)}`
      case 'not':
        return `-${write(node.node, true)}`
      case 'and': {
        const body = node.nodes.map((child) => write(child, true)).filter((part) => part !== '')
        return inside && body.length > 1 ? `(${body.join(' ')})` : body.join(' ')
      }
      case 'or': {
        const body = node.nodes.map((child) => write(child, true)).filter((part) => part !== '')
        return body.length > 1 ? (inside ? `(${body.join(' OR ')})` : body.join(' OR ')) : body.join('')
      }
    }
  }

  const parts = [write(query.node, false)]
  if (query.entity !== 'rounds') parts.push(`in:${query.entity}`)
  if (query.sort !== null) parts.push(`sort:${query.sort.desc ? '' : '+'}${query.sort.key}`)
  if (query.limit !== null) parts.push(`limit:${query.limit}`)
  return parts.filter((part) => part !== '').join(' ')
}

/**
 * Write or replace a `source:` token in a query string.
 *
 * The search page's dropdown calls this so picking Cursor and typing `source:cursor` stay the
 * same language. Browse pages pin with `?source=` instead. A new source replaces the previous
 * token instead of appending a second one. `null` removes every `source:` atom (All).
 */
export function setSourceQuery(text: string, alias: string | null): string {
  const stripped = text
    .replace(/(?:^|\s)-?source:(?:claude-code|claude|cursor|codex|unknown)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (alias === null || alias === '') return stripped
  return stripped === '' ? `source:${alias}` : `${stripped} source:${alias}`
}

/** The last `source:` token in a query, as a CLI alias, or null when the query does not name one. */
export function sourceQueryOf(text: string): string | null {
  const matches = [...text.matchAll(/\bsource:(claude-code|claude|cursor|codex|unknown)\b/gi)]
  if (matches.length === 0) return null
  const raw = matches[matches.length - 1]![1]!.toLowerCase()
  return raw === 'claude-code' ? 'claude' : raw
}

// ---------------------------------------------------------------------------------------------
// What a round looks like to a query
// ---------------------------------------------------------------------------------------------

/**
 * One round, as the fields address it.
 *
 * An interface rather than a function over `Round` because the index that arrives next answers the
 * same questions from columns instead of from records, and the evaluator should not have to know
 * which of the two it is reading. Everything is lazy: a query of only `tool:Bash` must never build
 * the text haystack, which is the expensive part.
 */
export interface Subject {
  /** Every value this field holds for this round. Empty when it holds none. */
  strings(key: string): string[]
  /** The magnitude this field holds, or null when there is none to compare. */
  number(key: string): number | null
  /** Whether this round has the named property. */
  property(key: 'is' | 'has', value: string): boolean
  /** Everything free text searches, lowercased, built once. */
  haystack(): string
}

function compare(op: Op, found: number, low: number, high: number | null): boolean {
  switch (op) {
    case 'gt':
      return found > low
    case 'gte':
      return found >= low
    case 'lt':
      return found < low
    case 'lte':
      return found <= low
    case 'range':
      return found >= low && found <= (high ?? low)
    default:
      return found === low
  }
}

/** Whether a value satisfies a text field, by that field's own rule. See `Field.match`. */
function names(found: string, wanted: string, mode: Field['match']): boolean {
  const a = found.toLowerCase()
  const b = wanted.toLowerCase()
  if (b === '') return false
  switch (mode) {
    case 'command':
      return a === b || a.startsWith(`${b} `)
    case 'session':
      // A prefix, but never one that reaches past the segment it started in: `504799b8` is the
      // session and not `504799b8/a8261ff4`, which is a session of its own.
      return a === b || (a.startsWith(b) && !a.slice(b.length).includes('/'))
    case 'loose':
      return a.includes(b)
    default:
      return a === b
  }
}

/**
 * Every field key the tree names.
 *
 * Labelling a set of rounds is the expensive part of answering a query and most queries do not need
 * it, so the caller asks this first and skips the pass when `category` and `target` are absent. It
 * is also what the view reads to render a query as chips.
 */
export function fieldsUsed(node: Node): Set<string> {
  const found = new Set<string>()
  const walk = (at: Node): void => {
    switch (at.kind) {
      case 'field':
        found.add(at.key)
        return
      case 'and':
      case 'or':
        at.nodes.forEach(walk)
        return
      case 'not':
        walk(at.node)
        return
      default:
        return
    }
  }
  walk(node)
  return found
}

/** Whether a term is one plain word, which is what decides how it is looked for. */
export function isWord(text: string): boolean {
  if (text === '') return false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    const alnum =
      (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')
    if (!alnum) return false
  }
  return true
}

function alnumAt(text: string, at: number): boolean {
  const ch = text[at]
  if (ch === undefined) return false
  return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')
}

/**
 * Whether free text is in a round.
 *
 * One rule: the text has to appear where a word starts. `tok` finds `tokens`; `oken` does not find
 * it, and `"npm test"` does not find `pnpm test`. The end is left open, so what is typed matches
 * the start of a word rather than only a whole one, which is what makes a search narrow as it is
 * typed instead of finding nothing until the last letter.
 *
 * That boundary is not a nicety. It is the rule an index can answer — words can be indexed and
 * arbitrary substrings cannot — so it is what lets `searchindex.ts` narrow to candidates that this
 * then settles, with both sides agreeing by construction rather than by coincidence. Matching any
 * substring anywhere would mean every query read every round.
 */
export function searches(haystack: string, term: string): boolean {
  const wanted = term.toLowerCase()
  if (wanted === '') return false
  let from = 0
  while (true) {
    const at = haystack.indexOf(wanted, from)
    if (at === -1) return false
    // What comes before must not be a word character; what comes after may be anything.
    if (!alnumAt(haystack, at - 1)) return true
    from = at + 1
  }
}

export function matches(node: Node, subject: Subject): boolean {
  switch (node.kind) {
    case 'all':
      return true
    case 'none':
      return false
    case 'and':
      return node.nodes.every((child) => matches(child, subject))
    case 'or':
      return node.nodes.some((child) => matches(child, subject))
    case 'not':
      return !matches(node.node, subject)
    case 'term':
      return searches(subject.haystack(), node.text)
    case 'field': {
      if (node.key === 'is' || node.key === 'has') {
        return subject.property(node.key, node.value)
      }
      const spec = fieldFor(node.key)
      if (spec === null) return true
      if (node.op === 'has') return subject.strings(node.key).length > 0 || subject.number(node.key) !== null
      if (spec.kind === 'text' || spec.kind === 'enum') {
        const found = subject.strings(node.key)
        if (spec.kind === 'enum') return found.some((value) => value.toLowerCase() === node.value)
        return found.some((value) => names(value, node.value, spec.match))
      }
      const found = subject.number(node.key)
      if (found === null) return false
      return compare(node.op, found, node.low ?? 0, node.high)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// A stored round, read as a subject
// ---------------------------------------------------------------------------------------------

/** What a round needs around it before every field can be answered. */
export interface RoundContext {
  /**
   * Rates, for `cost:`. Optional because the flag compiler has none to offer — no flag asks about
   * money — and an absent table means no model has a rate, which is what `costOf` already means by
   * it: a round with no rate is unpriced, not free.
   */
  pricing?: Pricing
  /** This round's labels, from the one `labelRounds` pass the caller made over the whole set. */
  labels: Label[]
  /** What to call the project this round is in, so `project:` can be asked across a store. */
  project?: string
  /** Epoch milliseconds of the round's timestamp, parsed once by the caller. */
  ts?: number | null
}

/** Anything a tool call carries that is worth searching as text: its command, its paths, its name. */
function inputText(input: unknown): string {
  if (typeof input === 'string') return input
  if (input === null || typeof input !== 'object') return ''
  const parts: string[] = []
  for (const value of Object.values(input as Record<string, unknown>)) {
    if (typeof value === 'string') parts.push(value)
    else if (typeof value === 'number' || typeof value === 'boolean') parts.push(String(value))
  }
  return parts.join(' ')
}

export function subjectOf(round: Round, context: RoundContext): Subject {
  const tools = round.tools ?? []
  // Held rather than recomputed: a query naming three number fields would otherwise walk the tool
  // list three times, and one naming `command:` and `kind:` together would re-read every shell
  // line twice. Both are per round and per query, which is exactly where a store's size shows.
  let text: string | null = null
  let commands: Command[] | null = null
  let changed: { files: number; added: number; removed: number } | null = null

  const ran = (): Command[] => (commands ??= tools.flatMap((tool) => subCommands(tool)))

  const patch = (): { files: number; added: number; removed: number } => {
    if (changed !== null) return changed
    let files = 0
    let added = 0
    let removed = 0
    for (const tool of tools) {
      if (tool.patch === null) continue
      files += tool.patch.files
      added += tool.patch.added
      removed += tool.patch.removed
    }
    changed = { files, added, removed }
    return changed
  }

  return {
    strings(key) {
      switch (key) {
        case 'project':
          return context.project === undefined ? [] : [context.project]
        case 'session':
          return [round.session]
        case 'commit':
          return round.commit === null ? [] : [round.commit]
        case 'model':
          return round.model === null ? [] : [round.model]
        case 'agent':
          return [round.agent]
        case 'source':
          return [aliasOfSource(roundSourceOf(round))]
        case 'skill':
          return round.skill === null ? [] : [round.skill]
        case 'mcp':
          return round.mcp_server === null ? [] : [round.mcp_server]
        case 'tool':
          return tools.map((tool) => tool.name ?? '')
        case 'command':
          // `git` naming `git commit` is the rule the tools table already prints by, so the filter
          // has to read it the same way or the two disagree about what a command is called.
          return ran().map((command) => command.name)
        case 'kind':
          return ran().map((command) => command.kind)
        case 'category':
          return context.labels.map((label) => label.category)
        case 'target':
          return context.labels.map((label) => label.target)
        default:
          return []
      }
    },

    number(key) {
      switch (key) {
        case 'task':
          return round.task
        case 'round':
          return round.round
        case 'cost':
          return context.pricing === undefined ? null : costOf(round, context.pricing)
        case 'ms':
          return round.ms
        case 'gen':
          return round.gen_ms
        case 'wait':
          return round.wait_ms
        case 'input':
          return round.in_tokens
        case 'output':
          return round.out_tokens
        case 'cached':
          return round.in_cache_read
        case 'thinking':
          return round.thinking_chars
        case 'calls':
          return tools.length
        case 'errors':
          return tools.filter((tool) => tool.is_error === true).length
        case 'files':
          return patch().files
        case 'added':
          return patch().added
        case 'removed':
          return patch().removed
        case 'since':
        case 'before':
          return context.ts ?? (round.ts === null ? null : Date.parse(round.ts))
        default:
          return null
      }
    },

    property(key, value) {
      if (key === 'is') {
        switch (value) {
          case 'error':
            return tools.some((tool) => tool.is_error === true)
          case 'quiet':
            // Failures the harness did not report: stderr written, or a call cut short, while
            // `is_error` stayed false. On a real store these outnumber the ones it does report.
            return tools.some(
              (tool) =>
                tool.is_error !== true &&
                ((tool.stderr_chars ?? 0) > 0 || tool.interrupted === true),
            )
          case 'compacted':
            return round.compaction !== null
          case 'interrupted':
            return tools.some((tool) => tool.interrupted === true)
          case 'sub':
            return round.agent === 'sub'
          case 'main':
            return round.agent === 'main'
          case 'asked':
            return round.first_input === 'user_message'
          default:
            return false
        }
      }
      switch (value) {
        case 'patch':
          return tools.some((tool) => tool.patch !== null)
        case 'thinking':
          return round.thinking_chars > 0
        case 'text':
          return typeof round.text === 'string' && round.text.trim() !== ''
        case 'tools':
          return tools.length > 0
        case 'skill':
          return round.skill !== null
        case 'mcp':
          return round.mcp_server !== null
        case 'commit':
          return round.commit !== null
        default:
          return false
      }
    },

    haystack() {
      if (text !== null) return text
      const parts = [
        round.session,
        context.project ?? '',
        round.user_text ?? '',
        round.text ?? '',
      ]
      for (const tool of tools) {
        parts.push(tool.name ?? '')
        parts.push(inputText(tool.input))
      }
      text = parts.join('\n').toLowerCase()
      return text
    },
  }
}

// ---------------------------------------------------------------------------------------------
// The flags, as a query
// ---------------------------------------------------------------------------------------------

/**
 * What `probez rounds` and its neighbours accept as flags.
 *
 * Kept here rather than in `inspect.ts` so that the one thing that reads it — the compiler below —
 * does not have to import the module that imports the compiler.
 */
export interface RoundFilter {
  session?: string
  task?: number
  tool?: string
  command?: string
  kind?: string
  category?: string
  target?: string
  agent?: 'main' | 'sub'
  /** CLI/query alias: `claude` (not `claude-code`), `cursor`, `codex`, or `unknown`. */
  source?: string
  errorsOnly?: boolean
}

/**
 * The flags, compiled to the same tree a typed query produces.
 *
 * This is the whole reason the language could be added without a second filter engine. `--tool
 * Bash` and `tool:Bash` are now one code path down to the comparison, so the two cannot come to
 * disagree about what a tool name is or how a command is matched, and the existing tests over the
 * flags are also the tests over the language.
 */
export function queryFromFilter(filter: RoundFilter): Query {
  const nodes: Node[] = []
  const at: Span = { from: 0, to: 0 }
  const field = (key: string, value: string, op: Op = 'eq'): void => {
    nodes.push({ kind: 'field', key, op, value, low: null, high: null, at })
  }

  if (filter.session !== undefined) field('session', filter.session)
  if (filter.task !== undefined) {
    nodes.push({ kind: 'field', key: 'task', op: 'eq', value: String(filter.task), low: filter.task, high: null, at })
  }
  if (filter.tool !== undefined) field('tool', filter.tool)
  if (filter.command !== undefined) field('command', filter.command)
  if (filter.kind !== undefined) field('kind', filter.kind.toLowerCase())
  if (filter.category !== undefined) field('category', filter.category.toLowerCase())
  if (filter.target !== undefined) field('target', filter.target.toLowerCase())
  if (filter.agent !== undefined) field('agent', filter.agent)
  if (filter.source !== undefined) field('source', filter.source)
  if (filter.errorsOnly === true) field('is', 'error')

  const node: Node =
    nodes.length === 0 ? { kind: 'all' } : nodes.length === 1 ? nodes[0]! : { kind: 'and', nodes }
  return { text: '', node, entity: 'rounds', sort: null, limit: null, diagnostics: [] }
}
