#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { COMMAND_KINDS } from './bash.js'
import {
  defaultClaudeDir,
  discoverProjects,
  isEphemeral,
  matchByName,
  matchProjects,
  projectName,
} from './discover.js'
import { ago, clip, duration, pad, padStart, shorten, span, tokens, wrap } from './format.js'
import {
  filterRounds,
  findRound,
  findTask,
  looksLikeSelector,
  matchSession,
  SelectorError,
  sessionRows,
  taskRows,
  toolSummary,
  toolTally,
} from './inspect.js'
import type { RoundFilter, SessionRow, TaskRow, ToolRow } from './inspect.js'
import { collectProject, defaultDataDir, readRounds } from './store.js'
import type { CollectResult, Summary } from './store.js'
import type { Project, Round } from './types.js'

const COMMANDS = new Set([
  'collect',
  'projects',
  'sessions',
  'session',
  'tasks',
  'task',
  'rounds',
  'round',
  'tools',
  'help',
])

/** Commands that used to exist, and what to type instead. */
const RETIRED: Record<string, string> = {
  status: '`status` is gone. `probez <target>` collects and prints the same summary',
}

/** Flags that mean the same thing everywhere, so every command takes them. */
const GLOBAL_FLAGS = new Set([
  'json',
  'all',
  'include-temp',
  'data-dir',
  'claude-dir',
  'version',
  'help',
])

/**
 * What each command accepts on top of the global set.
 *
 * Flags are parsed once for the whole CLI, so without this every flag parses on every command and
 * the ones a command does not read are silently dropped. Being told `--kinds` does nothing here is
 * worth more than a table that quietly ignores it.
 */
const COMMAND_FLAGS: Record<string, string[]> = {
  collect: ['full'],
  projects: [],
  sessions: ['limit'],
  session: ['limit'],
  tasks: ['limit', 'session'],
  task: ['limit', 'session'],
  rounds: ['limit', 'session', 'task', 'tool', 'command', 'kind', 'agent', 'errors'],
  round: ['session'],
  tools: ['limit', 'kinds'],
  help: [],
}

/** Where a flag does work, for the error that says it does not work here. */
function acceptedBy(flag: string): string[] {
  return Object.keys(COMMAND_FLAGS).filter((name) => COMMAND_FLAGS[name]!.includes(flag))
}

/** Rounds listed before `--limit` has to withhold any. */
const DEFAULT_LIMIT = 50
/** Commands listed under a tool before `--limit` has to withhold any. */
const DEFAULT_SUB_LIMIT = 8

const HELP = `probez: see what your coding agents actually did.

What is recorded, and what names it
  project        a directory an agent was started in       its name, or its path
  └ session      one agent run                             504799b8
    └ task       a user turn, and everything it led to     504799b8#3
      └ round    one LLM call                              504799b8#3.12
        └ tool call                                        shown in full by its round

Every level has a list and a detail view: \`probez sessions\` then \`probez session <id>\`, and the
same for tasks and rounds. An id is the path down to the thing it names, so each one extends the
one above it and no two kinds of id can be mistaken for each other.

Usage
  probez [project]             Summary for a project, picking up anything new first
  probez projects              Every project on this machine

Sessions
  probez sessions [project]    One row per session
  probez session <id>          One session: its tasks, and what each one asked
  --limit <n>                  How many rows to list (default ${DEFAULT_LIMIT} for the list,
                               all of them for one session; 0 for all)

Tasks
  probez tasks [project]       One row per task, across every session
  probez task <id>             One task: what it asked, and every round it took
  --session <id>               Only tasks from this session
  --limit <n>                  As above

Rounds
  probez rounds [project]      Every round
  probez round <id>            One round in full, with every tool call
  --session <id>               Only this session, by any unique prefix of its id
  --task <n>                   Only this task number
  --tool <name>                Only rounds that called this tool
  --command <name>             Only rounds that ran this shell command; "git" also
                               matches "git commit", the way the tools table names it
  --kind <kind>                Only rounds that ran a command of this kind:
                               ${COMMAND_KINDS.slice(0, 7).join(' · ')}
                               ${COMMAND_KINDS.slice(7).join(' · ')}
  --agent <main|sub>           Only main-agent or only subagent rounds
  --errors                     Only rounds where a tool failed
  --limit <n>                  How many rounds to list (default ${DEFAULT_LIMIT}, 0 for all)

\`--session\` also disambiguates \`probez task\` and \`probez round\` when a prefix is ambiguous.

Tools
  probez tools [project]       Every tool called, and what Bash actually ran
  --kinds                      Group Bash by kind of work instead of by command
  --limit <n>                  How many commands to list under each tool
                               (default ${DEFAULT_SUB_LIMIT}, 0 for all)

Collection
  probez collect [project]     Collect one project, or every project under a folder
  probez collect --all         Collect every project on this machine
  --full                       Re-read every session instead of only what changed

Options (these work on every command)
  --json                       Machine-readable output
  --all                        Every project on this machine, not just one
  --include-temp               Include scratch directories, which projects and --all skip
  --data-dir <dir>             Where probez stores data (default ~/.probez,
                               or \$PROBEZ_DATA_DIR when that is set)
  --claude-dir <dir>           Where to read sessions from (default ~/.claude/projects)
  --version                    Print the version
  -h, --help                   Print this help

Every other flag above belongs to the command it is listed under, and giving one to a command that
does not take it is an error rather than a silent no-op.

A list withholds rows past its limit and says so; a detail view (\`session <id>\`, \`task <id>\`,
\`round <id>\`) shows the whole thing unless you ask for a limit.

Naming a project
  Leave it out and probez uses the current directory. Otherwise give the project's name, as
  \`probez projects\` lists it, or the path it was worked in:
      probez sessions flowz-mcp
      probez sessions ~/Dev/workspace/flowz-mcp
  A path holding several projects covers all of them: \`probez collect ~/Dev\` collects each.

Naming a session, a task or a round
  Any unique prefix of a session id will do, since the tables print the first eight characters:
      probez session 0b2cc149     probez task 0b2cc149#3     probez round 0b2cc149#3.12
  The session comes off when the project has only one:
      probez task 3               probez round 3.12
`

function printSummary(summary: Summary, extra?: string): void {
  const title = summary.path ? shorten(summary.path) : summary.project
  console.log('')
  console.log(`probez  ${summary.project}  ${title}`)
  console.log('')
  console.log(
    `  ${pad('sessions', 11)}${pad(String(summary.sessions), 10)}${pad('rounds', 9)}${pad(String(summary.rounds), 9)}tasks  ${summary.tasks}`,
  )
  console.log(`  ${pad('tokens', 11)}${tokens(summary.in_tokens)} in · ${tokens(summary.out_tokens)} out`)
  console.log(`  ${pad('span', 11)}${span(summary.first_ts, summary.last_ts)}`)
  if (summary.tools.length > 0) {
    console.log(
      `  ${pad('top tools', 11)}${summary.tools.map((tool) => `${tool.name} ${tool.calls}`).join(' · ')}`,
    )
  }
  console.log('')
  if (extra !== undefined) console.log(`  ${extra}`)
  console.log(`  → ${shorten(summary.dir)}/rounds.jsonl`)
  console.log('')
}

function collectedLine(result: CollectResult): string {
  if (result.read_sessions === 0) return `up to date, ${result.skipped_sessions} sessions unchanged`
  const sessions = `${result.read_sessions} session${result.read_sessions === 1 ? '' : 's'} read`
  const skipped = result.skipped_sessions > 0 ? `, ${result.skipped_sessions} unchanged` : ''
  return `+${result.new_rounds} rounds, ${sessions}${skipped}`
}

/**
 * Sessions record the path with symlinks resolved, so a target has to be resolved the same way
 * before comparing. On macOS /var/folders is really /private/var/folders, and checkouts are often
 * reached through a link. The directory may also be long gone, which is normal for the scratch
 * directories agents work in, so resolve the deepest ancestor that still exists and re-attach the
 * rest.
 */
async function resolveThroughLinks(target: string): Promise<string> {
  const missing: string[] = []
  let current = resolve(target)
  for (;;) {
    try {
      const real = await realpath(current)
      return missing.length === 0 ? real : join(real, ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(target)
      missing.push(basename(current))
      current = parent
    }
  }
}

interface Targets {
  projects: Project[]
  /** Scratch projects left out of an --all sweep. */
  skippedTemp: number
}

/**
 * A target is a path (a project, or a folder containing several) or a bare project name.
 *
 * `--all` leaves scratch directories out, since a benchmark harness can turn one run into dozens
 * of throwaway projects. Asking for one by name or path always collects it.
 */
async function resolveTargets(
  projects: Project[],
  target: string | undefined,
  options: { all: boolean; includeTemp: boolean },
): Promise<Targets> {
  if (options.all) {
    if (options.includeTemp) return { projects, skippedTemp: 0 }
    const kept = projects.filter((project) => !isEphemeral(project))
    return { projects: kept, skippedTemp: projects.length - kept.length }
  }
  const wanted = target ?? process.cwd()
  const byPath = matchProjects(projects, await resolveThroughLinks(wanted))
  if (byPath.length > 0 || target === undefined) return { projects: byPath, skippedTemp: 0 }
  return { projects: matchByName(projects, target), skippedTemp: 0 }
}

function noMatch(projects: Project[], target: string | undefined): never {
  if (target === undefined) {
    console.error(`probez: no agent sessions recorded for ${shorten(process.cwd())}`)
  } else {
    console.error(`probez: no project matched "${target}"`)
  }
  const names = projects.slice(0, 5).map(projectName)
  if (names.length > 0) {
    console.error(`\nMost recent projects: ${names.join(', ')}`)
    console.error('Run `probez projects` for the full list.')
  }
  process.exit(1)
}

function projectHeader(project: Project): void {
  const name = projectName(project)
  console.log('')
  console.log(`  ${name}  ${project.path ? shorten(project.path) : '(path unknown)'}`)
  console.log('')
}

function nothingCollected(project: Project): void {
  console.log(`\n  ${projectName(project)}: nothing collected yet. Run \`probez collect\`.\n`)
}

/** Model ids carry a vendor prefix and a training date that say nothing at a glance. */
function shortModel(model: string | null): string {
  if (model === null) return '—'
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

/**
 * How many rows to show, and how to say what was left out. A list that silently stops at its limit
 * reads as the whole set, so every list says which it is.
 */
function shown<T>(rows: T[], limit: number): T[] {
  return limit > 0 ? rows.slice(0, limit) : rows
}

function counted(count: number, total: number, noun: string): string {
  return count < total
    ? `showing ${count} of ${total} ${noun}s`
    : `${total} ${noun}${total === 1 ? '' : 's'}`
}

/** Trails the footer rather than interrupting it, so the counts stay adjacent. */
function more(count: number, total: number): string {
  return count < total ? ', --limit 0 for all' : ''
}

function printSessions(all: ReturnType<typeof sessionRows>, limit: number): void {
  // Totals describe the project, not the page, so they are counted before the limit is applied.
  const totals = all.reduce((sum, row) => sum + row.rounds, 0)
  const rows = shown(all, limit)
  console.log(
    `  ${pad('SESSION', 11)}${padStart('ROUNDS', 6)}  ${padStart('TASKS', 5)}  ${pad('TOOLS', 10)}${padStart('IN', 8)}  ${padStart('OUT', 7)}  LAST`,
  )
  for (const row of rows) {
    const calls = `${row.tool_calls}${row.errors > 0 ? ` ✗${row.errors}` : ''}`
    const last = row.last_ts === null ? '—' : ago(Date.parse(row.last_ts))
    console.log(
      `  ${pad(row.session.slice(0, 8), 11)}${padStart(String(row.rounds), 6)}  ${padStart(String(row.tasks), 5)}  ${pad(calls, 10)}${padStart(tokens(row.in_tokens), 8)}  ${padStart(tokens(row.out_tokens), 7)}  ${last}`,
    )
  }
  console.log('')
  console.log(
    `  ${counted(rows.length, all.length, 'session')} · ${totals} rounds${more(rows.length, all.length)}`,
  )
  console.log('  `probez session <id>` shows one of them, task by task.')
  console.log('')
}

/** How a task is named on screen, and typed back: `504799b8#3`, or `3` inside a lone session. */
function taskId(row: TaskRow, showSession: boolean): string {
  return showSession ? `${row.session.slice(0, 8)}#${row.task}` : String(row.task)
}

function printTaskRows(tasks: TaskRow[], width: number, showSession: boolean): void {
  // The id column is named after what it identifies. Calling it `#` in a table that also counts
  // rounds reads as "round number", which is the one thing it is not.
  const idWidth = showSession ? 13 : 6
  const asked = Math.max(20, width - idWidth - 34)
  console.log(
    `  ${pad('TASK', idWidth)}${padStart('ROUNDS', 6)}  ${padStart('IN', 7)}  ${padStart('OUT', 6)}  ${padStart('TIME', 7)}  ASKED`,
  )
  for (const task of tasks) {
    console.log(
      `  ${pad(taskId(task, showSession), idWidth)}${padStart(String(task.rounds), 6)}  ${padStart(tokens(task.in_tokens), 7)}  ${padStart(tokens(task.out_tokens), 6)}  ${padStart(duration(task.ms), 7)}  ${clip(task.asked === '' ? '—' : task.asked, asked)}`,
    )
  }
}

/** Every task in the project, which is the work seen in the units it was asked for. */
function printTasks(all: TaskRow[], width: number, showSession: boolean, limit: number): void {
  const tasks = shown(all, limit)
  printTaskRows(tasks, width, showSession)
  console.log('')
  console.log(
    `  ${counted(tasks.length, all.length, 'task')}${more(tasks.length, all.length)}. \`probez task <id>\` shows one in full`,
  )
  console.log('')
}

/** One task: what was asked, what it cost, and every round it took. */
function printTask(
  row: TaskRow,
  rounds: Round[],
  total: number,
  width: number,
  limit: number,
): void {
  const tools = toolTally(rounds)
  const errors = tools.reduce((sum, tool) => sum + tool.errors, 0)
  console.log(
    `  task ${row.task} of session ${row.session.slice(0, 8)}  ·  ${rounds.length} rounds · ${tokens(row.in_tokens)} in · ${tokens(row.out_tokens)} out · ${duration(row.ms)}`,
  )

  if (row.asked !== '') {
    console.log('')
    console.log('  asked')
    for (const line of wrap(row.asked, width)) console.log(`    ${line}`)
  }
  if (tools.length > 0) {
    console.log('')
    const summary = tools.slice(0, 6).map((tool) => `${tool.name} ${tool.calls}`).join(' · ')
    console.log(`  tools  ${summary}${errors > 0 ? ` ✗${errors}` : ''}`)
  }

  console.log('')
  const page = shown(rounds, limit)
  printRoundRows(page, true)
  console.log('')
  console.log(
    `  ${counted(page.length, rounds.length, 'round')} · task ${row.task} of ${total}${more(page.length, rounds.length)}`,
  )
  console.log('')
}

/**
 * One session, as its tasks. A task is the unit someone actually remembers: what they asked, and
 * what it cost, which the round list never shows however far you scroll it.
 */
function printSession(
  row: SessionRow,
  all: TaskRow[],
  width: number,
  showSession: boolean,
  limit: number,
): void {
  const errors = row.errors > 0 ? ` · ${row.errors} tool error${row.errors === 1 ? '' : 's'}` : ''
  console.log(
    `  session ${row.session.slice(0, 8)}  ·  ${all.length} task${all.length === 1 ? '' : 's'} · ${row.rounds} rounds · ${tokens(row.in_tokens)} in · ${tokens(row.out_tokens)} out${errors} · ${span(row.first_ts, row.last_ts)}`,
  )
  console.log('')
  const tasks = shown(all, limit)
  printTaskRows(tasks, width, showSession)
  console.log('')
  console.log(
    `  ${counted(tasks.length, all.length, 'task')} · ${row.rounds} rounds${more(tasks.length, all.length)}. \`probez task ${taskId(tasks[0] ?? ({ session: row.session, task: 1 } as TaskRow), showSession)}\` shows one in full`,
  )
  console.log('')
}

/**
 * `showSession` follows the project, not the rows on screen: with one session the round number is
 * enough to type back, but as soon as the project has several, every id has to carry its session or
 * it is not a selector `round` can resolve, even when a filter happens to leave one session shown.
 */
/** How a round is named on screen, and typed back: `504799b8#3.12`, or `3.12` inside a lone session. */
function roundId(round: Round, showSession: boolean): string {
  const local = `${round.task}.${round.round}`
  return showSession ? `${round.session.slice(0, 8)}#${local}` : local
}

function printRoundRows(rounds: Round[], showSession: boolean): void {
  const idWidth = showSession ? 16 : 9
  // No TASK column: a round's id carries its task, so a second one would print the same number
  // twice. `probez task 504799b8#3` opens the task any row belongs to.
  console.log(
    `  ${pad('ROUND', idWidth)}${pad('AGENT', 6)}${pad('MODEL', 16)}${padStart('IN', 8)}  ${padStart('OUT', 6)}  ${padStart('TIME', 7)}  TOOLS`,
  )
  for (const round of rounds) {
    console.log(
      `  ${pad(roundId(round, showSession), idWidth)}${pad(round.agent, 6)}${pad(shortModel(round.model), 16)}${padStart(tokens(round.in_tokens), 8)}  ${padStart(tokens(round.out_tokens), 6)}  ${padStart(duration(round.ms), 7)}  ${clip(toolSummary(round), 44)}`,
    )
  }
}

function printRounds(rounds: Round[], total: number, limit: number, showSession: boolean): void {
  printRoundRows(rounds, showSession)
  console.log('')
  if (limit > 0 && total > rounds.length) {
    console.log(`  showing ${rounds.length} of ${total} rounds, --limit 0 for all`)
  } else {
    console.log(`  ${rounds.length} round${rounds.length === 1 ? '' : 's'}`)
  }
  console.log('')
}

/** One `key: value` line per top-level input key. Paths and commands are what identify a call. */
function printToolInput(input: unknown, width: number): void {
  if (input === null || input === undefined) return
  if (typeof input !== 'object' || Array.isArray(input)) {
    console.log(`       ${clip(String(input), width)}`)
    return
  }
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const rendered = typeof value === 'string' ? value : JSON.stringify(value)
    console.log(`       ${key}: ${clip(rendered ?? 'null', width)}`)
  }
}

function printRound(round: Round, width: number): void {
  console.log('')
  console.log(
    `  round ${roundId(round, true)} · ${round.agent} · ${shortModel(round.model)}`,
  )
  console.log(
    `  ${tokens(round.in_tokens)} in · ${tokens(round.out_tokens)} out · ${duration(round.ms)} · ${round.thinking_chars} thinking chars`,
  )
  console.log(`  session ${round.session}${round.ts ? ` · ${round.ts}` : ''}`)

  if (round.user_text !== '') {
    console.log('')
    console.log('  user')
    for (const line of wrap(round.user_text, width)) console.log(`    ${line}`)
  }
  if (round.text !== '') {
    console.log('')
    console.log('  assistant')
    for (const line of wrap(round.text, width)) console.log(`    ${line}`)
  }

  const tools = round.tools ?? []
  console.log('')
  if (tools.length === 0) {
    console.log('  no tool calls')
    console.log('')
    return
  }
  console.log(`  tools (${tools.length})`)
  tools.forEach((tool, index) => {
    const chars = tool.result_chars === null ? '—' : `${tokens(tool.result_chars)} chars`
    console.log(
      `    ${padStart(String(index + 1), 2)}  ${tool.is_error === true ? '✗' : ' '} ${pad(tool.name ?? '?', 14)}${padStart(duration(tool.ms), 7)}  ${chars}`,
    )
    printToolInput(tool.input, width - 8)
  })
  console.log('')
}

function toolLine(name: string, indent: number, row: ToolRow): string {
  const width = 22 - indent
  return `${' '.repeat(indent)}${pad(clip(name, width - 1), width)}${padStart(String(row.calls), 6)}  ${padStart(row.errors > 0 ? String(row.errors) : '·', 6)}  ${padStart(tokens(row.result_chars), 8)}  ${padStart(duration(row.ms), 8)}`
}

/**
 * The tool table, with the second level indented under any tool that has one. `noun` names what
 * those rows are, since it is the difference between a command and a kind of work.
 */
function printTools(rows: ToolRow[], subLimit: number, noun: string): void {
  console.log(
    `  ${pad('TOOL', 20)}${padStart('CALLS', 6)}  ${padStart('ERRORS', 6)}  ${padStart('RESULT', 8)}  ${padStart('TIME', 8)}`,
  )
  let calls = 0
  let errors = 0
  const broken: string[] = []
  for (const row of rows) {
    calls += row.calls
    errors += row.errors
    console.log(toolLine(row.name, 2, row))

    const sub = row.sub ?? []
    if (sub.length === 0) continue
    broken.push(`${sub.length} ${noun}${sub.length === 1 ? '' : 's'} under ${row.name}`)
    const shown = subLimit > 0 ? sub.slice(0, subLimit) : sub
    for (const entry of shown) console.log(toolLine(entry.name, 4, entry))
    if (shown.length < sub.length) {
      console.log(`      … ${sub.length - shown.length} more, --limit 0 for all`)
    }
  }
  console.log('')
  console.log(
    `  ${rows.length} tool${rows.length === 1 ? '' : 's'} · ${calls} call${calls === 1 ? '' : 's'} · ${errors} error${errors === 1 ? '' : 's'}`,
  )
  if (broken.length > 0) {
    // Without this the sub-rows look like they should add up to their tool's own count, and they
    // never will: one call can run several commands, and it counts for each of them.
    console.log(`  ${broken.join(' · ')}. A call that ran several is counted for each`)
  }
  console.log('')
}

function fail(message: string): never {
  console.error(`probez: ${message}`)
  process.exit(2)
}

function asCount(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) fail(`--${flag} needs a whole number, got "${value}"`)
  return n
}

async function main(): Promise<void> {
  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (nodeMajor < 20) {
    console.error(`probez needs Node 20 or newer. This is Node ${process.versions.node}.`)
    process.exit(1)
  }

  let parsed
  try {
    parsed = parseArgs({
      allowPositionals: true,
      tokens: true,
      options: {
        'data-dir': { type: 'string' },
        'claude-dir': { type: 'string' },
        json: { type: 'boolean', default: false },
        all: { type: 'boolean', default: false },
        full: { type: 'boolean', default: false },
        'include-temp': { type: 'boolean', default: false },
        kinds: { type: 'boolean', default: false },
        session: { type: 'string' },
        task: { type: 'string' },
        tool: { type: 'string' },
        command: { type: 'string' },
        kind: { type: 'string' },
        agent: { type: 'string' },
        errors: { type: 'boolean', default: false },
        limit: { type: 'string' },
        version: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
  } catch (error) {
    console.error(`probez: ${(error as Error).message}`)
    process.exit(2)
  }

  const { values, positionals } = parsed
  // A bare target is shorthand for collect, so `probez ~/some/repo` and `probez my-repo` work.
  const first = positionals[0]
  if (first !== undefined && RETIRED[first] !== undefined) fail(RETIRED[first]!)
  const isCommand = first !== undefined && COMMANDS.has(first)
  const command = isCommand ? first : 'collect'
  let target = isCommand ? positionals[1] : first
  let selector: string | undefined

  // The detail commands name something inside a project, so they take an id as well as a project
  // and either one may be omitted. Two positionals are `<project> <id>`; one is the id alone,
  // except for `task` and `round`, whose ids are numeric, so a positional that does not look like `7`
  // or `fe64e716#7` is a project name there.
  if (command === 'session' || command === 'task' || command === 'round') {
    if (positionals[2] !== undefined) {
      selector = positionals[2]
    } else if (target !== undefined && (command === 'session' || looksLikeSelector(target))) {
      selector = target
      target = undefined
    }
  }

  if (values.help || command === 'help') {
    console.log(HELP)
    return
  }

  // What was actually typed, which `values` cannot say: a boolean flag left out is `false` there,
  // indistinguishable from one passed explicitly.
  const allowed = COMMAND_FLAGS[command] ?? []
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue
    const flag = token.name
    if (GLOBAL_FLAGS.has(flag) || allowed.includes(flag)) continue
    const elsewhere = acceptedBy(flag)
    const where =
      elsewhere.length === 0
        ? ''
        : ` It belongs to ${elsewhere.map((name) => `\`${name}\``).join(', ')}.`
    fail(`--${flag} does not apply to \`probez ${command}\`.${where}`)
  }
  if (values.version) {
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
    console.log(pkg.version)
    return
  }

  const dataDir = values['data-dir'] ? resolve(values['data-dir']) : defaultDataDir()
  const claudeDir = values['claude-dir'] ? resolve(values['claude-dir']) : defaultClaudeDir()
  const projects = await discoverProjects(claudeDir)

  if (projects.length === 0) {
    console.error(`probez: no agent sessions found in ${shorten(claudeDir)}`)
    process.exit(1)
  }

  if (command === 'projects') {
    // Scratch projects are mostly noise in a listing for the same reason --all skips them.
    const listed = values['include-temp'] ? projects : projects.filter((p) => !isEphemeral(p))
    const skippedTemp = projects.length - listed.length
    if (values.json) {
      console.log(
        JSON.stringify(
          listed.map((p) => ({
            key: p.key,
            path: p.path,
            sessions: p.sessions.length,
            last_activity: new Date(p.lastActivity).toISOString(),
          })),
          null,
          2,
        ),
      )
      return
    }
    console.log('')
    for (const project of listed) {
      const name = project.path ? project.path.split('/').pop()! : project.key
      const count = project.sessions.length
      console.log(
        `  ${pad(name, 28)}${pad(`${count} session${count === 1 ? '' : 's'}`, 14)}${pad(ago(project.lastActivity), 13)}${project.path ? shorten(project.path) : '(path unknown)'}`,
      )
    }
    console.log(`\n  ${listed.length} projects`)
    if (skippedTemp > 0) {
      console.log(
        `  ${skippedTemp} scratch project${skippedTemp === 1 ? '' : 's'} in temp directories hidden. Use --include-temp to list them`,
      )
    }
    console.log('  `probez <name>` collects one and shows its summary.')
    console.log('')
    return
  }

  const targeting = { all: values.all, includeTemp: values['include-temp'] }

  const READ_COMMANDS = ['sessions', 'session', 'tasks', 'task', 'rounds', 'round', 'tools']
  if (READ_COMMANDS.includes(command)) {
    const { projects: matched } = await resolveTargets(projects, target, targeting)
    if (matched.length === 0) noMatch(projects, target)

    const width = Math.max(60, Math.min(process.stdout.columns ?? 100, 120)) - 8
    const limit = asCount(values.limit, 'limit') ?? DEFAULT_LIMIT
    // A tool's commands are a short list next to a session's rounds, so they keep their own default
    // and only follow --limit when it was actually typed.
    const subLimit = values.limit === undefined ? DEFAULT_SUB_LIMIT : limit
    // Lists paginate; a detail view is a request for one thing in full, so `session <id>` and
    // `task <id>` withhold nothing unless --limit was actually typed.
    const detailLimit = asCount(values.limit, 'limit') ?? 0
    const taskFilter = asCount(values.task, 'task')
    if (values.agent !== undefined && values.agent !== 'main' && values.agent !== 'sub') {
      fail(`--agent takes main or sub, got "${values.agent}"`)
    }
    if (values.kind !== undefined && !COMMAND_KINDS.includes(values.kind as never)) {
      fail(`--kind takes one of ${COMMAND_KINDS.join(', ')}, got "${values.kind}"`)
    }

    // Naming one thing inside a project only means something once the project is settled.
    const DETAIL = ['session', 'task', 'round']
    if (DETAIL.includes(command) && matched.length > 1) {
      fail(
        `"${target ?? process.cwd()}" matches ${matched.length} projects. Name one to look inside it`,
      )
    }
    if (command === 'round' && selector === undefined) {
      fail('round needs a round id, as `probez round 3.12` or `probez round fe64e716#3.12`')
    }
    if (command === 'task' && selector === undefined) {
      fail('task needs a task number, as `probez task 3` or `probez task fe64e716#3`')
    }
    if (command === 'session' && selector === undefined) {
      fail('session needs a session id, as `probez session 0b2cc149`. `probez sessions` lists them')
    }

    const output: unknown[] = []
    for (const project of matched) {
      const rounds = await readRounds(project, dataDir)
      // An empty store still has a shape in --json: an empty list of whatever was asked for, so a
      // script sees the same fields either way. Only the printed form needs to say what to do.
      if (rounds.length === 0 && !values.json) {
        nothingCollected(project)
        continue
      }

      if (command === 'sessions') {
        const rows = sessionRows(rounds)
        if (values.json) {
          output.push(matched.length > 1 ? { project: projectName(project), path: project.path, sessions: rows } : rows)
          continue
        }
        projectHeader(project)
        printSessions(rows, limit)
        continue
      }

      if (command === 'tools') {
        const rows = toolTally(rounds, values.kinds ? 'kind' : 'command')
        if (values.json) {
          output.push(matched.length > 1 ? { project: projectName(project), path: project.path, tools: rows } : rows)
          continue
        }
        projectHeader(project)
        printTools(rows, subLimit, values.kinds ? 'kind' : 'command')
        continue
      }

      const sessions = [...new Set(rounds.map((round) => round.session))]
      let session: string | undefined
      try {
        session = values.session === undefined ? undefined : matchSession(sessions, values.session)
      } catch (error) {
        if (error instanceof SelectorError) fail(error.message)
        throw error
      }

      if (command === 'tasks') {
        // `--session` narrows to one session, the same way it does on `rounds`.
        const mine = session === undefined ? rounds : rounds.filter((r) => r.session === session)
        const rows = taskRows(mine)
        if (values.json) {
          output.push(matched.length > 1 ? { project: projectName(project), path: project.path, tasks: rows } : rows)
          continue
        }
        projectHeader(project)
        printTasks(rows, width, sessions.length > 1, limit)
        continue
      }

      if (command === 'session') {
        let id: string
        try {
          id = matchSession(sessions, selector!)
        } catch (error) {
          if (error instanceof SelectorError) fail(error.message)
          throw error
        }
        const mine = rounds.filter((round) => round.session === id)
        const row = sessionRows(mine)[0]!
        const tasks = taskRows(mine)
        if (values.json) {
          // The session's own row, except that `tasks` carries the tasks rather than counting
          // them: the count is the length, and a second key for it would be the same fact twice.
          output.push({ ...row, tasks })
          continue
        }
        projectHeader(project)
        printSession(row, tasks, width, sessions.length > 1, detailLimit)
        continue
      }

      if (command === 'task') {
        let mine: Round[]
        try {
          mine = findTask(rounds, selector!, session)
        } catch (error) {
          if (error instanceof SelectorError) fail(error.message)
          throw error
        }
        const row = taskRows(mine)[0]!
        if (values.json) {
          // As with `session`, the detail view's own key carries the things rather than counting
          // them: `rounds` is the rounds, and the count is its length.
          output.push({ ...row, rounds: mine })
          continue
        }
        const total = new Set(
          rounds.filter((r) => r.session === row.session).map((r) => r.task),
        ).size
        projectHeader(project)
        printTask(row, mine, total, width, detailLimit)
        continue
      }

      if (command === 'round') {
        try {
          const found = findRound(rounds, selector!, session)
          if (values.json) {
            output.push(found)
          } else {
            printRound(found, width)
          }
        } catch (error) {
          if (error instanceof SelectorError) fail(error.message)
          throw error
        }
        continue
      }

      const filter: RoundFilter = {
        session,
        task: taskFilter,
        tool: values.tool,
        command: values.command,
        kind: values.kind,
        agent: values.agent as 'main' | 'sub' | undefined,
        errorsOnly: values.errors,
      }
      const selected = filterRounds(rounds, filter)
      const shown = limit > 0 ? selected.slice(0, limit) : selected
      if (values.json) {
        output.push(matched.length > 1 ? { project: projectName(project), path: project.path, rounds: shown } : shown)
        continue
      }
      projectHeader(project)
      if (selected.length === 0) {
        console.log('  no rounds matched those filters')
        console.log('')
        continue
      }
      printRounds(shown, selected.length, limit, sessions.length > 1)
    }

    if (values.json) {
      console.log(JSON.stringify(output.length === 1 ? output[0] : output, null, 2))
    }
    return
  }

  const { projects: matched, skippedTemp } = await resolveTargets(projects, target, targeting)
  if (matched.length === 0) noMatch(projects, target)

  const results: CollectResult[] = []
  for (const project of matched) {
    results.push(await collectProject(project, dataDir, { full: values.full }))
  }

  if (values.json) {
    console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2))
    return
  }

  if (results.length === 1) {
    printSummary(results[0]!, collectedLine(results[0]!))
    return
  }

  console.log('')
  let rounds = 0
  let added = 0
  for (const result of results) {
    rounds += result.rounds
    added += result.new_rounds
    // The path, not the name, is what identifies a project, since several can share a basename.
    console.log(
      `  ${pad(result.project, 24)}${pad(`${result.rounds} rounds`, 13)}${pad(result.new_rounds > 0 ? `+${result.new_rounds}` : '·', 9)}${result.path ? shorten(result.path) : '(path unknown)'}`,
    )
  }
  console.log('')
  console.log(`  ${results.length} projects · ${rounds} rounds · +${added} new`)
  console.log(`  → ${shorten(dataDir)}/projects`)
  console.log('')
  if (skippedTemp > 0) {
    console.log(
      `  skipped ${skippedTemp} scratch project${skippedTemp === 1 ? '' : 's'} in temp directories. Use --include-temp to collect them`,
    )
  }
  console.log('  `probez <path>` shows one project, including where its rounds.jsonl is.')
  console.log('')
}

main().catch((error: unknown) => {
  console.error(`probez: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
