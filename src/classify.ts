/**
 * What kind of work a round did.
 *
 * `act.ts` reads a tool call down to the mechanical operations it performed: opened a file, wrote
 * one, ran a suite, committed. This decides what kind of *work* each of those is. That is the whole
 * job, and it is one table: a verb goes in, a category and a sub-kind come out.
 *
 * Two rules keep the taxonomy honest:
 *
 * 1. A category is the shape of the act. The target is what the act was done to. "Read the router"
 *    and "read a vendored README" differ in target, and only the second is prose, which is the one
 *    place a path changes the category rather than only the target.
 * 2. Reading is never writing. Reading `CHANGELOG.md` is planning; writing it is documentation.
 *
 * Nothing here executes or resolves anything, and nothing here calls a model. Every label is a
 * lookup, and a label you disagree with is one row to change rather than a rule to trace.
 *
 * What is deliberately absent is as load-bearing as what is here. There is still no `repair`
 * category: `is_error` is a harness-level flag, so a Bash call running a suite with 47 failures
 * comes back `is_error: false`. The store now keeps `stderr_chars` and `interrupted`, which is the
 * signal that was missing, but a category is a claim about what work *was* and that needs rules
 * written against the new field rather than the old one renamed. There is no `trace` sub-kind: it
 * would mean "this file was opened because of a symbol found in that one", which needs result
 * bodies the store does not keep. Both would have been buckets that only ever looked full.
 *
 * `review` was here and is gone. It existed to hold one rule — that a `git diff` after an edit is
 * checking your work and the same command before one is orienting — and paying for that rule meant
 * every round carrying the history of its task. Read-only git is now unconditionally reconstruction,
 * which costs a distinction that was never load-bearing and buys a classifier where a round can be
 * labelled on its own.
 *
 * `reconstruction/mcp` is the one row here that is a placement rather than a reading. `act.ts` can
 * tell that a call went to an MCP server and nothing else: the tool after `mcp__<server>__` is
 * whatever someone configured, so no built-in table can say whether it read a Figma file or filed a
 * Jira ticket. Reconstruction is where the bulk of them sit — an agent reaches for a server to find
 * out something the repo does not hold — and it is the honest default, but a server that writes is
 * filed under reading it. The sub-kind is kept separate from `inspect` precisely so that share stays
 * visible and can be moved wholesale if a store says otherwise. Before this, all of it was
 * `unclassified/unknown`.
 */

import { actsOf, documentSub, isProse } from './act.js'
import type { Act, Target, Verb } from './act.js'
import type { Round, ToolCall } from './types.js'

export type { Act, Target, Verb } from './act.js'
export { isTarget, pathOf, pathsIn, targetOf, TARGETS, VERBS, writesToFile } from './act.js'

export type Category =
  | 'planning'
  | 'reconstruction'
  | 'implementation'
  | 'testing'
  | 'documentation'
  | 'delivery'
  | 'environment'
  | 'unclassified'

export interface CategoryInfo {
  id: Category
  /** How the category is written in a table. */
  label: string
  /** How it is written where a column is too narrow for the label. */
  short: string
  /** Every sub-kind the table below can produce, in the order they are worth reading. */
  subs: string[]
}

/**
 * The categories, in the order work tends to happen.
 *
 * `planning` counts prose reads as well as the harness transitions around a plan, which makes it
 * the one category whose meaning is wider than its name suggests: it is time spent on what the work
 * should be, whether that was spent deciding or spent reading someone else's decision. It is also
 * the reason a planning share from before 0.3.2 is not comparable to one after — the old number
 * counted only the transitions, and those are near 1% of any store.
 *
 * `environment` stays small and stays named. A named 1% is worth more than an unnamed one, because
 * the alternative is `npm install` being indistinguishable from a tool nothing recognized. Its
 * third sub-kind, `infra`, is that argument applied again: `kubectl`, `terraform`, `aws` and the
 * rest of the container and cloud CLIs used to land in `unclassified/unknown`, which said only that
 * nothing recognized them. Working on the machines the code runs on is not the same work as
 * changing the code, and it is not nothing.
 */
export const CATEGORIES: CategoryInfo[] = [
  {
    id: 'planning',
    label: 'Planning',
    short: 'Plan',
    subs: ['read', 'clarify', 'decompose', 'design'],
  },
  {
    id: 'reconstruction',
    label: 'Reconstruction',
    short: 'Recon',
    subs: ['locate', 'graph', 'read', 'inspect', 'mcp'],
  },
  { id: 'implementation', label: 'Implementation', short: 'Impl', subs: ['create', 'modify'] },
  { id: 'testing', label: 'Testing', short: 'Test', subs: ['test', 'run'] },
  { id: 'documentation', label: 'Documentation', short: 'Docs', subs: ['system', 'change', 'agent'] },
  {
    id: 'delivery',
    label: 'Delivery',
    short: 'Deliv',
    subs: ['build', 'commit', 'publish', 'branch'],
  },
  { id: 'environment', label: 'Environment', short: 'Env', subs: ['deps', 'env', 'infra'] },
  { id: 'unclassified', label: 'Unclassified', short: 'Uncl', subs: ['incidental', 'unknown'] },
]

const CATEGORY_IDS: Category[] = CATEGORIES.map((info) => info.id)

export function categoryInfo(id: Category): CategoryInfo {
  // Every id in the type has a row, so this is a lookup rather than a search that can fail.
  return CATEGORIES.find((info) => info.id === id) as CategoryInfo
}

export function isCategory(value: string): value is Category {
  return (CATEGORY_IDS as string[]).includes(value)
}

/** One labelled unit of work. Weights within a round sum to 1, or to 0 when nothing ran. */
export interface Label {
  category: Category
  sub: string
  target: Target
  weight: number
  /**
   * What produced this label: a tool name, or a command name. Kept so `analyze --unclassified` can
   * name what it could not classify instead of reporting a share with nothing behind it.
   */
  source: string
}

// ---------------------------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------------------------

/**
 * Every verb, and the work it is.
 *
 * This is the entire taxonomy decision. Three verbs get a second look at their path — that is
 * `labelOf` below — and everything else is exactly this row.
 */
const LABELS: Record<Verb, [Category, string]> = {
  read: ['reconstruction', 'read'],
  search: ['reconstruction', 'locate'],
  graph: ['reconstruction', 'graph'],
  query: ['reconstruction', 'inspect'],
  write: ['implementation', 'modify'],
  move: ['implementation', 'modify'],
  test: ['testing', 'test'],
  run: ['testing', 'run'],
  build: ['delivery', 'build'],
  commit: ['delivery', 'commit'],
  publish: ['delivery', 'publish'],
  branch: ['delivery', 'branch'],
  install: ['environment', 'deps'],
  env: ['environment', 'env'],
  infra: ['environment', 'infra'],
  ask: ['planning', 'clarify'],
  track: ['planning', 'decompose'],
  plan: ['planning', 'design'],
  mcp: ['reconstruction', 'mcp'],
  noop: ['unclassified', 'incidental'],
  unknown: ['unclassified', 'unknown'],
}

/**
 * One act, as the work it was.
 *
 * The three exceptions to the table are all the same question asked of the path — is this prose? —
 * and they are the only place a category depends on anything but the verb. Reading prose is
 * planning, writing it is documentation, and a write that brought the file into existence is
 * creating rather than changing. Asking it here, once, is why `Write` on a README and
 * `cat > README.md` cannot disagree.
 */
export function labelOf(one: Act): Label {
  const [category, sub] = LABELS[one.verb]
  const label: Label = { category, sub, target: one.target, weight: one.weight, source: one.source }

  if (one.path !== '' && isProse(one.path)) {
    if (one.verb === 'read') return { ...label, category: 'planning', sub: 'read' }
    if (one.verb === 'write') {
      return { ...label, category: 'documentation', sub: documentSub(one.path) }
    }
  }
  if (one.verb === 'write' && one.creating) return { ...label, sub: 'create' }
  return label
}

/** Everything a single tool call was, with weights summing to 1. */
export function classifyCall(tool: ToolCall): Label[] {
  return actsOf(tool).map(labelOf)
}

// ---------------------------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------------------------

/**
 * One round, as the work it did. Weights sum to 1, or to 0 for a round that called no tool.
 *
 * A round of pure prose gets no label at all rather than a guessed one. Roughly one round in
 * eleven is exactly that, and it is where planning, explaining and summarising all live together
 * with no way to tell them apart: the store keeps assistant text but no reasoning, and
 * `thinking_chars` is zero throughout. Counting them all as planning would inflate that category on
 * an assumption. They are excluded from the denominator and reported instead, so a share is always
 * a share of rounds that did something a tool can see.
 */
export function classifyRound(round: Round): Label[] {
  const tools = round.tools ?? []
  if (tools.length === 0) return []

  const out: Label[] = []
  const perCall = 1 / tools.length
  for (const tool of tools) {
    for (const label of classifyCall(tool)) {
      out.push({ ...label, weight: label.weight * perCall })
    }
  }
  return out
}

/**
 * Every round in order, labelled.
 *
 * A round is labelled on its own: no rule reaches outside the call it is looking at, so there is no
 * task context to carry and no order to preserve. That is what removing `review` bought.
 */
export function classifyRounds(rounds: Round[]): Map<string, Label[]> {
  const out = new Map<string, Label[]>()
  for (const round of rounds) {
    out.set(`${round.session}\0${round.round}`, classifyRound(round))
  }
  return out
}
