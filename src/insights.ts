/**
 * The store-wide half of the view: what everything cost, and where it went nowhere.
 *
 * Everything under `viewdata.ts` answers about one project, because the view began as a drill-down
 * from a project list. The two questions people open probez with do not start from a project:
 * "what did my agents cost this month" and "which session was it". So these payloads read every
 * project in the store under one *scope* — a time range, an agent, and optionally one project —
 * and every Insights chart and Investigate list is drawn from the same pass, which is what lets a
 * bar on one page and a row count on another agree.
 *
 * Nothing here is a new measurement. Cost is `costOf`, the work split is `labelRounds`, questions
 * and trails are the modules the project page already reads, and a finding is one of those signals
 * counted and priced. Like the rest of the view, nothing in this file writes to the store.
 */

import { roundSourceOf } from './agents/paths.js'
import { categoryInfo, isCategory } from './classify.js'
import { failed } from './errors.js'
import { committerOf, readCommitter } from './identity.js'
import { debugOn } from './debug.js'
import { DEFAULT_THRESHOLDS, findingsFile, readThresholds, thresholdsFrom, writeThresholds } from './findings.js'
import type { Thresholds } from './findings.js'
import {
  filterRounds,
  labelRounds,
  peakContextOccupancyDaily,
  reusedVsFreshDaily,
} from './inspect.js'
import type { PeakContextDay, ReusedFreshDay } from './inspect.js'
import { contextShare, contextTokens, contextWindowOf } from './models.js'
import { costOf, priceOf, readPricing } from './pricing.js'
import type { Pricing } from './pricing.js'
import { questionsOf } from './question.js'
import type { Question } from './question.js'
import { listStored, readResultsIn } from './store.js'
import type { StoredProject } from './store.js'
import { idsToRead, trailsOf } from './trail.js'
import type { Trail } from './trail.js'
import type { Round, RoundSource } from './types.js'
import { shorten } from './format.js'
import { BadRequest, NotFound, pageSourceOf, roundsOf, viewSessions } from './viewdata.js'
import type { PageSource, ViewSession } from './viewdata.js'

/* Scope ------------------------------------------------------------------------------------------ */

/** The ranges the scope bar offers. `all` is every round the store holds, dated or not. */
export const RANGES = ['7d', '30d', '90d', 'all'] as const
export type Range = (typeof RANGES)[number]

export interface Scope {
  range: Range
  source: PageSource | null
  /** One project's slug, or null for the whole store. */
  project: string | null
  /** Whose work: a name rounds were recorded under, or null for everyone's. See `identity.ts`. */
  committer: string | null
  /** The instant the range ends at. The present, except under test. */
  now: number
}

const DAY = 86_400_000

function daysIn(range: Range): number | null {
  return range === 'all' ? null : Number(range.slice(0, -1))
}

/**
 * The scope a request names. Absent is the last 30 days of every agent in every project, which is
 * what the scope bar opens on.
 */
export function scopeOf(params: URLSearchParams, now = Date.now()): Scope {
  const range = params.get('range') ?? '30d'
  if (!(RANGES as readonly string[]).includes(range)) {
    throw new BadRequest(`range must be one of ${RANGES.join(', ')}, got "${range}"`)
  }
  const project = params.get('project')
  const committer = params.get('committer')
  return {
    range: range as Range,
    source: pageSourceOf(params.get('source')),
    project: project === null || project === '' ? null : project,
    committer: committer === null || committer.trim() === '' ? null : committer.trim(),
    now,
  }
}

/** The scope as the page is told it, so a heading can say what it is a heading over. */
export interface ScopeShown {
  range: Range
  source: PageSource | null
  project: string | null
  committer: string | null
  /** First day in range, `YYYY-MM-DD`, or null for all time. */
  from: string | null
  /** Last day in range. For all time, the last day anything ran. */
  to: string | null
}

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function msOf(round: Round): number | null {
  if (typeof round.ts !== 'string') return null
  const at = Date.parse(round.ts)
  return Number.isNaN(at) ? null : at
}

/**
 * The window a range covers, as instants: the last `days` whole days up to and including today.
 *
 * Whole days, so the first bar on a chart is a full day rather than whatever fraction of one
 * happened to fall after this time yesterday-minus-thirty.
 */
function windowOf(scope: Scope): { start: number; end: number } | null {
  const days = daysIn(scope.range)
  if (days === null) return null
  const today = Date.parse(`${dayOf(scope.now)}T00:00:00.000Z`)
  return { start: today - (days - 1) * DAY, end: today + DAY }
}

/** The window of the same length immediately before, for "vs previous 30 days". */
function previousOf(scope: Scope): { start: number; end: number } | null {
  const window = windowOf(scope)
  if (window === null) return null
  const length = window.end - window.start
  return { start: window.start - length, end: window.start }
}

function within(rounds: Round[], window: { start: number; end: number } | null): Round[] {
  if (window === null) return rounds
  return rounds.filter((round) => {
    const at = msOf(round)
    return at !== null && at >= window.start && at < window.end
  })
}

interface Scoped {
  project: StoredProject
  /** Every round the project holds, under the agent filter only. What per-project caches key on. */
  all: Round[]
  rounds: Round[]
  previous: Round[]
}

/**
 * Every project under the scope, with its rounds cut to it.
 *
 * A project the agent filter empties is left out, as the projects list does. A project that is
 * merely quiet in the time range stays in: it exists, it just did nothing this month.
 */
async function gather(dataDir: string, scope: Scope): Promise<Scoped[]> {
  const stored = await listStored(dataDir)
  const local = scope.committer === null ? '' : await readCommitter(dataDir)
  const window = windowOf(scope)
  const before = previousOf(scope)
  const out: Scoped[] = []
  for (const project of stored) {
    if (scope.project !== null && project.slug !== scope.project) continue
    const collected = await roundsOf(project.dir)
    const bySource = scope.source === null ? collected : filterRounds(collected, { source: scope.source })
    const all =
      scope.committer === null ? bySource : bySource.filter((round) => committerOf(round, local) === scope.committer)
    if ((scope.source !== null || scope.committer !== null) && all.length === 0) continue
    out.push({ project, all, rounds: within(all, window), previous: within(all, before) })
  }
  if (scope.project !== null && out.length === 0 && !stored.some((one) => one.slug === scope.project)) {
    throw new NotFound(`no project ${scope.project} in this store`)
  }
  return out
}

function shownScope(scope: Scope, projects: Scoped[]): ScopeShown {
  const window = windowOf(scope)
  let first: string | null = null
  let last: string | null = null
  for (const { rounds } of projects) {
    for (const round of rounds) {
      if (typeof round.ts !== 'string') continue
      if (first === null || round.ts < first) first = round.ts
      if (last === null || round.ts > last) last = round.ts
    }
  }
  return {
    range: scope.range,
    source: scope.source,
    project: scope.project,
    committer: scope.committer,
    from: window === null ? (first === null ? null : first.slice(0, 10)) : dayOf(window.start),
    to: window === null ? (last === null ? null : last.slice(0, 10)) : dayOf(window.end - DAY),
  }
}

/* Insights --------------------------------------------------------------------------------------- */

/** One period's totals: the row of figures across the top of Overview. */
export interface Period {
  cost: number
  /** Rounds with no rate for their model, which are outside `cost` rather than free. */
  unpriced: number
  rounds: number
  tasks: number
  sessions: number
  in_tokens: number
  in_cache_read: number
  /** Input that was not a cache read: uncached input and input written to cache. */
  fresh: number
  out_tokens: number
}

/** The four ways spend can be split, which is the control on the Spend page. */
export type SplitBy = 'project' | 'model' | 'source' | 'category'

export interface SplitRow {
  key: string
  label: string
  cost: number
  rounds: number
  sessions: number
  in_tokens: number
  in_cache_read: number
  out_tokens: number
}

export interface Day {
  day: string
  cost: number
  rounds: number
  /** Cost that day under each split, keyed by `SplitRow.key`. Absent keys spent nothing. */
  by: Record<SplitBy, Record<string, number>>
}

export interface CacheProject {
  slug: string
  project: string
  fresh: number
  reused: number
  /** What the fresh input cost at its own rates. */
  fresh_cost: number
}

export interface CacheSummary {
  reused: number
  fresh: number
  /** What the input that was not a cache read cost, at the rates in Settings. */
  fresh_cost: number
  /** What that same input would have cost had every token of it been a cache read. */
  fresh_at_read: number
  /** What the cache reads cost. */
  reused_cost: number
  by_project: CacheProject[]
  days: ReusedFreshDay[]
}

/** One task whose context went over the threshold. */
export interface ContextTask {
  slug: string
  project: string
  session: string
  task: number
  /** The round its peak was on, so the row can open the trace there. */
  round: number
  first_ts: string | null
  model: string | null
  peak_tokens: number
  window: number
  share: number
  /** Compactions the task went through. */
  compactions: number
  cost: number
}

export interface CompactionRow {
  slug: string
  project: string
  session: string
  task: number
  round: number
  ts: string | null
  trigger: string | null
  pre_tokens: number | null
  post_tokens: number | null
}

export interface ContextSummary {
  threshold: number
  days: PeakContextDay[]
  /** Tasks that went over, fullest first. */
  over: ContextTask[]
  /** Tasks with a known window, which is what `over` is a share of. */
  measured: number
  compactions: CompactionRow[]
}

export interface InsightsPayload {
  scope: ScopeShown
  totals: Period
  /** The window of the same length before this one, or null for all time. */
  previous: Period | null
  days: Day[]
  splits: Record<SplitBy, SplitRow[]>
  cache: CacheSummary
  context: ContextSummary
  /** The latest round anywhere under the agent and project filter, whatever the range. */
  latest: string | null
}

/** A source as the scope bar names it: `claude`, not `claude-code`. */
export function sourceKey(source: RoundSource): string {
  return source === 'claude-code' ? 'claude' : source
}

const SOURCE_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
  copilot: 'Copilot',
  pi: 'Pi',
  opencode: 'OpenCode',
  goose: 'Goose',
  cline: 'Cline',
  unknown: 'Unknown',
}

/** What a round that called no tool is filed under: outside the classification, not unclassified. */
export const PROSE = 'prose'

function categoryLabel(key: string): string {
  if (key === PROSE) return 'Prose only'
  return isCategory(key) ? categoryInfo(key).label : key
}

/**
 * A round's cost, divided among the kinds of work it did.
 *
 * The split `categoryTally` makes: each label carries its call's share of the round, so the parts
 * add back up to the round. A round that called nothing is prose, whole.
 */
function costByCategory(labels: { category: string; weight: number }[], spent: number): Map<string, number> {
  const out = new Map<string, number>()
  if (labels.length === 0) {
    out.set(PROSE, spent)
    return out
  }
  let total = 0
  for (const label of labels) total += label.weight
  if (total === 0) {
    out.set(PROSE, spent)
    return out
  }
  for (const label of labels) {
    out.set(label.category, (out.get(label.category) ?? 0) + (spent * label.weight) / total)
  }
  return out
}

function emptyPeriod(): Period {
  return {
    cost: 0,
    unpriced: 0,
    rounds: 0,
    tasks: 0,
    sessions: 0,
    in_tokens: 0,
    in_cache_read: 0,
    fresh: 0,
    out_tokens: 0,
  }
}

function freshOf(round: Round): number {
  return (round.in_uncached ?? 0) + (round.in_cache_write ?? 0)
}

function periodOf(projects: Scoped[], pick: (one: Scoped) => Round[], pricing: Pricing): Period {
  const period = emptyPeriod()
  const sessions = new Set<string>()
  const tasks = new Set<string>()
  for (const one of projects) {
    for (const round of pick(one)) {
      period.rounds += 1
      sessions.add(`${one.project.slug}\u0000${round.session}`)
      tasks.add(`${one.project.slug}\u0000${round.session}\u0000${round.task}`)
      const spent = costOf(round, pricing)
      if (spent === null) period.unpriced += 1
      else period.cost += spent
      period.in_tokens += round.in_tokens ?? 0
      period.in_cache_read += round.in_cache_read ?? 0
      period.fresh += freshOf(round)
      period.out_tokens += round.out_tokens ?? 0
    }
  }
  period.sessions = sessions.size
  period.tasks = tasks.size
  return period
}

/** Every day in the scope, empty ones included, so a chart's axis is time and not activity. */
function dayList(scope: ScopeShown): string[] {
  if (scope.from === null || scope.to === null) return []
  const out: string[] = []
  const start = Date.parse(`${scope.from}T00:00:00.000Z`)
  const end = Date.parse(`${scope.to}T00:00:00.000Z`)
  for (let at = start; at <= end; at += DAY) out.push(dayOf(at))
  return out
}

/**
 * What one input would have cost as a cache read instead, at the same model's rates.
 *
 * The question the Tokens page exists to answer is "how much did not hitting the cache cost me",
 * and the honest form of it is a pair of prices for the same tokens rather than a share.
 */
function freshPrices(round: Round, pricing: Pricing): { cost: number; at_read: number; reused: number } | null {
  const fresh = priceOf(pricing, round.model, {
    uncached: round.in_uncached ?? 0,
    write_5m: round.in_cache_write_5m ?? 0,
    write_1h: round.in_cache_write_1h ?? 0,
    cache_read: 0,
    out: 0,
  })
  if (fresh === null) return null
  const atRead = priceOf(pricing, round.model, {
    uncached: 0,
    write_5m: 0,
    write_1h: 0,
    cache_read: freshOf(round),
    out: 0,
  })
  const reused = priceOf(pricing, round.model, {
    uncached: 0,
    write_5m: 0,
    write_1h: 0,
    cache_read: round.in_cache_read ?? 0,
    out: 0,
  })
  return { cost: fresh, at_read: atRead ?? 0, reused: reused ?? 0 }
}

function contextOf(projects: Scoped[], pricing: Pricing, threshold: number): ContextSummary {
  const over: ContextTask[] = []
  const compactions: CompactionRow[] = []
  let measured = 0
  const all: Round[] = []
  for (const one of projects) {
    const shownName = one.project.project
    const byTask = new Map<string, Round[]>()
    for (const round of one.rounds) {
      all.push(round)
      const key = `${round.session}\u0000${round.task}`
      const found = byTask.get(key)
      if (found === undefined) byTask.set(key, [round])
      else found.push(round)
      if (round.compaction !== null && round.compaction !== undefined) {
        compactions.push({
          slug: one.project.slug,
          project: shownName,
          session: round.session,
          task: round.task,
          round: round.round,
          ts: round.compaction.ts ?? round.ts,
          trigger: round.compaction.trigger,
          pre_tokens: round.compaction.pre_tokens,
          post_tokens: round.compaction.post_tokens,
        })
      }
    }
    for (const rounds of byTask.values()) {
      let peak: Round | null = null
      let peakShare = -1
      let cost = 0
      let compacted = 0
      for (const round of rounds) {
        cost += costOf(round, pricing) ?? 0
        if (round.compaction !== null && round.compaction !== undefined) compacted += 1
        const share = contextShare(round)
        if (share !== null && share > peakShare) {
          peak = round
          peakShare = share
        }
      }
      if (peak === null) continue
      measured += 1
      if (peakShare <= threshold) continue
      over.push({
        slug: one.project.slug,
        project: shownName,
        session: peak.session,
        task: peak.task,
        round: peak.round,
        first_ts: rounds[0]?.ts ?? null,
        model: peak.model,
        peak_tokens: contextTokens(peak) ?? 0,
        window: contextWindowOf(peak) ?? 0,
        share: peakShare,
        compactions: compacted,
        cost,
      })
    }
  }
  over.sort((a, b) => b.share - a.share || b.cost - a.cost)
  compactions.sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? ''))
  return { threshold, days: peakContextOccupancyDaily(all), over, measured, compactions }
}

export async function insightsPayload(dataDir: string, scope: Scope): Promise<InsightsPayload> {
  const projects = await gather(dataDir, scope)
  const pricing = await readPricing(dataDir)
  const thresholds = await readThresholds(dataDir)
  const shownAs = shownScope(scope, projects)

  const days = new Map<string, Day>()
  for (const day of dayList(shownAs)) {
    days.set(day, { day, cost: 0, rounds: 0, by: { project: {}, model: {}, source: {}, category: {} } })
  }
  const splits: Record<SplitBy, Map<string, SplitRow & { seen: Set<string> }>> = {
    project: new Map(),
    model: new Map(),
    source: new Map(),
    category: new Map(),
  }
  const add = (
    by: SplitBy,
    key: string,
    label: string,
    round: Round,
    session: string,
    cost: number,
    weight: number,
  ): void => {
    let row = splits[by].get(key)
    if (row === undefined) {
      row = {
        key,
        label,
        cost: 0,
        rounds: 0,
        sessions: 0,
        in_tokens: 0,
        in_cache_read: 0,
        out_tokens: 0,
        seen: new Set(),
      }
      splits[by].set(key, row)
    }
    row.cost += cost
    row.rounds += weight
    row.in_tokens += (round.in_tokens ?? 0) * weight
    row.in_cache_read += (round.in_cache_read ?? 0) * weight
    row.out_tokens += (round.out_tokens ?? 0) * weight
    row.seen.add(session)
  }

  const cache: CacheSummary = {
    reused: 0,
    fresh: 0,
    fresh_cost: 0,
    fresh_at_read: 0,
    reused_cost: 0,
    by_project: [],
    days: [],
  }
  let latest: string | null = null
  const scopedRounds: Round[] = []

  for (const one of projects) {
    for (const round of one.all) {
      if (typeof round.ts === 'string' && (latest === null || round.ts > latest)) latest = round.ts
    }
    const labelled = labelRounds(one.rounds)
    const mine: CacheProject = {
      slug: one.project.slug,
      project: one.project.project,
      fresh: 0,
      reused: 0,
      fresh_cost: 0,
    }
    for (const round of one.rounds) {
      scopedRounds.push(round)
      const spent = costOf(round, pricing) ?? 0
      const session = `${one.project.slug}\u0000${round.session}`
      const source = sourceKey(roundSourceOf(round))
      const model = typeof round.model === 'string' && round.model !== '' ? round.model : '(no model)'
      add('project', one.project.slug, one.project.project, round, session, spent, 1)
      add('model', model, model, round, session, spent, 1)
      add('source', source, SOURCE_NAMES[source] ?? source, round, session, spent, 1)
      const labels = labelled.get(round) ?? []
      const byCategory = costByCategory(labels, spent)
      const weights = costByCategory(labels, 1)
      for (const [category, cost] of byCategory) {
        add('category', category, categoryLabel(category), round, session, cost, weights.get(category) ?? 0)
      }

      const at = msOf(round)
      const day = at === null ? undefined : days.get(dayOf(at))
      if (day !== undefined) {
        day.cost += spent
        day.rounds += 1
        const bump = (by: SplitBy, key: string, value: number): void => {
          day.by[by][key] = (day.by[by][key] ?? 0) + value
        }
        bump('project', one.project.slug, spent)
        bump('model', model, spent)
        bump('source', source, spent)
        for (const [category, cost] of byCategory) bump('category', category, cost)
      }

      const fresh = freshOf(round)
      cache.fresh += fresh
      cache.reused += round.in_cache_read ?? 0
      mine.fresh += fresh
      mine.reused += round.in_cache_read ?? 0
      const priced = freshPrices(round, pricing)
      if (priced !== null) {
        cache.fresh_cost += priced.cost
        cache.fresh_at_read += priced.at_read
        cache.reused_cost += priced.reused
        mine.fresh_cost += priced.cost
      }
    }
    if (mine.fresh + mine.reused > 0) cache.by_project.push(mine)
  }
  cache.by_project.sort((a, b) => b.fresh_cost - a.fresh_cost || b.fresh - a.fresh)
  cache.days = reusedVsFreshDaily(scopedRounds)

  const finish = (by: SplitBy): SplitRow[] =>
    [...splits[by].values()]
      .map(({ seen, ...row }) => ({ ...row, sessions: seen.size }))
      .sort((a, b) => b.cost - a.cost || b.rounds - a.rounds)

  return {
    scope: shownAs,
    totals: periodOf(projects, (one) => one.rounds, pricing),
    previous: scope.range === 'all' ? null : periodOf(projects, (one) => one.previous, pricing),
    days: [...days.values()],
    splits: {
      project: finish('project'),
      model: finish('model'),
      source: finish('source'),
      category: finish('category'),
    },
    cache,
    context: contextOf(projects, pricing, thresholds.context),
    latest,
  }
}

/* Store-wide lists ------------------------------------------------------------------------------- */

export interface StoreSession extends ViewSession {
  slug: string
  project: string
  /** Share of input that was a cache read, or null for a session that recorded no input. */
  cache_share: number | null
  /** The session's cost divided among the kinds of work it did, as `costByCategory` splits it. */
  cost_by_category: Record<string, number>
}

export interface SessionsPayload {
  scope: ScopeShown
  sessions: StoreSession[]
  /** The projects in scope, so the list's project filter offers only those that are there. */
  projects: Array<{ slug: string; project: string }>
  thresholds: Thresholds
}

/**
 * Every session in the scope, across every project, costliest first.
 *
 * A session is cut to the scope with the rest: one that ran across the start of the range is
 * listed with the part of it that falls inside, which is the part the totals above it counted.
 */
export async function sessionsPayload(dataDir: string, scope: Scope): Promise<SessionsPayload> {
  const projects = await gather(dataDir, scope)
  const pricing = await readPricing(dataDir)
  const sessions: StoreSession[] = []
  for (const one of projects) {
    if (one.rounds.length === 0) continue
    const labelled = labelRounds(one.rounds)
    const byCategory = new Map<string, Record<string, number>>()
    for (const round of one.rounds) {
      const spent = costOf(round, pricing) ?? 0
      let split = byCategory.get(round.session)
      if (split === undefined) {
        split = {}
        byCategory.set(round.session, split)
      }
      for (const [category, cost] of costByCategory(labelled.get(round) ?? [], spent)) {
        split[category] = (split[category] ?? 0) + cost
      }
    }
    for (const session of viewSessions(one.rounds, pricing)) {
      sessions.push({
        ...session,
        slug: one.project.slug,
        project: one.project.project,
        cache_share: session.in_tokens > 0 ? session.in_cache_read / session.in_tokens : null,
        cost_by_category: byCategory.get(session.session) ?? {},
      })
    }
  }
  sessions.sort((a, b) => b.cost - a.cost || (b.last_ts ?? '').localeCompare(a.last_ts ?? ''))
  return {
    scope: shownScope(scope, projects),
    sessions,
    projects: projects
      .filter((one) => one.rounds.length > 0)
      .map((one) => ({ slug: one.project.slug, project: one.project.project })),
    thresholds: await readThresholds(dataDir),
  }
}

/**
 * Questions and trails for a project, read once per version of its rounds.
 *
 * Both are a pass over every call, and trails a read of result bodies besides, so computing them
 * per request for every project in the store would make each page of the Investigate section cost
 * a full analysis. The rounds array a project's cache hands out only changes when the store does,
 * so it is the key: a sync replaces it, and the entry goes with the array it described.
 */
const derived = new WeakMap<Round[], { questions?: Question[]; trails?: Trail[] }>()

function held(all: Round[]): { questions?: Question[]; trails?: Trail[] } {
  let entry = derived.get(all)
  if (entry === undefined) {
    entry = {}
    derived.set(all, entry)
  }
  return entry
}

function questionsFor(one: Scoped): Question[] {
  const entry = held(one.all)
  entry.questions ??= questionsOf(one.all, { root: one.project.path ?? '' })
  return entry.questions
}

async function trailsFor(one: Scoped): Promise<Trail[]> {
  const entry = held(one.all)
  if (entry.trails === undefined) {
    const results = await readResultsIn(one.project.dir, idsToRead(one.all))
    entry.trails = trailsOf(one.all, { results, root: one.project.path ?? '' })
  }
  return entry.trails
}

/** The rounds in scope, addressed the way a call names its round. */
function roundIndex(rounds: Round[], pricing: Pricing): Map<string, number> {
  const out = new Map<string, number>()
  for (const round of rounds) out.set(`${round.session}\u0000${round.round}`, costOf(round, pricing) ?? 0)
  return out
}

/** What a run of calls cost: each call's share of its round, which is how a round's cost is split. */
function callsCost(calls: Array<{ session: string; round: number; share: number }>, costs: Map<string, number>): number {
  let total = 0
  for (const call of calls) total += (costs.get(`${call.session}\u0000${call.round}`) ?? 0) * call.share
  return total
}

export interface StoreQuestion extends Question {
  slug: string
  project: string
  cost: number
}

export interface QuestionsListPayload {
  scope: ScopeShown
  questions: StoreQuestion[]
  /** Every question in scope, of which `questions` may be the costliest part. */
  total: number
  reasked: number
}

/** How many rows a store-wide list hands over. The rest are counted, and a filter narrows to them. */
export const LIST_LIMIT = 500

export async function questionsListPayload(dataDir: string, scope: Scope): Promise<QuestionsListPayload> {
  const projects = await gather(dataDir, scope)
  const pricing = await readPricing(dataDir)
  const all: StoreQuestion[] = []
  let reasked = 0
  for (const one of projects) {
    if (one.rounds.length === 0) continue
    const costs = roundIndex(one.rounds, pricing)
    for (const question of questionsFor(one)) {
      const first = question.calls[0]
      if (first === undefined || !costs.has(`${first.session}\u0000${first.round}`)) continue
      if (question.repeats > 0) reasked += 1
      all.push({ ...question, slug: one.project.slug, project: one.project.project, cost: callsCost(question.calls, costs) })
    }
  }
  all.sort((a, b) => b.cost - a.cost || b.calls.length - a.calls.length)
  return { scope: shownScope(scope, projects), questions: all.slice(0, LIST_LIMIT), total: all.length, reasked }
}

/**
 * A path as a store-wide list should print it: relative to its project when it is inside it.
 *
 * A list of trails from six projects is a list of six checkouts' absolute paths, every one of
 * them starting with the same home directory, and the part that tells two rows apart is at the
 * far end of a column that clips. The project column already says which checkout; this says where
 * in it. Anything outside the project is written `~/…`, as every path the view prints is.
 */
export function insideOf(root: string | null, path: string): string {
  if (path === '') return ''
  if (root !== null && root !== '') {
    const norm = (text: string): string => text.replaceAll('\\', '/').replace(/\/+$/, '')
    const base = norm(root)
    const full = norm(path)
    // Windows paths compare without case, and an agent may have written the drive either way.
    const same = /^[a-z]:\//i.test(base) ? full.toLowerCase().startsWith(`${base.toLowerCase()}/`) : full.startsWith(`${base}/`)
    if (same) return full.slice(base.length + 1)
  }
  return shorten(path)
}

export interface StoreTrail extends Trail {
  slug: string
  project: string
  cost: number
}

export interface TrailsListPayload {
  scope: ScopeShown
  trails: StoreTrail[]
  total: number
  abandoned: number
}

export async function trailsListPayload(dataDir: string, scope: Scope): Promise<TrailsListPayload> {
  const projects = await gather(dataDir, scope)
  const pricing = await readPricing(dataDir)
  const all: StoreTrail[] = []
  let abandoned = 0
  for (const one of projects) {
    if (one.rounds.length === 0) continue
    const costs = roundIndex(one.rounds, pricing)
    for (const trail of await trailsFor(one)) {
      const first = trail.steps[0]
      if (first === undefined || !costs.has(`${first.session}\u0000${first.round}`)) continue
      if (trail.outcome === 'abandoned') abandoned += 1
      all.push({
        ...trail,
        ended_on: insideOf(one.project.path, trail.ended_on),
        slug: one.project.slug,
        project: one.project.project,
        cost: callsCost(trail.steps, costs),
      })
    }
  }
  all.sort((a, b) => b.cost - a.cost || b.steps.length - a.steps.length)
  return { scope: shownScope(scope, projects), trails: all.slice(0, LIST_LIMIT), total: all.length, abandoned }
}

/* Findings --------------------------------------------------------------------------------------- */

export type FindingId = 'reconstruction' | 'context' | 'reasked' | 'abandoned' | 'errors' | 'unpriced'
export type Severity = 'high' | 'med' | 'low' | 'info'

export interface Finding {
  id: FindingId
  severity: Severity
  /** How many things it counted: sessions, tasks, questions, trails, calls or rounds. */
  count: number
  /** What `count` counts, so the row can say "6 sessions" rather than "6". */
  unit: string
  /** Sessions it touched. */
  sessions: number
  /** What it cost. Null for a finding about a hole in the pricing, which has no cost to give. */
  cost: number | null
  /** The line it was drawn at, for the two findings that have one. */
  threshold: number | null
  /** What else to say: the commonest tool, the compactions that followed, the model with no rate. */
  detail: string
}

export interface FindingsPayload {
  scope: ScopeShown
  findings: Finding[]
  thresholds: Thresholds
  /** Spend in scope, which is what severity is a share of. */
  total: number
  /** When probez last read any project in scope: collected here, or imported. */
  synced_at: string | null
}

/**
 * How loudly a finding should be drawn: by what it cost, as a share of everything in scope.
 *
 * A share rather than a dollar figure, because $20 is most of a quiet week and noise in a busy
 * month, and the page should rank a finding by whether it matters to *this* bill.
 */
export function severityOf(cost: number, total: number): Severity {
  if (total <= 0 || cost <= 0) return 'low'
  const share = cost / total
  if (share >= 0.05) return 'high'
  if (share >= 0.01) return 'med'
  return 'low'
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many
}

export async function findingsPayload(dataDir: string, scope: Scope): Promise<FindingsPayload> {
  const projects = await gather(dataDir, scope)
  const pricing = await readPricing(dataDir)
  const thresholds = await readThresholds(dataDir)
  let total = 0

  // Reconstruction: sessions whose money went mostly on finding their way back around.
  let reconCount = 0
  let reconCost = 0
  // Errors: calls the harness reported as failed, priced at their share of the round.
  let errorCalls = 0
  let errorCost = 0
  const errorSessions = new Set<string>()
  const errorTools = new Map<string, number>()
  // Unpriced: rounds whose model has no rate, by model.
  let unpricedRounds = 0
  const unpricedModels = new Map<string, number>()
  const unpricedSessions = new Set<string>()

  for (const one of projects) {
    const labelled = labelRounds(one.rounds)
    const bySession = new Map<string, { cost: number; recon: number }>()
    for (const round of one.rounds) {
      const spent = costOf(round, pricing)
      const session = `${one.project.slug}\u0000${round.session}`
      if (spent === null) {
        unpricedRounds += 1
        unpricedSessions.add(session)
        const model = round.model ?? '(no model recorded)'
        unpricedModels.set(model, (unpricedModels.get(model) ?? 0) + 1)
      }
      const cost = spent ?? 0
      total += cost
      let entry = bySession.get(round.session)
      if (entry === undefined) {
        entry = { cost: 0, recon: 0 }
        bySession.set(round.session, entry)
      }
      entry.cost += cost
      entry.recon += costByCategory(labelled.get(round) ?? [], cost).get('reconstruction') ?? 0

      const tools = round.tools ?? []
      for (const tool of tools) {
        if (!failed(tool)) continue
        errorCalls += 1
        errorCost += cost / tools.length
        errorSessions.add(session)
        errorTools.set(tool.name ?? '(unnamed)', (errorTools.get(tool.name ?? '(unnamed)') ?? 0) + 1)
      }
    }
    for (const entry of bySession.values()) {
      if (entry.cost > 0 && entry.recon / entry.cost > thresholds.reconstruction) {
        reconCount += 1
        reconCost += entry.recon
      }
    }
  }

  const context = contextOf(projects, pricing, thresholds.context)
  const contextSessions = new Set(context.over.map((task) => `${task.slug}\u0000${task.session}`))
  const contextCost = context.over.reduce((sum, task) => sum + task.cost, 0)
  const contextCompactions = context.over.reduce((sum, task) => sum + task.compactions, 0)

  let reasked = 0
  let reaskedCost = 0
  const reaskedSessions = new Set<string>()
  let abandoned = 0
  let abandonedCost = 0
  const abandonedSessions = new Set<string>()
  // Both read every call, and trails every result body too, which made this the slowest page in
  // the view; so the two findings drawn from them are found under `--debug` only. See `debug.ts`.
  for (const one of debugOn() ? projects : []) {
    if (one.rounds.length === 0) continue
    const costs = roundIndex(one.rounds, pricing)
    for (const question of questionsFor(one)) {
      const first = question.calls[0]
      if (first === undefined || !costs.has(`${first.session}\u0000${first.round}`)) continue
      if (question.repeats === 0) continue
      reasked += 1
      reaskedCost += callsCost(question.calls, costs)
      reaskedSessions.add(`${one.project.slug}\u0000${question.session}`)
    }
    for (const trail of await trailsFor(one)) {
      const first = trail.steps[0]
      if (first === undefined || !costs.has(`${first.session}\u0000${first.round}`)) continue
      if (trail.outcome !== 'abandoned') continue
      abandoned += 1
      abandonedCost += callsCost(trail.steps, costs)
      abandonedSessions.add(`${one.project.slug}\u0000${trail.session}`)
    }
  }

  const findings: Finding[] = []
  const priced = (finding: Omit<Finding, 'severity'> & { cost: number }): void => {
    findings.push({ ...finding, severity: severityOf(finding.cost, total) })
  }
  if (reconCount > 0) {
    priced({
      id: 'reconstruction',
      count: reconCount,
      unit: plural(reconCount, 'session'),
      sessions: reconCount,
      cost: reconCost,
      threshold: thresholds.reconstruction,
      detail: 'Agents finding their way back around code: reading, searching and listing more than changing anything.',
    })
  }
  if (context.over.length > 0) {
    priced({
      id: 'context',
      count: context.over.length,
      unit: plural(context.over.length, 'task'),
      sessions: contextSessions.size,
      cost: contextCost,
      threshold: thresholds.context,
      detail:
        contextCompactions === 0
          ? 'None of them was compacted, so each carried the whole context to the end.'
          : `${contextCompactions} ${plural(contextCompactions, 'compaction')} followed.`,
    })
  }
  if (reasked > 0) {
    priced({
      id: 'reasked',
      count: reasked,
      unit: plural(reasked, 'question'),
      sessions: reaskedSessions.size,
      cost: reaskedCost,
      threshold: null,
      detail: 'A call asked, word for word and place for place, something the same question had already asked.',
    })
  }
  if (abandoned > 0) {
    priced({
      id: 'abandoned',
      count: abandoned,
      unit: plural(abandoned, 'trail'),
      sessions: abandonedSessions.size,
      cost: abandonedCost,
      threshold: null,
      detail: 'Searches that ended without an edit or a test run following from them.',
    })
  }
  if (errorCalls > 0) {
    const top = [...errorTools.entries()].sort((a, b) => b[1] - a[1])[0]
    priced({
      id: 'errors',
      count: errorCalls,
      unit: plural(errorCalls, 'tool call'),
      sessions: errorSessions.size,
      cost: errorCost,
      threshold: null,
      detail: top === undefined ? '' : `Most were ${top[0]} (${top[1]}).`,
    })
  }
  findings.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))
  if (unpricedRounds > 0) {
    const models = [...unpricedModels.entries()].sort((a, b) => b[1] - a[1])
    findings.push({
      id: 'unpriced',
      severity: 'info',
      count: unpricedRounds,
      unit: plural(unpricedRounds, 'round'),
      sessions: unpricedSessions.size,
      cost: null,
      threshold: null,
      detail: `${models
        .slice(0, 3)
        .map(([model]) => model)
        .join(', ')}${models.length > 3 ? ` and ${models.length - 3} more` : ''} ${models.length === 1 ? 'has' : 'have'} no rate in Settings, so ${unpricedRounds === 1 ? 'its' : 'their'} cost is left out.`,
    })
  }

  let synced: string | null = null
  for (const { project } of projects) {
    const at = project.imported_at ?? project.collected_at
    if (at !== null && (synced === null || at > synced)) synced = at
  }

  return { scope: shownScope(scope, projects), findings, thresholds, total, synced_at: synced }
}

/* Thresholds ------------------------------------------------------------------------------------- */

export interface ThresholdsPayload {
  thresholds: Thresholds
  defaults: Thresholds
  /** Where they are kept, written `~/…`. */
  file: string
}

export async function thresholdsPayload(dataDir: string): Promise<ThresholdsPayload> {
  return {
    thresholds: await readThresholds(dataDir),
    defaults: { ...DEFAULT_THRESHOLDS },
    file: shorten(findingsFile(dataDir)),
  }
}

export async function saveThresholds(dataDir: string, body: unknown): Promise<ThresholdsPayload> {
  const sent = thresholdsFrom(body)
  if (typeof sent === 'string') throw new BadRequest(sent)
  await writeThresholds(dataDir, sent)
  return thresholdsPayload(dataDir)
}
