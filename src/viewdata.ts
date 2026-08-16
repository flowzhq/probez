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
  workIndex,
} from './inspect.js'
import type { Analysis, Dominant, RoundLabel, SessionRow, TaskRow, ToolRow, Trace } from './inspect.js'
import { collectProject, findStored, listStored, readRoundsIn, slugFor, writeAnalysis } from './store.js'
import type { CollectResult, StoredProject } from './store.js'
import type { Round } from './types.js'

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

/** A session as the view lists it: the stored row, plus what the tables around it need. */
export interface ViewSession extends SessionRow {
  model: string | null
  /** Wall clock across the session, gaps included. */
  elapsed_ms: number
  /** Time the model itself was generating, which `ms` undercounts badly. */
  active_ms: number
  work: Dominant | null
}

/** A task as the view lists it. `ms` on the stored row is active time; elapsed is the other one. */
export interface ViewTask extends TaskRow {
  tool_calls: number
  errors: number
  elapsed_ms: number
  work: Dominant | null
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
}

export interface RoundPayload {
  project: StoredProject
  round: Round
  labels: RoundLabel[]
}

export interface ToolsPayload {
  project: StoredProject
  tools: ToolRow[]
  kinds: ToolRow[]
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

async function open(dataDir: string, slug: string): Promise<{ stored: StoredProject; rounds: Round[] }> {
  const stored = await findStored(dataDir, slug)
  if (stored === null) throw new NotFound(`no project ${slug} in this store`)
  return { stored, rounds: await roundsOf(stored.dir) }
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
  const projects = []
  for (const project of stored) {
    const rounds = await roundsOf(project.dir)
    const analysis = categoryTally(rounds)
    const all: RoundLabel[] = []
    for (const labels of labelRounds(rounds).values()) all.push(...labels)
    projects.push({ ...project, work: dominant(all), mix: mixOf(analysis) })
  }
  return { data_dir: dataDir, projects }
}

export async function projectPayload(dataDir: string, slug: string): Promise<ProjectPayload> {
  const { stored, rounds } = await open(dataDir, slug)
  const work = workIndex(rounds)
  const bySession = new Map<string, Round[]>()
  for (const round of rounds) {
    const found = bySession.get(round.session)
    if (found === undefined) bySession.set(round.session, [round])
    else found.push(round)
  }

  const sessions: ViewSession[] = sessionRows(rounds).map((row) => {
    const mine = bySession.get(row.session) ?? []
    return {
      ...row,
      model: modelOf(mine),
      elapsed_ms: elapsedOf(mine),
      active_ms: mine.reduce((sum, round) => sum + (round.gen_ms ?? round.ms ?? 0), 0),
      work: work.session(row.session),
    }
  })

  return {
    project: stored,
    ...callsIn(rounds),
    analysis: categoryTally(rounds),
    // Newest first: the view is for looking at what just happened.
    sessions: sessions.reverse(),
  }
}

export async function sessionPayload(
  dataDir: string,
  slug: string,
  session: string,
): Promise<SessionPayload> {
  const { stored, rounds } = await open(dataDir, slug)
  const mine = rounds.filter((round) => round.session === session)
  if (mine.length === 0) throw new NotFound(`no session ${session} in ${slug}`)

  const work = workIndex(rounds)
  const byTask = new Map<number, Round[]>()
  for (const round of mine) {
    const found = byTask.get(round.task)
    if (found === undefined) byTask.set(round.task, [round])
    else found.push(round)
  }

  const row = sessionRows(mine)[0]!
  const tasks: ViewTask[] = taskRows(mine).map((task) => {
    const rows = byTask.get(task.task) ?? []
    return {
      ...task,
      ...callsIn(rows),
      elapsed_ms: elapsedOf(rows),
      work: work.task(session, task.task),
    }
  })

  return {
    project: stored,
    session: {
      ...row,
      model: modelOf(mine),
      elapsed_ms: elapsedOf(mine),
      active_ms: mine.reduce((sum, round) => sum + (round.gen_ms ?? round.ms ?? 0), 0),
      work: work.session(session),
    },
    analysis: categoryTally(mine),
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
  const { stored, rounds } = await open(dataDir, slug)
  let mine: Round[]
  try {
    mine = findTask(rounds, `${session}#${task}`)
  } catch {
    throw new NotFound(`no task ${task} in session ${session}`)
  }

  const work = workIndex(rounds)
  const row = taskRows(mine)[0]!
  return {
    project: stored,
    session: mine[0]!.session,
    task: {
      ...row,
      ...callsIn(mine),
      elapsed_ms: elapsedOf(mine),
      work: work.task(mine[0]!.session, task),
    },
    analysis: categoryTally(mine),
    trace: traceOf(mine),
  }
}

export async function roundPayload(
  dataDir: string,
  slug: string,
  session: string,
  round: number,
): Promise<RoundPayload> {
  const { stored, rounds } = await open(dataDir, slug)
  // Labels depend on what came before in the task, so the whole project is labelled and this one
  // looked up. Classifying a round on its own would give a different answer.
  const labelled = labelRounds(rounds)
  const found = rounds.find(
    (candidate) => candidate.session.startsWith(session) && candidate.round === round,
  )
  if (found === undefined) throw new NotFound(`no round ${round} in session ${session}`)
  return { project: stored, round: found, labels: labelled.get(found) ?? [] }
}

export async function toolsPayload(dataDir: string, slug: string): Promise<ToolsPayload> {
  const { stored, rounds } = await open(dataDir, slug)
  return { project: stored, tools: toolTally(rounds, 'command'), kinds: toolTally(rounds, 'kind') }
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
  slug: string,
): Promise<SyncResult> {
  const held = running.get(slug)
  if (held !== undefined) return held

  const work = (async (): Promise<SyncResult> => {
    const stored = await findStored(dataDir, slug)
    if (stored === null) throw new NotFound(`no project ${slug} in this store`)

    const projects = await discoverProjects(claudeDir)
    const source = projects.find((project) => slugFor(project) === slug) ?? null

    let collected: CollectResult | null = null
    if (source !== null) collected = await collectProject(source, dataDir)

    // Whatever collect did or did not add, the cache is rebuilt from what is on disk now.
    cache.delete(stored.dir)
    const rounds = await roundsOf(stored.dir)
    const analysis = categoryTally(rounds)
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
      source_dir: source?.dir ?? stored.source_dir,
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
  const analysis = categoryTally(rounds)
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
