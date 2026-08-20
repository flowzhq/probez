import { useEffect, useState } from 'react'

import { api } from '../api'
import type { Label, ResultPayload, RoundPayload, ToolCall } from '../api'
import { orderOf, styleOf } from '../categories'
import { duration, percent, shortModel, tokens, when } from '../format'
import type { ReactElement } from 'react'

/**
 * One round, in full.
 *
 * This is the bottom of the hierarchy and the end of every question the pages above raise: the
 * distribution says a third of the work was reconstruction, the trace says which stretch, and this
 * says what was actually read. So it shows the record rather than a summary of it — the prompt if
 * this round opened a task, the assistant's prose, and every tool call with the arguments it was
 * given.
 *
 * What it cannot show, it says it cannot show. Reasoning is kept as a character count, so it
 * appears as a size rather than as an empty panel implying there was nothing there, and a truncated
 * input says how large it really was for the same reason. What the store knows about a result —
 * anything on stderr, a call cut short, the lines a patch changed — sits on the call beside the
 * harness's own flag, which reports something narrower.
 *
 * A result *body* is the exception, and the one thing here that is not already in hand when the
 * panel opens. `rounds.jsonl` keeps its size and not its text; the text is in the session's
 * archived copy, and `Result` below reads it from there per call, when asked.
 */
/** Which band a context share falls in, decided on the rounded percent the reader actually sees. */
function contextBand(share: number): string {
  const shown = Number(percent(share, 0).replace('%', ''))
  if (shown <= 20) return 'context-low'
  return shown <= 80 ? 'context-mid' : 'context-high'
}

export function Inspector({
  slug,
  session,
  round,
  onStep,
}: {
  slug: string
  session: string
  round: number
  onStep?: (delta: number) => void
}): ReactElement {
  const [payload, setPayload] = useState<RoundPayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setError(null)
    api
      .round(slug, session, round)
      .then((data) => {
        if (live) setPayload(data)
      })
      .catch((problem: Error) => {
        if (live) setError(problem.message)
      })
    return () => {
      live = false
    }
  }, [slug, session, round])

  useEffect(() => {
    if (onStep === undefined) return
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target !== null && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return
      if (event.key === 'ArrowLeft') onStep(-1)
      else if (event.key === 'ArrowRight') onStep(1)
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onStep])

  if (error !== null) {
    return (
      <div className="inspector">
        <div className="inspector-body note">{error}</div>
      </div>
    )
  }
  if (payload === null) {
    return (
      <div className="inspector">
        <div className="inspector-body note">Reading round {round}…</div>
      </div>
    )
  }

  const { round: it, labels, context_share: fill } = payload
  const errors = it.tools.filter((tool) => tool.is_error === true).length

  const compaction = it.compaction

  return (
    <div className="inspector">
      {compaction === null || compaction === undefined ? null : (
        <div
          className="compaction"
          title="The harness dropped most of the context here. Every figure below is measured against a conversation the round before this one never saw."
        >
          <span className="rule" />
          <span className="mono">
            compacted{compaction.trigger === null ? '' : ` (${compaction.trigger})`}
            {compaction.pre_tokens === null || compaction.post_tokens === null
              ? ''
              : ` · ${tokens(compaction.pre_tokens)} → ${tokens(compaction.post_tokens)}`}
            {compaction.ms === null ? '' : ` · took ${duration(compaction.ms)}`}
          </span>
          <span className="rule" />
        </div>
      )}
      <div className="inspector-head">
        <strong className="mono">
          {it.task}.{it.round}
        </strong>
        <span className="tag">{it.agent}</span>
        <span className="tag">{shortModel(it.model)}</span>
        <span className="muted num">
          {tokens(it.in_tokens)} in · {tokens(it.out_tokens)} out · {duration(it.gen_ms ?? it.ms)}
        </span>
        {fill === null ? null : (
          <span
            // Banded on the figure as shown, not on the raw share: 20.4% prints as `20%`, and a
            // reader told that green means 20% or under should not be looking at an amber `20%`.
            className={`num ${contextBand(fill)}`}
            title="How full this model's context window the round's input was. Green under 20%, amber to 80%, red above it — a session near the ceiling is about to be compacted."
          >
            {percent(fill, 0)} of context
          </span>
        )}
        <span
          className="muted num"
          title="Input the model had not seen before, written to cache, and served from cache. The three are priced differently."
        >
          {tokens(it.in_uncached)} new · {tokens(it.in_cache_write)} cached ·{' '}
          {tokens(it.in_cache_read)} reused
        </span>
        {it.wait_ms === null ? null : (
          <span className="muted num" title="Time this round spent waiting on a person.">
            waited {duration(it.wait_ms)}
          </span>
        )}
        {it.mcp_server === null ? null : (
          <span className="tag">
            {it.mcp_server}
            {it.mcp_tool === null ? '' : ` · ${it.mcp_tool}`}
          </span>
        )}
        {it.skill === null ? null : <span className="tag">skill · {it.skill}</span>}
        {it.thinking_chars > 0 ? (
          <span className="muted num">{tokens(it.thinking_chars)} chars reasoning</span>
        ) : null}
        {errors > 0 ? <span className="bad">{errors} failed</span> : null}
        <span className="spacer" style={{ flex: 1 }} />
        <span className="muted">{when(it.ts)}</span>
        {onStep === undefined ? null : (
          <span className="muted">
            <span className="kbd">←</span> <span className="kbd">→</span>
          </span>
        )}
      </div>

      <div className="inspector-body">
        <Labels labels={labels} />

        {it.user_text.trim() === '' ? null : (
          <div>
            <h2>Asked</h2>
            <div className="asked">{it.user_text.trim()}</div>
          </div>
        )}

        {it.text.trim() === '' ? (
          <p className="note">
            This round said nothing in prose.
            {it.thinking_chars > 0
              ? ` It reasoned for ${tokens(it.thinking_chars)} characters, which the store keeps only as a size.`
              : ''}
          </p>
        ) : (
          <div>
            <h2>Said</h2>
            <div className="prose">{it.text.trim()}</div>
          </div>
        )}

        <div>
          <h2>
            Tool calls {it.tools.length === 0 ? '' : `(${it.tools.length})`}
          </h2>
          {it.tools.length === 0 ? (
            <p className="note">
              None. A round of pure prose carries no label at all, which is why it sits outside every
              share on this page rather than inside one.
            </p>
          ) : (
            it.tools.map((tool, at) => (
              /*
               * Keyed by the round as well as the position, so stepping to the next round replaces
               * these rather than reusing them. A call holds state now — whether it is open, and
               * the result body once someone has read it — and keyed by position alone, round 6's
               * first call would inherit all of it from round 5's and show the wrong output under
               * the right command.
               */
              <Call
                key={`${it.id}:${at}`}
                slug={slug}
                session={it.session}
                tool={tool}
                labels={labels.filter((label) => label.call === at)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

interface Merged {
  label: Label
  weight: number
  /** How many acts of this kind were merged, so a call that read four files can say so. */
  count: number
  sources: Set<string>
}

/**
 * Labels of one kind, as one label.
 *
 * Two reads of two files are two labels of the same kind. Listing them separately would suggest the
 * work was two different things, when the only fact is that it was one thing done twice.
 */
function merge(labels: Label[]): Merged[] {
  const merged = new Map<string, Merged>()
  for (const label of labels) {
    const key = `${label.category}\u0000${label.sub}\u0000${label.target}`
    const found = merged.get(key)
    if (found === undefined) {
      merged.set(key, { label, weight: label.weight, count: 1, sources: new Set([label.source]) })
    } else {
      found.weight += label.weight
      found.count += 1
      found.sources.add(label.source)
    }
  }
  return [...merged.values()].sort(
    (a, b) => orderOf(a.label.category) - orderOf(b.label.category) || b.weight - a.weight,
  )
}

function Labels({ labels }: { labels: Label[] }): ReactElement | null {
  if (labels.length === 0) return null

  const ordered = merge(labels)

  return (
    <div>
      <h2>Counted as</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {ordered.map(({ label, weight, sources }, at) => {
          const style = styleOf(label.category)
          return (
            <span key={at} className="tag" title={`from ${[...sources].join(', ')}`}>
              <span
                className={style.hatched === true ? 'swatch hatch' : 'swatch'}
                style={style.hatched === true ? undefined : { background: style.fill }}
              />
              {style.label} · {label.sub}
              {label.target === 'unknown' ? '' : ` · ${label.target}`}
              <span className="muted num"> {percent(weight, 0)}</span>
            </span>
          )
        })}
      </div>
    </div>
  )
}

function Call({
  slug,
  session,
  tool,
  labels,
}: {
  slug: string
  session: string
  tool: ToolCall
  labels: Label[]
}): ReactElement {
  const [open, setOpen] = useState(false)
  const input = JSON.stringify(tool.input, null, 2)
  return (
    <div className="call">
      <button className="call-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="muted mono">{open ? '▾' : '▸'}</span>
        <strong>{tool.name ?? '(unnamed)'}</strong>
        {/* What this one call was counted as. The round's own summary above is these, added up;
            a Bash call that ran three commands is three of them on one row. */}
        <Work labels={labels} />
        <span className="muted num">{duration(tool.ms)}</span>
        <span className="muted num">
          {tool.result_chars === null ? 'no result' : `${tokens(tool.result_chars)} chars back`}
        </span>
        {tool.is_error === true ? <span className="bad">failed</span> : null}
        {/* The harness flag above says the call was accepted. These say what it did. */}
        {tool.interrupted === true ? <span className="bad">interrupted</span> : null}
        {tool.stderr_chars !== null && tool.stderr_chars > 0 ? (
          <span className="bad" title="The tool wrote to stderr, which the harness flag does not report.">
            {tokens(tool.stderr_chars)} stderr
          </span>
        ) : null}
        {tool.patch === null ? null : (
          <span className="muted num" title={`${tool.patch.files} file(s) changed`}>
            +{tool.patch.added} −{tool.patch.removed}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span className="muted clip mono" style={{ maxWidth: 320 }}>
          {summarize(tool.input)}
        </span>
      </button>
      {open ? (
        <>
          <pre>{input === undefined ? '(no input recorded)' : input}</pre>
          {/* Long strings are cut so a Write payload cannot dominate the store. Saying the full
              size keeps the cut honest rather than silent. */}
          {tool.input_chars > input.length ? (
            <p className="note">
              {tokens(tool.input_chars)} characters were passed; the store keeps the shape and the
              first 200 of any long string. The whole of it is in this session's archived copy.
            </p>
          ) : null}
          <Result slug={slug} session={session} tool={tool} />
        </>
      ) : null}
    </div>
  )
}

/**
 * The body of one tool result, read on request.
 *
 * Everything else on this page arrived with the round. This did not: `rounds.jsonl` keeps a
 * result's size and not its text, and the text is in the session's archived copy, which the server
 * scans per call. So it is fetched when someone asks for this result and never on the way to the
 * panel — a round of twenty calls would otherwise read twenty slices of a large file to fill a
 * screen nobody has scrolled to. Once read it is kept, so hiding and showing it again costs
 * nothing.
 *
 * The two ways there is nothing to fetch are told apart rather than both being an empty panel: a
 * call that never came back, and a call the store cannot match a result to.
 */
function Result({
  slug,
  session,
  tool,
}: {
  slug: string
  session: string
  tool: ToolCall
}): ReactElement {
  const [payload, setPayload] = useState<ResultPayload | null>(null)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState(false)

  const id = tool.id
  const size = tool.result_chars

  if (size === null) {
    return (
      <p className="note">
        No result was recorded for this call. It was cut short, or the session ended before one
        arrived.
      </p>
    )
  }
  if (id === null) {
    return (
      <p className="note">
        This call was recorded without an id, which is what a result is matched back to it by, so
        its body cannot be found in the archived session.
      </p>
    )
  }

  const load = (): void => {
    if (payload !== null) {
      setShown(!shown)
      return
    }
    setReading(true)
    setError(null)
    api
      .result(slug, session, id)
      .then((data) => {
        setPayload(data)
        setShown(true)
      })
      .catch((problem: Error) => setError(problem.message))
      .finally(() => setReading(false))
  }

  return (
    <>
      <div className="call-result">
        <button className="ghost" onClick={load} disabled={reading} aria-expanded={shown}>
          {reading
            ? 'Reading…'
            : payload !== null && shown
              ? 'Hide result'
              : `Show result · ${tokens(size)} chars`}
        </button>
        {error === null ? null : <span className="note bad">{error}</span>}
      </div>
      {shown && payload !== null ? (
        <>
          {/* A result that was only an image has no text and is not an empty result; the note
              below is the whole of what there is to say about it. */}
          {payload.body === '' && payload.omitted.length > 0 ? null : (
            <pre>{payload.body === '' ? '(the result was empty)' : payload.body}</pre>
          )}
          {payload.truncated ? (
            <p className="note">
              The first {tokens(payload.cap)} of {tokens(payload.chars)} characters. The whole of it
              is in <span className="mono">{payload.file}</span>.
            </p>
          ) : null}
          {payload.omitted.length === 0 ? null : (
            <p className="note">
              This result {payload.body === '' ? 'was' : 'also carried'}{' '}
              {payload.omitted.join(', ')} content, which is not text and is not shown here.
            </p>
          )}
        </>
      ) : null}
    </>
  )
}

/**
 * What one call was classified as, on the call's own row.
 *
 * Short labels, because this sits beside a tool name and a duration: the full category, the target
 * and the tool or command the label came from are all in the title. A call that did the same thing
 * several times says how many rather than repeating the chip.
 */
function Work({ labels }: { labels: Label[] }): ReactElement | null {
  if (labels.length === 0) return null

  return (
    <span className="work">
      {merge(labels).map(({ label, count, sources }, at) => {
        const style = styleOf(label.category)
        const target = label.target === 'unknown' ? '' : ` · ${label.target}`
        return (
          <span
            key={at}
            className="tag"
            title={`${style.label} · ${label.sub}${target} — from ${[...sources].join(', ')}`}
          >
            <span
              className={style.hatched === true ? 'swatch hatch' : 'swatch'}
              style={style.hatched === true ? undefined : { background: style.fill }}
            />
            {style.short} · {label.sub}
            {count > 1 ? <span className="muted num"> ×{count}</span> : null}
          </span>
        )
      })}
    </span>
  )
}

/** The one field of an input worth putting on the collapsed row. */
function summarize(input: unknown): string {
  if (input === null || typeof input !== 'object') return ''
  const fields = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'pattern', 'path', 'url', 'query', 'description']) {
    const value = fields[key]
    if (typeof value === 'string' && value !== '') return value.replace(/\s+/g, ' ')
  }
  return ''
}
