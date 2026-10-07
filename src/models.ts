import type { Round } from './types.js'

/**
 * How much room a model has for input, in tokens.
 *
 * This is what `in_tokens` is a share of. A round that sent 250K into a 1M window filled a quarter
 * of it, and that share is worth seeing beside the cost, because it is the number that decides when
 * the harness compacts — and a compaction is the most expensive thing that can happen to a session
 * that nobody asked for.
 *
 * Keyed by the model id exactly as the agent recorded it, the same way `pricing.ts` keys rates. A
 * model that is not listed has *no* share rather than a share of zero: an unknown window is not a
 * small one, and guessing would report a comfortable session as one about to fall over.
 *
 * The figure is *input* room, not the headline context window, and for the GPT models those are not
 * the same number: `gpt-5.3-codex` advertises a 400,000 window that admits 272,000 tokens of input,
 * the rest being reserved for output. Taking the headline would understate every share by 47%. The
 * Claude models quote the input limit directly — `max_input_tokens` on `GET /v1/models` — so their
 * headline figure is the one to use.
 */
export const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-fable-5-1': 1_000_000,
  'claude-mythos-5-1': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-mythos-5': 1_000_000,
  'claude-opus-5-5': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-opus-4-5': 200_000,
  'claude-opus-4-1': 200_000,
  // Two spellings of one model: `claude-opus-4-0` is the alias, and `claude-opus-4` is what the
  // dated id `claude-opus-4-20250514` becomes once `resolveModel` strips the snapshot off it.
  'claude-opus-4-0': 200_000,
  'claude-opus-4': 200_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-sonnet-4-5': 200_000,
  'claude-sonnet-4-0': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-haiku-4-5': 200_000,
  'claude-3-5-haiku': 200_000,

  // Codex. The four current models share a 1,050,000-token window that admits 922,000 of input.
  'gpt-6-astra': 922_000,
  'gpt-5.6-sol': 922_000,
  'gpt-5.6-terra': 922_000,
  'gpt-5.6-luna': 922_000,
  // The GPT-5 generation: a 400,000-token window, 272,000 of it input. Codex can be configured to
  // raise this on some of them, which makes the figure a floor rather than a certainty.
  'gpt-5.5': 272_000,
  'gpt-5.4': 272_000,
  'gpt-5.4-mini': 272_000,
  'gpt-5-mini': 272_000,
  'gpt-5.3-codex': 272_000,
  'gpt-5.2': 272_000,
  'gpt-5.1': 272_000,
  'gpt-5': 272_000,
}

/** A dated snapshot: `-20251001` as Claude Code writes it, `@20251101` as Vertex does. */
const SNAPSHOT = /[-@]\d{8}$/

/**
 * A point version written the way a marketing name spells it: `4.5`, not `4-5`.
 *
 * GitHub Copilot CLI's `selectedModel`/`currentModel` record `claude-haiku-4.5` — confirmed from a
 * real session — where the published tables, and every other agent, spell the same model
 * `claude-haiku-4-5`. Anchored to digits on both sides so a real hyphenated id already in the
 * table, such as `gpt-5.6-sol`, is never reached by this at all: `resolveModel` tries the exact
 * spelling first, and that one already matches.
 */
const DOTTED_VERSION = /(\d)\.(\d)/g

/**
 * The id a table actually holds for a model, given the id an agent recorded.
 *
 * Agents do not all record the same spelling of the same model. Claude Code writes
 * `claude-haiku-4-5-20251001` where the published tables say `claude-haiku-4-5`, and a store here
 * held 6,196 rounds priced at nothing for exactly that reason — not a model anybody was missing, a
 * model nobody could look up. Stripping the snapshot is the first fix that bought; normalizing a
 * dotted point version, tried next against whatever the snapshot strip left, is the second — the
 * same failure in a different spelling, this time from Copilot CLI.
 *
 * The third is a provider in front of the model. A router names the model by who serves it —
 * OpenRouter's `anthropic/claude-sonnet-4.5`, which Goose and OpenCode record as configured — so
 * when the whole spelling finds nothing, the id after the last `/` is tried the same way. The
 * whole spelling is always tried first, so a rate typed against the prefixed id still wins.
 *
 * Deliberately no further than that. There is no family-prefix fallback, so a `claude-opus-6-…`
 * nobody has priced yet stays unpriced rather than being charged at Opus 5's rate. That is the same
 * rule `costOf` states from the other side: a round that cost something unknown must not be counted
 * as one that cost nothing — and counting it at a *wrong* price is worse, because nothing about the
 * total then says it is a guess.
 */
export function resolveModel(
  model: string | null,
  known: (id: string) => boolean,
): string | null {
  if (model === null) return null
  const found = resolveSpelling(model, known)
  if (found !== null) return found
  const slash = model.lastIndexOf('/')
  return slash >= 0 && slash < model.length - 1 ? resolveSpelling(model.slice(slash + 1), known) : null
}

/** One spelling of a model, as recorded, then without its snapshot, then with its version dashed. */
function resolveSpelling(model: string, known: (id: string) => boolean): string | null {
  if (known(model)) return model
  const base = model.replace(SNAPSHOT, '')
  if (base !== model && known(base)) return base
  const dotted = base.replace(DOTTED_VERSION, '$1-$2')
  return dotted !== base && known(dotted) ? dotted : null
}

/** The window a model has, or null when the model is unknown or unnamed. */
export function contextWindow(model: string | null): number | null {
  const id = resolveModel(model, (one) => CONTEXT_WINDOWS[one] !== undefined)
  return id === null ? null : CONTEXT_WINDOWS[id]!
}

/**
 * The window a round's input was measured against: the one its harness recorded enforcing, when
 * it recorded one, and otherwise its model's published window.
 */
export function contextWindowOf(round: Round): number | null {
  const recorded = round.context_window
  if (typeof recorded === 'number' && recorded > 0) return recorded
  return contextWindow(round.model)
}

/**
 * How many tokens of its model's input window a round filled, or null when that is not known.
 *
 * `in_tokens` for every source but one: a source that records the window apart from its billed
 * input sets `context_tokens`, and then that field alone is the answer, null included — falling
 * back to `in_tokens` there would report a billing share as a context size.
 */
export function contextTokens(round: Round): number | null {
  // Checked by type rather than against null, because a store written by an earlier probez is read
  // back as a raw cast and may not carry either field at all.
  if (round.context_tokens !== undefined) {
    return typeof round.context_tokens === 'number' ? round.context_tokens : null
  }
  return typeof round.in_tokens === 'number' ? round.in_tokens : null
}

/**
 * What share of its model's window a round's input filled, from 0 to 1.
 *
 * Null when the window is unknown or the session recorded no usage — Cursor transcripts do not —
 * which is not the same as a round that filled none of it.
 */
export function contextShare(round: Round): number | null {
  const window = contextWindowOf(round)
  const filled = contextTokens(round)
  if (window === null || filled === null) return null
  return filled / window
}
