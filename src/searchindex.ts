/**
 * The search index: what a query can be answered from without reading the rounds.
 *
 * A store on a working machine is hundreds of megabytes, and nearly all of what reading one costs
 * is `JSON.parse` turning it into objects. That is fine when you press enter on a command and
 * hopeless behind a search box, so this is the artifact that stands between the two: every field a
 * query can name, in a form small enough to hold and cheap enough to walk, with `rounds.jsonl`
 * opened only for the rounds that actually matched.
 *
 * It is written and versioned exactly the way `analysis.jsonl` is — one header line, then records,
 * `0600`, rebuilt wholesale rather than patched — and it is derived data in the strict sense:
 * deleting it costs speed and nothing else, because every path that reads it can also do without
 * it. That is not politeness. It is what makes the index safe to change: a reader that finds a
 * version it does not know reads the rounds instead of guessing.
 *
 * ## What is in it, and what is deliberately not
 *
 * - **Structured fields are columns**, one slot per round, and a query walks them. Not posting
 *   lists: intersecting postings is the right shape for a corpus of documents and the wrong one
 *   here, where the whole point is to avoid allocating anything per round. A tight loop over
 *   parallel arrays answers `cost:>0.50 -tool:Read since:7d` across a million rounds in
 *   milliseconds, and it is a tenth of the code.
 *
 * - **Free text is an inverted index**, because that is the one thing columns cannot be: the tokens
 *   of every prompt and every command are as large as the source they came from. Terms narrow to
 *   candidates and the rounds themselves settle it, which is why the index is allowed to be
 *   approximate about text and the answer is not.
 *
 * - **Cost is not in it.** It depends on rates the person edits under Settings, so what is stored
 *   is tokens and a model, and `cost:` is worked out at query time from `pricing.json`. An index
 *   that baked in a price would go silently wrong the moment one was corrected.
 *
 * - **Neither are questions or trails.** Both read a run of calls across the whole project, so
 *   neither can be answered from a slice of it. `in:questions` and `in:trails` read the rounds and
 *   say so, rather than being given a fast wrong answer.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { subCommands } from './bash.js'
import { asked, labelRounds } from './inspect.js'
import type { RoundLabel } from './inspect.js'
import { priceOf } from './pricing.js'
import type { Pricing } from './pricing.js'
import { isWord, matches } from './query.js'
import type { Node, Query, Subject } from './query.js'
import { DIR_MODE, eachRoundLine, FILE_MODE, tighten } from './store.js'
import type { Round } from './types.js'

/** Bumped whenever a field changes meaning. An older index is rebuilt rather than read. */
export const INDEX_VERSION = 1

/** The file, beside `analysis.jsonl` in the project's own store directory. */
export function indexFile(dir: string): string {
  return join(dir, 'search.jsonl')
}

// ---------------------------------------------------------------------------------------------
// The shape on disk
// ---------------------------------------------------------------------------------------------

/**
 * What a round is, as bits.
 *
 * `live` is first because it is the one that is not about the round: a line that did not parse
 * keeps its position in the file and is recorded here as matching nothing, which is what lets a
 * position mean the same thing to the writer and to the reader without either of them parsing the
 * whole file to agree on it.
 */
export const FLAG = {
  live: 1 << 0,
  error: 1 << 1,
  quiet: 1 << 2,
  compacted: 1 << 3,
  interrupted: 1 << 4,
  sub: 1 << 5,
  asked: 1 << 6,
  patch: 1 << 7,
  thinking: 1 << 8,
  text: 1 << 9,
  tools: 1 << 10,
  skill: 1 << 11,
  mcp: 1 << 12,
  commit: 1 << 13,
} as const

interface Header {
  index_version: number
  built_at: string
  rounds: number
  terms: number
  /** Size and mtime of the `rounds.jsonl` this was built from, which is how staleness is read. */
  source: { size: number; mtime_ms: number }
}

/** Dictionaries, so a repeated name is stored once and compared as a number. */
interface Dicts {
  session: string[]
  model: string[]
  skill: string[]
  mcp: string[]
  commit: string[]
  tool: string[]
  command: string[]
  kind: string[]
  category: string[]
  target: string[]
}

type DictName = keyof Dicts

/** The fields a round can hold several of at once, which are counted a column at a time. */
const MULTI = ['tool', 'command', 'kind', 'category', 'target'] as const

/** Whether a field is one the index counts values for, which is what a typeahead can offer. */
export function isFacet(key: string): key is DictName {
  return (
    MULTI.includes(key as (typeof MULTI)[number]) ||
    key === 'session' ||
    key === 'model' ||
    key === 'skill' ||
    key === 'mcp' ||
    key === 'commit'
  )
}

/** One slot per round. Nulls are kept: a round with no usage recorded is not a round that used none. */
interface Columns {
  session: number[]
  task: number[]
  round: number[]
  model: Array<number | null>
  skill: Array<number | null>
  mcp: Array<number | null>
  commit: Array<number | null>
  ts: Array<number | null>
  ms: Array<number | null>
  gen: Array<number | null>
  wait: Array<number | null>
  input: Array<number | null>
  output: Array<number | null>
  cached: Array<number | null>
  /** The three remaining counts a price is worked out from. See the note about `cost` above. */
  uncached: Array<number | null>
  write5m: Array<number | null>
  write1h: Array<number | null>
  thinking: number[]
  calls: number[]
  errors: number[]
  files: number[]
  added: number[]
  removed: number[]
  flags: number[]
  /** Where this round's line starts in `rounds.jsonl`, and how long it is. */
  offset: number[]
  bytes: number[]
}

/** The fields a round holds several of at once. Dictionary ids, one small array per round. */
interface Multi {
  tool: number[][]
  command: number[][]
  kind: number[][]
  category: number[][]
  target: number[][]
}

/**
 * What a task is called, which is the one thing a task row needs and no column can hold.
 *
 * A task's prompt lives on the round that opened it, and that round is usually not one of the ones
 * a query matched — so `in:tasks` would print a table of nameless rows without this.
 */
interface TaskRow {
  session: number
  task: number
  asked: string
  commit: number | null
  rounds: number
  first_ts: number | null
}

/** Longest prompt worth keeping. A task row has one line for it; the rounds keep every word. */
const MAX_ASKED = 200

// ---------------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------------

/** Shortest token worth an entry. One letter narrows nothing and costs a posting list per letter. */
const MIN_TERM = 2
/** Longest. Past this it is a base64 blob or a minified line, not a word anyone will search for. */
const MAX_TERM = 40

/**
 * The words of a piece of text.
 *
 * Runs of letters and digits, lowercased. `src/act.ts` is `src`, `act`, `ts` — which is why free
 * text matches whole words and word prefixes rather than any substring: `tok` finds `tokens` and
 * `oken` does not. That is what every search box does, and it is the rule that lets an index exist
 * at all. `matches` in `query.ts` applies the same rule when it reads a round directly, so the two
 * agree by construction rather than by coincidence.
 */
export function tokensOf(text: string): string[] {
  const found: string[] = []
  let word = ''
  for (let i = 0; i <= text.length; i += 1) {
    const ch = i < text.length ? text[i]! : ' '
    const alnum =
      (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= '0' && ch <= '9')
    if (alnum) {
      word += ch
      continue
    }
    if (word.length >= MIN_TERM && word.length <= MAX_TERM) found.push(word.toLowerCase())
    word = ''
  }
  return found
}

// ---------------------------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------------------------

class Dictionary {
  private readonly at = new Map<string, number>()
  readonly values: string[] = []

  id(value: string): number {
    const found = this.at.get(value)
    if (found !== undefined) return found
    const next = this.values.length
    this.at.set(value, next)
    this.values.push(value)
    return next
  }
}

/** What the index is built from: one round, at the position that names it. */
export interface Indexable {
  at: number
  /** Where the line sits in `rounds.jsonl`, so a hit can be read without walking to it. */
  offset: number
  bytes: number
  round: Round | null
  labels: RoundLabel[]
}

/**
 * Write a project's index.
 *
 * Built from the same traversal that produces `analysis.jsonl`, and given the same labels, so the
 * two files cannot come to disagree about what a round was.
 */
export async function writeIndex(
  dir: string,
  entries: Indexable[],
  source: { size: number; mtime_ms: number },
): Promise<void> {
  const dicts: Record<DictName, Dictionary> = {
    session: new Dictionary(),
    model: new Dictionary(),
    skill: new Dictionary(),
    mcp: new Dictionary(),
    commit: new Dictionary(),
    tool: new Dictionary(),
    command: new Dictionary(),
    kind: new Dictionary(),
    category: new Dictionary(),
    target: new Dictionary(),
  }

  const columns: Columns = {
    session: [], task: [], round: [], model: [], skill: [], mcp: [], commit: [], ts: [],
    ms: [], gen: [], wait: [], input: [], output: [], cached: [], uncached: [], write5m: [],
    write1h: [], thinking: [], calls: [], errors: [], files: [], added: [], removed: [], flags: [],
    offset: [], bytes: [],
  }
  const multi: Multi = { tool: [], command: [], kind: [], category: [], target: [] }
  const postings = new Map<string, number[]>()
  const tasks = new Map<string, TaskRow>()

  const id = (name: DictName, value: string | null): number | null =>
    value === null || value === '' ? null : dicts[name].id(value)

  const ids = (name: DictName, values: string[]): number[] => {
    const out: number[] = []
    for (const value of values) {
      const found = dicts[name].id(value)
      if (!out.includes(found)) out.push(found)
    }
    return out
  }

  for (const entry of entries) {
    const at = entry.at
    const round = entry.round
    columns.offset[at] = entry.offset
    columns.bytes[at] = entry.bytes

    if (round === null) {
      // A line that did not parse. It keeps its position and matches nothing.
      columns.session[at] = 0
      columns.task[at] = 0
      columns.round[at] = 0
      for (const key of ['model', 'skill', 'mcp', 'commit', 'ts', 'ms', 'gen', 'wait', 'input', 'output', 'cached', 'uncached', 'write5m', 'write1h'] as const) {
        columns[key][at] = null
      }
      for (const key of ['thinking', 'calls', 'errors', 'files', 'added', 'removed', 'flags'] as const) {
        columns[key][at] = 0
      }
      for (const key of ['tool', 'command', 'kind', 'target', 'category'] as const) multi[key][at] = []
      continue
    }

    const tools = round.tools ?? []
    let errors = 0
    let files = 0
    let added = 0
    let removed = 0
    let interrupted = false
    let quiet = false
    let patched = false
    for (const tool of tools) {
      if (tool.is_error === true) errors += 1
      if (tool.interrupted === true) interrupted = true
      if (tool.is_error !== true && ((tool.stderr_chars ?? 0) > 0 || tool.interrupted === true)) {
        quiet = true
      }
      if (tool.patch !== null) {
        patched = true
        files += tool.patch.files
        added += tool.patch.added
        removed += tool.patch.removed
      }
    }

    let flags = FLAG.live
    if (errors > 0) flags |= FLAG.error
    if (quiet) flags |= FLAG.quiet
    if (round.compaction !== null) flags |= FLAG.compacted
    if (interrupted) flags |= FLAG.interrupted
    if (round.agent === 'sub') flags |= FLAG.sub
    if (round.first_input === 'user_message') flags |= FLAG.asked
    if (patched) flags |= FLAG.patch
    if (round.thinking_chars > 0) flags |= FLAG.thinking
    if (typeof round.text === 'string' && round.text.trim() !== '') flags |= FLAG.text
    if (tools.length > 0) flags |= FLAG.tools
    if (round.skill !== null) flags |= FLAG.skill
    if (round.mcp_server !== null) flags |= FLAG.mcp
    if (round.commit !== null) flags |= FLAG.commit

    columns.session[at] = dicts.session.id(round.session)
    columns.task[at] = round.task
    columns.round[at] = round.round
    columns.model[at] = id('model', round.model)
    columns.skill[at] = id('skill', round.skill)
    columns.mcp[at] = id('mcp', round.mcp_server)
    columns.commit[at] = id('commit', round.commit)
    columns.ts[at] = round.ts === null ? null : Date.parse(round.ts)
    columns.ms[at] = round.ms
    columns.gen[at] = round.gen_ms
    columns.wait[at] = round.wait_ms
    columns.input[at] = round.in_tokens
    columns.output[at] = round.out_tokens
    columns.cached[at] = round.in_cache_read
    columns.uncached[at] = round.in_uncached
    columns.write5m[at] = round.in_cache_write_5m
    columns.write1h[at] = round.in_cache_write_1h
    columns.thinking[at] = round.thinking_chars
    columns.calls[at] = tools.length
    columns.errors[at] = errors
    columns.files[at] = files
    columns.added[at] = added
    columns.removed[at] = removed
    columns.flags[at] = flags

    const commands = tools.flatMap((tool) => subCommands(tool))
    multi.tool[at] = ids('tool', tools.map((tool) => tool.name ?? ''))
    multi.command[at] = ids('command', commands.map((command) => command.name))
    multi.kind[at] = ids('kind', commands.map((command) => command.kind))
    multi.category[at] = ids('category', entry.labels.map((label) => label.category))
    multi.target[at] = ids('target', entry.labels.map((label) => label.target))

    // The same text `subjectOf` searches, so a term found here is a term the round really carries.
    const words = new Set<string>()
    for (const token of tokensOf(round.session)) words.add(token)
    for (const token of tokensOf(round.user_text ?? '')) words.add(token)
    for (const token of tokensOf(round.text ?? '')) words.add(token)
    for (const tool of tools) {
      for (const token of tokensOf(tool.name ?? '')) words.add(token)
      for (const token of tokensOf(inputText(tool.input))) words.add(token)
    }
    for (const word of words) {
      const list = postings.get(word)
      if (list === undefined) postings.set(word, [at])
      else list.push(at)
    }

    const key = `${round.session} ${round.task}`
    let task = tasks.get(key)
    if (task === undefined) {
      task = {
        session: columns.session[at]!,
        task: round.task,
        asked: '',
        commit: null,
        rounds: 0,
        first_ts: null,
      }
      tasks.set(key, task)
    }
    task.rounds += 1
    if (task.asked === '' && typeof round.user_text === 'string' && round.user_text !== '') {
      task.asked = asked(round.user_text).slice(0, MAX_ASKED)
    }
    task.commit ??= columns.commit[at] ?? null
    const stamp = columns.ts[at]
    if (stamp !== null && stamp !== undefined && (task.first_ts === null || stamp < task.first_ts)) {
      task.first_ts = stamp
    }
  }

  const header: Header = {
    index_version: INDEX_VERSION,
    built_at: new Date().toISOString(),
    rounds: entries.length,
    terms: postings.size,
    source,
  }

  const lines: string[] = [
    JSON.stringify(header),
    JSON.stringify({
      dicts: Object.fromEntries(
        (Object.keys(dicts) as DictName[]).map((name) => [name, dicts[name].values]),
      ),
    }),
    JSON.stringify({ cols: columns }),
    JSON.stringify({ multi }),
    JSON.stringify({ tasks: [...tasks.values()] }),
  ]
  // Sorted, so the terms a prefix reaches sit next to each other and a lookup is a binary search
  // rather than a walk of every word the project has ever contained.
  for (const term of [...postings.keys()].sort()) {
    lines.push(JSON.stringify({ t: term, p: deltas(postings.get(term)!) }))
  }

  const file = indexFile(dir)
  await mkdir(dirname(file), { recursive: true, mode: DIR_MODE })
  await writeFile(file, lines.join('\n') + '\n', { encoding: 'utf8', mode: FILE_MODE })
  // `mode` above applies only when the file is created, so an index rewritten into a store that
  // was once left world-readable would stay that way. The index holds prompts and shell commands
  // like everything else here.
  await tighten(file, FILE_MODE)
}

/**
 * Build a project's index from its rounds.
 *
 * Reads `rounds.jsonl` once, by line, because a position in that file is what the index calls a
 * round and only a walk of the lines can assign one. A line that does not parse keeps its position
 * and is written down as matching nothing, so the writer and every later reader agree about what a
 * position means without either of them having to parse the file again to find out.
 *
 * The size and mtime are taken *before* the read rather than after. If the file grows in between,
 * what gets recorded is the old size, the next reader sees a mismatch, and the index is rebuilt —
 * which is the harmless direction. Stamping it afterwards would record a size that matches a file
 * the columns are short of, and that is the one failure mode an index must not have.
 */
export async function buildIndex(dir: string): Promise<{ rounds: number } | null> {
  const file = join(dir, 'rounds.jsonl')
  const info = await stat(file).catch(() => null)
  if (info === null) return null

  const entries: Indexable[] = []
  const rounds: Round[] = []
  await eachRoundLine(file, (at, line, offset, bytes) => {
    try {
      const round = JSON.parse(line) as Round
      rounds.push(round)
      entries.push({ at, offset, bytes, round, labels: [] })
    } catch {
      entries.push({ at, offset, bytes, round: null, labels: [] })
    }
  })

  // The same labels `analysis.jsonl` is written from, so the two files cannot disagree about what
  // a round was.
  const labelled = labelRounds(rounds)
  for (const entry of entries) {
    if (entry.round !== null) entry.labels = labelled.get(entry.round) ?? []
  }

  await writeIndex(dir, entries, { size: info.size, mtime_ms: info.mtimeMs })
  return { rounds: entries.length }
}

/** Anything a tool call carries that is worth searching. Mirrors `inputText` in `query.ts`. */
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

/** Positions as gaps, which is most of the file and nearly all of the saving on a common word. */
function deltas(positions: number[]): number[] {
  const out: number[] = []
  let last = 0
  for (const at of positions) {
    out.push(at - last)
    last = at
  }
  return out
}

function undeltas(gaps: number[]): number[] {
  const out: number[] = []
  let at = 0
  for (const gap of gaps) {
    at += gap
    out.push(at)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------


/** What a set of rounds comes to, read off the columns. */
export interface Tallied {
  rounds: number
  tasks: number
  sessions: number
  cost: number
  unpriced: number
  ms: number
  input: number
  output: number
  errors: number
  first_ts: string | null
  last_ts: string | null
}

/** Everything a query can be answered from, for one project. */
export class SearchIndex {
  private terms: Map<string, number[]> | null = null
  /** The same keys, sorted, so a prefix is a range rather than a walk of every word. */
  private sorted: string[] = []

  private constructor(
    readonly header: Header,
    private readonly dicts: Dicts,
    private readonly cols: Columns,
    private readonly multi: Multi,
    readonly tasks: TaskRow[],
    /** The term lines, sorted, parsed on first use and not before. */
    private readonly termLines: string[],
  ) {}

  get rounds(): number {
    return this.header.rounds
  }

  /** What a dictionary id spells, for the rows that are read straight off the index. */
  name(dict: DictName, at: number | null): string | null {
    if (at === null) return null
    return this.dicts[dict][at] ?? null
  }

  column<K extends keyof Columns>(key: K): Columns[K] {
    return this.cols[key]
  }

  /** Where each of these rounds sits in `rounds.jsonl`, for a read that seeks rather than walks. */
  ranges(at: number[]): Array<{ at: number; offset: number; bytes: number }> {
    return at.map((one) => ({
      at: one,
      offset: this.cols.offset[one] ?? 0,
      bytes: this.cols.bytes[one] ?? 0,
    }))
  }

  /**
   * Read one project's index, or nothing when there is not a usable one.
   *
   * Nothing is the ordinary case, not an error: a store collected before this existed has no index,
   * and one whose rounds have moved underneath it has a stale one. Both mean the same thing to
   * every caller — read the rounds instead — so both come back the same way.
   */
  static async read(dir: string): Promise<SearchIndex | null> {
    const file = indexFile(dir)
    const [text, source] = await Promise.all([
      readFile(file, 'utf8').catch(() => null),
      stat(join(dir, 'rounds.jsonl')).catch(() => null),
    ])
    if (text === null || source === null) return null

    const lines = text.split('\n')
    if (lines.length < 5) return null
    try {
      const header = JSON.parse(lines[0]!) as Header
      if (header.index_version !== INDEX_VERSION) return null
      // The rounds are appended to and never rewritten, so size and mtime settle whether this is
      // still about them — the same test the in-memory round cache already makes.
      if (header.source.size !== source.size || header.source.mtime_ms !== source.mtimeMs) {
        return null
      }
      const dicts = (JSON.parse(lines[1]!) as { dicts: Dicts }).dicts
      const cols = (JSON.parse(lines[2]!) as { cols: Columns }).cols
      const multi = (JSON.parse(lines[3]!) as { multi: Multi }).multi
      const tasks = (JSON.parse(lines[4]!) as { tasks: TaskRow[] }).tasks
      return new SearchIndex(header, dicts, cols, multi, tasks, lines.slice(5))
    } catch {
      // A half-written index is not an index. The next build replaces it.
      return null
    }
  }

  /** The postings, parsed once, and only if something actually asks for a word. */
  private words(): Map<string, number[]> {
    if (this.terms !== null) return this.terms
    const found = new Map<string, number[]>()
    for (const line of this.termLines) {
      if (line === '') continue
      try {
        const record = JSON.parse(line) as { t: string; p: number[] }
        found.set(record.t, undeltas(record.p))
      } catch {
        // a torn line; the term is simply unknown, which narrows nothing rather than mis-answering
      }
    }
    this.terms = found
    this.sorted = [...found.keys()].sort()
    return found
  }

  /**
   * The rounds a word could be in.
   *
   * A superset, always. `null` means "cannot narrow" — the word is shorter or longer than anything
   * that was indexed — rather than "nowhere", because the index is allowed to be approximate about
   * text and the answer is not: whatever comes back here is checked against the round itself. An
   * empty set is a real answer, and says the word is in none of them.
   */
  private forWord(prefix: string): Set<number> | null {
    if (prefix.length < MIN_TERM || prefix.length > MAX_TERM) return null
    const words = this.words()
    const found = new Set<number>()
    // The keys are sorted, so every term with this prefix sits in one run. Find where the run
    // starts and walk until a term no longer begins with it.
    let low = 0
    let high = this.sorted.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (this.sorted[mid]! < prefix) low = mid + 1
      else high = mid
    }
    for (let at = low; at < this.sorted.length; at += 1) {
      const term = this.sorted[at]!
      if (!term.startsWith(prefix)) break
      for (const position of words.get(term) ?? []) found.add(position)
    }
    return found
  }

/**
   * What a set of rounds came to, without reading any of them.
   *
   * This is the other half of what the index is for. A share needs the whole project's totals as
   * its denominator, and reading fifty thousand rounds to divide by them would cost exactly what
   * the index exists to avoid — so the denominator comes from the columns, and only the rounds that
   * matched are ever built.
   */
  tally(pricing: Pricing, at?: number[]): Tallied {
    const out: Tallied = {
      rounds: 0, tasks: 0, sessions: 0, cost: 0, unpriced: 0, ms: 0,
      input: 0, output: 0, errors: 0, first_ts: null, last_ts: null,
    }
    const sessions = new Set<number>()
    const tasks = new Set<string>()
    let first: number | null = null
    let last: number | null = null

    const visit = (i: number): void => {
      if (((this.cols.flags[i] ?? 0) & FLAG.live) === 0) return
      out.rounds += 1
      const session = this.cols.session[i] ?? 0
      sessions.add(session)
      tasks.add(`${session} ${this.cols.task[i] ?? 0}`)
      const cost = priceOf(pricing, this.dicts.model[this.cols.model[i] ?? -1] ?? null, {
        uncached: this.cols.uncached[i] ?? null,
        write_5m: this.cols.write5m[i] ?? null,
        write_1h: this.cols.write1h[i] ?? null,
        cache_read: this.cols.cached[i] ?? null,
        out: this.cols.output[i] ?? null,
      })
      if (cost === null) out.unpriced += 1
      else out.cost += cost
      out.ms += this.cols.ms[i] ?? 0
      out.input += this.cols.input[i] ?? 0
      out.output += this.cols.output[i] ?? 0
      out.errors += this.cols.errors[i] ?? 0
      const stamp = this.cols.ts[i]
      if (stamp !== null && stamp !== undefined) {
        if (first === null || stamp < first) first = stamp
        if (last === null || stamp > last) last = stamp
      }
    }

    if (at === undefined) for (let i = 0; i < this.header.rounds; i += 1) visit(i)
    else for (const i of at) visit(i)

    out.sessions = sessions.size
    out.tasks = tasks.size
    out.first_ts = first === null ? null : new Date(first).toISOString()
    out.last_ts = last === null ? null : new Date(last).toISOString()
    return out
  }

  /** Rounds per session across the whole project, which is what a matched session is a part of. */
  sessionCounts(): Map<string, number> {
    const counts = new Map<string, number>()
    for (let i = 0; i < this.header.rounds; i += 1) {
      if (((this.cols.flags[i] ?? 0) & FLAG.live) === 0) continue
      const name = this.dicts.session[this.cols.session[i] ?? 0] ?? ''
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return counts
  }

  /** What each task is called and how big it is, keyed the way a task row is. */
  taskIndex(): Map<string, { asked: string; commit: string | null; rounds: number }> {
    const out = new Map<string, { asked: string; commit: string | null; rounds: number }>()
    for (const task of this.tasks) {
      const session = this.dicts.session[task.session] ?? ''
      out.set(`${session} ${task.task}`, {
        asked: task.asked,
        commit: task.commit === null ? null : (this.dicts.commit[task.commit] ?? null),
        rounds: task.rounds,
      })
    }
    return out
  }

  /** How often each value of a field appears, most first. What a typeahead offers. */
  facets(key: DictName): Array<{ value: string; rounds: number }> {
    const counts = new Map<number, number>()
    const many = MULTI.includes(key as (typeof MULTI)[number])
    if (many) {
      for (const list of this.multi[key as keyof Multi]) {
        for (const at of list ?? []) counts.set(at, (counts.get(at) ?? 0) + 1)
      }
    } else {
      const single = this.cols[key as 'session' | 'model' | 'skill' | 'mcp' | 'commit']
      for (const at of single) if (at !== null) counts.set(at, (counts.get(at) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([at, rounds]) => ({ value: this.dicts[key][at] ?? '', rounds }))
      .filter((row) => row.value !== '')
      .sort((a, b) => b.rounds - a.rounds || a.value.localeCompare(b.value))
  }

  /**
   * The rounds a query could have matched.
   *
   * Exact when the query names no free text — every field it asks about is a column, so what comes
   * back is the answer. When it does, this is a candidate set and `exact` says so, and the caller
   * settles it by reading those rounds and asking `matches` directly.
   */
  select(query: Query, project: string, pricing: Pricing): { at: number[]; exact: boolean } {
    const text = hasTerm(query.node)
    const structural = relax(query.node)
    const narrowed = text ? this.candidates(query.node) : null

    const at: number[] = []
    for (let i = 0; i < this.header.rounds; i += 1) {
      if (((this.cols.flags[i] ?? 0) & FLAG.live) === 0) continue
      if (narrowed !== null && !narrowed.has(i)) continue
      if (!matches(structural, this.subject(i, project, pricing))) continue
      at.push(i)
    }
    return { at, exact: !text }
  }

  /** Every round the free text in a query could be satisfied by, or null when it cannot narrow. */
  private candidates(node: Node): Set<number> | null {
    switch (node.kind) {
      case 'term': {
        // One plain word is looked up as itself, and is the case the index answers exactly.
        // Anything else — a path, a phrase, a command line — is narrowed by the words inside it and
        // then checked literally against the round, so all this has to do is find the rounds
        // carrying every one of them.
        const words = isWord(node.text) ? [node.text.toLowerCase()] : tokensOf(node.text)
        if (words.length === 0) return null
        let found: Set<number> | null = null
        for (const word of words) {
          const one = this.forWord(word)
          if (one === null) return null
          found = found === null ? one : intersect(found, one)
        }
        return found
      }
      case 'and': {
        let found: Set<number> | null = null
        for (const child of node.nodes) {
          const one = this.candidates(child)
          if (one === null) continue
          found = found === null ? one : intersect(found, one)
        }
        return found
      }
      case 'or': {
        const found = new Set<number>()
        for (const child of node.nodes) {
          const one = this.candidates(child)
          // One branch that cannot narrow means the union cannot either.
          if (one === null) return null
          for (const at of one) found.add(at)
        }
        return found
      }
      default:
        // A negation, a field or a neutral node: nothing here says where the text is.
        return null
    }
  }

  /** One round as the columns hold it, with no object built for it beyond this. */
  private subject(at: number, project: string, pricing: Pricing): Subject {
    const cols = this.cols
    const multi = this.multi
    const dicts = this.dicts
    const spell = (dict: DictName, list: number[] | undefined): string[] =>
      (list ?? []).map((id) => dicts[dict][id] ?? '')
    const one = (dict: DictName, id: number | null | undefined): string[] =>
      id === null || id === undefined ? [] : [dicts[dict][id] ?? '']

    return {
      strings(key) {
        switch (key) {
          case 'project':
            return [project]
          case 'session':
            return one('session', cols.session[at])
          case 'commit':
            return one('commit', cols.commit[at])
          case 'model':
            return one('model', cols.model[at])
          case 'agent':
            return [((cols.flags[at] ?? 0) & FLAG.sub) !== 0 ? 'sub' : 'main']
          case 'skill':
            return one('skill', cols.skill[at])
          case 'mcp':
            return one('mcp', cols.mcp[at])
          case 'tool':
            return spell('tool', multi.tool[at])
          case 'command':
            return spell('command', multi.command[at])
          case 'kind':
            return spell('kind', multi.kind[at])
          case 'category':
            return spell('category', multi.category[at])
          case 'target':
            return spell('target', multi.target[at])
          default:
            return []
        }
      },

      number(key) {
        switch (key) {
          case 'task':
            return cols.task[at] ?? null
          case 'round':
            return cols.round[at] ?? null
          case 'ms':
            return cols.ms[at] ?? null
          case 'gen':
            return cols.gen[at] ?? null
          case 'wait':
            return cols.wait[at] ?? null
          case 'input':
            return cols.input[at] ?? null
          case 'output':
            return cols.output[at] ?? null
          case 'cached':
            return cols.cached[at] ?? null
          case 'thinking':
            return cols.thinking[at] ?? null
          case 'calls':
            return cols.calls[at] ?? null
          case 'errors':
            return cols.errors[at] ?? null
          case 'files':
            return cols.files[at] ?? null
          case 'added':
            return cols.added[at] ?? null
          case 'removed':
            return cols.removed[at] ?? null
          case 'since':
          case 'before':
            return cols.ts[at] ?? null
          case 'cost':
            // Worked out here rather than stored, from the counts in the columns and the rates in
            // force right now. An index that had baked in a price would go silently wrong the
            // moment somebody corrected one.
            return priceOf(pricing, dicts.model[cols.model[at] ?? -1] ?? null, {
              uncached: cols.uncached[at] ?? null,
              write_5m: cols.write5m[at] ?? null,
              write_1h: cols.write1h[at] ?? null,
              cache_read: cols.cached[at] ?? null,
              out: cols.output[at] ?? null,
            })
          default:
            return null
        }
      },

      property(key, value) {
        const flags = cols.flags[at] ?? 0
        if (key === 'is') {
          if (value === 'main') return (flags & FLAG.sub) === 0
          const bit = (FLAG as Record<string, number>)[value]
          return bit === undefined ? false : (flags & bit) !== 0
        }
        const bit = (FLAG as Record<string, number>)[value]
        return bit === undefined ? false : (flags & bit) !== 0
      },

      haystack() {
        // Never reached: a query carrying free text is answered by narrowing here and verifying
        // against the round, so nothing asks the columns for text they do not hold.
        return ''
      },
    }
  }
}

function intersect(a: Set<number>, b: Set<number>): Set<number> {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  const out = new Set<number>()
  for (const at of small) if (large.has(at)) out.add(at)
  return out
}

/** Whether any part of a tree searches for text rather than for a field. */
export function hasTerm(node: Node): boolean {
  switch (node.kind) {
    case 'term':
      return true
    case 'and':
    case 'or':
      return node.nodes.some(hasTerm)
    case 'not':
      return hasTerm(node.node)
    default:
      return false
  }
}

/**
 * The tree with everything the columns cannot answer taken out.
 *
 * What comes back matches at least everything the original does, never less, which is the property
 * the whole arrangement rests on: narrowing may be loose, and the rounds are then asked directly.
 * A negation containing text has to go whole — `-flaky` is only false where `flaky` is true, and
 * the columns cannot say where that is, so keeping it would drop rounds that do match.
 */
export function relax(node: Node): Node {
  switch (node.kind) {
    case 'term':
      return { kind: 'all' }
    case 'not':
      return hasTerm(node.node) ? { kind: 'all' } : node
    case 'and': {
      const nodes = node.nodes.map(relax).filter((child) => child.kind !== 'all')
      if (nodes.length === 0) return { kind: 'all' }
      return nodes.length === 1 ? nodes[0]! : { kind: 'and', nodes }
    }
    case 'or': {
      const nodes = node.nodes.map(relax)
      // One branch that can no longer be narrowed makes the whole alternation unnarrowable.
      if (nodes.some((child) => child.kind === 'all')) return { kind: 'all' }
      return { kind: 'or', nodes }
    }
    default:
      return node
  }
}

/**
 * Whether answering a query needs the rounds themselves whatever the index says.
 *
 * Only the two entities that read a run of calls across a whole project. Every field, `cost:`
 * included, is answerable from the columns.
 */
export function needsRounds(query: Query): boolean {
  return query.entity === 'questions' || query.entity === 'trails'
}
