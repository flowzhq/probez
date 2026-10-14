/**
 * Whether this run was started with `--debug`.
 *
 * Trails and questions are probez reading its own reading: useful for working on the classifier,
 * slow on a large store — a trail is a pass over every call and a read of the archived result
 * bodies besides — and not what anyone opens the view to learn. So they are computed and shown only
 * when asked for, and every other page is spared the cost of them.
 *
 * Set once at start-up, like the command table in `bash.ts`, because every reader of it is deep in
 * a payload that would otherwise have to be handed it through every call between.
 */
let on = false

export function useDebug(value: boolean): void {
  on = value
}

export function debugOn(): boolean {
  return on
}

/** What a request for one of them is told when the run was not started with `--debug`. */
export const DEBUG_ONLY = 'trails and questions are shown only under `probez view --debug`'
