/**
 * The eight kinds of work, and how each one is drawn.
 *
 * The order is `classify.ts`'s order, which is roughly the order work tends to happen in, and it is
 * also the order colours are assigned in. That matters: the palette's slot ordering is what makes
 * adjacent pairs distinguishable under colour-vision deficiency, so a category's colour follows its
 * place in the taxonomy and never its size in the current chart. A filter that drops a category
 * must not repaint the others.
 *
 * Unclassified is the exception, and deliberately so. It is not an eighth hue but a hatched neutral,
 * because it is not a kind of work — it is the part the analyzer could not name. Drawing the hole
 * as though it were another colour of thing would be the one dishonesty this view cannot afford.
 *
 * This table is a hand-maintained copy of `CATEGORIES` in `src/classify.ts`: the view is built
 * separately and cannot import from it. `styleOf` falls back to the neutral for an id it does not
 * know, so a drift shows up as a grey chart rather than an error — which is why
 * `test/classify.test.ts` asserts the two lists match.
 */
export interface CategoryStyle {
  id: string
  label: string
  short: string
  /** The variable holding this category's colour in both themes. */
  fill: string
  /** Drawn as a hatch over a neutral rather than a flat fill. */
  hatched?: boolean
}

export const CATEGORIES: CategoryStyle[] = [
  { id: 'planning', label: 'Planning', short: 'Plan', fill: 'var(--series-1)' },
  { id: 'reconstruction', label: 'Reconstruction', short: 'Recon', fill: 'var(--series-2)' },
  { id: 'implementation', label: 'Implementation', short: 'Impl', fill: 'var(--series-3)' },
  { id: 'testing', label: 'Testing', short: 'Test', fill: 'var(--series-4)' },
  { id: 'documentation', label: 'Documentation', short: 'Docs', fill: 'var(--series-5)' },
  { id: 'delivery', label: 'Delivery', short: 'Deliv', fill: 'var(--series-6)' },
  { id: 'environment', label: 'Environment', short: 'Env', fill: 'var(--series-7)' },
  {
    id: 'unclassified',
    label: 'Unclassified',
    short: 'Uncl',
    fill: 'var(--series-none)',
    hatched: true,
  },
]

const BY_ID = new Map(CATEGORIES.map((category) => [category.id, category]))

/** A round that called no tool is not unclassified. It is outside the classification entirely. */
export const PROSE: CategoryStyle = {
  id: 'prose',
  label: 'Prose only',
  short: 'Prose',
  fill: 'var(--series-none)',
  hatched: true,
}

export function styleOf(id: string | null | undefined): CategoryStyle {
  if (id === null || id === undefined) return PROSE
  return BY_ID.get(id) ?? PROSE
}

export function orderOf(id: string): number {
  const at = CATEGORIES.findIndex((category) => category.id === id)
  return at === -1 ? CATEGORIES.length : at
}

/** The fill for a mark, which for the two neutrals is a pattern rather than a colour. */
export function fillOf(style: CategoryStyle): string {
  return style.hatched === true ? 'url(#probez-hatch)' : style.fill
}

/**
 * What each question kind stands for.
 *
 * A hand-maintained copy of `ASK_MEANING` in `src/question.ts`, for the same reason the table above
 * is a copy of `CATEGORIES`: the view is built separately and cannot import from the CLI.
 * `test/question.test.ts` asserts the two agree.
 *
 * It exists because a kind is one word in a column, and one word never says what it means. Every
 * place the view prints a kind hangs this off it.
 */
export const ASK_MEANING: Record<string, string> = {
  define: "show me this symbol's body",
  refs: 'where is this used',
  outline: 'what does this file declare',
  flow: 'where does this value travel across layers',
  touches: 'every artifact naming a concept, code and prose alike',
  covers: 'what constrains this — the tests that exercise it',
  other: 'asked something no rule in the table reads',
}

/** The six a rule can name, in the order `question.ts` tries them. `other` is the hole, not a kind. */
export const ASKS = ['define', 'refs', 'outline', 'flow', 'touches', 'covers'] as const

/** The kind with its meaning, for a tooltip. An unknown kind is just itself. */
export function askTitle(kind: string): string {
  const meaning = ASK_MEANING[kind]
  return meaning === undefined ? kind : `${kind}: ${meaning}`
}
