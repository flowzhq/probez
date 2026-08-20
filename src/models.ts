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
 */
export const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-fable-5': 1_000_000,
  'claude-mythos-5': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5': 200_000,
}

/** The window a model has, or null when the model is unknown or unnamed. */
export function contextWindow(model: string | null): number | null {
  if (model === null) return null
  return CONTEXT_WINDOWS[model] ?? null
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
