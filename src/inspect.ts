import { commandOf, parseCommands, UNPARSED } from './bash.js'
import type { Command } from './bash.js'
import type { Round, ToolCall } from './types.js'

/** One session as recorded in the store, not as it exists on disk under ~/.claude. */
export interface SessionRow {
  session: string
  rounds: number
  tasks: number
  tool_calls: number
  errors: number
  in_tokens: number
  out_tokens: number
  first_ts: string | null
  last_ts: string | null
}

/** One task within a session: a user turn and everything the agent did about it. */
export interface TaskRow {
  session: string
  task: number
  rounds: number
  in_tokens: number
  out_tokens: number
  ms: number
  first_ts: string | null
  /** What was asked to start this task — the first user text in it. */
  asked: string
}

export interface ToolRow {
  name: string
  calls: number
  errors: number
  result_chars: number
  ms: number
  /** The kind of work, on rows that stand for a command rather than a tool. */
  kind?: string
  /** A finer level under this tool, when its calls decompose into something worth counting. */
  sub?: ToolRow[]
}

export interface RoundFilter {
  session?: string
  task?: number
  tool?: string
  command?: string
  kind?: string
  agent?: 'main' | 'sub'
  errorsOnly?: boolean
}

/**
 * Tools whose calls decompose one level further, and how. `Bash` is the only member: every other
 * tool's name already is its operation. The registry is what keeps adding another — an MCP server's
 * tools, a `Task`'s subagent type — an entry rather than a second design.
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
 * Sessions in the store, oldest activity first — the order they were worked in, which is also the
 * order `rounds.jsonl` was appended in.
 *
 * Tasks are counted per session because task numbers restart at 1 in every session; this is the
 * same rule `summarize` applies when it totals them.
 */
export function sessionRows(rounds: Round[]): SessionRow[] {
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
          in_tokens: 0,
          out_tokens: 0,
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
    row.in_tokens += round.in_tokens || 0
    row.out_tokens += round.out_tokens || 0
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
 * Blocks the agent's harness wraps around a user turn — a slash command's name, the caveat that
 * introduces it, a reminder injected into the message. They are envelope, not what was asked.
 */
const ENVELOPE =
  /<(local-command-caveat|command-name|command-message|command-args|local-command-stdout|system-reminder)>[\s\S]*?<\/\1>/g

/**
 * What a user turn actually asked, with the harness envelope taken off. The stored round keeps the
 * text verbatim — `probez round <n>` still prints every word of it — this is for the one line a
 * table has room for.
 */
export function asked(text: string): string {
  const stripped = text.replace(ENVELOPE, '').trim()
  return stripped === '' ? text.trim() : stripped
}

/**
 * Tasks, oldest first — the order they were worked.
 *
 * Keyed by session as well as by number, because task numbers restart at 1 in every session: task 3
 * of one session and task 3 of the next are different work, and merging them would invent a task
 * that never happened. Subagent rounds count towards their task; delegated work is still work the
 * task cost.
 */
export function taskRows(rounds: Round[]): TaskRow[] {
  const byTask = new Map<string, TaskRow>()
  for (const round of rounds) {
    const key = `${round.session} ${round.task}`
    let row = byTask.get(key)
    if (row === undefined) {
      row = {
        session: round.session,
        task: round.task,
        rounds: 0,
        in_tokens: 0,
        out_tokens: 0,
        ms: 0,
        first_ts: null,
        asked: '',
      }
      byTask.set(key, row)
    }
    row.rounds += 1
    row.in_tokens += round.in_tokens || 0
    row.out_tokens += round.out_tokens || 0
    if (typeof round.ms === 'number') row.ms += round.ms
    if (typeof round.ts === 'string' && (row.first_ts === null || round.ts < row.first_ts)) {
      row.first_ts = round.ts
    }
    // Only the round that opened the task carries the prompt; the rest were driven by tool results.
    if (row.asked === '' && typeof round.user_text === 'string') row.asked = asked(round.user_text)
  }
  return [...byTask.values()].sort(
    (a, b) => (a.first_ts ?? '').localeCompare(b.first_ts ?? '') || a.task - b.task,
  )
}

function add(row: ToolRow, tool: ToolCall): void {
  row.calls += 1
  if (tool.is_error === true) row.errors += 1
  if (typeof tool.result_chars === 'number') row.result_chars += tool.result_chars
  if (typeof tool.ms === 'number') row.ms += tool.ms
}

const byCalls = (a: ToolRow, b: ToolRow): number => b.calls - a.calls || a.name.localeCompare(b.name)

/**
 * Every tool the project called, most-used first.
 *
 * With `sub`, a tool that decomposes carries a second level — `Bash` by command, or by the kind of
 * work each command does. Two things about those counts, which the printed table repeats:
 *
 * - A command is counted once per call it appears in, so `calls` means the same thing it does at
 *   the top level. `cd x && npm test` is one call that ran two commands, and it counts for both;
 *   sub-row calls therefore sum to more than the tool's own.
 * - Errors, result size and time belong to the call, not to a command inside it — a call has one
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
        row = { name: tool.name, calls: 0, errors: 0, result_chars: 0, ms: 0 }
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
        // Distinct commands of one kind — `grep` then `find` — are one use of that kind.
        if (seen.has(key)) continue
        seen.add(key)
        let entry = group.get(key)
        if (entry === undefined) {
          entry = { name: key, calls: 0, errors: 0, result_chars: 0, ms: 0 }
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

/** `git` names `git commit` as well as itself, since that is how the sub-rows read. */
function namesCommand(name: string, wanted: string): boolean {
  const found = name.toLowerCase()
  return found === wanted || found.startsWith(`${wanted} `)
}

export function filterRounds(rounds: Round[], filter: RoundFilter): Round[] {
  return rounds.filter((round) => {
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
 * Whether a positional is an id — `3`, `3.12`, `fe64e716#3.12` — rather than a project name.
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
 * of a task column and pasted into `probez round` names a real round — a wrong answer rather than
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
    throw new SelectorError('nothing collected for this project yet — run `probez collect`')
  }
  if (prefix !== undefined) return { session: matchSession(sessions, prefix), rest }
  if (sessions.length === 1) return { session: sessions[0]!, rest }
  throw new SelectorError(
    `this project has ${sessions.length} sessions — say which, as ${sessions[0]!.slice(0, 8)}#${rest}`,
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
        `"${selector}" names a task — a round is written ${selector}.<round>, or try \`probez task ${selector}\``,
      )
    }
    throw new SelectorError(`"${selector}" is not a round selector — try 3.12 or fe64e716#3.12`)
  }

  const { session } = resolveSession(rounds, selector, sessionHint)
  const task = Number(shape[1])
  const index = Number(shape[2])
  const found = rounds.find((round) => round.session === session && round.round === index)
  if (found === undefined) {
    const last = rounds.filter((round) => round.session === session).length - 1
    throw new SelectorError(
      `session ${session.slice(0, 8)} has no round ${index}${last >= 0 ? ` — it runs 0 to ${last}` : ''}`,
    )
  }
  // The task in the id is derivable, which makes it a check: a mismatch means the id was assembled
  // by hand from two different rows, and answering it anyway would answer a question nobody asked.
  if (found.task !== task) {
    throw new SelectorError(
      `round ${index} of session ${session.slice(0, 8)} is in task ${found.task}, not task ${task} — try ${session.slice(0, 8)}#${found.task}.${index}`,
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
        ? `"${selector}" names a round — its task is ${selector.replace(/\.\d+$/, '')}`
        : `"${selector}" is not a task selector — try 3 or fe64e716#3`,
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
      `session ${session.slice(0, 8)} has no task ${index}${last > 0 ? ` — it runs 1 to ${last}` : ''}`,
    )
  }
  return found
}
