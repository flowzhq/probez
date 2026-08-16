/**
 * The same units the CLI prints, deliberately.
 *
 * `probez analyze` and this page describe one store, and a reader will check one against the other.
 * A number that rounds differently in the two places reads as a disagreement about the data rather
 * than a difference of formatting, so these thresholds mirror `src/format.ts` exactly.
 */

export function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(Math.round(n))
}

export function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = seconds / 60
  if (minutes < 60) return `${minutes.toFixed(1)}m`
  return `${(minutes / 60).toFixed(1)}h`
}

export function percent(share: number, places = 0): string {
  return `${(share * 100).toFixed(places)}%`
}

export function count(n: number): string {
  return n.toLocaleString('en-US')
}

export function ago(iso: string | null): string {
  if (iso === null) return '—'
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return '—'
  const minutes = Math.max(0, (Date.now() - at) / 60000)
  const hours = minutes / 60
  const days = hours / 24
  if (minutes < 2) return 'just now'
  if (hours < 1) return `${Math.round(minutes)} min ago`
  if (days < 1) return `${Math.round(hours)} hr ago`
  if (days < 30) {
    const whole = Math.round(days)
    return `${whole} day${whole === 1 ? '' : 's'} ago`
  }
  return `${Math.round(days / 30)} mo ago`
}

export function when(iso: string | null, withTime = true): string {
  if (iso === null) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  })
}

/** One line, no longer than `width`, the way a table cell needs it. */
export function clip(text: string, width: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= width ? line : `${line.slice(0, Math.max(1, width - 1))}…`
}

export function shortId(session: string): string {
  return session.slice(0, 8)
}

/** `claude-opus-5` is the model; the vendor prefix is the same on every row. */
export function shortModel(model: string | null): string {
  return model === null ? '—' : model.replace(/^claude-/, '')
}

/**
 * Dollars, at a precision that survives being small.
 *
 * Mirrors `money` in `src/cli.ts`: a category can cost fractions of a cent on a short task and
 * hundreds of dollars on a long one, so the decimals move with the size rather than rounding every
 * small number away to `$0.00`.
 */
export function money(value: number): string {
  if (value === 0) return '·'
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1000) return `$${value.toFixed(2)}`
  return `$${Math.round(value).toLocaleString('en-US')}`
}
