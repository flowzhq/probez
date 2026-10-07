/**
 * Query tokens for the agent-source filter on the search page.
 *
 * Mirrors `setSourceQuery` / `sourceQueryOf` in `src/query.ts`. The view cannot import that
 * module. Browse pages pin with `?source=` instead; this only rewrites the token the search-page
 * dropdown writes into `q`.
 */

const SOURCE_ATOM = /(?:^|\s)-?source:(?:claude-code|claude|cursor|codex|copilot|pi|opencode|goose|cline|unknown)\b/gi

export const SOURCE_CHOICES = ['claude', 'cursor', 'codex', 'copilot', 'pi', 'opencode', 'goose', 'cline'] as const

export type SourceChoice = (typeof SOURCE_CHOICES)[number]

export function setSourceQuery(text: string, alias: string | null): string {
  const stripped = text.replace(SOURCE_ATOM, ' ').replace(/\s+/g, ' ').trim()
  if (alias === null || alias === '') return stripped
  return stripped === '' ? `source:${alias}` : `${stripped} source:${alias}`
}

export function sourceQueryOf(text: string): string | null {
  const matches = [...text.matchAll(/\bsource:(claude-code|claude|cursor|codex|copilot|pi|opencode|goose|cline|unknown)\b/gi)]
  if (matches.length === 0) return null
  const raw = matches[matches.length - 1]![1]!.toLowerCase()
  return raw === 'claude-code' ? 'claude' : raw
}

export function sourceAlias(
  source: 'claude-code' | 'cursor' | 'codex' | 'copilot' | 'pi' | 'opencode' | 'goose' | 'cline' | 'unknown',
): string {
  return source === 'claude-code' ? 'claude' : source
}

/** The name a source reads as in prose, keyed by its alias. One table, so a fifth source is one edit. */
export const SOURCE_LABEL: Record<SourceChoice, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  copilot: 'Copilot',
  pi: 'Pi',
  opencode: 'OpenCode',
  goose: 'Goose',
  cline: 'Cline',
}
