/**
 * Which flagged calls are faults, for the view.
 *
 * `is_error` is one bit, and the bit fires for a `grep` that matched nothing as readily as for an
 * `Edit` whose anchor had moved. `src/errors.ts` is where that is sorted out, and every CLI and
 * aggregate path asks it — so a panel that reads `is_error` directly disagrees with the round line
 * printed two commands away, and disagrees in the direction that invents failures.
 *
 * This is a hand-maintained copy of `countsAsFailure` in `src/errors.ts`: the view is built
 * separately and cannot import from it. A drift shows up as a badge that is merely wrong rather
 * than as an error, which is why `test/errors.test.ts` asserts the two kind lists match.
 */

import type { ToolCall } from './api'

type Flagged = Pick<ToolCall, 'is_error' | 'error_kind'>

/**
 * Kinds that are flagged and are not anything going wrong.
 *
 * `nomatch` is a search answering "no" — exit 1 from `grep`, `diff` or `test` is the documented way
 * those programs say it. `denied` is a person working the tool, not the tool breaking.
 */
const BENIGN = new Set(['nomatch', 'denied'])

/** Flagged by the harness, with nothing actually wrong. */
export function benign(tool: Flagged): boolean {
  return tool.is_error === true && tool.error_kind !== null && BENIGN.has(tool.error_kind)
}

/**
 * Whether a call is worth showing as a failure.
 *
 * A null kind counts, matching `failed` in `src/errors.ts`: a round collected before probez
 * recorded kinds carries the flag and no kind, and the honest reading of that is "a failure of
 * unknown sort" rather than a silent pardon.
 */
export function failed(tool: Flagged): boolean {
  return tool.is_error === true && !benign(tool)
}
