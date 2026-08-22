/**
 * What the agent needed to know, and what finding out cost it.
 *
 * `trail.ts` reads a run of calls as a walk: which call opened something an earlier call named.
 * That is a shape, and it is the right question to ask of a search that went somewhere. It is the
 * wrong question to ask of a search that went nowhere. An edge there exists only where a call
 * *narrowed* — a smaller scope, a file under a directory already reached — so asking the same thing
 * a sixth time produces no edge, no step, and no trail. In probez's own store a third of all
 * finding calls are exactly that repeat, and a tenth of them reach a trail. The walk keeps the
 * productive hops and drops the thrash, which is backwards for anyone measuring what navigation
 * costs.
 *
 * So this asks the other question. A *question* is every call that went after one thing the agent
 * needed to know, whether or not any of them narrowed anything. Eleven greps for `out_tokens` in
 * one file are one question that cost eleven calls, not eleven calls that formed no walk. The two
 * modules are not rivals: a trail says how a search was shaped, a question says what it was for and
 * what it came to.
 *
 * Membership is one rule and the kind is one table, the same bargain `classify.ts` makes. Nothing
 * is scored and nothing executes. A question no rule in the table names comes back `other` rather
 * than as the closest guess, because a wrong kind is worse than a named hole.
 */

import { targetOf } from './act.js'
import { costOf, isFindingVerb, sitsUnder, stepsOf } from './trail.js'
import type { Call } from './trail.js'
import type { Round } from './types.js'

// ---------------------------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------------------------

/**
 * What the agent was trying to learn.
 *
 * Six of the seven questions a navigation command can express, plus `other`. The seventh — how does
 * A reach B, the call chain between two named things — is deliberately absent: no grep expresses
 * it, so no reading of a grep can recover it. An agent with that question answers it by reading
 * four files, and those calls arrive here as whatever they literally were. Naming a `path` kind
 * that the evidence can never produce would be a claim about intent that the inputs do not carry.
 */
export type Ask =
  /** Show me this symbol's body. */
  | 'define'
  /** Where is this used. */
  | 'refs'
  /** What does this file declare. */
  | 'outline'
  /** Where does this value travel across layers. */
  | 'flow'
  /** Every artifact naming a concept, code and prose alike — the "four places" question. */
  | 'touches'
  /** What constrains this: the tests that exercise it. */
  | 'covers'
  /** Asked something, but nothing in the table reads it. */
  | 'other'

export const ASKS: Ask[] = ['define', 'refs', 'outline', 'flow', 'touches', 'covers', 'other']

export function isAsk(value: string): value is Ask {
  return (ASKS as string[]).includes(value)
}

/**
 * Words that describe a declaration rather than name one.
 *
 * `grep -n "^export \|^interface \|^function " src/inspect.ts` asks what a file declares. The words
 * it searched for are the language's, not the project's, and a question made only of them is an
 * outline however many of them there are. Without this the same call reads as a four-word
 * alternation sweep, which is the opposite finding — a sweep is the agent guessing at vocabulary it
 * does not have, and this is the agent asking for a table of contents.
 */
const STRUCTURAL = new Set([
  'export', 'exports', 'import', 'imports', 'function', 'interface', 'class', 'const', 'type',
  'types', 'enum', 'func', 'struct', 'impl', 'trait', 'define', 'module', 'package', 'public',
  'private', 'protected', 'static', 'async', 'await', 'return', 'declare', 'namespace', 'abstract',
  'extends', 'implements', 'constructor', 'property', 'method', 'field', 'string', 'number',
  'boolean', 'void', 'null', 'true', 'false',
])

/**
 * How many words at once counts as guessing.
 *
 * `grep -n "advance\|newContext\|CallContext\|classifyCall"` is one call asking four different
 * questions, and it is what an agent does when it has not learned the project's vocabulary yet. Two
 * alternatives is a spelling; three is a guess. Reported as a choice rather than a measurement, the
 * way `trail.ts` reports its lookback.
 */
export const SWEEP_TERMS = 3

/**
 * Which of the six this question was, decided by the first rule that reads it.
 *
 * Order is the design, and each rule is one line you can disagree with in one place.
 *
 * `covers` and `touches` come first, because where a question went outranks what its pattern said:
 * a name searched across the test surface is asking what constrains it, not where it lives. Both
 * ask for *half* the places rather than any of them. An earlier draft asked for any, and a single
 * `arch_test.go` among sixteen files turned an eleven-call sweep of a repository into a question
 * about tests.
 *
 * `outline` then takes the questions that asked for no name at all — a listing, a file opened
 * whole, a grep for the language's own keywords. Its third clause is the one that earns its keep:
 * a question where most of the calls named nothing is an agent reading its way to an understanding,
 * whatever the one call that started it happened to search for.
 *
 * What is left is separated by how the words were asked. A `flow` needs one word in two or more
 * *calls* across three or more places — a single `ls a b c` names three places at once and is a
 * sweep, not a value being followed. Then width: asked of a tree or a directory is `refs`, asked of
 * one or two files is `define`.
 */
function kindOf(terms: string[], files: string[], calls: Call[]): Ask {
  const targets = files.map((file) => targetOf(file))
  const half = (kind: string): boolean =>
    files.length > 0 && targets.filter((one) => one === kind).length * 2 >= files.length
  if (half('tests')) return 'covers'
  if (half('docs')) return 'touches'

  const quiet = calls.filter((call) => call.probes.length === 0).length
  if (terms.length === 0) return 'outline'
  if (terms.every((term) => STRUCTURAL.has(term))) return 'outline'
  if (quiet * 2 > calls.length) return 'outline'

  for (const term of terms) {
    if (STRUCTURAL.has(term)) continue
    const asked = calls.filter((call) => call.probes.includes(term))
    if (asked.length < 2) continue
    const where = new Set<string>()
    for (const call of asked) for (const site of call.sites) where.add(site)
    if (where.size >= 3) return 'flow'
  }
  if (calls.some((call) => call.scope === 'tree' || call.scope === 'dir')) return 'refs'
  if (files.length <= 2) return 'define'
  return 'other'
}

// ---------------------------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------------------------

/** One thing the agent needed to know, and every call it spent finding out. */
export interface Question {
  session: string
  task: number
  /**
   * `<task>.<round>` of the first call. What a question is called, and how it is asked for.
   *
   * Not unique on its own. A round can make several tool calls at once and two of them can start
   * two different questions, which is 5.5% of the questions in the corpora this was built against.
   * `at` is what addresses one exactly; this is what a person reads.
   */
  ref: string
  /**
   * Position of the first call within its task, which is unique across the task's questions.
   *
   * A round number cannot name a question on its own, and neither can anything else a person would
   * type. So the name and the address are two fields rather than one overloaded string.
   */
  at: number
  /** `<task>.<round>` of the last. */
  last: string
  kind: Ask
  /** The words it asked about, in the order it first asked them. */
  terms: string[]
  /** The places it looked. */
  files: string[]
  calls: Call[]
  /**
   * Calls that asked something this question had already asked, word for word and place for place.
   * The waste `trail.ts` cannot see, because a repeat narrows nothing and so forms no edge.
   */
  repeats: number
  /**
   * Calls that only fetched a body for somewhere an earlier call in the question had already named.
   * The second half of `locate, then fetch`: protocol overhead rather than thinking.
   */
  fetches: number
  /** Calls that named three or more different words at once, which is vocabulary guessing. */
  sweeps: number
  ms: number
  in_tokens: number
  out_tokens: number
}

export interface QuestionOptions {
  /** The checkout the calls ran in, so an absolute path and a typed one name one place. */
  root?: string
  window?: number
}

/**
 * How many calls can pass before the same word is a new question.
 *
 * Reported as a choice, like `trail.ts`'s lookback. Unbounded within a task is wrong in a way that
 * is easy to see: a task that greps `store` at call 3 and again at call 90, either side of an edit
 * and a test run, asked two questions and got two answers, and joining them would report one
 * question costing two calls an hour apart. Twelve calls is wide enough for the shape this exists
 * to catch — the eleven-grep run that prompted the module spans eleven.
 *
 * The window is measured from the last call that was *evidence the question is still being asked*:
 * one that named a word, or opened exactly the file the question had named. A call that only opened
 * something under a directory the question swept does not renew it. Without that, one
 * `grep -rn store src/` stays open for as long as anything under `src/` keeps being read, which is
 * the whole task in most repositories.
 */
export const DEFAULT_WINDOW = 12

/** The signature a repeat repeats: the same words asked of the same places. */
function signatureOf(call: Call): string {
  return JSON.stringify([[...call.probes].sort(), [...call.sites].sort()])
}

/** The words in a call that could name something this project owns. */
function namedIn(call: Call): string[] {
  return call.probes.filter((probe) => !STRUCTURAL.has(probe))
}

/** A question under construction, before it is worth reporting. */
interface Open {
  terms: string[]
  /** The project's own words among them, which are the only ones another call can join on. */
  named: string[]
  files: string[]
  seen: Set<string>
  calls: Call[]
  repeats: number
  fetches: number
  /** Position of the last call in it, so the window is measured in calls rather than in rounds. */
  at: number
}

/**
 * Every question one task asked.
 *
 * A call joins the most recent open question that shares one of the project's own words with it, or
 * — when the call named none of them — that already reached the place it opened. That second half
 * is what makes a `sed -n 40,80p` belong to the grep that found line 40 rather than starting a
 * question of its own, and it is the same locate-then-fetch pair `trail.ts` reads as a narrowing.
 * A call that matches nothing open starts a question, which is what a new subject looks like.
 *
 * The words the language owns cannot join anything. `func` is in three unrelated greps in half the
 * Go sessions in a real store, and joining on it folded a search for one tool, a search for a clone
 * URL and a search for a binary path into a single five-call question about nothing. A word has to
 * belong to the project before two calls naming it are asking about the same thing.
 *
 * Most recent and not every match, for the reason `trail.ts` links to the nearest source: one word
 * asked early can otherwise absorb every later call that happens to mention it, and a task collapses
 * into one question that cost forty calls.
 */
export function questionsOf(rounds: Round[], options: QuestionOptions = {}): Question[] {
  const root = options.root ?? ''
  const window = Math.max(1, Math.round(options.window ?? DEFAULT_WINDOW))

  const ordered = [...rounds].sort(
    (a, b) => a.session.localeCompare(b.session) || a.round - b.round,
  )

  // A new user turn is a new question by definition, so nothing here crosses one.
  const byTask = new Map<string, Round[]>()
  for (const round of ordered) {
    const key = `${round.session}\0${round.task}`
    const group = byTask.get(key)
    if (group === undefined) byTask.set(key, [round])
    else group.push(round)
  }

  const out: Question[] = []
  for (const group of byTask.values()) {
    const cost = costOf(group)
    // `stepsOf` returns every call in the task, walk material or not, because a trail reads its
    // outcome off the writes and the test runs that follow. A question is made of finding calls
    // alone, and which those are is `trail.ts`'s rule, asked for rather than restated.
    const finding = stepsOf(group, root)
      .filter((step) => isFindingVerb(step.verb))
      // The edge fields come off here rather than being carried and ignored: a question makes no
      // claim about what put a call where it is, and publishing `source: null` on every one of them
      // would invite a reader to believe it had looked and found nothing.
      .map(({ source, edge, via, ...call }): Call => call)
    const open: Open[] = []

    finding.forEach((call, at) => {
      const named = namedIn(call)
      const within = (one: Open, at2: number): boolean => at2 - one.at <= window

      // A shared word first, and only then a shared place. Tried in that order rather than
      // most-recent-wins across both, or a read that happens to sit under a directory some nearer
      // question swept would outrank the question that actually named the word being chased.
      let found: Open | null = null
      let fetched = false
      // Whether the evidence for the join says the question is still being pursued, or only that
      // the agent is still in the neighbourhood. See the window note below.
      let live = true
      for (let i = open.length - 1; i >= 0 && found === null; i -= 1) {
        const one = open[i]!
        if (within(one, at) && named.some((word) => one.named.includes(word))) found = one
      }
      if (found === null && named.length === 0) {
        // An exact place beats a containing one, for the same reason: `sed -n 40,80p a.ts` belongs
        // to the search that named `a.ts`, not to the one that swept the directory holding it.
        for (const exact of [true, false]) {
          for (let i = open.length - 1; i >= 0 && found === null; i -= 1) {
            const one = open[i]!
            if (!within(one, at)) continue
            const hit = call.sites.some((site) =>
              exact
                ? one.files.includes(site)
                : one.files.some((wider) => sitsUnder(site, wider)),
            )
            if (!hit) continue
            found = one
            live = exact
            // Only a call that asked nothing at all is the fetch half of a pair. One that asked for
            // a file's declarations is a question of its own that happens to share the place.
            fetched = call.probes.length === 0
          }
          if (found !== null) break
        }
      }
      if (found === null) {
        found = {
          terms: [],
          named: [],
          files: [],
          seen: new Set(),
          calls: [],
          repeats: 0,
          fetches: 0,
          at,
        }
        open.push(found)
      }

      const signature = signatureOf(call)
      if (found.seen.has(signature)) found.repeats += 1
      found.seen.add(signature)
      if (fetched) found.fetches += 1
      for (const probe of call.probes) if (!found.terms.includes(probe)) found.terms.push(probe)
      for (const word of named) if (!found.named.includes(word)) found.named.push(word)
      for (const site of call.sites) if (!found.files.includes(site)) found.files.push(site)
      found.calls.push(call)
      // Opening a file that merely sits under a directory the question swept does not renew it.
      // That is where the agent is looking, not what it is still asking, and letting it renew the
      // window lets one `grep -rn x src/` absorb every later read anywhere under `src/` — the same
      // way a top-level `narrow` edge swallows a trail.
      if (live) found.at = at
    })

    for (const one of open) {
      const first = one.calls[0]!
      const last = one.calls[one.calls.length - 1]!

      let ms = 0
      let inTokens = 0
      let outTokens = 0
      for (const call of one.calls) {
        const per = cost.get(`${call.session}\0${call.round}`)
        if (per === undefined) continue
        ms += per.ms * call.share
        inTokens += per.in * call.share
        outTokens += per.out * call.share
      }

      out.push({
        session: first.session,
        task: first.task,
        ref: first.ref,
        at: first.at,
        last: last.ref,
        kind: kindOf(one.terms, one.files, one.calls),
        terms: one.terms,
        files: one.files,
        calls: one.calls,
        repeats: one.repeats,
        fetches: one.fetches,
        sweeps: one.calls.filter((call) => call.probes.length >= SWEEP_TERMS).length,
        ms: Math.round(ms),
        in_tokens: Math.round(inTokens),
        out_tokens: Math.round(outTokens),
      })
    }
  }

  return out.sort(
    (a, b) => a.session.localeCompare(b.session) || a.task - b.task || a.calls[0]!.at - b.calls[0]!.at,
  )
}

// ---------------------------------------------------------------------------------------------
// Shares
// ---------------------------------------------------------------------------------------------

/** What a project's questions cost, as one row. */
export interface QuestionShare {
  questions: number
  /** Every call that was finding something out. The denominator, and the same one trails use. */
  calls: number
  repeats: number
  fetches: number
  sweeps: number
  /** Questions that took more than one call to answer. */
  reasked: number
  /** The costliest question in the span, which is the one worth reading first. */
  worst: Question | null
}

/**
 * What finding things out cost, counted by the thing being found out rather than by the call.
 *
 * This is the number a tally of `reconstruction` cannot give and a trail share does not either:
 * not how much of the finding was directed, but how many separate things the agent had to learn and
 * how many calls each one took. One call per question is an agent that knows where it is. Eleven is
 * a repository it cannot ask.
 */
export function questionShare(rounds: Round[], options: QuestionOptions = {}): QuestionShare {
  const questions = questionsOf(rounds, options)
  let worst: Question | null = null
  for (const question of questions) {
    if (worst === null || question.calls.length > worst.calls.length) worst = question
  }
  return {
    questions: questions.length,
    calls: questions.reduce((sum, question) => sum + question.calls.length, 0),
    repeats: questions.reduce((sum, question) => sum + question.repeats, 0),
    fetches: questions.reduce((sum, question) => sum + question.fetches, 0),
    sweeps: questions.reduce((sum, question) => sum + question.sweeps, 0),
    reasked: questions.filter((question) => question.calls.length > 1).length,
    worst,
  }
}
