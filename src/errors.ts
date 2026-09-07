/**
 * Why a failed call failed.
 *
 * `is_error` is one bit, and one bit turns out to be the wrong shape for the question. Across a
 * real store the flag fires for a `grep` that found nothing, for a suite that failed, for an `Edit`
 * whose anchor had moved, for a person clicking "no", and for a Figma server that was not running.
 * Those are five different facts about a session and only one of them — the `Edit` — is a mistake
 * anyone can act on. Counting them together produces an error rate that cannot go down, because
 * most of what it counts was never wrong.
 *
 * So each failed call carries a kind. The kind is read once, at extraction, from the result body
 * that is in hand there and recorded nowhere else: probez keeps result *sizes*, never result text,
 * and that constraint is why this is a label rather than a search over stored bodies. What survives
 * is one short word per failed call.
 *
 * Nothing here executes or resolves anything, and every rule is a string test over a body the
 * harness wrote. A body this reader does not recognise is `other`, which is a named hole rather
 * than a guess — the same rule `bash.ts` and `act.ts` follow.
 */

import { isMcpTool } from './act.js'
import { commandOf, parsePlaced } from './bash.js'
import type { ErrorKind, ToolCall } from './types.js'

export type { ErrorKind }

/**
 * The kinds of failure, and who each one is about.
 *
 * The split that matters is not severity but *whose problem it is*. `harness`, `limit` and `schema`
 * are the agent's own mistakes and are the only ones worth trying to drive down. `exit` is the
 * agent's shell reporting on the world. `nomatch` and `denied` are correct outcomes wearing an
 * error flag. `remote` is somebody else's machine.
 */
export const ERROR_KINDS = ['harness', 'exit', 'nomatch', 'limit', 'schema', 'denied', 'remote', 'other'] as const

/** Whether a string is one of the kinds, for reading a store back and for validating a filter. */
export function isErrorKind(value: string): value is ErrorKind {
  return (ERROR_KINDS as readonly string[]).includes(value)
}

/** What each kind stands for, since a single word never explains itself. */
export const ERROR_MEANING: Record<ErrorKind, string> = {
  harness: 'the agent misused the tool and the harness refused the call',
  exit: 'a command the agent ran exited non-zero',
  nomatch: 'a search or comparison found nothing, which is an answer rather than a failure',
  limit: 'the call hit a tool ceiling: too big, too many tokens, wrong kind of thing',
  schema: "the model's structured output did not satisfy its schema",
  denied: 'the call was refused before it ran, by a person or by a permission rule',
  remote: 'an MCP server, a browser or a network call failed',
  other: 'recognised as a failure, but not as any particular kind',
}

/**
 * Kinds that are worth calling a failure.
 *
 * `nomatch` and `denied` are excluded because neither describes anything going wrong. A `grep` that
 * matches nothing did its job; a person declining a call is the person working the tool, not the
 * tool breaking. On this machine's store the two together are about an eighth of every flagged
 * call, and leaving them in was the difference between an error rate that moves and one that does
 * not.
 */
export function countsAsFailure(kind: ErrorKind | null): boolean {
  return kind !== 'nomatch' && kind !== 'denied'
}

/**
 * Whether a call is worth counting as a failure.
 *
 * Null counts. A round collected before probez recorded kinds has `is_error` and no kind, and the
 * honest reading of that is "a failure of unknown sort" — dropping it would quietly rewrite the
 * history of every store that predates this field.
 */
export function failed(tool: Pick<ToolCall, 'is_error' | 'error_kind'>): boolean {
  return tool.is_error === true && countsAsFailure(tool.error_kind)
}

/** The other half: flagged by the harness, and not anything going wrong. */
export function benign(tool: Pick<ToolCall, 'is_error' | 'error_kind'>): boolean {
  return tool.is_error === true && !countsAsFailure(tool.error_kind)
}

/** Commands whose non-zero exit is a finding rather than a fault, and the code that means it. */
const SEARCH = /^(?:grep|egrep|fgrep|rg|ag|ack|git grep)$/
const COMPARE = /^(?:diff|git diff|cmp|test|\[)$/

/**
 * Whether a non-zero exit is the command answering rather than failing.
 *
 * `grep` exits 1 when it matched nothing, `diff` exits 1 when the files differ, `test` exits 1 when
 * the condition is false. All three are the documented way those programs say "no", and all three
 * arrive here flagged as errors. Only the *last* command decides, because that is the exit status a
 * shell reports for a pipeline: `grep x f | wc -l` exits from `wc` and is not a search result.
 *
 * Exit 1 only. `grep` exits 2 on a bad pattern or an unreadable file, which is a real failure, and
 * every other code is left alone.
 */
function isNoMatch(code: number, input: unknown): boolean {
  if (code !== 1) return false
  const placed = parsePlaced(commandOf(input))
  const last = placed.at(-1)
  if (last === undefined) return false
  return SEARCH.test(last.name) || COMPARE.test(last.name)
}

/** The exit code a Bash result leads with, or null when the body does not start with one. */
function exitCode(body: string): number | null {
  const found = /^Exit code (\d+)/.exec(body)
  return found === null ? null : Number(found[1])
}

/**
 * What kind of failure a result body describes.
 *
 * Called only for calls already flagged as errors, so the question is never "did this fail" but
 * "what sort of failing was it". Order matters: a refusal and a ceiling are both wrapped in
 * `<tool_use_error>` sometimes and bare other times, so the specific tests run before the generic
 * wrapper test rather than after it.
 */
export function errorKindOf(
  body: string,
  name: string | null,
  input: unknown,
  /**
   * An exit status the transcript recorded as a field rather than in the body. Claude Code writes
   * `Exit code N` at the head of the text and leaves this undefined; Codex records `exit_code` on
   * the output object and its bodies open with the command's own output, so there is nothing to
   * parse. Both arrive at the same two kinds.
   */
  code?: number | null,
): ErrorKind {
  const text = body.trim()

  // A person, or a permission rule standing in for one, said no. Nothing ran.
  if (
    // Either apostrophe: the harness writes a straight one today, and a curly one would otherwise
    // silently reclassify every refusal in the store as `other`.
    /^The user (?:doesn['\u2019]t|does not) want/.test(text) ||
    /tool use was rejected/i.test(text) ||
    /^Permission (?:for this action was )?denied/i.test(text)
  ) {
    return 'denied'
  }

  // A tool's own ceiling. These are the agent aiming a tool badly rather than the tool breaking:
  // `Read` at a directory, or at a file it was never going to be able to return whole.
  if (/exceeds maximum allowed (?:tokens|size)/i.test(text) || /^EISDIR\b/.test(text)) return 'limit'

  // The model's own output, judged against the schema it was handed.
  if (/Output does not match required schema/i.test(text)) return 'schema'

  // A command ran and the shell reported on it. Whether that is a failure depends on the command.
  const status = code ?? exitCode(text)
  if (status !== null && status !== 0) return isNoMatch(status, input) ? 'nomatch' : 'exit'

  // The harness refusing the call: a validation error, an unknown skill, a file written before it
  // was read, an edit anchor that no longer matches, a blocked command shape.
  if (/^<tool_use_error>/.test(text)) return 'harness'

  // Somebody else's machine. Checked late so that a refusal or a ceiling reported by an MCP server
  // is still filed as what it was.
  if (name !== null && isMcpTool(name)) return 'remote'

  return 'other'
}
