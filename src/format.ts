import { homedir, tmpdir } from 'node:os'

export function shorten(path: string): string {
  const home = homedir()
  if (path === home || path.startsWith(home + '/')) return '~' + path.slice(home.length)
  // Scratch directories are long, noisy, and identical up to their last segment.
  for (const tmp of [tmpdir(), '/private' + tmpdir()]) {
    if (path.startsWith(tmp + '/')) return '$TMPDIR' + path.slice(tmp.length)
  }
  return path
}

/**
 * A commit as it is read and typed: the first seven characters, the length git itself abbreviates
 * to. The full hash stays in `--json`, since that is what another tool wants.
 */
export function shortCommit(hash: string | null): string | null {
  return hash === null || hash === '' ? null : hash.slice(0, 7)
}

export function tokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

/** Wall time, at the precision that reads best: 41ms · 8.4s · 1.2m · 1.5h. */
export function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = seconds / 60
  if (minutes < 60) return `${minutes.toFixed(1)}m`
  return `${(minutes / 60).toFixed(1)}h`
}

function day(iso: string, withYear: boolean): string {
  const date = new Date(iso)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  })
}

export function span(first: string | null, last: string | null): string {
  if (first === null || last === null) return '—'
  const sameDay = first.slice(0, 10) === last.slice(0, 10)
  if (sameDay) return day(first, true)
  const sameYear = first.slice(0, 4) === last.slice(0, 4)
  return `${day(first, !sameYear)} – ${day(last, true)}`
}

export function ago(ms: number): string {
  const seconds = Math.max(0, (Date.now() - ms) / 1000)
  const minutes = seconds / 60
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

export function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}

/** Right-align, for numeric columns. */
export function padStart(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value
}

/**
 * Break text into lines no wider than `width`, keeping the blank lines that separate paragraphs.
 * A word longer than the width, such as a URL or a path, is left whole rather than cut mid-token.
 */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') {
      lines.push('')
      continue
    }
    let line = ''
    for (const word of paragraph.trim().split(/\s+/)) {
      if (line === '') {
        line = word
      } else if (line.length + 1 + word.length <= width) {
        line += ' ' + word
      } else {
        lines.push(line)
        line = word
      }
    }
    if (line !== '') lines.push(line)
  }
  return lines
}

/** One line, no longer than `width`. Newlines become spaces so a table row stays a row. */
export function clip(text: string, width: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= width ? line : line.slice(0, Math.max(1, width - 1)) + '…'
}
