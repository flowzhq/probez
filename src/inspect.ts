import { commandOf, parseCommands, UNPARSED } from './bash.js'
import type { Command } from './bash.js'
import { CATEGORIES, categoryInfo, classifyCall } from './classify.js'
import type { Category, Label } from './classify.js'
import { costOf } from './pricing.js'
import type { Pricing } from './pricing.js'
import { isFinding, trailsOf } from './trail.js'
import type { Trail, TrailOptions } from './trail.js'
import type { Round, ToolCall } from './types.js'

/**
 * What a span of rounds cost and changed, beyond the round count.
 *
 * Carried by sessions and tasks alike, because the questions are the same at both sizes: how much
 * of the input was new rather than reused, how much of the time was the model's rather than the
 * person's, and how much code came out the other end.
 */
export interface Totals {
  in_tokens: number
  in_uncached: number
  in_cache_write: number
  in_cache_write_5m: number
  in_cache_write_1h: number
  in_cache_read: number
  out_tokens: number
  /** Dollars, at the rates in force when this was totalled. Zero for rounds with no rate. */
  cost: number
  /** Time from each round's prompt to its last output, which `ms` does not cover. */
  gen_ms: number
  /** Time spent waiting on a person. */
  wait_ms: number
  /** Lines a file-editing tool added and removed. */
  added: number
  removed: number
}

/** One session as recorded in the store, not as it exists on disk under ~/.claude. */
export interface SessionRow extends Totals {
  session: string
  rounds: number
  tasks: number
  tool_calls: number
  errors: number
  first_ts: string | null
  last_ts: string | null
}

/** One task within a session: a user turn and everything the agent did about it. */
export interface TaskRow extends Totals {
  session: string
  task: number
  rounds: number
  ms: number
  first_ts: string | null
  /** What was asked to start this task: the first user text in it. */
  asked: string
  /**
   * The commit the checkout was on when this task started, which is the state the work was asked
   * against. Null when nothing recorded one; see `Round.commit`.
   */
  commit: string | null
}

export interface ToolRow {
  name: string
  calls: number
  errors: number
  /**
   * Calls that wrote to stderr or were cut short while the harness reported no error. These are
   * failures `errors` cannot see, and on a real store they outnumber the ones it can.
   */
  quiet: number
  result_chars: number
  ms: number
  /** The kind of work, on rows that stand for a command rather than a tool. */
  kind?: string
  /** A finer level under this tool, when its calls decompose into something worth counting. */
  sub?: ToolRow[]
}

/** Zeroes for every field of `Totals`, so a row starts complete rather than being filled in twice. */
function noTotals(): Totals {
  return {
    in_tokens: 0,
    in_uncached: 0,
    in_cache_write: 0,
    in_cache_write_5m: 0,
    in_cache_write_1h: 0,
    in_cache_read: 0,
    out_tokens: 0,
    cost: 0,
    gen_ms: 0,
    wait_ms: 0,
    added: 0,
    removed: 0,
  }
}

/** Fold one round's cost and changes into a running total. */
function addTotals(row: Totals, round: Round, pricing: Pricing): void {
  row.in_tokens += round.in_tokens || 0
  row.in_uncached += round.in_uncached || 0
  row.in_cache_write += round.in_cache_write || 0
  row.in_cache_write_5m += round.in_cache_write_5m || 0
  row.in_cache_write_1h += round.in_cache_write_1h || 0
  row.in_cache_read += round.in_cache_read || 0
  row.out_tokens += round.out_tokens || 0
  row.cost += costOf(round, pricing) ?? 0
  row.gen_ms += round.gen_ms || 0
  row.wait_ms += round.wait_ms || 0
  for (const tool of round.tools ?? []) {
    if (tool.patch === null || tool.patch === undefined) continue
    row.added += tool.patch.added
    row.removed += tool.patch.removed
  }
}

export interface RoundFilter {
  session?: string
  task?: number
  tool?: string
  command?: string
  kind?: string
  category?: string
  target?: string
  agent?: 'main' | 'sub'
  errorsOnly?: boolean
}

/** One category, or one sub-kind under it. `rounds` is fractional: a round splits across its work. */
export interface CategoryRow {
  name: string
  label: string
  rounds: number
  errors: number
  ms: number
  /** Input the category was charged, split the same way a round's is. */
  in_tokens: number
  in_uncached: number
  in_cache_write_5m: number
  in_cache_write_1h: number
  in_cache_read: number
  out_tokens: number
  /** Dollars this category was charged, which is what its share is a share of. */
  cost: number
  sub?: CategoryRow[]
}

/**
 * What the distribution is a distribution *of*.
 *
 * Printed beside every table rather than kept for the curious. A share with no denominator behind
 * it invites the reader to assume the denominator is everything, and here it is not: rounds that
 * called no tool are outside it entirely, and a sixth of what is inside it is work no built-in
 * table can name.
 */
export interface Coverage {
  /** Every round read. */
  rounds: number
  /** Rounds that called at least one tool. The denominator for every share. */
  classified: number
  /** Rounds of pure prose, which carry no label. */
  toolless: number
  /** Total labelled weight, which equals `classified`. */
  weight: number
  /** Weight that landed in `unclassified`, whatever the sub-kind. */
  unclassified: number
  /** Weight whose target the path table could name. */
  targeted: number
  /** Dollars across the classified rounds. The denominator for every share. */
  cost: number
  /** Classified rounds whose model has no rate, and so are outside `cost` entirely. */
  unpriced: number
}

export interface Analysis {
  rows: CategoryRow[]
  coverage: Coverage
  /** What could not be classified, most weight first, so the hole can be named. */
  unknown: { name: string; weight: number }[]
  /** Models with no rate, most rounds first, so that hole can be named too. */
  unpriced: { model: string; rounds: number }[]
}

/**
 * Tools whose calls decompose one level further, and how. `Bash` is the only member: every other
 * tool's name already is its operation. The registry is what keeps adding another. An MCP server's
 * tools or a `Task`'s subagent type get an entry rather than a second design.
 */
const SUB_LABELS: Record<string, (input: unknown) => Command[]> = {
  Bash: (input) => parseCommands(commandOf(input)),
}

/** What one call decomposes into, or an empty list when the tool has no finer level. */
export function subCommands(tool: ToolCall): Command[] {
  const label = tool.name === null ? undefined : SUB_LABELS[tool.name]
  if (label === undefined) return []
  const found = label(tool.input)
  // A call that ran *something* always counts as one row, or the sub-table quietly under-reports.
  return found.length > 0 ? found : [{ name: UNPARSED, kind: 'other' }]
}

/**
 * Sessions in the store, oldest activity first, the order they were worked in, which is also the
 * order `rounds.jsonl` was appended in.
 *
 * Tasks are counted per session because task numbers restart at 1 in every session; this is the
 * same rule `summarize` applies when it totals them.
 */
export function sessionRows(rounds: Round[], pricing: Pricing): SessionRow[] {
  const bySession = new Map<string, { row: SessionRow; tasks: Set<number> }>()

  for (const round of rounds) {
    let entry = bySession.get(round.session)
    if (entry === undefined) {
      entry = {
        row: {
          session: round.session,
          rounds: 0,
          tasks: 0,
          tool_calls: 0,
          errors: 0,
          ...noTotals(),
          first_ts: null,
          last_ts: null,
        },
        tasks: new Set(),
      }
      bySession.set(round.session, entry)
    }
    const { row, tasks } = entry
    row.rounds += 1
    tasks.add(round.task)
    addTotals(row, round, pricing)
    for (const tool of round.tools ?? []) {
      row.tool_calls += 1
      if (tool.is_error === true) row.errors += 1
    }
    if (typeof round.ts === 'string') {
      if (row.first_ts === null || round.ts < row.first_ts) row.first_ts = round.ts
      if (row.last_ts === null || round.ts > row.last_ts) row.last_ts = round.ts
    }
  }

  const rows: SessionRow[] = []
  for (const { row, tasks } of bySession.values()) {
    row.tasks = tasks.size
    rows.push(row)
  }
  rows.sort((a, b) => (a.last_ts ?? '').localeCompare(b.last_ts ?? ''))
  return rows
}

/**
 * Blocks the agent's harness wraps around a user turn: a slash command's name, the caveat that
 * introduces it, a reminder injected into the message. They are envelope, not what was asked.
 */
const ENVELOPE =
  /<(local-command-caveat|command-name|command-message|command-args|local-command-stdout|system-reminder)>[\s\S]*?<\/\1>/g

/**
 * What a user turn actually asked, with the harness envelope taken off. The stored round keeps the
 * text verbatim, and `probez round <n>` still prints every word of it. This is for the one line a
 * table has room for.
 */
export function asked(text: string): string {
  const stripped = text.replace(ENVELOPE, '').trim()
  return stripped === '' ? text.trim() : stripped
}

/**
 * Tasks, oldest first, in the order they were worked.
 *
 * Keyed by session as well as by number, because task numbers restart at 1 in every session: task 3
 * of one session and task 3 of the next are different work, and merging them would invent a task
 * that never happened. Subagent rounds count towards their task; delegated work is still work the
 * task cost.
 */
export function taskRows(rounds: Round[], pricing: Pricing): TaskRow[] {
  const byTask = new Map<string, TaskRow>()
  for (const round of rounds) {
    const key = `${round.session} ${round.task}`
    let row = byTask.get(key)
    if (row === undefined) {
      row = {
        session: round.session,
        task: round.task,
        rounds: 0,
        ...noTotals(),
        ms: 0,
        first_ts: null,
        asked: '',
        commit: null,
      }
      byTask.set(key, row)
    }
    row.rounds += 1
    addTotals(row, round, pricing)
    if (typeof round.ms === 'number') row.ms += round.ms
    if (typeof round.ts === 'string' && (row.first_ts === null || round.ts < row.first_ts)) {
      row.first_ts = round.ts
    }
    // Only the round that opened the task carries the prompt; the rest were driven by tool results.
    if (row.asked === '' && typeof round.user_text === 'string') row.asked = asked(round.user_text)
    // Every round of a task was stamped with the same commit, so the first one that has one settles
    // it. Rounds collected before probez recorded commits have none, and do not overwrite one.
    row.commit ??= round.commit ?? null
  }
  return [...byTask.values()].sort(
    (a, b) => (a.first_ts ?? '').localeCompare(b.first_ts ?? '') || a.task - b.task,
  )
}

function add(row: ToolRow, tool: ToolCall): void {
  row.calls += 1
  if (tool.is_error === true) row.errors += 1
  else if (quietlyFailed(tool)) row.quiet += 1
  if (typeof tool.result_chars === 'number') row.result_chars += tool.result_chars
  if (typeof tool.ms === 'number') row.ms += tool.ms
}

/**
 * A call that went wrong without the harness saying so.
 *
 * `is_error` reports that the call was accepted, so a command that ran and failed comes back false.
 * Counted only when `is_error` is not already true, so the two columns never describe the same call.
 */
export function quietlyFailed(tool: ToolCall): boolean {
  return tool.interrupted === true || (tool.stderr_chars ?? 0) > 0
}

const byCalls = (a: ToolRow, b: ToolRow): number => b.calls - a.calls || a.name.localeCompare(b.name)

/**
 * Every tool the project called, most-used first.
 *
 * With `sub`, a tool that decomposes carries a second level: `Bash` by command, or by the kind of
 * work each command does. Two things about those counts, which the printed table repeats:
 *
 * - A command is counted once per call it appears in, so `calls` means the same thing it does at
 *   the top level. `cd x && npm test` is one call that ran two commands, and it counts for both;
 *   sub-row calls therefore sum to more than the tool's own.
 * - Errors, result size and time belong to the call, not to a command inside it. A call has one
 *   result and one duration. Every command in a multi-command call is charged the whole call.
 */
export function toolTally(rounds: Round[], sub?: 'command' | 'kind'): ToolRow[] {
  const byName = new Map<string, ToolRow>()
  const subRows = new Map<string, Map<string, ToolRow>>()

  for (const round of rounds) {
    for (const tool of round.tools ?? []) {
      // A call whose name never arrived cannot be attributed, and inventing a bucket for it would
      // read as a real tool.
      if (typeof tool.name !== 'string' || tool.name === '') continue
      let row = byName.get(tool.name)
      if (row === undefined) {
        row = { name: tool.name, calls: 0, errors: 0, quiet: 0, result_chars: 0, ms: 0 }
        byName.set(tool.name, row)
      }
      add(row, tool)

      if (sub === undefined) continue
      const commands = subCommands(tool)
      if (commands.length === 0) continue
      let group = subRows.get(tool.name)
      if (group === undefined) {
        group = new Map()
        subRows.set(tool.name, group)
      }
      const seen = new Set<string>()
      for (const command of commands) {
        const key = sub === 'kind' ? command.kind : command.name
        // Distinct commands of one kind, `grep` then `find`, are one use of that kind.
        if (seen.has(key)) continue
        seen.add(key)
        let entry = group.get(key)
        if (entry === undefined) {
          entry = { name: key, calls: 0, errors: 0, quiet: 0, result_chars: 0, ms: 0 }
          if (sub === 'command') entry.kind = command.kind
          group.set(key, entry)
        }
        add(entry, tool)
      }
    }
  }

  const rows = [...byName.values()].sort(byCalls)
  for (const row of rows) {
    const group = subRows.get(row.name)
    if (group !== undefined) row.sub = [...group.values()].sort(byCalls)
  }
  return rows
}

/** A label, plus which call in the round produced it and whether that call failed. */
export interface RoundLabel extends Label {
  /**
   * The call's position in `round.tools`, zero-based. `source` names the tool or command, which is
   * enough to say what produced a label but not which of two `Bash` calls it was; the index is, so
   * a reader can put every label back on the call it came from.
   */
  call: number
  errored: boolean
}

/**
 * Every round, labelled.
 *
 * Each round is labelled on its own. No rule reaches outside the call it is looking at, so there is
 * no task context to build up, and the order rounds arrive in no longer changes what they get.
 */
export function labelRounds(rounds: Round[]): Map<Round, RoundLabel[]> {
  const out = new Map<Round, RoundLabel[]>()
  for (const round of rounds) {
    const tools = round.tools ?? []
    const labels: RoundLabel[] = []
    if (tools.length > 0) {
      const perCall = 1 / tools.length
      tools.forEach((tool, call) => {
        for (const label of classifyCall(tool)) {
          labels.push({
            ...label,
            weight: label.weight * perCall,
            call,
            errored: tool.is_error === true,
          })
        }
      })
    }
    out.set(round, labels)
  }
  return out
}

/**
 * The distribution of work, most of it first.
 *
 * `sub` chooses what the second level counts: the sub-kind of the act, or the target it acted on.
 * Time and tokens are split by the same weights as the rounds, so a category that is cheap in
 * rounds but expensive on the clock stays visible instead of averaging away.
 */
export function categoryTally(
  rounds: Round[],
  pricing: Pricing,
  sub: 'sub' | 'target' = 'sub',
): Analysis {
  const labelled = labelRounds(rounds)
  const byCategory = new Map<string, CategoryRow>()
  const subRows = new Map<string, Map<string, CategoryRow>>()
  const unknown = new Map<string, number>()
  const coverage: Coverage = {
    rounds: 0,
    classified: 0,
    toolless: 0,
    weight: 0,
    unclassified: 0,
    targeted: 0,
    cost: 0,
    unpriced: 0,
  }
  const unpricedModels = new Map<string, number>()

  for (const round of rounds) {
    coverage.rounds += 1
    const labels = labelled.get(round) ?? []
    if (labels.length === 0) {
      coverage.toolless += 1
      continue
    }
    coverage.classified += 1

    // A round whose model has no rate contributes nothing to the shares. That is a hole, not a
    // zero, so it is counted and named rather than quietly averaged in at nothing.
    const spent = costOf(round, pricing)
    if (spent === null) {
      coverage.unpriced += 1
      const name = round.model ?? '(no model recorded)'
      unpricedModels.set(name, (unpricedModels.get(name) ?? 0) + 1)
    } else {
      coverage.cost += spent
    }

    for (const label of labels) {
      coverage.weight += label.weight
      if (label.category === 'unclassified') {
        coverage.unclassified += label.weight
        if (label.sub === 'unknown') {
          unknown.set(label.source, (unknown.get(label.source) ?? 0) + label.weight)
        }
      }
      if (label.target !== 'unknown') coverage.targeted += label.weight

      const info = categoryInfo(label.category)
      let row = byCategory.get(label.category)
      if (row === undefined) {
        row = { name: label.category, label: info.label, rounds: 0, errors: 0, ms: 0, ...noCategoryTokens(), cost: 0 }
        byCategory.set(label.category, row)
      }
      addWeighted(row, label, round, spent ?? 0)

      const key = sub === 'target' ? label.target : label.sub
      let group = subRows.get(label.category)
      if (group === undefined) {
        group = new Map()
        subRows.set(label.category, group)
      }
      let entry = group.get(key)
      if (entry === undefined) {
        entry = { name: key, label: key, rounds: 0, errors: 0, ms: 0, ...noCategoryTokens(), cost: 0 }
        group.set(key, entry)
      }
      addWeighted(entry, label, round, spent ?? 0)
    }
  }

  // Category order is the order work tends to happen, not the order it happened to be counted in.
  const rows = [...byCategory.values()].sort(
    (a, b) => categoryOrder(a.name) - categoryOrder(b.name),
  )
  for (const row of rows) {
    const group = subRows.get(row.name)
    if (group !== undefined) row.sub = [...group.values()].sort((a, b) => b.rounds - a.rounds)
  }

  return {
    rows,
    coverage,
    unknown: [...unknown.entries()]
      .map(([name, weight]) => ({ name, weight }))
      .sort((a, b) => b.weight - a.weight),
    unpriced: [...unpricedModels.entries()]
      .map(([model, rounds]) => ({ model, rounds }))
      .sort((a, b) => b.rounds - a.rounds),
  }
}

/** One round as the analysis cache records it: what it was, with none of what it said. */
export interface AnalysisRecord {
  session: string
  round: number
  task: number
  labels: Array<{
    category: Category
    sub: string
    target: string
    weight: number
    source: string
  }>
}

/**
 * Every round, labelled, in the shape `analysis.jsonl` stores.
 *
 * Two commands write that file now — `analyze` on its way through, and `view`'s sync — and a cache
 * that means one thing depending on which of them last touched it would be worse than no cache. So
 * the record is built here, once, and both callers hand the result to `writeAnalysis`.
 *
 * Weights are rounded to six places because they are the result of dividing by tool-call counts and
 * the full binary expansion is noise in a file meant to be read.
 */
export function analysisRecords(rounds: Round[]): AnalysisRecord[] {
  const labelled = labelRounds(rounds)
  return rounds.map((round) => ({
    session: round.session,
    round: round.round,
    task: round.task,
    labels: (labelled.get(round) ?? []).map((label) => ({
      category: label.category,
      sub: label.sub,
      target: label.target,
      weight: Number(label.weight.toFixed(6)),
      source: label.source,
    })),
  }))
}

/**
 * The category a set of rounds mostly was, and how much of it that category actually is.
 *
 * The share travels with the label on purpose. A bare winner reads as a description of the whole
 * span, and it often is not: reconstruction at 34% beating implementation at 31% is a different
 * fact from reconstruction at 80%, and a column that shows only the name hides which one it is.
 */
export interface Dominant {
  category: Category
  short: string
  share: number
}

export function dominant(labels: Label[]): Dominant | null {
  if (labels.length === 0) return null
  const totals = new Map<string, number>()
  let all = 0
  for (const label of labels) {
    totals.set(label.category, (totals.get(label.category) ?? 0) + label.weight)
    all += label.weight
  }
  if (all === 0) return null
  let best = ''
  let most = -1
  for (const [id, weight] of totals) {
    // Ties break toward the earlier category, so the answer does not depend on iteration order.
    if (weight > most || (weight === most && categoryOrder(id) < categoryOrder(best))) {
      best = id
      most = weight
    }
  }
  const category = best as Category
  return { category, short: categoryInfo(category).short, share: most / all }
}

/**
 * The dominant category of every span worth naming, looked up rather than recomputed.
 *
 * A table prints one of these per row, and each row would otherwise re-label the whole project to
 * answer a question about one session. Labelling happens once here; the callers ask.
 */
/** One category's share of a piece of work, for a bar that shows the whole distribution. */
export interface Share {
  category: Category
  label: string
  short: string
  share: number
}

/**
 * The same tally `dominant` picks a winner from, kept whole.
 *
 * Deliberately weighted the way `dominant` weighs it rather than the way `categoryTally` counts
 * rounds. A bar drawn from one basis beside a name drawn from the other can disagree about which
 * category is largest, and a bar whose widest slice is not the one the row is named after reads as
 * a bug in the measurement rather than as two honest numbers.
 */
export function spread(labels: Label[]): Share[] {
  const totals = new Map<string, number>()
  let all = 0
  for (const label of labels) {
    totals.set(label.category, (totals.get(label.category) ?? 0) + label.weight)
    all += label.weight
  }
  if (all === 0) return []
  return [...totals]
    .map(([id, weight]) => {
      const category = id as Category
      const info = categoryInfo(category)
      return { category, label: info.label, short: info.short, share: weight / all }
    })
    .sort((a, b) => categoryOrder(a.category) - categoryOrder(b.category))
}

export interface WorkIndex {
  session(id: string): Dominant | null
  task(session: string, task: number): Dominant | null
  round(round: Round): Dominant | null
  /** The whole distribution behind `task`, for the bar the tasks table draws instead of a name. */
  taskMix(session: string, task: number): Share[]
}

export function workIndex(rounds: Round[]): WorkIndex {
  const labelled = labelRounds(rounds)
  const bySession = new Map<string, RoundLabel[]>()
  const byTask = new Map<string, RoundLabel[]>()
  for (const round of rounds) {
    const labels = labelled.get(round) ?? []
    if (labels.length === 0) continue
    for (const [map, key] of [
      [bySession, round.session],
      [byTask, `${round.session} ${round.task}`],
    ] as const) {
      const found = map.get(key)
      if (found === undefined) map.set(key, [...labels])
      else found.push(...labels)
    }
  }
  return {
    session: (id) => dominant(bySession.get(id) ?? []),
    task: (session, task) => dominant(byTask.get(`${session} ${task}`) ?? []),
    round: (round) => dominant(labelled.get(round) ?? []),
    taskMix: (session, task) => spread(byTask.get(`${session} ${task}`) ?? []),
  }
}

/**
 * How many rounds decide a phase. Wide enough that a single read between two edits does not become
 * its own band, narrow enough that a short phase still shows: on a real store, 5 turns a 122-round
 * task from 80 bands into a dozen.
 */
const DEFAULT_WINDOW = 5

/** One round on a timeline: what it cost and what it was, with none of what it said. */
export interface TraceRound {
  session: string
  /** Index within the session, which is what a round is named by. */
  round: number
  task: number
  agent: 'main' | 'sub'
  /** How to ask for this round: `<task>.<round>`, the selector `probez round` takes. */
  ref: string
  ts: string | null
  /** Span of the round's own records. `ts` is the first of them. */
  ms: number | null
  /** From the input that prompted the round to its last output, so it precedes `ts`. */
  gen_ms: number | null
  in_tokens: number | null
  in_cache_read: number | null
  out_tokens: number | null
  thinking_chars: number
  tools: number
  errors: number
  /** What this one round mostly was. The truth about the round, however jumpy it reads. */
  dominant: Dominant | null
  /** What the rounds around it were, which is what a phase is. See `Trace.window`. */
  phase: Dominant | null
  /**
   * This round's weight split across the categories it earned, summing to 1. Empty for a round of
   * pure prose, which is a different thing from a round that did nothing.
   */
  weights: Array<{ category: Category; weight: number }>
}

/** A stretch of consecutive rounds that were mostly the same kind of work. */
export interface TraceRun {
  /** null for a run of prose-only rounds, which have no category to be. */
  category: Category | null
  short: string
  /** Indices into `Trace.rounds`, both inclusive. */
  from: number
  to: number
  rounds: number
}

export interface Trace {
  rounds: TraceRound[]
  runs: TraceRun[]
  /**
   * How many rounds a phase is decided over. Reported because it is a choice, not a measurement:
   * at 1 the ribbon is the raw per-round dominant, and every alternation between reading a file and
   * writing one becomes its own band.
   */
  window: number
  span: {
    first: string | null
    last: string | null
    /** Wall clock from the first round starting to the last one finishing, gaps included. */
    elapsed_ms: number
    /** Time the model was generating. Always the smaller number, often by a lot. */
    active_ms: number
  }
}

/**
 * A span of rounds as a timeline: every round in order, and the phases they fall into.
 *
 * The two numbers in `span` are deliberately both kept. `active_ms` is the time the model spent
 * generating; `elapsed_ms` is how long you waited, which includes tool execution and every gap
 * where it was your turn. Reporting one as the other is the easiest lie this data tells.
 *
 * Runs are the phase ribbon: consecutive rounds sharing a category, collapsed. What they collapse
 * is not the per-round dominant but a `window`-wide one, and the difference matters. Real work
 * alternates on a scale of one round — read a file, write a file, read it back — so run-length
 * encoding the raw series gives a band per round or two and says nothing. A phase is a claim about
 * a stretch of rounds, so it is decided over a stretch of rounds.
 *
 * The smoothing is a choice rather than a measurement, which is why the width travels with the
 * result and why every round keeps its own unsmoothed `dominant` alongside. Pass `window: 1` for
 * the raw series.
 */
export function traceOf(rounds: Round[], options: { window?: number } = {}): Trace {
  const window = Math.max(1, Math.round(options.window ?? DEFAULT_WINDOW))
  const ordered = [...rounds].sort(
    (a, b) => a.session.localeCompare(b.session) || a.round - b.round,
  )
  const labelled = labelRounds(ordered)

  const perRound = ordered.map((round) => labelled.get(round) ?? [])

  const traced: TraceRound[] = ordered.map((round, at) => {
    const labels = perRound[at]!
    const byCategory = new Map<Category, number>()
    for (const label of labels) {
      byCategory.set(label.category, (byCategory.get(label.category) ?? 0) + label.weight)
    }
    // The phase is the dominant of a neighbourhood, centred on this round and clipped at the ends.
    const half = Math.floor(window / 2)
    const near: RoundLabel[] = []
    for (let i = Math.max(0, at - half); i <= Math.min(perRound.length - 1, at + half); i += 1) {
      near.push(...perRound[i]!)
    }
    const tools = round.tools ?? []
    return {
      session: round.session,
      round: round.round,
      task: round.task,
      agent: round.agent,
      ref: `${round.task}.${round.round}`,
      ts: round.ts,
      ms: round.ms,
      gen_ms: round.gen_ms ?? null,
      in_tokens: round.in_tokens,
      in_cache_read: round.in_cache_read,
      out_tokens: round.out_tokens,
      thinking_chars: round.thinking_chars || 0,
      tools: tools.length,
      errors: tools.filter((tool) => tool.is_error === true).length,
      dominant: dominant(labels),
      // A round of pure prose stays prose: a neighbourhood cannot lend it work no tool saw.
      phase: labels.length === 0 ? null : dominant(near),
      weights: [...byCategory.entries()]
        .map(([category, weight]) => ({ category, weight }))
        .sort((a, b) => categoryOrder(a.category) - categoryOrder(b.category)),
    }
  })

  const runs: TraceRun[] = []
  for (const [at, round] of traced.entries()) {
    const category = round.phase?.category ?? null
    const open = runs[runs.length - 1]
    if (open !== undefined && open.category === category) {
      open.to = at
      open.rounds += 1
      continue
    }
    runs.push({
      category,
      short: category === null ? 'Prose' : categoryInfo(category).short,
      from: at,
      to: at,
      rounds: 1,
    })
  }

  let first: string | null = null
  let last: string | null = null
  let start = Infinity
  let end = -Infinity
  let active = 0
  for (const round of traced) {
    // `gen_ms` runs from the input that prompted the round to its last output, so it covers the
    // wait before the model spoke; `ms` spans only the records the round wrote and misses most of
    // it. Tool execution is outside both, since a result arrives as the next round's input.
    active += round.gen_ms ?? round.ms ?? 0
    if (round.ts === null) continue
    if (first === null || round.ts < first) first = round.ts
    if (last === null || round.ts > last) last = round.ts
    const began = Date.parse(round.ts)
    if (Number.isNaN(began)) continue
    if (began < start) start = began
    if (began + (round.ms ?? 0) > end) end = began + (round.ms ?? 0)
  }

  return {
    rounds: traced,
    runs,
    window,
    span: {
      first,
      last,
      elapsed_ms: start === Infinity ? 0 : Math.max(0, end - start),
      active_ms: active,
    },
  }
}

/**
 * A round has one duration and one output size, so each label takes its share of both. An error
 * belongs to a call rather than to a share of one, and is counted whole against every label that
 * call produced, the same way `toolTally` charges a multi-command call to each command in it.
 */
function addWeighted(row: CategoryRow, label: RoundLabel, round: Round, spent: number): void {
  row.rounds += label.weight
  row.ms += (round.ms ?? 0) * label.weight
  // Input is charged to the work the round did, on the same split as the round count. A round that
  // read two files and ran a test charges each of those a third of the context it was given.
  row.in_tokens += (round.in_tokens || 0) * label.weight
  row.in_uncached += (round.in_uncached || 0) * label.weight
  row.in_cache_write_5m += (round.in_cache_write_5m || 0) * label.weight
  row.in_cache_write_1h += (round.in_cache_write_1h || 0) * label.weight
  row.in_cache_read += (round.in_cache_read || 0) * label.weight
  row.out_tokens += (round.out_tokens || 0) * label.weight
  row.cost += spent * label.weight
  if (label.errored) row.errors += 1
}

/** The token fields of a category row at zero, so a row starts complete. */
function noCategoryTokens(): Pick<
  CategoryRow,
  'in_tokens' | 'in_uncached' | 'in_cache_write_5m' | 'in_cache_write_1h' | 'in_cache_read' | 'out_tokens'
> {
  return {
    in_tokens: 0,
    in_uncached: 0,
    in_cache_write_5m: 0,
    in_cache_write_1h: 0,
    in_cache_read: 0,
    out_tokens: 0,
  }
}

/** One source of truth for the order: the table in `classify.ts` that also defines the sub-kinds. */
const CATEGORY_ORDER = new Map(CATEGORIES.map((info, at) => [info.id as string, at]))

function categoryOrder(id: string): number {
  return CATEGORY_ORDER.get(id) ?? CATEGORIES.length
}

/** `git` names `git commit` as well as itself, since that is how the sub-rows read. */
function namesCommand(name: string, wanted: string): boolean {
  const found = name.toLowerCase()
  return found === wanted || found.startsWith(`${wanted} `)
}

export function filterRounds(rounds: Round[], filter: RoundFilter): Round[] {
  // Labels depend on what came before in the task, so they are worked out over the whole set once,
  // before anything is dropped. Filtering first would change what the survivors mean.
  const labelled =
    filter.category !== undefined || filter.target !== undefined ? labelRounds(rounds) : null

  return rounds.filter((round) => {
    if (labelled !== null) {
      const labels = labelled.get(round) ?? []
      if (filter.category !== undefined) {
        const wanted = filter.category.toLowerCase()
        if (!labels.some((label) => label.category === wanted)) return false
      }
      if (filter.target !== undefined) {
        const wanted = filter.target.toLowerCase()
        if (!labels.some((label) => label.target === wanted)) return false
      }
    }
    if (filter.session !== undefined && round.session !== filter.session) return false
    if (filter.task !== undefined && round.task !== filter.task) return false
    if (filter.agent !== undefined && round.agent !== filter.agent) return false
    if (filter.tool !== undefined) {
      const wanted = filter.tool.toLowerCase()
      if (!(round.tools ?? []).some((tool) => tool.name?.toLowerCase() === wanted)) return false
    }
    if (filter.command !== undefined) {
      const wanted = filter.command.toLowerCase()
      const hit = (round.tools ?? []).some((tool) =>
        subCommands(tool).some((command) => namesCommand(command.name, wanted)),
      )
      if (!hit) return false
    }
    if (filter.kind !== undefined) {
      const wanted = filter.kind.toLowerCase()
      const hit = (round.tools ?? []).some((tool) =>
        subCommands(tool).some((command) => command.kind === wanted),
      )
      if (!hit) return false
    }
    if (filter.errorsOnly === true) {
      if (!(round.tools ?? []).some((tool) => tool.is_error === true)) return false
    }
    return true
  })
}

/** Tool counts for one round, as `Bash 2 · Edit 1 ✗1`. */
export function toolSummary(round: Round): string {
  const counts = new Map<string, number>()
  let errors = 0
  for (const tool of round.tools ?? []) {
    if (tool.is_error === true) errors += 1
    const name = tool.name ?? '?'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  if (counts.size === 0) return '·'
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, calls]) => `${name} ${calls}`)
  return parts.join(' · ') + (errors > 0 ? ` ✗${errors}` : '')
}

export class SelectorError extends Error {}

/**
 * Resolve a session id from any unique prefix, so the 8 characters the tables print are enough to
 * type back. An ambiguous prefix names its candidates rather than picking one.
 */
export function matchSession(sessions: string[], prefix: string): string {
  const wanted = prefix.toLowerCase()
  const exact = sessions.find((id) => id.toLowerCase() === wanted)
  if (exact !== undefined) return exact
  const hits = sessions.filter((id) => id.toLowerCase().startsWith(wanted))
  if (hits.length === 1) return hits[0]!
  if (hits.length === 0) throw new SelectorError(`no session in this project starts with "${prefix}"`)
  throw new SelectorError(
    `"${prefix}" matches ${hits.length} sessions: ${hits.map((id) => id.slice(0, 8)).join(', ')}`,
  )
}

/**
 * Whether a positional is an id (`3`, `3.12`, `fe64e716#3.12`) rather than a project name.
 */
export function looksLikeSelector(value: string): boolean {
  return /^(?:[0-9a-fA-F-]{4,}#)?\d+(?:\.\d+)?$/.test(value)
}

/**
 * An id is the path down to the thing it names, and each level extends the one above it: a session
 * is `504799b8`, its third task `504799b8#3`, and the rounds of that task `504799b8#3.0`, `#3.1`.
 *
 * The task is part of a round's id even though it could be derived from it, because that is what
 * keeps the two kinds of id from being mistaken for each other. Without the dot, an id copied out
 * of a task column and pasted into `probez round` names a real round, a wrong answer rather than
 * an error, which is the failure worth spending a redundant number to prevent.
 */
function resolveSession(
  rounds: Round[],
  selector: string,
  sessionHint: string | undefined,
): { session: string; rest: string } {
  const hash = selector.lastIndexOf('#')
  const prefix = hash === -1 ? sessionHint : selector.slice(0, hash)
  const rest = selector.slice(hash + 1)

  const sessions = [...new Set(rounds.map((round) => round.session))]
  if (sessions.length === 0) {
    throw new SelectorError('nothing collected for this project yet. Run `probez collect`')
  }
  if (prefix !== undefined) return { session: matchSession(sessions, prefix), rest }
  if (sessions.length === 1) return { session: sessions[0]!, rest }
  throw new SelectorError(
    `this project has ${sessions.length} sessions. Say which, as ${sessions[0]!.slice(0, 8)}#${rest}`,
  )
}

/** Find the round a selector names, as `<task>.<round>` within its session. */
export function findRound(rounds: Round[], selector: string, sessionHint?: string): Round {
  const shape = /^(?:[0-9a-fA-F-]{4,}#)?(\d+)\.(\d+)$/.exec(selector)
  if (shape === null) {
    // A bare number is a task id. Saying so beats "not a round selector", because it is almost
    // always an id copied from the task column of a table.
    const task = /^((?:[0-9a-fA-F-]{4,}#)?\d+)$/.exec(selector)
    if (task !== null) {
      throw new SelectorError(
        `"${selector}" names a task. A round is written ${selector}.<round>, or try \`probez task ${selector}\``,
      )
    }
    throw new SelectorError(`"${selector}" is not a round selector. Try 3.12 or fe64e716#3.12`)
  }

  const { session } = resolveSession(rounds, selector, sessionHint)
  const task = Number(shape[1])
  const index = Number(shape[2])
  const found = rounds.find((round) => round.session === session && round.round === index)
  if (found === undefined) {
    const last = rounds.filter((round) => round.session === session).length - 1
    throw new SelectorError(
      `session ${session.slice(0, 8)} has no round ${index}${last >= 0 ? `, which runs 0 to ${last}` : ''}`,
    )
  }
  // The task in the id is derivable, which makes it a check: a mismatch means the id was assembled
  // by hand from two different rows, and answering it anyway would answer a question nobody asked.
  if (found.task !== task) {
    throw new SelectorError(
      `round ${index} of session ${session.slice(0, 8)} is in task ${found.task}, not task ${task}. Try ${session.slice(0, 8)}#${found.task}.${index}`,
    )
  }
  return found
}

/** Every round belonging to the task a selector names, in order. */
export function findTask(rounds: Round[], selector: string, sessionHint?: string): Round[] {
  if (!/^(?:[0-9a-fA-F-]{4,}#)?\d+$/.test(selector)) {
    const round = /\.\d+$/.test(selector)
    throw new SelectorError(
      round
        ? `"${selector}" names a round. Its task is ${selector.replace(/\.\d+$/, '')}`
        : `"${selector}" is not a task selector. Try 3 or fe64e716#3`,
    )
  }

  const { session, rest } = resolveSession(rounds, selector, sessionHint)
  const index = Number(rest)
  if (index < 1) throw new SelectorError(`tasks start at 1, so there is no task ${index}`)
  const mine = rounds.filter((round) => round.session === session)
  const found = mine.filter((round) => round.task === index)
  if (found.length === 0) {
    const last = Math.max(0, ...mine.map((round) => round.task))
    throw new SelectorError(
      `session ${session.slice(0, 8)} has no task ${index}${last > 0 ? `, which runs 1 to ${last}` : ''}`,
    )
  }
  return found
}

// ---------------------------------------------------------------------------------------------
// Trails
// ---------------------------------------------------------------------------------------------

/**
 * Find the walk a selector names.
 *
 * A trail has no id of its own. It is named by the round it starts at, which is already a selector
 * `probez round` takes, and asking for any round the walk passed through finds it — that is the
 * question someone reading a round listing actually has. Inventing a fifth kind of id to sit beside
 * session, task and round would buy nothing and would be one more thing to mistake for the others.
 */
export function findTrail(
  rounds: Round[],
  trails: Trail[],
  selector: string,
  sessionHint?: string,
): Trail {
  const round = findRound(rounds, selector, sessionHint)
  const mine = trails.filter(
    (trail) =>
      trail.session === round.session && trail.steps.some((step) => step.round === round.round),
  )
  const starts = mine.find((trail) => trail.steps[0]?.round === round.round)
  if (starts !== undefined) return starts
  if (mine.length > 0) return mine[0]!
  throw new SelectorError(
    `round ${round.task}.${round.round} is not part of a trail. \`probez trails\` lists them`,
  )
}

/** How much of a project's finding was done inside a walk rather than scattered. */
export interface TrailShare {
  trails: number
  /** Calls that were a step of some walk. */
  steps: number
  /** Every call that was finding something out, walk or not. The denominator. */
  finding: number
  /** Walks whose edges were read out of result bodies rather than inferred from inputs. */
  proven: number
  /** Walks that ended in a change to somewhere they visited. */
  landed: number
  /** The deepest walk in the span, which is the one worth looking at first. */
  deepest: Trail | null
}

/**
 * What share of the finding happened inside a walk.
 *
 * The number this exists to make available is the one a tally of `reconstruction` cannot give: not
 * how much time went on finding things out, but how much of that finding was *directed* — a search
 * that led somewhere — against how much was calls that stand alone. A low share is not a fault; it
 * is what an agent working in a repository it already knows looks like.
 */
export function trailShare(rounds: Round[], options: TrailOptions = {}): TrailShare {
  const trails = trailsOf(rounds, options)
  const inTrail = new Set<string>()
  for (const trail of trails) {
    for (const step of trail.steps) inTrail.add(`${step.session}\0${step.at}`)
  }

  let finding = 0
  for (const round of rounds) {
    for (const tool of round.tools ?? []) {
      if (isFinding(tool)) finding += 1
    }
  }

  let deepest: Trail | null = null
  for (const trail of trails) {
    if (deepest === null || trail.depth > deepest.depth) deepest = trail
  }

  return {
    trails: trails.length,
    steps: trails.reduce((sum, trail) => sum + trail.steps.length, 0),
    finding,
    proven: trails.filter((trail) => trail.confidence === 'proven').length,
    landed: trails.filter((trail) => trail.outcome === 'edit').length,
    deepest,
  }
}
