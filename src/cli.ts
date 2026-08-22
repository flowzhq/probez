#!/usr/bin/env node
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { COMMAND_KINDS } from './bash.js'
import { CATEGORIES, classifyCall, isCategory, isTarget, TARGETS } from './classify.js'
import {
  defaultClaudeDir,
  defaultCursorDir,
  discoverProjects,
  isEphemeral,
  matchByName,
  matchProjects,
  projectName,
} from './discover.js'
import { ago, clip, duration, pad, padStart, shortCommit, shorten, span, tokens, wrap } from './format.js'
import { contextShare } from './models.js'
import {
  analysisRecords,
  categoryTally,
  dominant,
  filterRounds,
  findRound,
  findTask,
  findQuestion,
  findTrail,
  labelRounds,
  looksLikeSelector,
  matchSession,
  SelectorError,
  sessionRows,
  taskRows,
  toolSummary,
  toolTally,
  trailShare,
  workIndex,
} from './inspect.js'
import type {
  Analysis,
  CategoryRow,
  Dominant,
  RoundFilter,
  RoundLabel,
  SessionRow,
  TaskRow,
  ToolRow,
  TrailShare,
} from './inspect.js'
import { ASKS, isAsk, questionsOf } from './question.js'
import type { Question } from './question.js'
import { MIN_DEPTH, trailsOf } from './trail.js'
import type { Trail } from './trail.js'
import { idsToRead } from './trail.js'
import { CONTROL, ImportError, parseExport } from './import.js'
import { openInBrowser } from './open.js'
import { readPricing } from './pricing.js'
import { DEFAULT_PORT, startServer } from './serve.js'
import {
  analysisFile,
  collectProject,
  defaultDataDir,
  findStored,
  importProject,
  listStored,
  readResults,
  readRounds,
  slugFor,
  writeAnalysis,
} from './store.js'
import type { CollectResult, StoredProject, Summary } from './store.js'
import type { Project, Round, ToolCall } from './types.js'
import { exportProject } from './viewdata.js'

const COMMANDS = new Set([
  'collect',
  'export',
  'import',
  'projects',
  'sessions',
  'session',
  'tasks',
  'task',
  'rounds',
  'round',
  'trails',
  'trail',
  'questions',
  'question',
  'tools',
  'analyze',
  'view',
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
  'cursor-dir',
  'source',
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
  export: ['bundle', 'out'],
  import: ['as'],
  projects: [],
  sessions: ['limit'],
  session: ['limit'],
  tasks: ['limit', 'session'],
  task: ['limit', 'session'],
  rounds: ['limit', 'session', 'task', 'tool', 'command', 'kind', 'category', 'target', 'agent', 'errors'],
  round: ['session'],
  trails: ['limit', 'session', 'task', 'deep', 'min-depth', 'outcome'],
  trail: ['session', 'deep'],
  questions: ['limit', 'session', 'task', 'kind', 'min-calls'],
  question: ['session'],
  tools: ['limit', 'kinds'],
  analyze: ['limit', 'session', 'task', 'by', 'split', 'unclassified', 'deep'],
  view: ['port', 'no-open'],
  help: [],
}

/** Where a flag does work, for the error that says it does not work here. */
function acceptedBy(flag: string): string[] {
  return Object.keys(COMMAND_FLAGS).filter((name) => COMMAND_FLAGS[name]!.includes(flag))
}

/** How a walk can end, for the flag that filters on it. Mirrors `Outcome` in `trail.ts`. */
const OUTCOMES = ['edit', 'test', 'abandoned']

/** Rounds listed before `--limit` has to withhold any. */
const DEFAULT_LIMIT = 50
/** Commands listed under a tool before `--limit` has to withhold any. */
const DEFAULT_SUB_LIMIT = 8

const HELP = `probez: see what your coding agents actually did.

What is recorded, and what names it
  project            a directory an agent was started in    its name, or its path
  └ session          one agent run                          504799b8
    └ task           a user turn, and everything it led to  504799b8#3
      └ round        one LLM call                           504799b8#3.12
        └ tool call                                         shown in full by its round

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

  FROM is the commit the checkout was on when the task was asked: where the work started, not
  what it ended up as. It is read from git's HEAD reflog when the project is collected, so it
  is blank for a project outside a checkout and for tasks older than the reflog reaches.

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
  --category <name>            Only rounds that did this kind of work:
                               ${CATEGORIES.slice(0, 4).map((c) => c.id).join(' · ')}
                               ${CATEGORIES.slice(4).map((c) => c.id).join(' · ')}
  --target <name>              Only rounds that worked on this: ${TARGETS.join(' · ')}
  --agent <main|sub>           Only main-agent or only subagent rounds
  --errors                     Only rounds where a tool failed
  --limit <n>                  How many rounds to list (default ${DEFAULT_LIMIT}, 0 for all)

\`--session\` also disambiguates \`probez task\` and \`probez round\` when a prefix is ambiguous.

Trails
  probez trails [project]      Runs of calls that followed one another into the repository
  probez trail <id>            One of them, hop by hop, named by any round it passed through
  --deep                       Read the archived session results, which is the only way to
                               see that a call opened a path an earlier call's output named
  --min-depth <n>              Only walks that went at least this many hops (default ${MIN_DEPTH})
  --outcome <name>             Only walks that ended this way: ${OUTCOMES.join(' · ')}
  --session <id>               Only this session
  --task <n>                   Only this task number
  --limit <n>                  How many walks to list (default ${DEFAULT_LIMIT}, 0 for all)

  An agent that does not know a repository finds its way around it: it lists the tree, opens
  what the listing named, greps for a word, reads the lines the grep hit. \`analyze\` counts all
  of that as Reconstruction and cannot tell nine hops of one search from nine unrelated file
  opens. A trail is that search: DEPTH is how far it went, WIDE how far it fanned from a single
  call, ROOT what it started from and OUTCOME whether it ended in a change to somewhere it had
  been. Every hop names its evidence, and \`probez trail <id>\` prints them.

  Without \`--deep\` a hop is inferred from what the calls asked for — a search for a word, then
  a file carrying that word; a file under a directory already reached. With it, a hop can be
  read out of the earlier call's own output, which is the only way to see that \`find .\` is why
  the next five files were opened. Deep sees more and roots a walk further back, so a walk the
  shallow read names \`1.5\` may be named \`1.0\` with the flag; it is not strictly a superset,
  since a better-sourced hop can regroup a walk and leave a fragment under the three-call floor.
  An imported project carries its rounds and not the logs behind them, so \`--deep\` finds
  nothing there and says so.

Questions
  probez questions [project]   What the agent needed to know, and what finding out cost
  probez question <id>         One of them, call by call, named by any round it was asked at
  --kind <name>                Only questions of this kind:
                               ${ASKS.slice(0, 4).join(' · ')}
                               ${ASKS.slice(4).join(' · ')}
  --min-calls <n>              Only questions that took at least this many calls
  --session <id>               Only this session
  --task <n>                   Only this task number
  --limit <n>                  How many questions to list (default ${DEFAULT_LIMIT}, 0 for all)

  A trail is a walk that went somewhere. A question is one thing the agent needed to know, and
  every call it spent finding out — including the calls that went nowhere. The difference is
  the point: a trail's edges exist only where a call narrowed, so asking the same thing a sixth
  time makes no edge and joins no walk, and a third of all finding in a real store is exactly
  that. Eleven greps for one field name are one question that cost eleven calls.

  CALLS is what it cost. AGAIN is the same words asked of the same places over again. FETCH is
  calls that only turned a line number into a body, the second half of locate-then-fetch. GUESS
  is calls that named three or more different words at once, which is an agent reaching for
  vocabulary it has not learned. KIND is which of six questions it was, by one readable table:
  a seventh — how does A reach B — is left out because no grep expresses it, so no reading of
  one can recover it.

Tools
  probez tools [project]       Every tool called, and what Bash actually ran
  --kinds                      Group Bash by kind of work instead of by command
  --limit <n>                  How many commands to list under each tool
                               (default ${DEFAULT_SUB_LIMIT}, 0 for all)

Analysis
  probez analyze [project]     Where the work went
  --by <level>                 One table per project (default), session or task
  --split <axis>               What the second level counts: sub (default) or target
  --unclassified               List what did not classify, most of it first
  --deep                       Read the archived results, so the trail line counts the walks
                               that inputs alone cannot show. See \`probez trails\`
  --session <id>               Only this session
  --task <n>                   Only this task number
  --limit <n>                  How many sub-rows to list under each category

  Shares are of what the work cost, at the rates under Settings in \`probez view\`. ROUNDS still
  says how much of the work it was; the two disagree, which is the point. Rounds of pure prose
  carry no label and are reported instead of guessed at, and so is every tool with no entry in
  the table and every model with no rate. All three are on the coverage line.

The view
  probez view                  Open the local profiler in your browser: every project,
                               then a session, then a task as a timeline of its rounds
  --port <n>                   Which port to listen on (default ${DEFAULT_PORT})
  --no-open                    Print the URL instead of opening a browser

  From there each project has a ⋮ menu: Sync, which is collect then analyze on that one;
  Rename, which sets a label this CLI answers to and moves nothing; Export, which hands its
  rounds to your browser to save wherever you point it; and Delete, which asks first and then
  removes the project and everything probez recorded for it. The agent's own session files are
  never touched, so a collected project comes back with \`probez collect\`. An import does not.

  It listens on 127.0.0.1 and nothing leaves the machine. The URL carries a token that is new
  on every run, without which the data neither answers nor syncs. Reading writes nothing.

Sharing
  probez export <project>      Write a project out as a file to send someone
  --bundle                     One .json with the manifest and analysis, not bare .jsonl rounds
  --out <file>                 Write there instead of to stdout
  probez import <file>         Read a project someone exported, from .json or .jsonl
  --as <name>                  Store it under this name instead of the one in the file

  An export carries everything the store holds: prompts, commands, file paths. Read one before
  you send it. An import is someone else's work, shown as faithfully as your own — probez cannot
  check what is in it, so open one the way you would any attachment. Nothing is executed.

Collection
  probez collect [project]     Collect one project, or every project under a folder
  probez collect --all         Collect every project on this machine
  --full                       Re-read every session instead of only what changed
  --source claude|cursor|both  Which agents to read (default both)

  Claude Code sessions live under ~/.claude/projects. Cursor transcripts live under
  ~/.cursor/projects/<slug>/agent-transcripts. A repository used by both is one project.

  A store collected by an older probez is rebuilt on the next collect, from the session copies
  it already keeps. Nothing leaves the machine and nothing is lost, but it is not instant.

Options (these work on every command)
  --json                       Machine-readable output
  --all                        Every project on this machine, not just one
  --include-temp               Include scratch directories, which projects and --all skip
  --data-dir <dir>             Where probez stores data (default ~/.probez,
                               or \$PROBEZ_DATA_DIR when that is set)
  --claude-dir <dir>           Where to read Claude Code sessions from
                               (default ~/.claude/projects)
  --cursor-dir <dir>           Where to read Cursor projects from
                               (default ~/.cursor/projects)
  --source claude|cursor|both  Which agents to collect (default both)
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

/** How much of the input was served from cache, which is the part billed at a fraction of the rate. */
/**
 * How full the model's context window was for this round, as a percent.
 *
 * Empty when the model's window is unknown, rather than guessed: the point of the figure is to say
 * how close a session is to being compacted, and a made-up denominator answers the wrong question.
 */
function contextFill(round: Round): string {
  const share = contextShare(round)
  if (share === null) return ''
  // Under a tenth of a percent still reads as `0%`, which is the honest answer at this precision.
  return `  (${Math.round(share * 100)}% of context)`
}

function cacheShare(summary: { in_tokens: number; in_cache_read: number }): string {
  if (summary.in_tokens <= 0) return ''
  return `  (${Math.round((summary.in_cache_read / summary.in_tokens) * 100)}% reused)`
}

function printSummary(summary: Summary, extra?: string): void {
  const title = summary.path ? shorten(summary.path) : summary.project
  console.log('')
  console.log(`probez  ${summary.project}  ${title}`)
  console.log('')
  console.log(
    `  ${pad('sessions', 11)}${pad(String(summary.sessions), 10)}${pad('rounds', 9)}${pad(String(summary.rounds), 9)}tasks  ${summary.tasks}`,
  )
  console.log(`  ${pad('tokens', 11)}${tokens(summary.in_tokens)} in · ${tokens(summary.out_tokens)} out`)
  // The three price differently, and cache reads usually dwarf the rest, so the split says what the
  // total cannot: how much of that input was actually new.
  console.log(
    `  ${pad('', 11)}${tokens(summary.in_uncached)} new · ${tokens(summary.in_cache_write)} cached · ${tokens(summary.in_cache_read)} reused${cacheShare(summary)}`,
  )
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

/**
 * Read a project someone else exported.
 *
 * Reported the way `collect` reports: what came in, and what did not. A file with records probez
 * could not read is a common enough thing — a truncated download, two files concatenated — that
 * the count is worth printing rather than swallowing.
 */
async function runImport(
  dataDir: string,
  file: string,
  as: string | undefined,
  json: boolean,
): Promise<void> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    fail(`cannot read ${file}`)
  }

  let parsed
  try {
    parsed = parseExport(text)
  } catch (error) {
    if (error instanceof ImportError) fail(error.message)
    throw error
  }

  // The sender chose this string. It is a label, never a path, and `importSlug` is what decides
  // where anything lands — but it is also printed, so it loses anything a terminal would obey.
  const chosen = (as ?? parsed.name ?? nameFromFile(file)).replace(CONTROL, '').trim()
  const name = chosen.slice(0, 80) || 'imported'
  // Identity comes from what the sender called it, so re-importing a newer export of the same
  // project replaces it. With nothing to go on, the name is all there is.
  const source = parsed.source ?? name
  const result = await importProject(dataDir, name, source, parsed.rounds, parsed.skipped)

  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log('')
  console.log(`  imported  ${result.project}`)
  console.log('')
  console.log(
    `  ${pad('sessions', 11)}${pad(String(result.sessions), 10)}${pad('rounds', 9)}${pad(String(result.rounds), 9)}tasks  ${result.tasks}`,
  )
  if (result.skipped > 0) {
    console.log(`  ${pad('skipped', 11)}${result.skipped} records that were not rounds`)
  }
  console.log('')
  console.log(
    result.replaced
      ? '  replaced the copy already imported from this project'
      : '  this is somebody else\'s work, kept apart from anything collected here',
  )
  console.log(`  → ${shorten(result.dir)}/rounds.jsonl`)
  console.log(`  probez view ${result.slug}`)
  console.log('')
}

/**
 * Write a project out as a file to send someone.
 *
 * The same two formats the view offers, produced by the same function, so a file made here and a
 * file saved from the browser are the same file. It goes to stdout by default — a share is
 * usually a pipe or a redirect, and `--out` is for when you want it named.
 */
async function runExport(
  dataDir: string,
  target: string | undefined,
  bundle: boolean,
  out: string | undefined,
): Promise<void> {
  if (target === undefined) fail('probez export needs a project: `probez export my-app --out my-app.json`')

  const matched = await storedMatches(dataDir, target)
  if (matched.length === 0) {
    fail(`nothing collected for ${target} in ${shorten(dataDir)}. Run \`probez projects\` to see what is`)
  }
  if (matched.length > 1) {
    const names = matched.map((p) => p.slug).join(', ')
    fail(`${target} matches more than one project — name one of ${names}`)
  }

  const written = await exportProject(dataDir, matched[0]!.slug!, bundle ? 'json' : 'jsonl')
  if (out === undefined) {
    process.stdout.write(written.body)
    return
  }

  const file = resolve(out)
  await writeFile(file, written.body, { mode: 0o600 })
  const size = Buffer.byteLength(written.body)
  console.log('')
  console.log(`  exported  ${matched[0]!.key}  →  ${shorten(file)}`)
  console.log(`  ${(size / 1024).toFixed(0)} KB · they read it with \`probez import ${basename(file)}\``)
  console.log('')
}

/** A name from the file when the file carries none: `flowz-mcp-75ad21ac-rounds.jsonl` is flowz-mcp. */
function nameFromFile(file: string): string {
  return basename(file)
    .replace(/\.(jsonl|json|txt)$/i, '')
    .replace(/-rounds$/i, '')
    .replace(/-[0-9a-f]{8}$/i, '')
}

function collectedLine(result: CollectResult): string {
  // A rebuild rewrites the file rather than adding to it, so "+N rounds" would be a misreading of
  // what happened: none of them are new.
  if (result.rebuilt) {
    return `rebuilt for the current schema, ${result.read_sessions} sessions re-read, ${result.rounds} rounds`
  }
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
  // An import has no path because it was never run here. Saying so beats "(path unknown)", which
  // reads as something probez failed to work out rather than something that is not its own. The
  // path comes first because a project matched through the store is not necessarily an import —
  // one renamed here is matched that way too, and it has a path like any other.
  const where = project.path
    ? shorten(project.path)
    : project.slug !== undefined
      ? '(imported)'
      : '(path unknown)'
  console.log(`  ${name}  ${where}`)
  console.log('')
}

/**
 * Projects that exist only in the store, matched by slug or by name.
 *
 * Exact slug first, since that is what `import` prints and what a URL carries; then the name, so
 * `probez analyze their-project` works without anyone copying a hash around.
 */
async function storedMatches(dataDir: string, target: string | undefined): Promise<Project[]> {
  if (target === undefined) return []
  const stored = await listStored(dataDir)
  const wanted = target.toLowerCase()
  // A directory is how you name a project everywhere else, so it names one here too. Resolved
  // against the shell's cwd, the same way `probez collect .` is.
  const path = resolve(target)
  const bySlug = stored.filter((row) => row.slug === target)
  const byPath = stored.filter((row) => row.path === path)
  const matched =
    bySlug.length > 0
      ? bySlug
      : byPath.length > 0
        ? byPath
        : stored.filter((row) => row.project.toLowerCase() === wanted)
  return matched.map((row) => ({
    key: row.project,
    // What the store calls it, which is the one thing discovery could not have told us.
    name: row.project,
    path: row.path,
    dir: row.source_dir ?? '',
    sessions: [],
    lastActivity: Date.parse(row.last_ts ?? '') || 0,
    slug: row.slug,
    sources: row.sources,
  }))
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

/**
 * What a span of rounds mostly was, as `Recon 48%`.
 *
 * The share travels with the name because the name alone overstates it. Reconstruction winning at
 * 34% over implementation at 31% is a different fact from reconstruction at 80%, and a column that
 * printed only the winner would render both as the same word.
 */
interface Work {
  session(id: string): string
  task(session: string, task: number): string
  round(round: Round): string
}

function render(top: Dominant | null): string {
  return top === null ? '—' : `${top.short} ${(top.share * 100).toFixed(0)}%`
}

function printableWork(rounds: Round[]): Work {
  const index = workIndex(rounds)
  return {
    session: (id) => render(index.session(id)),
    task: (session, task) => render(index.task(session, task)),
    round: (round) => render(index.round(round)),
  }
}

function printSessions(all: ReturnType<typeof sessionRows>, limit: number, work: Work): void {
  // Totals describe the project, not the page, so they are counted before the limit is applied.
  const totals = all.reduce((sum, row) => sum + row.rounds, 0)
  const rows = shown(all, limit)
  console.log(
    `  ${pad('SESSION', 11)}${padStart('ROUNDS', 6)}  ${padStart('TASKS', 5)}  ${pad('TOOLS', 10)}${padStart('IN', 8)}  ${padStart('OUT', 7)}  ${pad('WORK', 11)}LAST`,
  )
  for (const row of rows) {
    const calls = `${row.tool_calls}${row.errors > 0 ? ` ✗${row.errors}` : ''}`
    const last = row.last_ts === null ? '—' : ago(Date.parse(row.last_ts))
    console.log(
      `  ${pad(row.session.slice(0, 8), 11)}${padStart(String(row.rounds), 6)}  ${padStart(String(row.tasks), 5)}  ${pad(calls, 10)}${padStart(tokens(row.in_tokens), 8)}  ${padStart(tokens(Math.round(row.out_tokens)), 7)}  ${pad(work.session(row.session), 11)}${last}`,
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

function printTaskRows(tasks: TaskRow[], width: number, showSession: boolean, work: Work): void {
  // The id column is named after what it identifies. Calling it `#` in a table that also counts
  // rounds reads as "round number", which is the one thing it is not.
  const idWidth = showSession ? 13 : 6
  // FROM is the commit the task was asked against, and it earns its width only where there is one:
  // a project outside a checkout, or one collected before probez recorded commits, gets the table
  // it has always had rather than a column of dashes taking room from what was asked.
  const from = tasks.some((task) => task.commit !== null)
  const fromWidth = from ? 9 : 0
  const asked = Math.max(20, width - idWidth - fromWidth - 45)
  console.log(
    `  ${pad('TASK', idWidth)}${padStart('ROUNDS', 6)}  ${padStart('IN', 7)}  ${padStart('OUT', 6)}  ${padStart('TIME', 7)}  ${pad('WORK', 11)}${from ? pad('FROM', fromWidth) : ''}ASKED`,
  )
  for (const task of tasks) {
    const commit = from ? pad(shortCommit(task.commit) ?? '—', fromWidth) : ''
    console.log(
      `  ${pad(taskId(task, showSession), idWidth)}${padStart(String(task.rounds), 6)}  ${padStart(tokens(task.in_tokens), 7)}  ${padStart(tokens(task.out_tokens), 6)}  ${padStart(duration(task.gen_ms), 7)}  ${pad(work.task(task.session, task.task), 11)}${commit}${clip(task.asked === '' ? '—' : task.asked, asked)}`,
    )
  }
}

/** Every task in the project, which is the work seen in the units it was asked for. */
function printTasks(all: TaskRow[], width: number, showSession: boolean, limit: number, work: Work): void {
  const tasks = shown(all, limit)
  printTaskRows(tasks, width, showSession, work)
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
  work: Work,
): void {
  const tools = toolTally(rounds)
  const errors = tools.reduce((sum, tool) => sum + tool.errors, 0)
  // Where the checkout stood when this was asked for, which is what the work was asked against.
  // Absent for a project that is not a git checkout, and for tasks collected before probez looked.
  const from = shortCommit(row.commit)
  console.log(
    `  task ${row.task} of session ${row.session.slice(0, 8)}  ·  ${rounds.length} rounds · ${tokens(row.in_tokens)} in · ${tokens(row.out_tokens)} out · ${duration(row.gen_ms)} working${from === null ? '' : ` · from ${from}`}`,
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
  printRoundRows(page, true, work)
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
  work: Work,
): void {
  const errors = row.errors > 0 ? ` · ${row.errors} tool error${row.errors === 1 ? '' : 's'}` : ''
  console.log(
    `  session ${row.session.slice(0, 8)}  ·  ${all.length} task${all.length === 1 ? '' : 's'} · ${row.rounds} rounds · ${tokens(row.in_tokens)} in · ${tokens(row.out_tokens)} out${errors} · ${span(row.first_ts, row.last_ts)}`,
  )
  console.log('')
  const tasks = shown(all, limit)
  printTaskRows(tasks, width, showSession, work)
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

function printRoundRows(rounds: Round[], showSession: boolean, work: Work): void {
  const idWidth = showSession ? 16 : 9
  // No TASK column: a round's id carries its task, so a second one would print the same number
  // twice. `probez task 504799b8#3` opens the task any row belongs to.
  console.log(
    `  ${pad('ROUND', idWidth)}${pad('AGENT', 6)}${pad('MODEL', 16)}${padStart('IN', 8)}  ${padStart('OUT', 6)}  ${padStart('TIME', 7)}  ${pad('WORK', 11)}TOOLS`,
  )
  for (const round of rounds) {
    console.log(
      `  ${pad(roundId(round, showSession), idWidth)}${pad(round.agent, 6)}${pad(shortModel(round.model), 16)}${padStart(tokens(round.in_tokens), 8)}  ${padStart(tokens(round.out_tokens), 6)}  ${padStart(duration(round.ms), 7)}  ${pad(work.round(round), 11)}${clip(toolSummary(round), 33)}`,
    )
  }
}

function printRounds(rounds: Round[], total: number, limit: number, showSession: boolean, work: Work): void {
  printRoundRows(rounds, showSession, work)
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

/**
 * What the call did, beyond whether the harness accepted it.
 *
 * `is_error` is the harness flag, so a command that ran and failed shows nothing there. Anything
 * written to stderr, a call cut short, or lines changed on disk are the parts worth saying.
 */
function outcome(tool: ToolCall): string {
  const parts: string[] = []
  if (tool.interrupted === true) parts.push('interrupted')
  if (tool.stderr_chars !== null && tool.stderr_chars > 0) parts.push(`${tokens(tool.stderr_chars)} stderr`)
  if (tool.patch !== null) parts.push(`+${tool.patch.added} −${tool.patch.removed}`)
  return parts.length === 0 ? '' : ` · ${parts.join(' · ')}`
}

/** How a trail is named on screen, and typed back: `504799b8#1.7`, or `1.7` in a lone session. */
function trailId(trail: Trail, showSession: boolean): string {
  return showSession ? `${trail.session.slice(0, 8)}#${trail.ref}` : trail.ref
}

/** The walk drawn as what it is: where it started, and what each hop had to go on. */
function printTrail(trail: Trail, width: number, showSession: boolean): void {
  console.log('')
  console.log(
    `  trail ${trailId(trail, showSession)} → ${trail.last} · ${trail.steps.length} steps · ${trail.confidence}`,
  )
  console.log(
    `  depth ${trail.depth} · breadth ${trail.breadth} · ${trail.paths} paths${trail.revisits > 0 ? ` · ${trail.revisits} revisited` : ''}`,
  )
  console.log(
    `  from a ${trail.root} · ${trail.outcome}${trail.ended_on === '' ? '' : ` ${shorten(trail.ended_on)}`} · ${tokens(trail.in_tokens)} in · ${tokens(trail.out_tokens)} out · ${duration(trail.ms)}`,
  )
  console.log('')

  // Where in the walk each step sits, so a fan-out reads as a fan-out rather than as a list.
  const depths = new Map<number, number>()
  for (const step of trail.steps) {
    depths.set(step.at, step.source === null ? 0 : (depths.get(step.source) ?? 0) + 1)
  }
  // The indent sits inside the STEP column rather than widening it, or every column after it
  // steps right with the walk and the table stops being one.
  const STEP = 20
  const room = Math.max(24, width - 54)
  console.log(`  ${pad('ROUND', 8)}${pad('STEP', STEP)}${pad('REACHED', 8)}${pad('FOLLOWED', 24)}WHERE`)
  for (const step of trail.steps) {
    const indent = '  '.repeat(Math.min(depths.get(step.at) ?? 0, 5))
    // `clip` trims, which is right for prose and would eat the indent that is the whole point here.
    const label = `${indent}${step.name}`
    const came = step.source === null ? 'started here' : `${step.edge} ${clip(shorten(step.via), 14)}`
    console.log(
      `  ${pad(step.ref, 8)}${pad(label.length < STEP ? label : `${label.slice(0, STEP - 2)}…`, STEP)}${pad(step.scope, 8)}${pad(came, 24)}${clip(step.sites.map(shorten).join(' ') || '—', room)}`,
    )
  }
  console.log('')
  console.log(`  \`probez round ${trail.ref}\` shows any one of these calls in full.`)
  console.log('')
}

/** How a question is named on screen, and typed back: `59921bd4#2.250`, or `2.250` alone. */
function questionId(question: Question, showSession: boolean): string {
  return showSession ? `${question.session.slice(0, 8)}#${question.ref}` : question.ref
}

/** The question drawn as what it cost: every call it took, and what each one asked. */
function printQuestion(question: Question, width: number, showSession: boolean): void {
  const calls = question.calls.length
  console.log('')
  console.log(
    `  question ${questionId(question, showSession)} → ${question.last} · ${calls} call${calls === 1 ? '' : 's'} · ${question.kind}`,
  )
  console.log(
    `  asked about ${question.terms.length === 0 ? 'nothing by name' : question.terms.join(', ')}`,
  )
  const waste = [
    question.repeats > 0 ? `${question.repeats} re-asked` : '',
    question.fetches > 0 ? `${question.fetches} fetched a body` : '',
    question.sweeps > 0 ? `${question.sweeps} guessed at words` : '',
  ].filter((part) => part !== '')
  // A search pointed at the checkout names no path at all, and "0 places" reads as a failure
  // rather than as the tree-wide sweep it was.
  const where =
    question.files.length === 0
      ? 'no place named'
      : `${question.files.length} place${question.files.length === 1 ? '' : 's'}`
  console.log(
    `  ${where}${waste.length === 0 ? '' : ` · ${waste.join(' · ')}`} · ${tokens(question.in_tokens)} in · ${tokens(question.out_tokens)} out · ${duration(question.ms)}`,
  )
  console.log('')

  const CALL = 20
  const room = Math.max(24, width - 56)
  console.log(`  ${pad('ROUND', 8)}${pad('CALL', CALL)}${pad('REACHED', 8)}${pad('ASKED', 26)}WHERE`)
  const seen = new Set<string>()
  for (const call of question.calls) {
    const signature = `${[...call.probes].sort().join(' ')}\0${[...call.sites].sort().join(' ')}`
    // A repeat is marked where it happens rather than only counted in the header, because the run
    // of them is the finding — a number says four, a column shows which four and how far apart.
    const again = seen.has(signature) ? ' ↺' : ''
    seen.add(signature)
    const asked = call.probes.length === 0 ? '—' : call.probes.join(' ')
    console.log(
      `  ${pad(call.ref, 8)}${pad(clip(call.name, CALL - 1), CALL)}${pad(call.scope, 8)}${pad(clip(asked, 24) + again, 26)}${clip(call.sites.map(shorten).join(' ') || '—', room)}`,
    )
  }
  console.log('')
  console.log(`  \`probez round ${question.ref}\` shows any one of these calls in full.`)
  console.log('')
}

/**
 * The listing, and under it what questions cost across the whole scope.
 *
 * `all` is what was asked for and `every` is what was there, because an average over the rows a
 * flag left standing is not a fact about the project. `--min-calls 2` would otherwise report that
 * this project spends 2.67 calls per question when most of its questions take one.
 */
function printQuestions(
  all: Question[],
  every: Question[],
  limit: number,
  showSession: boolean,
): void {
  // Costliest first. A listing sorted by when a question was asked buries the one that matters
  // under three hundred single-call reads, and what this table is for is the tail.
  const sorted = [...all].sort(
    (a, b) => b.calls.length - a.calls.length || a.session.localeCompare(b.session) || a.task - b.task,
  )
  const rows = shown(sorted, limit)
  console.log(
    `  ${pad('QUESTION', showSession ? 16 : 10)}${padStart('CALLS', 5)}  ${padStart('AGAIN', 5)}  ${padStart('FETCH', 5)}  ${padStart('GUESS', 5)}  ${pad('KIND', 9)}${padStart('IN', 7)}  ${padStart('TIME', 6)}  ASKED ABOUT`,
  )
  for (const question of rows) {
    console.log(
      `  ${pad(questionId(question, showSession), showSession ? 16 : 10)}${padStart(String(question.calls.length), 5)}  ${padStart(String(question.repeats), 5)}  ${padStart(String(question.fetches), 5)}  ${padStart(String(question.sweeps), 5)}  ${pad(question.kind, 9)}${padStart(tokens(question.in_tokens), 7)}  ${padStart(duration(question.ms), 6)}  ${clip(question.terms.join(' ') || '—', 30)}`,
    )
  }
  console.log('')
  const calls = every.reduce((sum, question) => sum + question.calls.length, 0)
  const reasked = every.filter((question) => question.calls.length > 1).length
  console.log(`  ${counted(rows.length, all.length, 'question')}${more(rows.length, all.length)}`)
  console.log(
    `  ${every.length} asked in all · ${calls} calls · ${(calls / every.length).toFixed(2)} per question · ${reasked} took more than one`,
  )
  console.log('  AGAIN is the same words asked of the same places over again.')
  console.log('  `probez question <id>` shows every call one of them took.')
  console.log('')
}

function printTrails(all: Trail[], limit: number, showSession: boolean, deep: boolean): void {
  const rows = shown(all, limit)
  console.log(
    `  ${pad('TRAIL', showSession ? 14 : 8)}${padStart('STEPS', 6)}  ${padStart('DEPTH', 5)}  ${padStart('WIDE', 4)}  ${padStart('PATHS', 5)}  ${pad('ROOT', 9)}${pad('OUTCOME', 10)}${padStart('IN', 7)}  ${padStart('TIME', 6)}`,
  )
  for (const trail of rows) {
    console.log(
      `  ${pad(trailId(trail, showSession), showSession ? 14 : 8)}${padStart(String(trail.steps.length), 6)}  ${padStart(String(trail.depth), 5)}  ${padStart(String(trail.breadth), 4)}  ${padStart(String(trail.paths), 5)}  ${pad(trail.root, 9)}${pad(trail.outcome, 10)}${padStart(tokens(trail.in_tokens), 7)}  ${padStart(duration(trail.ms), 6)}`,
    )
  }
  console.log('')
  const proven = all.filter((trail) => trail.confidence === 'proven').length
  console.log(
    `  ${counted(rows.length, all.length, 'trail')}${more(rows.length, all.length)} · ${proven} proven from result bodies`,
  )
  if (!deep) {
    // Worth saying every time rather than once in the help: the difference between the two answers
    // is large, and a reader looking at the shallow one has no way to tell what it could not see.
    console.log('  `--deep` reads the archived sessions and finds the walks inputs alone cannot show.')
  }
  console.log('  `probez trail <id>` draws one of them, hop by hop.')
  console.log('')
}

/**
 * The compaction this round followed, when it followed one.
 *
 * Printed above the round rather than as a field on it, because that is where it happened: every
 * number below this line is measured against a context the one before it never saw.
 */
function printCompaction(round: Round): void {
  // Not `=== null`: the store is read back as a raw cast, so a round written by an earlier probez
  // has no such field at all. A schema addition must not make an existing store unreadable.
  const c = round.compaction
  if (c === null || c === undefined) return
  const sizes =
    c.pre_tokens === null || c.post_tokens === null
      ? ''
      : ` · ${tokens(c.pre_tokens)} → ${tokens(c.post_tokens)}`
  const took = c.ms === null ? '' : ` · took ${duration(c.ms)}`
  console.log(`  ── compacted${c.trigger === null ? '' : ` (${c.trigger})`}${sizes}${took} ──`)
  console.log('')
}

function printRound(round: Round, width: number): void {
  console.log('')
  printCompaction(round)
  console.log(
    `  round ${roundId(round, true)} · ${round.agent} · ${shortModel(round.model)}`,
  )
  console.log(
    `  ${tokens(round.in_tokens)} in · ${tokens(round.out_tokens)} out · ${duration(round.ms)} · ${round.thinking_chars} thinking chars${contextFill(round)}`,
  )
  console.log(
    `  ${tokens(round.in_uncached)} new · ${tokens(round.in_cache_write)} cached · ${tokens(round.in_cache_read)} reused`,
  )
  // `ms` spans the round's own records; `gen_ms` also covers the wait before the model said
  // anything, which is most of what the round actually took.
  const waited = round.wait_ms === null ? '' : ` · waited ${duration(round.wait_ms)}`
  console.log(`  generated in ${duration(round.gen_ms)}${waited}`)
  const attributed = [round.mcp_server && `mcp ${round.mcp_server}`, round.skill && `skill ${round.skill}`]
    .filter((part): part is string => typeof part === 'string')
    .join(' · ')
  if (attributed !== '') console.log(`  ${attributed}`)
  const from = shortCommit(round.commit)
  console.log(
    `  session ${round.session}${round.ts ? ` · ${round.ts}` : ''}${from === null ? '' : ` · from ${from}`}`,
  )

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
    const work = classifyCall(tool)
      .map((label) => `${label.category}/${label.sub}${label.target === 'unknown' ? '' : ` × ${label.target}`}`)
      .join(' · ')
    console.log(
      `    ${padStart(String(index + 1), 2)}  ${tool.is_error === true ? '✗' : ' '} ${pad(tool.name ?? '?', 14)}${padStart(duration(tool.ms), 7)}  ${chars}${outcome(tool)}`,
    )
    console.log(`       ${clip(work, width - 8)}`)
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

function percent(part: number, whole: number): string {
  if (whole === 0) return '—'
  return `${((part / whole) * 100).toFixed(1)}%`
}

/** Fractional rounds, since a round splits across the work it did. */
function amount(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1)
}

/**
 * A share is a share of money, not of rounds.
 *
 * The two disagree, and the disagreement is the point: a round of reconstruction reading a large
 * file and a round of implementation writing one line are one round each, and nothing like one
 * dollar each. `ROUNDS` still says how much of the work it was.
 */
function categoryLine(name: string, indent: number, row: CategoryRow, whole: number): string {
  const width = 22 - indent
  return `${' '.repeat(indent)}${pad(clip(name, width - 1), width)}${padStart(amount(row.rounds), 8)}  ${padStart(percent(row.cost, whole), 7)}  ${padStart(money(row.cost), 8)}  ${padStart(row.errors >= 0.5 ? amount(row.errors) : '·', 6)}  ${padStart(duration(row.ms), 8)}  ${padStart(tokens(Math.round(row.out_tokens)), 7)}`
}

/**
 * Dollars, at a precision that survives being small.
 *
 * A category can cost fractions of a cent on a short task and hundreds of dollars on a long one, so
 * the number of decimals moves with the size rather than rounding the small ones away to `$0.00`.
 */
export function money(value: number): string {
  if (value === 0) return '·'
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1000) return `$${value.toFixed(2)}`
  return `$${Math.round(value).toLocaleString('en-US')}`
}

/**
 * The distribution, with each category's second level indented under it.
 *
 * The coverage line is not a footnote. A share here is a share of what the rounds that called a
 * tool cost, and three things sit outside that: rounds of pure prose, calls no table can name, and
 * models with no rate. Printing the percentages without them would invite the reader to assume they
 * are not there.
 */
function printAnalysis(
  analysis: Analysis,
  subLimit: number,
  axis: string,
  walks: TrailShare | null,
): void {
  const { coverage } = analysis
  const whole = coverage.cost
  console.log(
    `  ${pad('WORK', 20)}${padStart('ROUNDS', 8)}  ${padStart('SHARE', 7)}  ${padStart('COST', 8)}  ${padStart('ERRORS', 6)}  ${padStart('TIME', 8)}  ${padStart('OUT', 7)}`,
  )
  for (const row of analysis.rows) {
    console.log(categoryLine(row.label, 2, row, whole))
    const sub = row.sub ?? []
    const shown = subLimit > 0 ? sub.slice(0, subLimit) : sub
    for (const entry of shown) console.log(categoryLine(entry.name, 4, entry, whole))
    if (shown.length < sub.length) {
      console.log(`      … ${sub.length - shown.length} more, --limit 0 for all`)
    }
  }
  console.log('')
  // With nothing priced there is no denominator, and "shares are of the · they cost" would be a
  // sentence about a symbol. The line says what is actually true instead.
  const of =
    coverage.cost > 0
      ? `Shares are of the ${money(coverage.cost)} they cost`
      : 'None of them has a priced model, so there is no cost to divide'
  console.log(
    `  ${coverage.classified} round${coverage.classified === 1 ? '' : 's'} did something a tool can see, out of ${coverage.rounds}. ${of}`,
  )
  const holes: string[] = []
  if (coverage.toolless > 0) {
    holes.push(
      `${coverage.toolless} round${coverage.toolless === 1 ? '' : 's'} of prose only (${percent(coverage.toolless, coverage.rounds)})`,
    )
  }
  if (coverage.unclassified > 0) {
    holes.push(`${percent(coverage.unclassified, coverage.weight)} unclassified`)
  }
  holes.push(`${percent(coverage.targeted, coverage.weight)} of work has a known target`)
  console.log(`  ${holes.join(' · ')}`)
  // A model with no rate costs nothing here and something in reality, so it is named rather than
  // left to sink the shares by an amount the reader cannot see.
  if (coverage.unpriced > 0) {
    const models = analysis.unpriced.slice(0, 3).map((row) => row.model).join(', ')
    console.log(
      `  ${coverage.unpriced} round${coverage.unpriced === 1 ? '' : 's'} are outside that: no rate for ${models}. Set one in \`probez view\` → Settings`,
    )
  }
  if (axis === 'sub' && analysis.unknown.length > 0) {
    const top = analysis.unknown.slice(0, 3).map((row) => row.name).join(', ')
    console.log(`  Unclassified is mostly ${top}. --unclassified lists it`)
  }
  // Reconstruction says how much of the work was finding things out. This says how much of that
  // finding was *directed* — a search that led somewhere — as against calls that stand alone. A
  // low share is not a fault; it is what an agent working in a repository it knows looks like.
  if (walks !== null && walks.finding > 0) {
    const deepest = walks.deepest
    const led = walks.trails === 0 ? '' : `, ${walks.landed} of which ended in a change`
    console.log(
      `  ${percent(walks.steps, walks.finding)} of the finding was inside ${walks.trails} trail${walks.trails === 1 ? '' : 's'}${led}`,
    )
    if (deepest !== null) {
      console.log(
        `  The deepest went ${deepest.depth} hops from a ${deepest.root}: \`probez trail ${deepest.session.slice(0, 8)}#${deepest.ref}\``,
      )
    }
  }
  console.log('')
}

/** What did not classify, so the hole has names in it rather than only a size. */
function printUnclassified(analysis: Analysis, limit: number): void {
  const rows = limit > 0 ? analysis.unknown.slice(0, limit) : analysis.unknown
  if (rows.length === 0) {
    console.log('  Everything classified.')
    console.log('')
    return
  }
  console.log(`  ${pad('WHAT RAN', 44)}${padStart('ROUNDS', 8)}  ${padStart('SHARE', 7)}`)
  for (const row of rows) {
    console.log(
      `  ${pad(clip(row.name, 43), 44)}${padStart(amount(row.weight), 8)}  ${padStart(percent(row.weight, analysis.coverage.weight), 7)}`,
    )
  }
  if (rows.length < analysis.unknown.length) {
    console.log(`  … ${analysis.unknown.length - rows.length} more, --limit 0 for all`)
  }
  console.log('')
  console.log('  A tool with no entry in the table is named rather than guessed at.')
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

/**
 * A project named on the command line, matched against the store rather than against the agent's
 * directory. By the name the tables print, or by any path that contains it.
 */
function matchStored(stored: StoredProject[], target: string): StoredProject[] {
  const wanted = target.toLowerCase()
  const byName = stored.filter((project) => project.project.toLowerCase() === wanted)
  if (byName.length > 0) return byName
  const path = resolve(target)
  return stored.filter(
    (project) =>
      project.path !== null && (project.path === path || project.path.startsWith(`${path}/`)),
  )
}

/**
 * Serve the local profiler until interrupted.
 *
 * The URL carries a token because the store is unredacted: prompts, file paths and shell commands,
 * exactly as they were typed. A port on this machine is a small door, but it is a door, and the
 * page that opens it should be the one you asked for.
 */
async function runView(
  dataDir: string,
  claudeDir: string,
  cursorDir: string,
  target: string | undefined,
  options: { port?: string; open: boolean; json: boolean },
): Promise<void> {
  const port = options.port === undefined ? undefined : asCount(options.port, 'port')
  if (port !== undefined && port > 65535) fail(`--port takes a number under 65536, got ${port}`)

  const stored = await listStored(dataDir)
  // An empty store is no longer a dead end: importing a file someone sent is done from this page,
  // and refusing to open it would mean the one way in required a store to already exist.
  if (stored.length === 0 && target !== undefined) {
    console.error(
      `probez: nothing collected yet in ${shorten(dataDir)}. Run \`probez collect\` first`,
    )
    process.exit(1)
  }

  let at = ''
  if (target !== undefined) {
    const matched = matchStored(stored, target)
    if (matched.length === 0) {
      const names = stored
        .slice(0, 6)
        .map((project) => project.project)
        .join(', ')
      fail(`nothing collected for "${target}". This store has: ${names}`)
    }
    // A path holding several projects names all of them, and the list is where you choose.
    if (matched.length === 1) at = `p/${matched[0]!.slug}`
  }

  const serving = await startServer({
    dataDir,
    claudeDir,
    cursorDir,
    port,
    pinned: options.port !== undefined,
  })
  const url = `http://127.0.0.1:${serving.port}/${at}?t=${serving.token}`

  if (options.json) {
    console.log(JSON.stringify({ url, port: serving.port, token: serving.token }, null, 2))
  } else {
    const count = stored.length
    console.log('')
    console.log(`  probez view  ${url}`)
    console.log(`  serving ${count} project${count === 1 ? '' : 's'} from ${shorten(dataDir)}`)
    console.log('  ctrl-c to stop')
    console.log('')
  }

  if (options.open && !openInBrowser(url)) {
    console.log('  could not open a browser. Open the URL above yourself.')
  }

  await new Promise<void>((done) => {
    process.on('SIGINT', () => {
      void serving.close().then(() => done())
    })
  })
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
        'cursor-dir': { type: 'string' },
        source: { type: 'string' },
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
        category: { type: 'string' },
        target: { type: 'string' },
        by: { type: 'string' },
        split: { type: 'string' },
        unclassified: { type: 'boolean', default: false },
        deep: { type: 'boolean', default: false },
        'min-depth': { type: 'string' },
        'min-calls': { type: 'string' },
        outcome: { type: 'string' },
        agent: { type: 'string' },
        errors: { type: 'boolean', default: false },
        limit: { type: 'string' },
        port: { type: 'string' },
        as: { type: 'string' },
        bundle: { type: 'boolean', default: false },
        out: { type: 'string' },
        'no-open': { type: 'boolean', default: false },
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
  if (
    command === 'session' ||
    command === 'task' ||
    command === 'round' ||
    command === 'trail' ||
    command === 'question'
  ) {
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
  const cursorDir = values['cursor-dir'] ? resolve(values['cursor-dir']) : defaultCursorDir()
  if (
    values.source !== undefined &&
    values.source !== 'claude' &&
    values.source !== 'cursor' &&
    values.source !== 'both'
  ) {
    fail(`--source takes claude, cursor or both, got "${values.source}"`)
  }
  const source = (values.source ?? 'both') as 'claude' | 'cursor' | 'both'

  // Import reads a file and writes the store, and never looks at the agent's directory at all.
  if (command === 'import') {
    if (target === undefined) fail('probez import needs a file: `probez import their-project.json`')
    await runImport(dataDir, target, values.as, values.json === true)
    return
  }

  // Export reads the store and writes a file of its own; the agent's directory has no part in it.
  if (command === 'export') {
    await runExport(dataDir, target, values.bundle === true, values.out)
    return
  }

  // `view` reads the store, so it runs before the agent's directory is required to exist. What has
  // been collected stays browsable whether or not the sessions it came from still do; the agent's
  // directory is consulted only when you press Sync, and only then can it be missing.
  if (command === 'view') {
    await runView(dataDir, claudeDir, cursorDir, target, {
      port: values.port,
      open: values['no-open'] !== true,
      json: values.json,
    })
    return
  }

  const projects = await discoverProjects({ claudeDir, cursorDir, source })

  // An empty agent directory is only a dead end if the store is empty too. Someone who was sent an
  // export and has never run an agent has nothing to discover and a project to read all the same.
  if (projects.length === 0 && (await listStored(dataDir)).length === 0) {
    const where =
      source === 'cursor'
        ? shorten(cursorDir)
        : source === 'claude'
          ? shorten(claudeDir)
          : `${shorten(claudeDir)} or ${shorten(cursorDir)}`
    console.error(`probez: no agent sessions found in ${where}`)
    process.exit(1)
  }

  if (command === 'projects') {
    // Scratch projects are mostly noise in a listing for the same reason --all skips them.
    const own = values['include-temp'] ? projects : projects.filter((p) => !isEphemeral(p))
    const stored = await listStored(dataDir)
    // A name someone chose in `probez view` is the project's name everywhere, or the two lists
    // disagree about what the same project is called. Only the store knows it, since discovery
    // reads the agent's directory and has never heard of it.
    const chosen = new Map(stored.filter((row) => row.renamed).map((row) => [row.slug, row.project]))
    // Imports are in the store and nowhere else, so a listing built only from the agent's
    // directory would leave out projects this machine can plainly read.
    const imported = stored
      .filter((row) => row.imported_at !== null)
      .map((row) => ({
        key: row.project,
        path: null,
        dir: '',
        sessions: [],
        // The last round in it, the same thing this column means on every other row and the same
        // thing `probez view` prints. When it arrived is a different fact, and the project page is
        // where that one is stated.
        lastActivity: Date.parse(row.last_ts ?? row.imported_at ?? '') || 0,
        slug: row.slug,
        sources: row.sources,
      }))
    const listed = [...own, ...imported]
    const named = (project: Project): string =>
      chosen.get(slugFor(project)) ?? (project.path ? project.path.split('/').pop()! : project.key)
    const skippedTemp = projects.length - own.length
    if (values.json) {
      console.log(
        JSON.stringify(
          listed.map((p) => ({
            // `key` is the agent's own directory name and stays that; `name` is what the tables
            // print, which is a chosen name where there is one.
            name: named(p),
            key: p.key,
            path: p.path,
            slug: p.slug,
            imported: p.slug !== undefined,
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
      const name = named(project)
      const count = project.sessions.length
      const where =
        project.slug !== undefined
          ? `(imported)  ${project.slug}`
          : project.path
            ? shorten(project.path)
            : '(path unknown)'
      const sessions = project.slug === undefined ? `${count} session${count === 1 ? '' : 's'}` : ''
      console.log(
        `  ${pad(name, 28)}${pad(sessions, 14)}${pad(ago(project.lastActivity), 13)}${where}`,
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

  const READ_COMMANDS = ['sessions', 'session', 'tasks', 'task', 'rounds', 'round', 'trails', 'trail', 'questions', 'question', 'tools', 'analyze']
  if (READ_COMMANDS.includes(command)) {
    const { projects: found } = await resolveTargets(projects, target, targeting)
    // An imported project is in the store and nowhere else: the agent never ran it here, so
    // discovery cannot see it. Matching a name against the store as well is what makes one
    // readable — and if you have imported someone's copy of a project you also work in, both
    // answer to the name, which is the truth. A detail view then asks you to say which.
    const collected: Project[] = []
    for (const project of found) {
      if ((await findStored(dataDir, slugFor(project))) !== null) collected.push(project)
    }
    const stored = await storedMatches(dataDir, target)
    const extra = stored.filter((row) => !collected.some((p) => slugFor(p) === row.slug))
    const matched = collected.length + extra.length > 0 ? [...collected, ...extra] : found
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
    // `--kind` names a command kind under `rounds` and a question kind under `questions`. Two
    // commands take the flag and mean different vocabularies by it, so each is checked against its
    // own list — a shared check would refuse every legal value of whichever list it did not hold.
    if (command !== 'questions' && values.kind !== undefined && !COMMAND_KINDS.includes(values.kind as never)) {
      fail(`--kind takes one of ${COMMAND_KINDS.join(', ')}, got "${values.kind}"`)
    }
    if (values.category !== undefined && !isCategory(values.category.toLowerCase())) {
      fail(
        `--category takes one of ${CATEGORIES.map((c) => c.id).join(', ')}, got "${values.category}"`,
      )
    }
    if (values.target !== undefined && !isTarget(values.target.toLowerCase())) {
      fail(`--target takes one of ${TARGETS.join(', ')}, got "${values.target}"`)
    }
    const BY = ['project', 'session', 'task']
    if (values.by !== undefined && !BY.includes(values.by)) {
      fail(`--by takes one of ${BY.join(', ')}, got "${values.by}"`)
    }
    if (values.split !== undefined && values.split !== 'sub' && values.split !== 'target') {
      fail(`--split takes sub or target, got "${values.split}"`)
    }
    if (values.outcome !== undefined && !OUTCOMES.includes(values.outcome)) {
      fail(`--outcome takes one of ${OUTCOMES.join(', ')}, got "${values.outcome}"`)
    }
    if (command === 'questions' && values.kind !== undefined && !isAsk(values.kind)) {
      fail(`--kind takes one of ${ASKS.join(', ')}, got "${values.kind}"`)
    }

    // Naming one thing inside a project only means something once the project is settled.
    const DETAIL = ['session', 'task', 'round', 'trail', 'question']
    if (DETAIL.includes(command) && matched.length > 1) {
      fail(
        `"${target ?? process.cwd()}" matches ${matched.length} projects. Name one to look inside it`,
      )
    }
    if (command === 'trail' && selector === undefined) {
      fail('trail needs a round id from the walk, as `probez trail 1.7`. `probez trails` lists them')
    }
    if (command === 'question' && selector === undefined) {
      fail(
        'question needs a round id it was asked at, as `probez question 2.250`. ' +
          '`probez questions` lists them',
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
      // Labels are worked out over the whole project once and looked up by every table, rather
      // than recomputed per page.
      const work = printableWork(rounds)
      // Rates are read once per project rather than per table, so every share on the page is a
      // share of the same money.
      const pricing = await readPricing(dataDir)

      if (command === 'sessions') {
        const rows = sessionRows(rounds, pricing)
        if (values.json) {
          output.push(matched.length > 1 ? { project: projectName(project), path: project.path, sessions: rows } : rows)
          continue
        }
        projectHeader(project)
        printSessions(rows, limit, work)
        continue
      }

      if (command === 'analyze') {
        const axis = values.split === 'target' ? 'target' : 'sub'
        // Every share is recomputed from the rounds on the spot, so nothing printed can be stale.
        // The file written below is a cache for the next stage, never the source of these numbers.
        const scope = values.session === undefined && values.task === undefined
          ? rounds
          : filterRounds(rounds, {
              session: values.session === undefined ? undefined : matchSession([...new Set(rounds.map((r) => r.session))], values.session),
              task: asCount(values.task, 'task'),
            })

        const groups: { name: string; rounds: Round[] }[] =
          values.by === 'session'
            ? [...new Set(scope.map((r) => r.session))].map((id) => ({
                name: id.slice(0, 8),
                rounds: scope.filter((r) => r.session === id),
              }))
            : values.by === 'task'
              ? [...new Set(scope.map((r) => `${r.session}#${r.task}`))].map((id) => ({
                  name: `${id.slice(0, 8)}#${id.split('#')[1]}`,
                  rounds: scope.filter((r) => `${r.session}#${r.task}` === id),
                }))
              : [{ name: projectName(project), rounds: scope }]

        const analyses = groups.map((group) => ({
          name: group.name,
          analysis: categoryTally(group.rounds, pricing, axis),
        }))

        // Trails are per group for the same reason the table is: a share of finding inside a
        // session says something a share across the project averages away. The deep read is one
        // pass over the archived sessions, done once for every group rather than per group.
        const walkResults = values.deep
          ? await readResults(project, dataDir, idsToRead(scope))
          : undefined
        const walks = new Map<string, TrailShare>(
          groups.map((group) => [
            group.name,
            trailShare(group.rounds, { results: walkResults, root: project.path ?? '' }),
          ]),
        )

        // The cache always describes the whole project, whatever slice was asked to be printed.
        const whole = values.by === undefined && scope === rounds ? analyses[0]!.analysis : categoryTally(rounds, pricing, axis)
        await writeAnalysis(
          analysisFile(dataDir, project),
          { rounds: rounds.length, toolless: whole.coverage.toolless },
          analysisRecords(rounds),
        )

        if (values.json) {
          const shaped = analyses.map((entry) => ({
            name: entry.name,
            categories: entry.analysis.rows,
            coverage: entry.analysis.coverage,
            unclassified: entry.analysis.unknown,
          }))
          output.push(
            matched.length > 1
              ? { project: projectName(project), path: project.path, analysis: shaped }
              : shaped,
          )
          continue
        }

        projectHeader(project)
        for (const entry of analyses) {
          if (groups.length > 1) console.log(`  ${entry.name}`)
          if (values.unclassified) printUnclassified(entry.analysis, limit)
          else printAnalysis(entry.analysis, subLimit, axis, walks.get(entry.name) ?? null)
        }
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
        const rows = taskRows(mine, pricing)
        if (values.json) {
          output.push(matched.length > 1 ? { project: projectName(project), path: project.path, tasks: rows } : rows)
          continue
        }
        projectHeader(project)
        printTasks(rows, width, sessions.length > 1, limit, work)
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
        const row = sessionRows(mine, pricing)[0]!
        const tasks = taskRows(mine, pricing)
        if (values.json) {
          // The session's own row, except that `tasks` carries the tasks rather than counting
          // them: the count is the length, and a second key for it would be the same fact twice.
          output.push({ ...row, tasks })
          continue
        }
        projectHeader(project)
        printSession(row, tasks, width, sessions.length > 1, detailLimit, work)
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
        const row = taskRows(mine, pricing)[0]!
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
        printTask(row, mine, total, width, detailLimit, work)
        continue
      }

      if (command === 'questions' || command === 'question') {
        const scope = session === undefined ? rounds : rounds.filter((r) => r.session === session)
        const withTask = taskFilter === undefined
          ? scope
          : scope.filter((r) => r.task === taskFilter)
        const minCalls = asCount(values['min-calls'], 'min-calls') ?? 1
        const all = questionsOf(withTask, { root: project.path ?? '' })
        // Filtered here rather than inside `questionsOf`, so that what a question cost on average
        // stays a fact about the project and not about the rows that survived a flag.
        const wanted = all.filter(
          (question) =>
            question.calls.length >= minCalls &&
            (values.kind === undefined || question.kind === values.kind),
        )

        if (command === 'question') {
          try {
            const found = findQuestion(rounds, all, selector!, session)
            if (values.json) output.push(found)
            else printQuestion(found, width, sessions.length > 1)
          } catch (error) {
            if (!(error instanceof SelectorError)) throw error
            fail(error.message)
          }
          continue
        }

        if (values.json) {
          output.push(
            matched.length > 1
              ? { project: projectName(project), path: project.path, questions: wanted }
              : wanted,
          )
          continue
        }
        projectHeader(project)
        if (wanted.length === 0) {
          console.log('')
          console.log(
            all.length > 0
              ? '  no questions matched those filters'
              : '  no questions here: nothing in this project went looking for anything',
          )
          console.log('')
          continue
        }
        printQuestions(wanted, all, limit, sessions.length > 1)
        continue
      }

      if (command === 'trails' || command === 'trail') {
        // Result bodies live in the archived session copies rather than in `rounds.jsonl`, so the
        // deep read is one pass over those files and happens only when it is asked for.
        const results = values.deep ? await readResults(project, dataDir, idsToRead(rounds)) : undefined
        const scope = session === undefined ? rounds : rounds.filter((r) => r.session === session)
        const withTask = taskFilter === undefined
          ? scope
          : scope.filter((r) => r.task === taskFilter)
        const minDepth = asCount(values['min-depth'], 'min-depth')
        const all = trailsOf(withTask, { results, minDepth, root: project.path ?? '' })
        const wanted = values.outcome === undefined
          ? all
          : all.filter((trail) => trail.outcome === values.outcome)

        if (command === 'trail') {
          try {
            const found = findTrail(rounds, all, selector!, session)
            if (values.json) output.push(found)
            else printTrail(found, width, sessions.length > 1)
          } catch (error) {
            if (error instanceof SelectorError) fail(error.message)
            throw error
          }
          continue
        }

        if (values.json) {
          output.push(matched.length > 1 ? { project: projectName(project), path: project.path, trails: wanted } : wanted)
          continue
        }
        projectHeader(project)
        if (wanted.length === 0) {
          const narrowed = values['min-depth'] !== undefined || values.outcome !== undefined
          console.log(
            narrowed
              ? '  no trails matched those filters'
              : values.deep
                ? '  no trails here: no run of calls in this project followed one into another'
                : '  no trails from inputs alone. Try `--deep`, which reads the archived results',
          )
          console.log('')
          continue
        }
        printTrails(wanted, limit, sessions.length > 1, values.deep)
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
        category: values.category,
        target: values.target,
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
      printRounds(shown, selected.length, limit, sessions.length > 1, work)
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
  let rebuilt = 0
  for (const result of results) {
    rounds += result.rounds
    // A rebuild rewrites rounds that were already there, so counting them as new would overstate
    // what the run found by the size of the whole store.
    if (result.rebuilt) rebuilt += 1
    else added += result.new_rounds
    const change = result.rebuilt ? 'rebuilt' : result.new_rounds > 0 ? `+${result.new_rounds}` : '·'
    // The path, not the name, is what identifies a project, since several can share a basename.
    console.log(
      `  ${pad(result.project, 24)}${pad(`${result.rounds} rounds`, 13)}${pad(change, 9)}${result.path ? shorten(result.path) : '(path unknown)'}`,
    )
  }
  console.log('')
  const note = rebuilt > 0 ? ` · ${rebuilt} rebuilt for the current schema` : ''
  console.log(`  ${results.length} projects · ${rounds} rounds · +${added} new${note}`)
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

// `probez export big-project | head` closes the pipe while output is still being written, which is
// a normal thing to do and not an error to report. Anything else on stdout still is.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

main().catch((error: unknown) => {
  console.error(`probez: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
