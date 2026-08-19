/**
 * A run of calls, read as a walk through the repository.
 *
 * `act.ts` reads one call down to what it mechanically did, and `classify.ts` says what kind of work
 * that is. Both answer a question about a single call, on purpose: `classify.ts` gave up its
 * `review` category to make a round labellable on its own. This asks the question neither can,
 * because it is not about a call at all.
 *
 * An agent asked to build a feature it has never seen does not open the right file. It finds it: it
 * lists the tree, opens what the listing named, greps for a word, then reads the lines the grep hit.
 * Every one of those calls is `reconstruction` and the tally is true and says nothing — it cannot
 * tell nine hops of a directed search from nine unrelated file opens. What is missing is the shape:
 * how deep the search went, how wide it fanned, what it started from, and whether it ended anywhere.
 *
 * So a trail is a *graph*. Nodes are calls, edges are "this call opened something that call knew
 * about", and every edge names the reason it exists. Nothing here is scored. Membership is a rule
 * you can read, and depth, breadth, root and outcome are each one rule you can disagree with in one
 * place — the same bargain the classifier's table makes.
 *
 * Nothing here executes, resolves or reads a disk. Result bodies, when they are available, arrive
 * as a map the caller built. A step that cannot be explained gets no source rather than a guessed
 * one, since an invented edge is worse than a missing one.
 */

import { isProse, pathOf, pathsIn, targetOf, writesToFile } from './act.js'
import type { Verb } from './act.js'
import { actsOf } from './act.js'
import { commandOf, parsePlaced } from './bash.js'
import type { Placed } from './bash.js'
import type { Round, ToolCall } from './types.js'

// ---------------------------------------------------------------------------------------------
// What one call reached
// ---------------------------------------------------------------------------------------------

/**
 * How wide a call reached.
 *
 * This is the narrowing axis, and narrowing is most of what separates a walk from a scatter.
 * `find .` reaches a tree, `grep -rn x src/` a directory, `cat a.ts` a file, `sed -n 85,110p a.ts`
 * a span of one. A search that goes tree → dir → file → span is doing the thing this module exists
 * to name; four unrelated file reads are not.
 */
export type Scope = 'tree' | 'dir' | 'file' | 'span'

const SCOPE_RANK: Record<Scope, number> = { tree: 3, dir: 2, file: 1, span: 0 }

/** Verbs that are part of finding something out. A trail is made of these and nothing else. */
const FINDING = new Set<Verb>(['search', 'read', 'query'])

/** Verbs that end a search by acting on what it found. */
const ACTING = new Set<Verb>(['write', 'move'])
const CHECKING = new Set<Verb>(['test', 'build', 'run'])

/** Programs that search text. Their pattern is the edge label of a `probe`. */
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack'])

/** Programs that enumerate a tree without being given a word to look for. */
const LISTERS = new Set(['find', 'ls', 'tree', 'fd', 'locate'])

/**
 * Searcher flags whose value is itself a pattern. `-e` is the reason this is not just "skip the
 * flag": `grep -e foo -e bar` has two patterns and no bare argument at all.
 */
const PATTERN_FLAGS = new Set(['-e', '--regexp'])

/**
 * Searcher flags that swallow the token after them without it being a pattern. Without this,
 * `rg --type ts flush` names `ts` as what was being looked for.
 */
const SEARCH_VALUE_FLAGS = new Set([
  '-f', '--file', '--include', '--exclude', '--exclude-dir', '-m', '--max-count',
  '-A', '-B', '-C', '--after-context', '--before-context', '--context',
  '-g', '--glob', '-t', '--type', '--color', '--colour', '-d', '--directories',
])

/** `find` predicates whose value is a name to match, which is the same thing as a pattern. */
const FIND_NAME_FLAGS = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-regex'])

/**
 * A word long enough to identify a file.
 *
 * A probe is only useful here if it can be matched against a path, so a pattern is reduced to the
 * identifiers in it and the short ones are dropped. `deepEqual` and `delivery` survive;
 * `^not ok 52` reduces to nothing, which is right — that is a filter on test output, not a question
 * about the repository. Four characters is the shortest word that is about something.
 */
const TERM = /[A-Za-z_][A-Za-z0-9_]{3,}/g

/** Arguments of one command piece, with quotes read and removed. */
function tokenize(segment: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | null = null
  let started = false

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!
    if (quote !== null) {
      if (ch === '\\' && quote !== "'") {
        const next = segment[i + 1]
        if (next !== undefined) {
          current += next
          i += 1
        }
        continue
      }
      if (ch === quote) {
        quote = null
        continue
      }
      current += ch
      started = true
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      started = true
      continue
    }
    if (ch === '\\') {
      const next = segment[i + 1]
      if (next !== undefined) {
        current += next
        i += 1
      }
      continue
    }
    if (/\s/.test(ch)) {
      if (started) {
        out.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (started) out.push(current)
  return out
}

/** The identifiers in a pattern that could name a file. */
function termsOf(pattern: string): string[] {
  return (pattern.match(TERM) ?? []).map((term) => term.toLowerCase())
}

/**
 * What one command piece was looking for, or nothing.
 *
 * The pipe check is the whole reason this reads placed commands rather than named ones.
 * `grep -rn flush src` asks the repository a question; the `grep` in `npm test | grep "^not ok"`
 * reads output that already exists. They are the same program and only the first is a probe, and in
 * a real store the second is the commoner of the two by a wide margin — counted as a probe it would
 * root a trail at every test run.
 */
function probesOfCommand(placed: Placed): string[] {
  const [head] = placed.name.split(' ')
  if (head === undefined || placed.piped) return []

  const tokens = tokenize(placed.text)
  const out: string[] = []

  if (SEARCHERS.has(head)) {
    let bare: string | null = null
    for (let i = 1; i < tokens.length; i += 1) {
      const token = tokens[i]!
      if (PATTERN_FLAGS.has(token)) {
        const value = tokens[i + 1]
        if (value !== undefined) out.push(...termsOf(value))
        i += 1
        continue
      }
      if (SEARCH_VALUE_FLAGS.has(token)) {
        i += 1
        continue
      }
      if (token.startsWith('-')) continue
      // The first bare argument is the pattern; everything after it is where to look.
      if (bare === null) bare = token
    }
    if (out.length === 0 && bare !== null) out.push(...termsOf(bare))
    return out
  }

  if (head === 'find') {
    for (let i = 1; i < tokens.length; i += 1) {
      if (!FIND_NAME_FLAGS.has(tokens[i]!)) continue
      // A negated predicate says where *not* to look. `find . -not -path '*/node_modules/*'` is
      // not a search for node_modules, and reading it as one names the one directory the command
      // went out of its way to avoid.
      const before = tokens[i - 1]
      if (before === '-not' || before === '!') {
        i += 1
        continue
      }
      const value = tokens[i + 1]
      if (value !== undefined) out.push(...termsOf(value))
      i += 1
    }
    return out
  }

  return out
}

/** What a call was looking for: the words it asked the repository about. */
export function probesIn(tool: ToolCall): string[] {
  const name = typeof tool.name === 'string' ? tool.name : ''
  if (name === 'Grep' || name === 'Glob') {
    const input = tool.input
    if (input === null || typeof input !== 'object') return []
    const pattern = (input as Record<string, unknown>).pattern
    return typeof pattern === 'string' ? termsOf(pattern) : []
  }
  if (name !== 'Bash') return []
  const out = new Set<string>()
  for (const placed of parsePlaced(commandOf(tool.input))) {
    for (const term of probesOfCommand(placed)) out.add(term)
  }
  return [...out]
}

/**
 * Every path a call names.
 *
 * `bashActs` computes exactly this and keeps the first one, because a call has one target and the
 * first recognizable path is the honest stand-in for it. A walk needs all of them: `cat` over five
 * files is five nodes visited, not one.
 */
export function sitesIn(tool: ToolCall): string[] {
  const name = typeof tool.name === 'string' ? tool.name : ''
  if (name !== 'Bash') {
    const out: string[] = []
    const direct = pathOf(tool.input)
    if (direct !== '') out.push(direct)
    const input = tool.input
    if (input !== null && typeof input === 'object') {
      const where = (input as Record<string, unknown>).path
      if (typeof where === 'string' && where !== '' && where !== direct) out.push(where)
    }
    return out
  }

  const raw = commandOf(tool.input)
  const text = typeof raw === 'string' ? raw : ''
  if (text === '') return []
  const words = new Set(parsePlaced(raw).flatMap((placed) => placed.name.split(' ')))
  const found = pathsIn(text, words)
  // A heredoc body is data to `pathsIn`, which cuts the command at `<<`, so a script that rewrites
  // a file names it nowhere an argument scan can reach. `writesToFile` reads the body for exactly
  // that, and without it every `python3 - <<'PY'` edit is a step that touched nothing — which is
  // how a walk that ended in a change reads as abandoned.
  const wrote = writesToFile(text)
  if (wrote !== null && wrote !== '') found.unshift(wrote)
  return [...new Set(found)]
}

/** Whether a path names a directory rather than a file, as far as a reader can tell without one. */
function looksLikeDirectory(path: string): boolean {
  if (path.endsWith('/')) return true
  const base = path.slice(path.lastIndexOf('/') + 1)
  return !base.includes('.')
}

/** Whether a command reached everything under something rather than something named. */
function isRecursive(placed: Placed, tokens: string[]): boolean {
  const [head] = placed.name.split(' ')
  if (head === 'find' || head === 'tree' || head === 'fd' || head === 'rg' || head === 'ag') {
    return true
  }
  if (head === 'ls') return tokens.some((token) => /^-[A-Za-z]*R/.test(token))
  if (SEARCHERS.has(head ?? '')) {
    return tokens.some((token) => /^-[A-Za-z]*[rR]/.test(token) || token === '--recursive')
  }
  return false
}

/** Whether a command asked for a range of lines rather than a whole file. */
function isSpan(placed: Placed, tokens: string[]): boolean {
  const [head] = placed.name.split(' ')
  if (head === 'sed') return tokens.some((token) => /^-[A-Za-z]*n/.test(token))
  if (head === 'head' || head === 'tail') return !placed.piped
  return false
}

/** How wide a call reached. The widest thing it touched decides, since that is what it cost. */
export function scopeOf(tool: ToolCall, sites: string[]): Scope {
  const name = typeof tool.name === 'string' ? tool.name : ''

  if (name === 'Glob') return 'tree'
  if (name === 'Grep') {
    const target = sites[0]
    return target === undefined || looksLikeDirectory(target) ? 'tree' : 'file'
  }
  if (name === 'Read') {
    const input = tool.input
    const offset =
      input !== null && typeof input === 'object'
        ? (input as Record<string, unknown>).offset
        : undefined
    return typeof offset === 'number' ? 'span' : 'file'
  }
  if (name !== 'Bash') return sites.length > 0 ? 'file' : 'dir'

  let widest: Scope = sites.length > 0 ? 'file' : 'dir'
  let narrowest: Scope | null = null
  for (const placed of parsePlaced(commandOf(tool.input))) {
    const tokens = tokenize(placed.text)
    if (isRecursive(placed, tokens)) {
      // A recursive walk that was pointed at a directory reached that directory; pointed at the
      // checkout, or at nothing, it reached the tree.
      const under = sites.find((site) => looksLikeDirectory(site))
      widest = under !== undefined && sites.length > 0 && under !== '.' ? 'dir' : 'tree'
      if (SCOPE_RANK[widest] === SCOPE_RANK.tree) break
      continue
    }
    if (isSpan(placed, tokens) && sites.length > 0) narrowest = 'span'
    if (LISTERS.has(placed.name.split(' ')[0] ?? '')) {
      if (SCOPE_RANK[widest] < SCOPE_RANK.dir) widest = 'dir'
    }
  }
  if (narrowest !== null && SCOPE_RANK[widest] <= SCOPE_RANK.file) return narrowest
  return widest
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

/** Why one step follows another. Every edge names its evidence; there is no unlabelled edge. */
export type EdgeKind =
  /** The earlier call's result body named this path. Proof, and only available with the logs. */
  | 'listed'
  /** The earlier call asked about a word this path carries. `grep delivery` then `delivery.ts`. */
  | 'probe'
  /** The earlier call named this same path, and this one reached less of it. */
  | 'narrow'

/** One call, as a node in a walk. */
export interface Step {
  session: string
  /** Index of the round within its session. */
  round: number
  task: number
  /** `<task>.<round>`, the selector `probez round` takes. */
  ref: string
  /** Position of the call within its task, which is what edges point at. */
  at: number
  /** The call's id, which is how a result body is found for it. */
  id: string | null
  tool: string
  /** The command, for a `Bash` call, or the tool name again. What the step reads as. */
  name: string
  verb: Verb
  scope: Scope
  sites: string[]
  probes: string[]
  /** Where this step came from, or null for a root. */
  source: number | null
  edge: EdgeKind | null
  /** The path or word that links it to its source, so the edge can be read rather than trusted. */
  via: string
  /** Share of its round's cost this call carries, on the same even split `classifyRound` uses. */
  share: number
  ms: number | null
  result_chars: number | null
}

/** The single act a call is, for the purposes of a walk. A call that did several is its widest. */
function verbOf(tool: ToolCall): Verb {
  const acts = actsOf(tool)
  let found: Verb = 'unknown'
  for (const one of acts) {
    if (ACTING.has(one.verb) || CHECKING.has(one.verb)) return one.verb
    if (FINDING.has(one.verb) && !FINDING.has(found)) found = one.verb
  }
  return found
}

/** The name a step reads as: what the call ran, or the tool that has no finer level. */
function nameOf(tool: ToolCall): string {
  const name = typeof tool.name === 'string' ? tool.name : '(unnamed)'
  if (name !== 'Bash') return name
  const placed = parsePlaced(commandOf(tool.input))
  const real = placed.find((one) => one.kind !== 'nav' && one.kind !== 'shell')
  return (real ?? placed[0])?.name ?? name
}

/** Every call in one task, in order, as nodes with no edges yet. */
function stepsOf(rounds: Round[]): Step[] {
  const out: Step[] = []
  for (const round of rounds) {
    const tools = round.tools ?? []
    if (tools.length === 0) continue
    const share = 1 / tools.length
    for (const tool of tools) {
      const sites = sitesIn(tool)
      out.push({
        session: round.session,
        round: round.round,
        task: round.task,
        ref: `${round.task}.${round.round}`,
        at: out.length,
        id: tool.id,
        tool: typeof tool.name === 'string' ? tool.name : '(unnamed)',
        name: nameOf(tool),
        verb: verbOf(tool),
        scope: scopeOf(tool, sites),
        sites,
        probes: probesIn(tool),
        source: null,
        edge: null,
        via: '',
        share,
        ms: tool.ms,
        result_chars: tool.result_chars,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------------------------

/**
 * How far back a step will look for what explains it.
 *
 * Reported as a choice rather than a measurement, like `traceOf`'s window. Unbounded within a task
 * is defensible — a task is one question — but a 200-round task would then let a `find` at call 3
 * explain a read at call 180, which is not provenance, it is coincidence. Thirty calls is wide
 * enough for the shape this exists to catch: in the session that prompted this module, the widest
 * real edge spanned seventeen.
 */
export const DEFAULT_LOOKBACK = 30

/** A path's last segment, lowercased and stripped of its extension: what a probe is matched to. */
function stem(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/**
 * Whether an earlier step explains a later one, and how.
 *
 * The kinds are tried strongest first. `listed` is proof — the path was in the output, so the agent
 * had it. `probe` and `narrow` are inference from inputs alone, which is all `rounds.jsonl` can
 * support, and they are the reason a trail carries its confidence.
 */
function edgeBetween(
  from: Step,
  to: Step,
  results: ReadonlyMap<string, string> | undefined,
): { edge: EdgeKind; via: string } | null {
  if (to.sites.length === 0) return null

  const body = from.id === null ? undefined : results?.get(from.id)
  if (body !== undefined && body !== '') {
    for (const site of to.sites) {
      if (site !== '' && body.includes(site)) return { edge: 'listed', via: site }
    }
  }

  if (from.probes.length > 0) {
    for (const site of to.sites) {
      const name = stem(site)
      const hit = from.probes.find((probe) => name.includes(probe))
      if (hit !== undefined) return { edge: 'probe', via: hit }
    }
  }

  // Containment is the half of this the store can see with no logs at all, and it is the commonest
  // real narrowing: `grep -rn deepEqual tests/` then `sed -n 85,110p tests/app.test.ts` never
  // repeats a path, but the second is plainly inside the first. Requiring the two strings to match
  // would miss every search that was pointed at a directory, which is most of them.
  for (const site of to.sites) {
    const under = from.sites.find((wider) => sitsUnder(site, wider))
    if (under !== undefined) return { edge: 'narrow', via: under }
  }

  // The same path reached *less* of is following it in. The same path reached the same amount of is
  // paging, and it is not a walk: five `Read`s with offsets down one file used to chain into a
  // depth-five trail visiting one place, which was the largest false positive in a real store. A
  // step has to go somewhere to be a step.
  if (SCOPE_RANK[to.scope] < SCOPE_RANK[from.scope]) {
    for (const site of to.sites) {
      if (from.sites.includes(site)) return { edge: 'narrow', via: site }
    }
  }

  return null
}

/** Whether a path sits inside a directory another step reached. */
function sitsUnder(path: string, directory: string): boolean {
  if (directory === '' || !looksLikeDirectory(directory)) return false
  const prefix = directory.endsWith('/') ? directory : `${directory}/`
  return path.startsWith(prefix) && path.length > prefix.length
}

/**
 * Attach every finding step to the most recent earlier step that explains it.
 *
 * Most recent, and not every one that could: a single `find .` can explain everything downstream of
 * it, and letting it do so collapses a whole task into one node with sixty children. Provenance is
 * the last place the agent could have learned something, which is also how a person would answer.
 */
function link(steps: Step[], results: ReadonlyMap<string, string> | undefined, lookback: number): void {
  for (const [at, step] of steps.entries()) {
    if (!FINDING.has(step.verb)) continue
    for (let j = at - 1; j >= Math.max(0, at - lookback); j -= 1) {
      const from = steps[j]!
      if (!FINDING.has(from.verb)) continue
      const found = edgeBetween(from, step, results)
      if (found === null) continue
      step.source = j
      step.edge = found.edge
      step.via = found.via
      break
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Trails
// ---------------------------------------------------------------------------------------------

/** How a walk began: what the first step had to go on. */
export type Root = 'listing' | 'probe' | 'doc' | 'path'

/** How a walk ended. */
export type Outcome = 'edit' | 'test' | 'abandoned'

export interface Trail {
  session: string
  task: number
  /** `<task>.<round>` of the first step. A trail is asked for by where it started. */
  ref: string
  /** `<task>.<round>` of the last step. */
  last: string
  steps: Step[]
  /**
   * Longest chain of edges, counting the root. Two is one hop: something was found, then opened.
   * Depth is how far the search went; `breadth` is how wide, and they are different animals.
   */
  depth: number
  /** The most steps any single step explains. A fan-out from one listing is wide and shallow. */
  breadth: number
  root: Root
  /** Distinct paths visited. */
  paths: number
  /** Paths visited by more than one step, which is backtracking. */
  revisits: number
  outcome: Outcome
  /** The path the outcome acted on, or `''` when nothing acted on anything. */
  ended_on: string
  ms: number
  in_tokens: number
  out_tokens: number
  /** Whether any edge was read out of a result body, or all of them inferred from inputs. */
  confidence: 'proven' | 'inferred'
}

/** The fewest calls that can be a walk. Two calls is a pair; three is a path with a middle. */
export const MIN_STEPS = 3
/** The fewest hops. One is "found it and opened it", which is the shortest real traversal. */
export const MIN_DEPTH = 2
/** The fewest places. A walk that never leaves one file is reading a file, however many calls. */
export const MIN_PATHS = 2

export interface TrailOptions {
  /** Result bodies by tool call id. Absent means shallow: edges are inferred from inputs alone. */
  results?: ReadonlyMap<string, string>
  lookback?: number
  minSteps?: number
  minDepth?: number
  minPaths?: number
}

/** What the first step of a walk had to go on. */
function rootOf(step: Step): Root {
  if (step.scope === 'tree' || LISTERS.has(step.name.split(' ')[0] ?? '')) return 'listing'
  if (step.probes.length > 0) return 'probe'
  if (step.sites.some((site) => isProse(site))) return 'doc'
  return 'path'
}

/**
 * How a walk ended.
 *
 * Read forwards from the last step of the trail, through the rest of the task. A write to something
 * the walk visited is the answer it was looking for; a suite or a build reached without one is work
 * checked rather than changed; nothing at all means the search did not pay for itself here. The
 * paths are what makes this a claim rather than a coincidence — a write to an unrelated file after
 * a search is not that search's outcome.
 */
function outcomeOf(steps: Step[], after: number, visited: Set<string>): { outcome: Outcome; on: string } {
  let checked = false
  for (let i = after + 1; i < steps.length; i += 1) {
    const step = steps[i]!
    if (ACTING.has(step.verb)) {
      const hit = step.sites.find((site) => visited.has(site))
      if (hit !== undefined) return { outcome: 'edit', on: hit }
      continue
    }
    if (CHECKING.has(step.verb)) checked = true
  }
  return { outcome: checked ? 'test' : 'abandoned', on: '' }
}

/**
 * Every walk in a span of rounds.
 *
 * Adjacency is deliberately not the rule. A trail is what the evidence connects, so a write or a
 * test run between two linked reads does not break the walk — the agent went back to it. That is
 * the difference between this and `traceOf`, which collapses *consecutive* rounds and cannot see a
 * search that was interrupted and resumed.
 */
export function trailsOf(rounds: Round[], options: TrailOptions = {}): Trail[] {
  const lookback = Math.max(1, Math.round(options.lookback ?? DEFAULT_LOOKBACK))
  const minSteps = Math.max(2, Math.round(options.minSteps ?? MIN_STEPS))
  const minDepth = Math.max(1, Math.round(options.minDepth ?? MIN_DEPTH))
  const minPaths = Math.max(1, Math.round(options.minPaths ?? MIN_PATHS))

  const ordered = [...rounds].sort(
    (a, b) => a.session.localeCompare(b.session) || a.round - b.round,
  )

  // A new user turn is a new question, so a walk never crosses one.
  const byTask = new Map<string, Round[]>()
  for (const round of ordered) {
    const key = `${round.session}\0${round.task}`
    const group = byTask.get(key)
    if (group === undefined) byTask.set(key, [round])
    else group.push(round)
  }

  const out: Trail[] = []
  for (const group of byTask.values()) {
    const steps = stepsOf(group)
    if (steps.length < minSteps) continue
    link(steps, options.results, lookback)
    out.push(...assemble(steps, group, minSteps, minDepth, minPaths))
  }
  return out
}

/** Turn linked steps into the walks they form. */
function assemble(
  steps: Step[],
  rounds: Round[],
  minSteps: number,
  minDepth: number,
  minPaths: number,
): Trail[] {
  // A step belongs to its source's walk, and a step with no source starts one. Sources always sit
  // earlier in the array, so one forward pass resolves every membership.
  const owner = new Map<number, number>()
  const depths = new Map<number, number>()
  const children = new Map<number, number>()
  for (const step of steps) {
    if (!FINDING.has(step.verb)) continue
    if (step.source === null) {
      owner.set(step.at, step.at)
      depths.set(step.at, 1)
      continue
    }
    const root = owner.get(step.source)
    if (root === undefined) continue
    owner.set(step.at, root)
    depths.set(step.at, (depths.get(step.source) ?? 1) + 1)
    children.set(step.source, (children.get(step.source) ?? 0) + 1)
  }

  const groups = new Map<number, Step[]>()
  for (const step of steps) {
    const root = owner.get(step.at)
    if (root === undefined) continue
    const group = groups.get(root)
    if (group === undefined) groups.set(root, [step])
    else group.push(step)
  }

  const cost = costOf(rounds)
  const out: Trail[] = []
  for (const [root, group] of groups) {
    if (group.length < minSteps) continue
    const depth = Math.max(...group.map((step) => depths.get(step.at) ?? 1))
    if (depth < minDepth) continue

    const seen = new Map<string, number>()
    for (const step of group) {
      for (const site of new Set(step.sites)) seen.set(site, (seen.get(site) ?? 0) + 1)
    }
    if (seen.size < minPaths) continue
    const visited = new Set(seen.keys())
    const first = group[0]!
    const last = group[group.length - 1]!
    const ended = outcomeOf(steps, last.at, visited)

    let ms = 0
    let inTokens = 0
    let outTokens = 0
    for (const step of group) {
      const per = cost.get(`${step.session}\0${step.round}`)
      if (per === undefined) continue
      ms += per.ms * step.share
      inTokens += per.in * step.share
      outTokens += per.out * step.share
    }

    out.push({
      session: first.session,
      task: first.task,
      ref: first.ref,
      last: last.ref,
      steps: group,
      depth,
      breadth: Math.max(...group.map((step) => children.get(step.at) ?? 0), 0),
      root: rootOf(steps[root]!),
      paths: seen.size,
      revisits: [...seen.values()].filter((count) => count > 1).length,
      outcome: ended.outcome,
      ended_on: ended.on,
      ms: Math.round(ms),
      in_tokens: Math.round(inTokens),
      out_tokens: Math.round(outTokens),
      confidence: group.some((step) => step.edge === 'listed') ? 'proven' : 'inferred',
    })
  }
  return out.sort((a, b) => a.steps[0]!.at - b.steps[0]!.at)
}

/** What each round cost, so a step can carry its share of it the way a label does. */
function costOf(rounds: Round[]): Map<string, { ms: number; in: number; out: number }> {
  const out = new Map<string, { ms: number; in: number; out: number }>()
  for (const round of rounds) {
    out.set(`${round.session}\0${round.round}`, {
      ms: round.ms ?? 0,
      in: round.in_tokens ?? 0,
      out: round.out_tokens ?? 0,
    })
  }
  return out
}

/**
 * Whether a call was finding something out, which is the only kind of call a walk is made of.
 *
 * Exported so that a share of finding done inside walks counts its numerator and its denominator by
 * the same rule. Two rules that agree today are two rules that can stop agreeing.
 */
export function isFinding(tool: ToolCall): boolean {
  return FINDING.has(verbOf(tool))
}

/**
 * Every tool call id a deep read would need, for one span of rounds.
 *
 * Kept here rather than in the caller so that what the walk needs and what gets read off disk
 * cannot drift apart. Only finding calls are asked for: a result body is evidence for an edge, and
 * no edge ever leaves a write.
 */
export function idsToRead(rounds: Round[]): Set<string> {
  const out = new Set<string>()
  for (const round of rounds) {
    for (const tool of round.tools ?? []) {
      if (tool.id === null || !isFinding(tool)) continue
      out.add(tool.id)
    }
  }
  return out
}

/** Whether a path is worth showing as a target at all, which `targetOf` already decides. */
export function isKnownPath(path: string): boolean {
  return targetOf(path) !== 'unknown'
}
