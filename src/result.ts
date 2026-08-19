import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

/**
 * One tool result, read back out of a session's archived copy.
 *
 * `rounds.jsonl` keeps a result's size and nothing else. That is deliberate: the bodies are the
 * bulk of a session file, and an extract that carried them would be as large as the logs it
 * summarizes. But the bodies are not gone. `collect` copies every session file into the project's
 * `sessions/` directory verbatim, precisely so that what probez does not normalize stays
 * re-derivable locally — see the copy in `collectProject`.
 *
 * So this reads the raw log, on demand, for one call at a time. Two things keep that cheap enough
 * to sit behind a click. It streams and stops at the first match rather than parsing a file that
 * runs to tens of megabytes into memory. And it parses only the lines that could possibly match,
 * since a result always carries its call's id as a substring of the line holding it.
 *
 * Nothing here is cached. A result is read when someone asks to see that one result, which is the
 * only reason this file exists: the whole point of the extract is that browsing does not pay for
 * the logs, and a cache in front of this would quietly undo that.
 */

type Json = Record<string, unknown>

/**
 * How much of a result this will return.
 *
 * A `<pre>` holding a megabyte of shell output is not a thing anyone reads; it is a thing that
 * makes a page stutter. The cut is reported rather than silent, and the archived file is named
 * beside it, so the answer to "and the rest?" is a path rather than a shrug.
 */
export const MAX_RESULT_CHARS = 200_000

export interface ToolResultBody {
  /**
   * Characters of text in the whole result, before the cut.
   *
   * This can fall short of the round's `result_chars`, which measures the recorded content whatever
   * shape it took. A result carrying an image is the case: there is a block there and it has a
   * size, but it is not text and does not appear here. `omitted` names those.
   */
  chars: number
  /** The result as text, cut at `MAX_RESULT_CHARS`. */
  body: string
  /** Whether `body` stops short of `chars`. */
  truncated: boolean
  /** The harness's own flag, as recorded. Narrower than it sounds; see `ToolCall.is_error`. */
  is_error: boolean
  /** Types of any content blocks that were not text, named rather than dropped in silence. */
  omitted: string[]
}

/** The `tool_result` block for one call id, or null if this record holds no such block. */
function resultIn(record: Json, toolUseId: string): Json | null {
  const message = record.message
  if (message === null || typeof message !== 'object') return null
  const content = (message as Json).content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const it = block as Json
    if (it.type === 'tool_result' && it.tool_use_id === toolUseId) return it
  }
  return null
}

/**
 * Flatten a result's content to text, naming what could not be flattened.
 *
 * The same walk `extract.ts` does to measure a result, kept separate because it collects what it
 * skipped: a size may quietly ignore an image block, but a panel claiming to show the result may
 * not.
 */
function flatten(value: unknown, omitted: string[]): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => flatten(item, omitted))
      .filter((part) => part !== '')
      .join('\n')
  }
  if (typeof value === 'object') {
    const block = value as Json
    if (typeof block.text === 'string') return block.text
    if ('content' in block) return flatten(block.content, omitted)
    omitted.push(typeof block.type === 'string' ? block.type : 'unknown')
    return ''
  }
  return String(value)
}

function fold(block: Json, cap: number): ToolResultBody {
  const omitted: string[] = []
  const text = flatten(block.content, omitted)
  return {
    chars: text.length,
    body: text.length > cap ? text.slice(0, cap) : text,
    truncated: text.length > cap,
    is_error: block.is_error === true,
    omitted: [...new Set(omitted)],
  }
}

/**
 * How much of each result a bulk read keeps.
 *
 * `readToolResult` answers a click and can afford the whole thing. A bulk read holds every result
 * it was asked for at once, so the cap is what bounds the memory: a thousand results at the
 * single-result cap would be two hundred megabytes. Twenty thousand characters is a listing of a
 * few hundred paths, which is what the caller is looking through them for.
 *
 * The cost of the cut is real and worth naming: a `find` over a very large tree can name a file
 * past the cap, and an edge that would have been proof is then merely not found. That fails in the
 * safe direction — a missing edge, never an invented one.
 */
export const MAX_BULK_CHARS = 20_000

/**
 * Every named call's result, in one pass over an archived session file.
 *
 * `readToolResult` streams and stops at the first match, which is right for one call and quadratic
 * for a thousand. This reads the file once and collects whatever it was asked for, which is what a
 * whole-session analysis needs. Ids with no result are simply absent from the map, the same real
 * answer `readToolResult` gives as null.
 */
export async function readToolResults(
  file: string,
  ids: ReadonlySet<string>,
  cap = MAX_BULK_CHARS,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (ids.size === 0) return out

  let stream
  try {
    stream = createReadStream(file, { encoding: 'utf8' })
  } catch {
    return out
  }
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      // Every result carries the marker, so this keeps the scan to a substring search across the
      // file and a parse of only the lines that could hold one. Matching each id separately would
      // be a thousand substring searches per line.
      if (!line.includes('tool_use_id')) continue
      let record: Json
      try {
        record = JSON.parse(line) as Json
      } catch {
        continue
      }
      const message = record.message
      if (message === null || typeof message !== 'object') continue
      const content = (message as Json).content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue
        const it = block as Json
        if (it.type !== 'tool_result') continue
        const id = it.tool_use_id
        if (typeof id !== 'string' || !ids.has(id) || out.has(id)) continue
        out.set(id, fold(it, cap).body)
      }
    }
  } catch {
    // absent, or unreadable partway through; what was collected before that still stands
  } finally {
    lines.close()
    stream.destroy()
  }
  return out
}

/**
 * Find one call's result in an archived session file.
 *
 * Returns null when the file holds no result for that id, which is a real answer rather than a
 * failure: a call that was interrupted, or one the session ended before, never got one.
 */
export async function readToolResult(
  file: string,
  toolUseId: string,
  cap = MAX_RESULT_CHARS,
): Promise<ToolResultBody | null> {
  let stream
  try {
    stream = createReadStream(file, { encoding: 'utf8' })
  } catch {
    return null
  }
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      // A result names its call, so a line without that id cannot be the one. This is what keeps
      // the scan to a substring search across the file and a parse of the one line that matches.
      if (!line.includes(toolUseId)) continue
      let record: Json
      try {
        record = JSON.parse(line) as Json
      } catch {
        // a torn line from an interrupted write; the next one may still be the result
        continue
      }
      const found = resultIn(record, toolUseId)
      if (found !== null) return fold(found, cap)
    }
  } catch {
    // absent, or unreadable partway through; the caller reports it as having no body to show
  } finally {
    lines.close()
    stream.destroy()
  }
  return null
}
