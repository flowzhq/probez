/**
 * What a query comes to.
 *
 * `query.ts` says whether one round matches. This says what a set of matches *is*, and the
 * difference is the whole point of the feature. A search that answers with a list of rows is a
 * text box; a search that answers with a share — 412 rounds, $3.10, 18% of what this project cost,
 * concentrated in three sessions, 61% of it reconstruction — is a profiler. The idea is pprof's
 * `-focus`, which does not filter a listing but recomputes the profile over what survived, and it
 * is worth stealing because probez already knows how to say what a set of rounds was: the same
 * `categoryTally`, `sessionRows` and `taskRows` every other page is built from are what run here.
 *
 * Two decisions worth naming, because both could reasonably have gone the other way:
 *
 * - **Matching is always on rounds.** A round is the only thing the store records, so a session
 *   matches when a round inside it does. `in:sessions "flaky test"` therefore means "sessions
 *   containing a round that mentions a flaky test", which is what someone typing it means.
 *
 * - **A group row describes the matched rounds, not the whole group.** A session that spent two of
 *   its ninety rounds on what was asked for is reported as those two rounds and their cost, with
 *   `of` carrying the ninety beside it. The alternative — printing the session's full cost against
 *   a query it barely matched — reads as a much larger finding than it is.
 */

import { CATEGORIES } from './classify.js'
import {
  categoryTally,
  labelRounds,
  matchRounds,
  sessionRows,
  taskRows,
} from './inspect.js'
import type { Analysis, CategoryRow, SessionRow, TaskRow } from './inspect.js'
import { costOf } from './pricing.js'
import type { Pricing } from './pricing.js'
import { questionsOf } from './question.js'
import type { Question } from './question.js'
import { subjectOf } from './query.js'
import type { Diagnostic, Entity, Query } from './query.js'
import { needsRounds, SearchIndex } from './searchindex.js'
import type { Tallied } from './searchindex.js'
import { readRoundsAt, readRoundsAtOffsets, readRoundsIn } from './store.js'
import { trailsOf } from './trail.js'
import type { Trail } from './trail.js'
import type { Round } from './types.js'

// ---------------------------------------------------------------------------------------------
// What comes back
// ---------------------------------------------------------------------------------------------

/**
 * One project a search runs over, read a piece at a time.
 *
 * Not a list of rounds any more, because the whole point of the index is that most of them are
 * never built. A source says what it is called, whether it has a usable index, and how to get at
 * the rounds when something genuinely needs them.
 */
export interface Source {
  /** What to call the project these rounds are in. */
  project: string
  /** How the view addresses it, when the search was run against a store rather than a directory. */
  slug?: string
  /** The checkout the calls ran in, for the entities that resolve paths. */
  root?: string
  /** The index, or null when there is not a usable one and the rounds have to be read. */
  index: SearchIndex | null
  /** The rounds at these positions, and no others. Only ever called when there is an index. */
  at(wanted: number[]): Promise<Round[]>
  /** Every round. What the two entities the index cannot answer fall back to. */
  all(): Promise<Round[]>
}

/**
 * A project already in memory: the tests, and any caller that holds the rounds anyway.
 *
 * No index, so every query reads all of them — which is what `probez find` did before the index
 * existed and what it still does for a store that has not been collected since.
 */
export function fromRounds(
  project: string,
  rounds: Round[],
  extra: { slug?: string; root?: string } = {},
): Source {
  return {
    project,
    ...(extra.slug === undefined ? {} : { slug: extra.slug }),
    ...(extra.root === undefined ? {} : { root: extra.root }),
    index: null,
    at: async () => rounds,
    all: async () => rounds,
  }
}

/**
 * A project in the store, read through its index where it has a current one.
 *
 * A missing or stale index is the ordinary case, not a failure: a store collected before the index
 * existed has none, and one whose rounds have moved has one that is no longer about them. Both fall
 * back to reading the rounds, and the result says how many projects had to.
 */
export async function fromStore(
  dir: string,
  project: string,
  extra: { slug?: string; root?: string } = {},
): Promise<Source> {
  const index = await SearchIndex.read(dir)
  let held: Round[] | null = null
  return {
    project,
    ...(extra.slug === undefined ? {} : { slug: extra.slug }),
    ...(extra.root === undefined ? {} : { root: extra.root }),
    index,
    at: async (wanted) => {
      // Through the index's byte offsets where there is one, so what reaches the disk is the
      // rounds that matched rather than every line up to the last of them.
      const found =
        index === null
          ? await readRoundsAt(dir, new Set(wanted))
          : await readRoundsAtOffsets(dir, index.ranges(wanted))
      return wanted.flatMap((one) => {
        const round = found.get(one)
        return round === undefined ? [] : [round]
      })
    },
    all: async () => (held ??= await readRoundsIn(dir)),
  }
}

export interface Totalled {
  rounds: number
  tasks: number
  sessions: number
  projects: number
  /** Dollars over the rounds that could be priced. */
  cost: number
  /** Matched rounds whose model has no rate, and which are therefore outside `cost` entirely. */
  unpriced: number
  ms: number
  input: number
  output: number
  errors: number
  first_ts: string | null
  last_ts: string | null
}

/** One group of matched rounds, and how much of the group they were. */
export interface SessionHit extends SessionRow {
  project: string
  slug?: string
  /** Rounds this session has in the searched scope, matched or not. */
  of: number
}

export interface TaskHit extends TaskRow {
  project: string
  slug?: string
  of: number
}

export interface RoundHit {
  project: string
  slug?: string
  session: string
  task: number
  round: number
  ts: string | null
  model: string | null
  agent: 'main' | 'sub'
  ms: number | null
  cost: number | null
  in_tokens: number | null
  out_tokens: number | null
  /** The dominant category of this round, or null when nothing it did carried a label. */
  category: string | null
  errors: number
  tools: string
  /** One line of what the round was about: the prompt that opened it, or its own prose. */
  says: string
}

export interface ProjectHit {
  project: string
  slug?: string
  rounds: number
  of: number
  sessions: number
  tasks: number
  cost: number
  unpriced: number
  ms: number
  first_ts: string | null
  last_ts: string | null
}

export interface QuestionHit {
  project: string
  slug?: string
  session: string
  task: number
  ref: string
  at: number
  kind: string
  calls: number
  repeats: number
  terms: string[]
}

export interface TrailHit {
  project: string
  slug?: string
  session: string
  task: number
  ref: string
  depth: number
  breadth: number
  outcome: string
  steps: number
  ms: number
}

export type Hit = RoundHit | TaskHit | SessionHit | ProjectHit | QuestionHit | TrailHit

export interface SearchResult {
  /** The query as it was written, so a result can always say what produced it. */
  query: string
  diagnostics: Diagnostic[]
  entity: Entity
  totals: Totalled
  /** What the searched scope came to, so a matched slice can be read as a share of something. */
  scope: Totalled
  /** The matched slice against the scope it was matched in. Fractions, not percentages. */
  share: { rounds: number; cost: number }
  /**
   * `categoryTally` over the matched rounds alone: what this slice of work actually was.
   *
   * In the canonical category order — the order work tends to happen in, which is what the bars on
   * every page are drawn in — and so *not* sorted by size. `top` is the biggest one.
   */
  categories: CategoryRow[]
  /** The category most of the matched work was, and how much of it that is. Null when none carried a label. */
  top: { name: string; label: string; share: number } | null
  /** Where the matches are concentrated, most first. Always present, whatever `entity` says. */
  sessions: SessionHit[]
  /**
   * How the answer was arrived at: how many projects were searched, how many of them had a current
   * index, and how many had to have their rounds read. Reported rather than hidden, because a slow
   * search and a fast one differ only in this and it is worth being able to see which you got.
   */
  scanned: { projects: number; indexed: number; read: number }
  /** How many rows there are before `limit` withheld any. */
  found: number
  hits: Hit[]
}

// ---------------------------------------------------------------------------------------------
// Totalling
// ---------------------------------------------------------------------------------------------

function noTotals(): Totalled {
  return {
    rounds: 0,
    tasks: 0,
    sessions: 0,
    projects: 0,
    cost: 0,
    unpriced: 0,
    ms: 0,
    input: 0,
    output: 0,
    errors: 0,
    first_ts: null,
    last_ts: null,
  }
}

function total(groups: Array<{ project: string; rounds: Round[] }>, pricing: Pricing): Totalled {
  const out = noTotals()
  const sessions = new Set<string>()
  const tasks = new Set<string>()
  const projects = new Set<string>()
  for (const group of groups) {
    if (group.rounds.length > 0) projects.add(group.project)
    for (const round of group.rounds) {
      out.rounds += 1
      sessions.add(`${group.project} ${round.session}`)
      tasks.add(`${group.project} ${round.session} ${round.task}`)
      const cost = costOf(round, pricing)
      if (cost === null) out.unpriced += 1
      else out.cost += cost
      out.ms += round.ms ?? 0
      out.input += round.in_tokens ?? 0
      out.output += round.out_tokens ?? 0
      for (const tool of round.tools ?? []) if (tool.is_error === true) out.errors += 1
      if (typeof round.ts === 'string') {
        if (out.first_ts === null || round.ts < out.first_ts) out.first_ts = round.ts
        if (out.last_ts === null || round.ts > out.last_ts) out.last_ts = round.ts
      }
    }
  }
  out.sessions = sessions.size
  out.tasks = tasks.size
  out.projects = projects.size
  return out
}

// ---------------------------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------------------------

/**
 * The order rows come back in.
 *
 * Newest first by default, because a store is a history and the question people arrive with is
 * almost always about recent work. `sort:` puts a magnitude first instead, biggest end leading —
 * which is what every table in probez already does, and what makes `sort:cost` the one-word way to
 * ask where the money went.
 */
function order<T>(rows: T[], by: ((row: T) => number | null) | null, desc: boolean): T[] {
  if (by === null) return rows
  return [...rows].sort((a, b) => {
    const left = by(a)
    const right = by(b)
    // Nothing to compare sorts last either way round: a row with no figure is not a small figure.
    if (left === null && right === null) return 0
    if (left === null) return 1
    if (right === null) return -1
    return desc ? right - left : left - right
  })
}

function roundSort(query: Query, pricing: Pricing): ((round: Round) => number | null) | null {
  const sort = query.sort
  if (sort === null) return (round) => (round.ts === null ? null : Date.parse(round.ts))
  if (sort.key === 'ts') return (round) => (round.ts === null ? null : Date.parse(round.ts))
  if (sort.key === 'rounds') return null
  return (round) => subjectOf(round, { pricing, labels: [] }).number(sort.key)
}

/**
 * A row's figure for a `sort:` key, for the grouped entities whose rows carry their own totals.
 *
 * Read by name off the row rather than recomputed, because a session row's `cost` is already the
 * sum of the matched rounds in it and summing it a second time would be a different number.
 */
function groupSort(query: Query): ((row: Hit) => number | null) | null {
  const sort = query.sort
  if (sort === null) return null
  const key = sort.key === 'input' ? 'in_tokens' : sort.key === 'output' ? 'out_tokens' : sort.key
  return (row) => {
    const fields = row as unknown as Record<string, unknown>
    const value = fields[key]
    if (typeof value === 'number') return value
    if (key === 'ts') {
      const at = fields['last_ts'] ?? fields['first_ts'] ?? fields['ts']
      return typeof at === 'string' ? Date.parse(at) : null
    }
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

const CATEGORY_LABEL = new Map(CATEGORIES.map((one) => [one.id as string, one.label]))

/** The category a round mostly was: the one carrying the most of its weight. */
function mainCategory(labels: Array<{ category: string; weight: number }>): string | null {
  if (labels.length === 0) return null
  const weight = new Map<string, number>()
  for (const label of labels) {
    weight.set(label.category, (weight.get(label.category) ?? 0) + label.weight)
  }
  let best: string | null = null
  let most = -1
  for (const [category, found] of weight) {
    if (found > most) {
      most = found
      best = category
    }
  }
  return best
}

/** Tool counts for a round, as `Bash 2 · Edit 1`. The listing has one column for all of it. */
function toolsOf(round: Round): string {
  const counts = new Map<string, number>()
  for (const tool of round.tools ?? []) {
    const name = tool.name ?? '?'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  if (counts.size === 0) return ''
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, calls]) => `${name} ${calls}`)
    .join(' · ')
}

/** One line saying what a round was about: what was asked, or failing that what it said. */
function says(round: Round): string {
  const source = round.user_text?.trim() !== '' ? round.user_text : round.text
  return (source ?? '').replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------------------------

export interface SearchOptions {
  pricing: Pricing
  /** Rows to return. `null` means every one of them. Overridden by a `limit:` in the query. */
  limit?: number | null
}

/**
 * Run a query over one or more collected projects.
 *
 * Each project is matched on its own, because `project:` has to mean something and because a
 * project's rounds are its own file. What comes back is one result over all of them.
 *
 * Where a project has a current index, the query is answered from its columns and only the rounds
 * that matched are ever read — which is the difference between a search that can sit behind a box
 * you type into and one that cannot. Where it does not, the rounds are read and matched exactly as
 * they were before the index existed, and `read` in the result says how many projects that was.
 * Neither path can give a different answer: when a query names free text the index narrows to
 * candidates and the rounds themselves settle it.
 */
export async function search(
  sources: Source[],
  query: Query,
  options: SearchOptions,
): Promise<SearchResult> {
  const pricing = options.pricing
  const limit = query.limit ?? options.limit ?? null
  // Questions and trails read a run of calls across a whole project, so neither can be answered
  // from the part of it that matched.
  const whole = needsRounds(query)

  const matched: Matched[] = []
  let indexed = 0
  let read = 0

  for (const source of sources) {
    const index = source.index
    if (index === null || whole) {
      read += 1
      const all = await source.all()
      matched.push({
        source,
        rounds: matchRounds(all, query, { pricing, project: source.project }),
        all,
        scope: null,
      })
      continue
    }

    indexed += 1
    const picked = index.select(query, source.project, pricing)
    const fetched = await source.at(picked.at)
    matched.push({
      source,
      // Exact when the query named no free text: every field it asked about is a column, so the
      // positions are the answer. Otherwise those positions are candidates, and the rounds behind
      // them are asked directly — which is what makes the two paths agree.
      rounds: picked.exact
        ? fetched
        : matchRounds(fetched, query, { pricing, project: source.project }),
      all: null,
      scope: index.tally(pricing),
    })
  }

  const totals = total(
    matched.map((one) => ({ project: one.source.project, rounds: one.rounds })),
    pricing,
  )
  const scope = scopeOf(matched, pricing)

  // Every matched round in one list, for the tallies that do not care which project it came from.
  const flat = matched.flatMap((one) => one.rounds)

  const analysis: Analysis = categoryTally(flat, pricing)
  // The rows come back in the order work tends to happen, not in order of size, so the biggest has
  // to be picked rather than read off the front. Both are worth having: the order for a bar, the
  // biggest for the one-line answer.
  const biggest = analysis.rows.reduce<CategoryRow | null>(
    (best, row) => (best === null || row.rounds > best.rounds ? row : best),
    null,
  )
  const classified = analysis.rows.reduce((sum, row) => sum + row.rounds, 0)

  // Sessions are always reported, whatever is being counted, because "where is this concentrated"
  // is the second question every search has and the answer is cheap once the matches are in hand.
  const sessions = sessionHits(matched, pricing)

  const rows = hitsFor(query, matched, pricing, sessions)
  const ordered =
    query.entity === 'rounds' ? rows : order(rows, groupSort(query), query.sort?.desc ?? true)

  return {
    query: query.text,
    diagnostics: query.diagnostics,
    entity: query.entity,
    totals,
    scope,
    share: {
      rounds: scope.rounds === 0 ? 0 : totals.rounds / scope.rounds,
      cost: scope.cost === 0 ? 0 : totals.cost / scope.cost,
    },
    categories: analysis.rows,
    top:
      biggest === null || classified === 0
        ? null
        : { name: biggest.name, label: biggest.label, share: biggest.rounds / classified },
    sessions,
    scanned: { projects: sources.length, indexed, read },
    found: ordered.length,
    hits: limit === null || limit === 0 ? ordered : ordered.slice(0, limit),
  }
}

/**
 * What the searched projects come to in total, which is the denominator of every share.
 *
 * From the index where there is one, so the denominator costs nothing: reading fifty thousand
 * rounds in order to divide by them is exactly the expense the index exists to remove.
 */
function scopeOf(matched: Matched[], pricing: Pricing): Totalled {
  const out = noTotals()
  const projects = new Set<string>()
  for (const one of matched) {
    const tallied =
      one.scope ??
      total([{ project: one.source.project, rounds: one.all ?? [] }], pricing)
    if (tallied.rounds > 0) projects.add(one.source.project)
    out.rounds += tallied.rounds
    out.tasks += tallied.tasks
    out.sessions += tallied.sessions
    out.cost += tallied.cost
    out.unpriced += tallied.unpriced
    out.ms += tallied.ms
    out.input += tallied.input
    out.output += tallied.output
    out.errors += tallied.errors
    if (tallied.first_ts !== null && (out.first_ts === null || tallied.first_ts < out.first_ts)) {
      out.first_ts = tallied.first_ts
    }
    if (tallied.last_ts !== null && (out.last_ts === null || tallied.last_ts > out.last_ts)) {
      out.last_ts = tallied.last_ts
    }
  }
  out.projects = projects.size
  return out
}

/**
 * One project's answer, plus whatever was read to get it.
 *
 * `all` is the whole project's rounds, present only where they had to be read; `scope` is the same
 * project's totals read off its index, present only where they did not. Exactly one of the two is
 * ever set, and together they are what a share is divided by.
 */
type Matched = {
  source: Source
  rounds: Round[]
  all: Round[] | null
  scope: Tallied | null
}

function sessionHits(matched: Matched[], pricing: Pricing): SessionHit[] {
  const hits: SessionHit[] = []
  for (const one of matched) {
    if (one.rounds.length === 0) continue
    const whole = wholeSessions(one)
    for (const row of sessionRows(one.rounds, pricing)) {
      hits.push({
        ...row,
        project: one.source.project,
        ...(one.source.slug === undefined ? {} : { slug: one.source.slug }),
        of: whole.get(row.session) ?? row.rounds,
      })
    }
  }
  // Most spent first: a search is asking where something went, and the biggest share is the answer.
  return hits.sort((a, b) => b.cost - a.cost || b.rounds - a.rounds)
}

/** Rounds per session across the whole project, off the index where the rounds were not read. */
function wholeSessions(one: Matched): Map<string, number> {
  if (one.source.index !== null && one.all === null) return one.source.index.sessionCounts()
  const counts = new Map<string, number>()
  for (const round of one.all ?? one.rounds) {
    counts.set(round.session, (counts.get(round.session) ?? 0) + 1)
  }
  return counts
}

function hitsFor(
  query: Query,
  matched: Matched[],
  pricing: Pricing,
  sessions: SessionHit[],
): Hit[] {
  switch (query.entity) {
    case 'sessions':
      return sessions

    case 'tasks': {
      const hits: TaskHit[] = []
      for (const one of matched) {
        if (one.rounds.length === 0) continue
        // What a task *is* — the prompt that opened it and the commit it started from — lives on
        // its first round, and that round is often not one of the ones that matched. Totalling the
        // matches alone would leave every row nameless, so identity comes from the whole task and
        // only the figures come from the part of it that matched. The index carries exactly that,
        // which is why it does not have to be read out of the rounds.
        const whole = wholeTasks(one, pricing)
        for (const row of taskRows(one.rounds, pricing)) {
          const all = whole.get(`${row.session} ${row.task}`)
          hits.push({
            ...row,
            asked: all?.asked ?? row.asked,
            commit: all?.commit ?? row.commit,
            project: one.source.project,
            ...(one.source.slug === undefined ? {} : { slug: one.source.slug }),
            of: all?.rounds ?? row.rounds,
          })
        }
      }
      return hits
    }

    case 'projects': {
      const hits: ProjectHit[] = []
      for (const one of matched) {
        if (one.rounds.length === 0) continue
        const mine = total([{ project: one.source.project, rounds: one.rounds }], pricing)
        hits.push({
          project: one.source.project,
          ...(one.source.slug === undefined ? {} : { slug: one.source.slug }),
          rounds: mine.rounds,
          of: one.scope?.rounds ?? one.all?.length ?? mine.rounds,
          sessions: mine.sessions,
          tasks: mine.tasks,
          cost: mine.cost,
          unpriced: mine.unpriced,
          ms: mine.ms,
          first_ts: mine.first_ts,
          last_ts: mine.last_ts,
        })
      }
      return hits
    }

    case 'questions': {
      // Read over the whole project and then kept by what matched, never read over the matches
      // alone: a question is a run of calls, and handing it a set with holes in it would split one
      // question into three and report each fragment as its own. `needsRounds` is what guarantees
      // the whole project was read for this.
      const hits: QuestionHit[] = []
      for (const one of matched) {
        if (one.rounds.length === 0 || one.all === null) continue
        const keep = inRounds(one.rounds)
        for (const question of questionsOf(one.all, { root: one.source.root ?? '' })) {
          if (!question.calls.some((call) => keep.has(`${call.session} ${call.round}`))) continue
          hits.push(shapeQuestion(question, one.source))
        }
      }
      return hits
    }

    case 'trails': {
      const hits: TrailHit[] = []
      for (const one of matched) {
        if (one.rounds.length === 0 || one.all === null) continue
        const keep = inRounds(one.rounds)
        for (const trail of trailsOf(one.all, { root: one.source.root ?? '' })) {
          if (!trail.steps.some((step) => keep.has(`${step.session} ${step.round}`))) continue
          hits.push(shapeTrail(trail, one.source))
        }
      }
      return hits
    }

    default:
      return roundHits(query, matched, pricing)
  }
}

/** What each task in the project is called and how big it is, off the index where there is one. */
function wholeTasks(
  one: Matched,
  pricing: Pricing,
): Map<string, { asked: string; commit: string | null; rounds: number }> {
  if (one.source.index !== null && one.all === null) return one.source.index.taskIndex()
  const out = new Map<string, { asked: string; commit: string | null; rounds: number }>()
  for (const row of taskRows(one.all ?? one.rounds, pricing)) {
    out.set(`${row.session} ${row.task}`, {
      asked: row.asked,
      commit: row.commit,
      rounds: row.rounds,
    })
  }
  return out
}

function inRounds(rounds: Round[]): Set<string> {
  return new Set(rounds.map((round) => `${round.session} ${round.round}`))
}

function shapeQuestion(question: Question, source: Source): QuestionHit {
  return {
    project: source.project,
    ...(source.slug === undefined ? {} : { slug: source.slug }),
    session: question.session,
    task: question.task,
    ref: question.ref,
    at: question.at,
    kind: question.kind,
    calls: question.calls.length,
    repeats: question.repeats,
    terms: question.terms,
  }
}

function shapeTrail(trail: Trail, source: Source): TrailHit {
  return {
    project: source.project,
    ...(source.slug === undefined ? {} : { slug: source.slug }),
    session: trail.session,
    task: trail.task,
    ref: trail.ref,
    depth: trail.depth,
    breadth: trail.breadth,
    outcome: trail.outcome,
    steps: trail.steps.length,
    ms: trail.ms,
  }
}

function roundHits(query: Query, matched: Matched[], pricing: Pricing): RoundHit[] {
  const by = roundSort(query, pricing)
  const desc = query.sort?.desc ?? true
  const hits: RoundHit[] = []

  for (const { source, rounds } of matched) {
    if (rounds.length === 0) continue
    // A round's category is the one thing on this row that cannot be read off the round alone.
    // Over the matched rounds and not the whole project, which is the same answer for less work:
    // `labelRounds` labels each round on its own, so the set it arrives in does not change it.
    const labelled = labelRounds(rounds)
    for (const round of order(rounds, by, desc)) {
      hits.push({
        project: source.project,
        ...(source.slug === undefined ? {} : { slug: source.slug }),
        session: round.session,
        task: round.task,
        round: round.round,
        ts: round.ts,
        model: round.model,
        agent: round.agent,
        ms: round.ms,
        cost: costOf(round, pricing),
        in_tokens: round.in_tokens,
        out_tokens: round.out_tokens,
        category: mainCategory(labelled.get(round) ?? []),
        errors: (round.tools ?? []).filter((tool) => tool.is_error === true).length,
        tools: toolsOf(round),
        says: says(round),
      })
    }
  }

  // Merged across projects, since each was ordered on its own and a single list is what is printed.
  return by === null ? hits : order(hits, (hit) => rowFigure(hit, query), desc)
}

/** The sort figure for a round row, read back off the row so a merge does not re-read the round. */
function rowFigure(hit: RoundHit, query: Query): number | null {
  const key = query.sort?.key ?? 'ts'
  switch (key) {
    case 'ts':
      return hit.ts === null ? null : Date.parse(hit.ts)
    case 'cost':
      return hit.cost
    case 'ms':
      return hit.ms
    case 'input':
      return hit.in_tokens
    case 'output':
      return hit.out_tokens
    case 'errors':
      return hit.errors
    default:
      // Anything else was already ordered per corpus and has no column on the row to merge on.
      return null
  }
}

/** What a category id is called on screen, for the strip that says what a slice of work was. */
export function categoryLabel(id: string): string {
  return CATEGORY_LABEL.get(id) ?? id
}
