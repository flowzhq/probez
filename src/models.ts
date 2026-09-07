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
  'gpt-5.3-codex': 272_000,
  'gpt-5.2': 272_000,
  'gpt-5.1': 272_000,
  'gpt-5': 272_000,
}

/** A dated snapshot: `-20251001` as Claude Code writes it, `@20251101` as Vertex does. */
const SNAPSHOT = /[-@]\d{8}$/

/**
 * The id a table actually holds for a model, given the id an agent recorded.
 *
 * Agents do not all record the same spelling of the same model. Claude Code writes
 * `claude-haiku-4-5-20251001` where the published tables say `claude-haiku-4-5`, and a store here
 * held 6,196 rounds priced at nothing for exactly that reason — not a model anybody was missing, a
 * model nobody could look up. Stripping the snapshot is the whole of the fix.
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
  if (known(model)) return model
  const base = model.replace(SNAPSHOT, '')
  return base !== model && known(base) ? base : null
}

/** The window a model has, or null when the model is unknown or unnamed. */
export function contextWindow(model: string | null): number | null {
  const id = resolveModel(model, (one) => CONTEXT_WINDOWS[one] !== undefined)
  return id === null ? null : CONTEXT_WINDOWS[id]!
}

/**
 * What share of its model's window a round's input filled, from 0 to 1.
 *
 * Null when the window is unknown or the session recorded no usage — Cursor transcripts do not —
 * which is not the same as a round that filled none of it.
 */
export function contextShare(round: Round): number | null {
  const window = contextWindow(round.model)
  // Checked by type rather than against null, because a store written by an earlier probez is read
  // back as a raw cast and may not carry the field at all.
  if (window === null || typeof round.in_tokens !== 'number') return null
  return round.in_tokens / window
}
