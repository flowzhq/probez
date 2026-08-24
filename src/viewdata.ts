import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { discoverProjects } from './discover.js'
import {
  analysisRecords,
  categoryTally,
  dominant,
  findTask,
  labelRounds,
  sessionRows,
  taskRows,
  toolTally,
  traceOf,
  trailShare,
  workIndex,
} from './inspect.js'
import type { Analysis, Dominant, RoundLabel, SessionRow, Share, TaskRow, ToolRow, Trace } from './inspect.js'
import {
  collectProject,
  findStored,
  importProject,
  listStored,
  MAX_NAME,
  readResultsIn,
  readRoundsIn,
  removeProject,
  renameProject,
  slugFor,
  writeAnalysis,
} from './store.js'
import type { CollectResult, ImportResult, RemoveResult, StoredProject } from './store.js'
import { CONTROL, ImportError, parseExport } from './import.js'
import { shorten } from './format.js'
import { MAX_RESULT_CHARS, readToolResult, readToolResults } from './result.js'
import { questionsOf, questionShare } from './question.js'
import type { Question } from './question.js'
import {
  DEFAULT_TIMEOUT_MS,
  READER_VERSION,
  readerFile,
  readerName,
  readReader,
  writeReader,
} from './reader.js'
import { explainQuestion, isStale, promptFor, readingKey, readReadings } from './reading.js'
import type { Reading } from './reading.js'
import { idsToRead, trailsOf } from './trail.js'
import type { Trail } from './trail.js'
import {
  costOf,
  defaultPricing,
  PRICING_VERSION,
  pricingFile,
  readPricing,
  writePricing,
} from './pricing.js'
import type { Pricing, Rates } from './pricing.js'
import { contextShare } from './models.js'
import type { Round, ToolCall } from './types.js'

/**
 * What `view` answers with, one shape per screen.
 *
 * Every number here is derived in Node and tested with the rest of the aggregation layer, and the
 * browser renders what it is given. That split is on purpose: a share recomputed in the page is a
 * second implementation of the taxonomy that nothing checks, and the one thing this data cannot
 * afford is two answers to the same question.
 *
 * Nothing in this file writes. `analyze` caches its result to `analysis.jsonl` as a side effect of
 * reading; `view` deliberately does not, so browsing a store leaves it byte-identical.
 */

/**
 * A project as the view should print it, which is a path under home written `~/…`.
 *
 * The CLI has always shortened; the view printed the path in full, so every screenshot of it
 * carried whoever's home directory it ran in. The store keeps the real path — this is the copy the
 * browser is handed, and nothing sends it back.
 */
function shown<T extends { path: string | null }>(project: T): T {
  return project.path === null ? project : { ...project, path: shorten(project.path) }
}

/**
 * Trails as the view should print them, which means the one path they carry written `~/…`.
 *
 * The same argument `shown` makes for a project's path: paths in a store are absolute, so a table
 * of them is a table of somebody's home directory, and every screenshot of that page carries it.
 * The steps' own `sites` are left alone — the trace draws them nowhere, and shortening a field a
 * caller might match against would be a quiet edit rather than a display choice.
 */
function shownTrails(trails: Trail[]): Trail[] {
  return trails.map((trail) =>
    trail.ended_on === '' ? trail : { ...trail, ended_on: shorten(trail.ended_on) },
  )
}

/** A session as the view lists it: the stored row, plus what the tables around it need. */
export interface ViewSession extends SessionRow {
  model: string | null
  /** Wall clock across the session, gaps included. */
  elapsed_ms: number
  /** Time the model itself was generating, which `ms` undercounts badly. */
  active_ms: number
  work: Dominant | null
  /** The whole distribution behind `work`, which the sessions table draws as a bar. */
  mix: Share[]
}

/** A task as the view lists it. `ms` on the stored row is active time; elapsed is the other one. */
export interface ViewTask extends TaskRow {
  tool_calls: number
  errors: number
  elapsed_ms: number
  work: Dominant | null
  /** The whole distribution behind `work`, which the tasks table draws as a bar. */
  mix: Share[]
}

export interface ProjectsPayload {
  data_dir: string
  projects: Array<StoredProject & { work: Dominant | null; mix: CategoryShare[] }>
}

export interface CategoryShare {
  category: string
  label: string
  share: number
}

export interface ProjectPayload {
  project: StoredProject
  tool_calls: number
  errors: number
  /**
   * What the whole project cost, every round of it. Larger than `analysis.coverage.cost`, which
   * counts only the rounds that called a tool — that is the denominator of the shares, this is the
   * bill. Computed at read time, because rates change and a figure baked into the manifest at
   * collect time would be quietly wrong the moment one did.
   */
  cost: number
  /** Rounds whose model has no rate, and so are missing from `cost`. */
  unpriced: number
  analysis: Analysis
  sessions: ViewSession[]
}

export interface SessionPayload {
  project: StoredProject
  session: ViewSession
  analysis: Analysis
  tasks: ViewTask[]
  trace: Trace
}

export interface TaskPayload {
  project: StoredProject
  session: string
  task: ViewTask
  analysis: Analysis
  trace: Trace
  /**
   * The walks this task made through the repository, read deep.
   *
   * The CLI makes the deep read opt-in because it is a second pass over the logs and a whole
   * project is a lot of them. A task is one session, and the page is already reading that session's
   * store, so here the honest answer is the affordable one and there is no flag to get it wrong.
   */
  trails: Trail[]
  /**
   * What this task needed to know, and every call each answer cost.
   *
   * The other reading of the same calls. A walk is what followed something; a question is what was
   * being asked, including the asking that got nowhere — which is most of what a repeat is, and
   * none of what a walk can show. Read from the inputs alone, so unlike `trails` there is no deep
   * pass behind it.
   */
  questions: Question[]
  /** The readings already asked for in this task. See `QuestionsPayload`. */
  readings: Record<string, Reading>
  /** Keys of the readings whose calls have changed since they were made. */
  stale: string[]
  /** The configured reader, or null when there is nothing probez could run. */
  reader: string | null
}

export interface RoundPayload {
  project: StoredProject
  round: Round
  labels: RoundLabel[]
  /**
   * How full the model's context window this round's input was, from 0 to 1.
   *
   * Computed here rather than in the browser so the window table has one home. The view mirrors the
   * stored schema by hand, and a second copy of the model list is a second thing to keep current.
   */
  context_share: number | null
}

export interface ToolsPayload {
  project: StoredProject
  tools: ToolRow[]
  kinds: ToolRow[]
}

export interface TrailsPayload {
  project: StoredProject
  trails: Trail[]
  /** Calls that were a step of some walk, over every call that was finding something out. */
  steps: number
  finding: number
}

export interface QuestionsPayload {
  project: StoredProject
  questions: Question[]
  /**
   * The readings already asked for, keyed the way `readingKey` names one.
   *
   * Carried on the payload rather than fetched beside it, because a reading is what a row shows
   * instead of its search terms and a page that drew the table twice — once without them — would
   * flicker between two readings of the same question.
   */
  readings: Record<string, Reading>
  /** Keys of the readings whose calls have changed since they were made. */
  stale: string[]
  /** The configured reader, or null when there is nothing probez could run. */
  reader: string | null
  /** Every call that was finding something out, which is what the questions divide up. */
  calls: number
  repeats: number
  fetches: number
  sweeps: number
  /** Questions that took more than one call to answer. */
  reasked: number
}

/**
 * One tool result's body, which is the only thing `view` serves that is not derived.
 *
 * Every other payload here is aggregation: measured in Node, tested with the rest of the analysis
 * layer, and small. This is a slice of a raw log, read on request and never on the way to a page.
 * That is the whole design of it — the inspector shows sizes until someone asks for a body, and
 * asking is what pays for reading the file.
 */
export interface ResultPayload {
  project: StoredProject
  /** The session it was read from, in full: the request may have named a prefix. */
  session: string
  tool_use_id: string
  /** The tool whose result this is, named from the round that called it. */
  tool: string | null
  chars: number
  body: string
  truncated: boolean
  /** The cut this response was held to, so the page can say what it stopped at. */
  cap: number
  is_error: boolean
  omitted: string[]
  /** The archived file it came out of, written `~/…` like every other path the view prints. */
  file: string
}

/**
 * Rounds for one project, read once and kept until the file moves underneath us.
 *
 * `collect` only ever appends, so size and mtime settle the question the same way they settle
 * whether a session needs re-reading. A store being collected in another terminal invalidates this
 * on the next request rather than serving a stale page.
 */
interface Cached {
  size: number
  mtimeMs: number
  rounds: Round[]
}

const cache = new Map<string, Cached>()

/** Drop everything held in memory. Only the tests need this; a run of `view` is one store. */
export function forgetRounds(): void {
  cache.clear()
}

async function roundsOf(dir: string): Promise<Round[]> {
  const file = join(dir, 'rounds.jsonl')
  const info = await stat(file).catch(() => null)
  if (info === null) return []
  const held = cache.get(dir)
  if (held !== undefined && held.size === info.size && held.mtimeMs === info.mtimeMs) {
    return held.rounds
  }
  const rounds = await readRoundsIn(dir)
  cache.set(dir, { size: info.size, mtimeMs: info.mtimeMs, rounds })
  return rounds
}

/** A project is missing when it was never collected, or when the slug names nothing. */
export class NotFound extends Error {}

/** Something the caller sent is wrong, as opposed to something here being broken. */
export class BadRequest extends Error {}

async function open(
  dataDir: string,
  slug: string,
): Promise<{ stored: StoredProject; rounds: Round[]; pricing: Pricing }> {
  const stored = await findStored(dataDir, slug)
  if (stored === null) throw new NotFound(`no project ${slug} in this store`)
  return { stored, rounds: await roundsOf(stored.dir), pricing: await readPricing(dataDir) }
}

/**
 * A distribution as shares of classified weight, every category included.
 *
 * All of them, because the bar this feeds is one whole rather than a top-N: a row whose slices
 * stopped short of the end would read as a project with less work in it, rather than as one whose
 * remaining work was spread thinly.
 */
function mixOf(analysis: Analysis): CategoryShare[] {
  const total = analysis.coverage.classified
  if (total === 0) return []
  return analysis.rows.map((row) => ({
    category: row.name,
    label: row.label,
    share: row.rounds / total,
  }))
}

function modelOf(rounds: Round[]): string | null {
  const counts = new Map<string, number>()
  for (const round of rounds) {
    if (typeof round.model !== 'string' || round.model === '') continue
    counts.set(round.model, (counts.get(round.model) ?? 0) + 1)
  }
  let best: string | null = null
  let most = 0
  for (const [model, count] of counts) {
    if (count > most) {
      best = model
      most = count
    }
  }
  return best
}

function elapsedOf(rounds: Round[]): number {
  let start = Infinity
  let end = -Infinity
  for (const round of rounds) {
    if (typeof round.ts !== 'string') continue
    const began = Date.parse(round.ts)
    if (Number.isNaN(began)) continue
    if (began < start) start = began
    if (began + (round.ms ?? 0) > end) end = began + (round.ms ?? 0)
  }
  return start === Infinity ? 0 : Math.max(0, end - start)
}

function callsIn(rounds: Round[]): { tool_calls: number; errors: number } {
  let tool_calls = 0
  let errors = 0
  for (const round of rounds) {
    for (const tool of round.tools ?? []) {
      tool_calls += 1
      if (tool.is_error === true) errors += 1
    }
  }
  return { tool_calls, errors }
}

/**
 * Every project in the store, with the shape of its work.
 *
 * The mix costs a full labelling pass per project, which is why the rounds cache exists: the first
 * request pays for the whole machine, and every later one is a map lookup.
 */
export async function projectsPayload(dataDir: string): Promise<ProjectsPayload> {
  const stored = await listStored(dataDir)
  const pricing = await readPricing(dataDir)
  const projects = []
  for (const project of stored) {
    const rounds = await roundsOf(project.dir)
    const analysis = categoryTally(rounds, pricing)
    const all: RoundLabel[] = []
    for (const labels of labelRounds(rounds).values()) all.push(...labels)
    projects.push({ ...shown(project), work: dominant(all), mix: mixOf(analysis) })
  }
  return { data_dir: shorten(dataDir), projects }
}

export async function projectPayload(dataDir: string, slug: string): Promise<ProjectPayload> {
  const { stored, rounds, pricing } = await open(dataDir, slug)
  const work = workIndex(rounds)
  const bySession = new Map<string, Round[]>()
  for (const round of rounds) {
    const found = bySession.get(round.session)
    if (found === undefined) bySession.set(round.session, [round])
    else found.push(round)
  }

  const sessions: ViewSession[] = sessionRows(rounds, pricing).map((row) => {
    const mine = bySession.get(row.session) ?? []
    return {
      ...row,
      model: modelOf(mine),
      elapsed_ms: elapsedOf(mine),
      active_ms: mine.reduce((sum, round) => sum + (round.gen_ms ?? round.ms ?? 0), 0),
      work: work.session(row.session),
      mix: work.sessionMix(row.session),
    }
  })

  let cost = 0
  let unpriced = 0
  for (const round of rounds) {
    const spent = costOf(round, pricing)
    if (spent === null) unpriced += 1
    else cost += spent
  }

  return {
    project: shown(stored),
    cost,
    unpriced,
    ...callsIn(rounds),
    analysis: categoryTally(rounds, pricing),
    // Newest first: the view is for looking at what just happened.
    sessions: sessions.reverse(),
  }
}

export async function sessionPayload(
  dataDir: string,
  slug: string,
  session: string,
): Promise<SessionPayload> {
  const { stored, rounds, pricing } = await open(dataDir, slug)
  const mine = rounds.filter((round) => round.session === session)
  if (mine.length === 0) throw new NotFound(`no session ${session} in ${slug}`)

  const work = workIndex(rounds)
  const byTask = new Map<number, Round[]>()
  for (const round of mine) {
    const found = byTask.get(round.task)
    if (found === undefined) byTask.set(round.task, [round])
    else found.push(round)
  }

  const row = sessionRows(mine, pricing)[0]!
  const tasks: ViewTask[] = taskRows(mine, pricing).map((task) => {
    const rows = byTask.get(task.task) ?? []
    return {
      ...task,
      ...callsIn(rows),
      elapsed_ms: elapsedOf(rows),
      work: work.task(session, task.task),
      mix: work.taskMix(session, task.task),
    }
  })

  return {
    project: shown(stored),
    session: {
      ...row,
      model: modelOf(mine),
      elapsed_ms: elapsedOf(mine),
      active_ms: mine.reduce((sum, round) => sum + (round.gen_ms ?? round.ms ?? 0), 0),
      work: work.session(session),
      mix: work.sessionMix(session),
    },
    analysis: categoryTally(mine, pricing),
    tasks,
    trace: traceOf(mine),
  }
}

export async function taskPayload(
  dataDir: string,
  slug: string,
  session: string,
  task: number,
): Promise<TaskPayload> {
  const { stored, rounds, pricing } = await open(dataDir, slug)
  let mine: Round[]
  try {
    mine = findTask(rounds, `${session}#${task}`)
  } catch {
    throw new NotFound(`no task ${task} in session ${session}`)
  }

  const work = workIndex(rounds)
  const row = taskRows(mine, pricing)[0]!
  const questions = questionsOf(mine, { root: stored.path ?? '' })
  const readings = await readReadings(stored.dir)
  return {
    project: shown(stored),
    session: mine[0]!.session,
    task: {
      ...row,
      ...callsIn(mine),
      elapsed_ms: elapsedOf(mine),
      work: work.task(mine[0]!.session, task),
      mix: work.taskMix(mine[0]!.session, task),
    },
    analysis: categoryTally(mine, pricing),
    trace: traceOf(mine),
    trails: await taskTrails(stored, mine),
    questions,
    readings,
    stale: staleKeys(readings, questions),
    reader: await readerLabel(dataDir),
  }
}

/**
 * A task's walks, with their hops read out of the archived session rather than inferred.
 *
 * One file, one pass, and only the calls that were finding something out. A project with no
 * archived sessions — an import — falls back to what the inputs alone can show, which is fewer
 * walks and says so through each trail's `confidence` rather than through an empty section.
 */
async function taskTrails(stored: StoredProject, rounds: Round[]): Promise<Trail[]> {
  const session = rounds[0]?.session
  if (session === undefined) return []
  const file = join(stored.dir, 'sessions', `${session}.jsonl`)
  const results = await readToolResults(file, idsToRead(rounds))
  return shownTrails(trailsOf(rounds, { results, root: stored.path ?? '' }))
}

export async function roundPayload(
  dataDir: string,
  slug: string,
  session: string,
  round: number,
): Promise<RoundPayload> {
  const { stored, rounds, pricing } = await open(dataDir, slug)
  const labelled = labelRounds(rounds)
  const found = rounds.find(
    (candidate) => candidate.session.startsWith(session) && candidate.round === round,
  )
  if (found === undefined) throw new NotFound(`no round ${round} in session ${session}`)
  return {
    project: shown(stored),
    round: found,
    labels: labelled.get(found) ?? [],
    context_share: contextShare(found),
  }
}

/**
 * The body of one tool result, read from the archived session on request.
 *
 * The call is resolved out of the store before the file is touched, and that ordering is the
 * security of this route rather than a tidiness. It means `session` is only ever a session this
 * project recorded — a name matched against the rounds, never a path handed through from the
 * browser — and it means the id being searched for is one the store already knows, so this cannot
 * be turned into a way to look for an arbitrary string in a file.
 */
export async function resultPayload(
  dataDir: string,
  slug: string,
  session: string,
  toolUseId: string,
): Promise<ResultPayload> {
  const { stored, rounds } = await open(dataDir, slug)

  let found: { session: string; tool: ToolCall } | null = null
  for (const round of rounds) {
    if (!round.session.startsWith(session)) continue
    const tool = round.tools.find((candidate) => candidate.id === toolUseId)
    if (tool !== undefined) {
      found = { session: round.session, tool }
      break
    }
  }
  if (found === null) throw new NotFound(`no tool call ${toolUseId} in session ${session}`)

  const file = join(stored.dir, 'sessions', `${found.session}.jsonl`)
  if ((await stat(file).catch(() => null)) === null) {
    // Worth separating from "no result recorded": nothing is wrong with the call, there is simply
    // no log here to read it out of. An export carries the rounds probez normalized and not the
    // sessions behind them, which is also why a result body never leaves the machine it was
    // collected on.
    throw new NotFound(
      stored.imported_at === null
        ? `this project has no archived copy of session ${found.session}`
        : 'an imported project carries its rounds, not the logs behind them, so there is no result body here',
    )
  }

  const body = await readToolResult(file, toolUseId)
  if (body === null) {
    throw new NotFound(`the archived session records no result for ${toolUseId}`)
  }

  return {
    project: shown(stored),
    session: found.session,
    tool_use_id: toolUseId,
    tool: found.tool.name,
    chars: body.chars,
    body: body.body,
    truncated: body.truncated,
    cap: MAX_RESULT_CHARS,
    is_error: body.is_error,
    omitted: body.omitted,
    file: shorten(file),
  }
}

/**
 * Every walk in a project, read deep.
 *
 * This is the one payload that reads the archived sessions from end to end, which is why the page
 * fetches it on the tab rather than on the way in — the same bargain `Tools` makes, for a bigger
 * reason. Against probez's own store, twenty-nine sessions and six megabytes of rounds, that is
 * under a second; on anything larger it is still one pass, since every session is read once and
 * asked only for the ids it happens to hold.
 *
 * Shallow was never the right default here. It finds about a third of the steps and roots the walks
 * it does find further forward, so a project page showing it would understate the thing the page
 * exists to show — and unlike the CLI, there is no flag here to have got wrong.
 */
export async function trailsPayload(dataDir: string, slug: string): Promise<TrailsPayload> {
  const { stored, rounds } = await open(dataDir, slug)
  const results = await readResultsIn(stored.dir, idsToRead(rounds))
  const root = stored.path ?? ''
  const share = trailShare(rounds, { results, root })
  return {
    project: shown(stored),
    trails: shownTrails(trailsOf(rounds, { results, root })),
    steps: share.steps,
    finding: share.finding,
  }
}

/**
 * Every question a project asked, costliest first.
 *
 * Sorted here rather than in the page, for the reason the CLI sorts them: a listing in the order
 * they were asked buries the thirteen-call question under three hundred single-call reads, and the
 * tail is the whole reason to look.
 */
export async function questionsPayload(dataDir: string, slug: string): Promise<QuestionsPayload> {
  const { stored, rounds } = await open(dataDir, slug)
  const share = questionShare(rounds, { root: stored.path ?? '' })
  const questions = questionsOf(rounds, { root: stored.path ?? '' }).sort(
    (a, b) => b.calls.length - a.calls.length || a.session.localeCompare(b.session) || a.task - b.task,
  )
  const readings = await readReadings(stored.dir)
  return {
    project: shown(stored),
    questions,
    readings,
    stale: staleKeys(readings, questions),
    reader: await readerLabel(dataDir),
    calls: share.calls,
    repeats: share.repeats,
    fetches: share.fetches,
    sweeps: share.sweeps,
    reasked: share.reasked,
  }
}

/* Readings: the one place the view runs something. --------------------------------------------- */

/**
 * The reader as it would be run, or null when there is none.
 *
 * A label rather than the config, because this rides on every payload that carries questions and
 * the page needs exactly two things from it: whether there is anything to run, and what to call it.
 */
/**
 * Which held readings are about calls that have since moved.
 *
 * Computed here because staleness is a digest over the calls and the calls are here; the page would
 * otherwise have to hash them in the browser to find out. Listed rather than folded into each
 * reading, so what is stored stays exactly what the reader said.
 */
function staleKeys(readings: Record<string, Reading>, questions: Question[]): string[] {
  const out: string[] = []
  for (const question of questions) {
    const key = readingKey(question.session, question.task, question.at)
    const held = readings[key]
    if (held !== undefined && isStale(held, question)) out.push(key)
  }
  return out
}

async function readerLabel(dataDir: string): Promise<string | null> {
  const config = await readReader(dataDir)
  return config === null ? null : readerName(config)
}

export interface ReaderPayload {
  /** Where the command is written, shortened for showing. */
  file: string
  /** argv, empty when nothing is configured. */
  command: string[]
  timeout_ms: number
}

export async function readerPayload(dataDir: string): Promise<ReaderPayload> {
  const config = await readReader(dataDir)
  return {
    file: shorten(readerFile(dataDir)),
    command: config?.command ?? [],
    timeout_ms: config?.timeout_ms ?? DEFAULT_TIMEOUT_MS,
  }
}

/**
 * Set the command `explain` runs.
 *
 * argv and never a shell line, which is why it is a list here and stays a list all the way to
 * `spawn`. An empty list is how a person turns the reader off: it writes a config that reads back
 * as none, rather than deleting a file — nothing here removes anything from disk.
 */
export async function saveReaderConfig(dataDir: string, body: unknown): Promise<ReaderPayload> {
  if (body === null || typeof body !== 'object') throw new BadRequest('that is not a reader')
  const sent = (body as { command?: unknown; timeout_ms?: unknown }).command
  const argv: string[] = []
  if (Array.isArray(sent)) {
    for (const part of sent) {
      if (typeof part !== 'string') throw new BadRequest('a command is a list of strings')
      if (part.trim() !== '') argv.push(part.trim())
    }
  } else if (typeof sent === 'string') {
    // The settings field is one line, and it is argv split on whitespace rather than a shell line:
    // there is no quoting to honour here because there is no shell to honour it.
    for (const part of sent.trim().split(/\s+/)) if (part !== '') argv.push(part)
  } else if (sent !== undefined) {
    throw new BadRequest('a command is a list of strings')
  }

  const timeout = (body as { timeout_ms?: unknown }).timeout_ms
  const ms =
    typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
      ? Math.min(Math.round(timeout), 10 * 60_000)
      : DEFAULT_TIMEOUT_MS
  await writeReader(dataDir, { schema_version: READER_VERSION, command: argv, timeout_ms: ms })
  return readerPayload(dataDir)
}

export interface ReadingsPayload {
  project: StoredProject
  readings: Record<string, Reading>
  reader: string | null
}

/** Every reading held for a project. A read, and the only route here that touches the file. */
export async function readingsPayload(dataDir: string, slug: string): Promise<ReadingsPayload> {
  const stored = await findStored(dataDir, slug)
  if (stored === null) throw new NotFound(`no project ${slug} in this store`)
  return {
    project: shown(stored),
    readings: await readReadings(stored.dir),
    reader: await readerLabel(dataDir),
  }
}

export interface ExplainPayload {
  /** How the reading is addressed, so the page can put it straight into the map it holds. */
  key: string
  reading: Reading
  /** False when the reading came out of the file and nothing was run. */
  asked: boolean
  stale: boolean
}

/**
 * The one question a request names, or the reason it names none.
 *
 * Shared by `explain` and `prompt` so that the sentence a reader is given and the text a person
 * copies are about the same calls. Everything a caller can get wrong is a `BadRequest`; a question
 * that is simply not in the store is a `NotFound`.
 */
async function oneQuestion(
  dataDir: string,
  slug: string,
  named: { session?: unknown; task?: unknown; at?: unknown },
): Promise<{ stored: StoredProject; question: Question }> {
  if (typeof named.session !== 'string' || named.session === '') {
    throw new BadRequest('that names no session')
  }
  if (!Number.isInteger(named.task) || (named.task as number) < 0) {
    throw new BadRequest('that names no task')
  }
  if (!Number.isInteger(named.at) || (named.at as number) < 0) {
    throw new BadRequest('that names no question')
  }

  const stored = await findStored(dataDir, slug)
  if (stored === null) throw new NotFound(`no project ${slug} in this store`)
  const rounds = (await roundsOf(stored.dir)).filter(
    (round) => round.session === named.session && round.task === named.task,
  )
  const question = questionsOf(rounds, { root: stored.path ?? '' }).find(
    (one) => one.at === named.at,
  )
  if (question === undefined) {
    throw new NotFound(`no question at ${String(named.task)}.${String(named.at)} in that session`)
  }
  return { stored, question }
}

export interface PromptPayload {
  project: StoredProject
  /** How the question is addressed, so a caller can tell an answer from a stale request. */
  key: string
  /** Exactly what `explain` would send, and exactly what `probez explain <id> --prompt` prints. */
  prompt: string
}

/**
 * What would be sent, without sending it.
 *
 * The view's half of `explain --prompt`: it runs no program, needs no reader, and spends nothing,
 * which is what makes it a GET where `explain` is a POST. It exists because handing the question to
 * a chat you already have open is a supported way to use probez, not a workaround for one.
 */
export async function promptPayload(
  dataDir: string,
  slug: string,
  named: { session?: unknown; task?: unknown; at?: unknown },
): Promise<PromptPayload> {
  const { stored, question } = await oneQuestion(dataDir, slug, named)
  return {
    project: shown(stored),
    key: readingKey(question.session, question.task, question.at),
    prompt: promptFor(question),
  }
}

/**
 * Hand one question to the configured reader, and keep what it says.
 *
 * The only thing in the view that runs a program, and it runs exactly the one the person wrote into
 * `reader.json`, with exactly this question's calls on its stdin. It is a POST for the same reason
 * `sync` is: a URL that spends someone's tokens when it is merely visited is a URL that can be put
 * in an `<img>` tag on a page they did not write.
 *
 * Everything the reader can do wrong — missing, failing, timing out, answering in prose — comes
 * back as a `BadRequest` with what it said, because all of it is the person's setup to fix rather
 * than probez being broken.
 */
export async function explainOne(
  dataDir: string,
  slug: string,
  body: unknown,
): Promise<ExplainPayload> {
  if (body === null || typeof body !== 'object') throw new BadRequest('that names no question')
  const sent = body as { session?: unknown; task?: unknown; at?: unknown; again?: unknown }
  const { stored, question } = await oneQuestion(dataDir, slug, sent)

  const config = await readReader(dataDir)
  if (config === null) {
    throw new BadRequest(
      `no reader configured. Write the command to run in ${shorten(readerFile(dataDir))}, as ` +
        '{"command": ["claude", "-p"]}',
    )
  }

  let read
  try {
    read = await explainQuestion(stored.dir, config, question, { again: sent.again === true })
  } catch (error) {
    throw new BadRequest(error instanceof Error ? error.message : 'the reader failed')
  }
  return {
    key: readingKey(question.session, question.task, question.at),
    reading: read.reading,
    asked: read.asked,
    stale: read.stale,
  }
}

export async function toolsPayload(dataDir: string, slug: string): Promise<ToolsPayload> {
  const { stored, rounds, pricing } = await open(dataDir, slug)
  return { project: shown(stored), tools: toolTally(rounds, 'command'), kinds: toolTally(rounds, 'kind') }
}

/* Sync and export: the two things the view does that are not reading. -------------------------- */

export interface SyncResult {
  slug: string
  project: string
  /** False when the agent's session files for this project are gone. */
  source_found: boolean
  source_dir: string | null
  new_rounds: number
  read_sessions: number
  skipped_sessions: number
  rounds: number
  sessions: number
  tasks: number
  collected_at: string | null
}

/**
 * One sync per project at a time.
 *
 * `collect` appends to `rounds.jsonl` and rewrites `state.json`; two of them racing on one project
 * would interleave those writes. A second request for a project already syncing joins the first
 * rather than starting another, which is also what a double-clicked button should do.
 */
const running = new Map<string, Promise<SyncResult>>()

/**
 * Collect this project's new sessions, then recompute its analysis cache.
 *
 * This is the one path in the view that writes, and it writes exactly what the two commands it
 * stands for would write: `collectProject` appends new rounds and refreshes the manifest, and the
 * analysis is rebuilt through the same `analysisRecords` that `probez analyze` uses, so the cache
 * cannot come to mean two different things depending on which wrote it last.
 *
 * A project whose source sessions are gone still analyses. There is nothing new to collect from,
 * which the result says rather than treating as a failure: what was collected is still there, and
 * recomputing over it is still worth doing.
 */
export async function syncProject(
  dataDir: string,
  claudeDir: string,
  cursorDir: string,
  slug: string,
): Promise<SyncResult> {
  const held = running.get(slug)
  if (held !== undefined) return held

  const work = (async (): Promise<SyncResult> => {
    const stored = await findStored(dataDir, slug)
    if (stored === null) throw new NotFound(`no project ${slug} in this store`)

    const projects = await discoverProjects({ claudeDir, cursorDir })
    const source = projects.find((project) => slugFor(project) === slug) ?? null

    let collected: CollectResult | null = null
    if (source !== null) collected = await collectProject(source, dataDir)

    // Whatever collect did or did not add, the cache is rebuilt from what is on disk now.
    cache.delete(stored.dir)
    const rounds = await roundsOf(stored.dir)
    const analysis = categoryTally(rounds, await readPricing(dataDir))
    await writeAnalysis(
      join(stored.dir, 'analysis.jsonl'),
      { rounds: rounds.length, toolless: analysis.coverage.toolless },
      analysisRecords(rounds),
    )

    const after = (await findStored(dataDir, slug)) ?? stored
    return {
      slug,
      project: after.project,
      source_found: source !== null,
      source_dir: source === null ? stored.source_dir : shorten(source.dir),
      new_rounds: collected?.new_rounds ?? 0,
      read_sessions: collected?.read_sessions ?? 0,
      skipped_sessions: collected?.skipped_sessions ?? 0,
      rounds: after.rounds,
      sessions: after.sessions,
      tasks: after.tasks,
      collected_at: after.collected_at,
    }
  })()

  running.set(slug, work)
  try {
    return await work
  } finally {
    running.delete(slug)
  }
}

/* Renaming and removing: the two things the view does to a project rather than to its data. ------ */

/**
 * Give a project a name of your own, from the browser.
 *
 * A label and nothing more. It changes what every page calls the project and what `probez <name>`
 * answers to, and it changes neither the slug in the address bar nor a byte of the rounds.
 */
export async function renameStored(
  dataDir: string,
  slug: string,
  body: unknown,
): Promise<{ project: StoredProject }> {
  const wanted = (body as { name?: unknown } | null)?.name
  if (typeof wanted !== 'string') throw new BadRequest('expected { name: "<what to call it>" }')
  if (wanted.length > MAX_NAME * 4) throw new BadRequest(`a name has to fit in ${MAX_NAME} characters`)
  const renamed = await renameProject(dataDir, slug, wanted)
  if (renamed === null) throw new NotFound(`no project ${slug} in this store`)
  return { project: shown(renamed) }
}

/**
 * Remove a project from the store.
 *
 * The only route here that destroys anything, and it destroys the whole of what probez recorded for
 * one project. The agent's own session files are untouched, so a collected project comes back with
 * `probez collect` minus whatever the agent has since pruned; an imported one does not come back at
 * all, because the file it arrived as is the only copy that ever existed here. Which is why the page
 * asks first, and why this reports what went rather than answering with a tick.
 */
export async function removeStored(dataDir: string, slug: string): Promise<RemoveResult> {
  const removed = await removeProject(dataDir, slug)
  if (removed === null) throw new NotFound(`no project ${slug} in this store`)
  // The rounds cache is keyed on a file that no longer exists.
  cache.delete(removed.dir)
  return removed
}

export type ExportFormat = 'jsonl' | 'json'

export interface Export {
  filename: string
  type: string
  body: string
}

/**
 * A project's data, to be written wherever the person asked for it.
 *
 * probez writes only under its own data directory, and that rule is not bent here: this hands bytes
 * to the browser, and the browser writes them where you point it. Which is also the only way a page
 * can put a file on your disk, so the constraint and the mechanism agree.
 *
 * `jsonl` is the store's own file, verbatim — the contract every stage reads, one round per line.
 * `json` is a bundle for looking at rather than piping: the manifest, the analysis, and the rounds
 * in one document, so a share is never read apart from the coverage it is a share of.
 */
export async function exportProject(
  dataDir: string,
  slug: string,
  format: ExportFormat,
): Promise<Export> {
  const stored = await findStored(dataDir, slug)
  if (stored === null) throw new NotFound(`no project ${slug} in this store`)

  if (format === 'jsonl') {
    const body = await readFile(join(stored.dir, 'rounds.jsonl'), 'utf8').catch(() => '')
    return {
      filename: `${stored.slug}-rounds.jsonl`,
      type: 'application/x-ndjson; charset=utf-8',
      body,
    }
  }

  const rounds = await roundsOf(stored.dir)
  const analysis = categoryTally(rounds, await readPricing(dataDir))
  return {
    filename: `${stored.slug}.json`,
    type: 'application/json; charset=utf-8',
    body: JSON.stringify(
      {
        exported_at: new Date().toISOString(),
        manifest: stored,
        analysis: {
          categories: analysis.rows,
          coverage: analysis.coverage,
          unclassified: analysis.unknown,
        },
        rounds,
      },
      null,
      2,
    ),
  }
}

/**
 * Take in a project someone exported, from the browser.
 *
 * The same path the CLI takes, so a file that imports in one imports in the other. The body is a
 * string of the file's bytes: the browser reads the file the person picked, and nothing here ever
 * learns or uses the path it came from.
 */
/** A ".jsonl" of rounds carries no name of its own, so the file it arrived as is the next best one. */
function fileName(from: unknown): string {
  if (typeof from !== 'string') return ''
  return (from.split(/[/\\]/).pop() ?? '')
    .replace(/\.(jsonl|json|txt)$/i, '')
    .replace(/-rounds$/i, '')
    .replace(/-[0-9a-f]{8}$/i, '')
}

export async function importExport(
  dataDir: string,
  body: unknown,
): Promise<ImportResult & { name: string }> {
  const text = (body as { text?: unknown } | null)?.text
  if (typeof text !== 'string' || text === '') throw new BadRequest('no file contents were sent')
  const as = (body as { as?: unknown }).as
  // What the browser called the file. Only a fallback: a bundle names itself, and a name the sender
  // chose beats whatever the download ended up saved as.
  const from = (body as { from?: unknown }).from

  let parsed
  try {
    parsed = parseExport(text)
  } catch (error) {
    if (error instanceof ImportError) throw new BadRequest(error.message)
    throw error
  }

  const named = typeof as === 'string' ? as : (parsed.name ?? fileName(from))
  const chosen = named.replace(CONTROL, '').trim()
  const name = chosen.slice(0, 80) || 'imported'
  const result = await importProject(dataDir, name, parsed.source ?? name, parsed.rounds, parsed.skipped)
  // The rounds cache is keyed on the file's size and mtime, both of which just changed.
  cache.delete(result.dir)
  return { ...result, name }
}

/** A model the store has rounds for, and what it is charged. */
export interface PricedModel {
  model: string
  rounds: number
  /** Null when nothing has set a rate for it, which is what the settings screen is for. */
  rates: Rates | null
  /** Whether the rate in force is the published one or something this machine typed. */
  custom: boolean
}

export interface PricingPayload {
  file: string
  models: PricedModel[]
  /** The published rates, so the screen can offer to put one back. */
  defaults: Record<string, Rates>
}

/**
 * The rates, and every model the store would apply them to.
 *
 * Models are read from the rounds rather than from the rate table, so a model that has been used
 * but never priced appears in the list with nothing beside it. A settings screen that only lists
 * what it already knows about cannot tell you what it is missing.
 */
export async function pricingPayload(dataDir: string): Promise<PricingPayload> {
  const pricing = await readPricing(dataDir)
  const defaults = defaultPricing().models
  const seen = new Map<string, number>()
  for (const project of await listStored(dataDir)) {
    for (const round of await roundsOf(project.dir)) {
      if (round.model === null) continue
      seen.set(round.model, (seen.get(round.model) ?? 0) + 1)
    }
  }
  // Three sources, unioned: models the store has rounds for, models the rate file names, and models
  // with a published price. The last is what keeps the screen usable after a save — the file is
  // authoritative, so without it every model nobody had used yet would disappear the first time
  // anything was saved, and there would be no row left to type a rate into.
  for (const model of Object.keys(pricing.models)) if (!seen.has(model)) seen.set(model, 0)
  for (const model of Object.keys(defaults)) if (!seen.has(model)) seen.set(model, 0)

  const models: PricedModel[] = [...seen.entries()]
    .map(([model, rounds]) => {
      const rates = pricing.models[model] ?? null
      const fallback = defaults[model]
      const custom =
        rates !== null && (fallback === undefined || JSON.stringify(rates) !== JSON.stringify(fallback))
      return { model, rounds, rates, custom }
    })
    .sort((a, b) => b.rounds - a.rounds || a.model.localeCompare(b.model))

  return { file: shorten(pricingFile(dataDir)), models, defaults }
}

/**
 * Replace the rates.
 *
 * Every field of every model is checked before anything is written: a rate table is arithmetic that
 * silently changes every share on every page, and a string where a number belongs would turn those
 * into `NaN` rather than into an error anybody sees.
 */
export async function savePricing(dataDir: string, body: unknown): Promise<PricingPayload> {
  const models = (body as { models?: unknown } | null)?.models
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    throw new BadRequest('expected { models: { "<model>": { in, cache_write_5m, cache_write_1h, cache_read, out } } }')
  }
  const fields = ['in', 'cache_write_5m', 'cache_write_1h', 'cache_read', 'out'] as const
  const checked: Record<string, Rates> = {}
  for (const [model, value] of Object.entries(models as Record<string, unknown>)) {
    if (model === '' || model.length > 200) throw new BadRequest(`"${model}" is not a model name`)
    if (!value || typeof value !== 'object') throw new BadRequest(`${model} has no rates`)
    const raw = value as Record<string, unknown>
    const rates: Record<string, number> = {}
    for (const field of fields) {
      const rate = raw[field]
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
        throw new BadRequest(`${model}.${field} must be a number of dollars per million tokens`)
      }
      rates[field] = rate
    }
    checked[model] = rates as unknown as Rates
  }

  await writePricing(dataDir, { schema_version: PRICING_VERSION, models: checked })
  return pricingPayload(dataDir)
}
