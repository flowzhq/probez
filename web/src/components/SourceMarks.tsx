import type { ReactElement } from 'react'

import { sourceAlias } from '../source'

const TITLES: Record<string, string> = {
  claude: 'Claude Code sessions',
  cursor: 'Cursor sessions. Cursor transcripts do not record token usage or cost.',
  codex: 'Codex CLI sessions',
  unknown: 'Sessions whose agent could not be determined',
}

const ORDER = ['claude-code', 'cursor', 'codex', 'unknown'] as const

/**
 * Every agent source present, as compact marks. Claude is shown like the others — it is not an
 * invisible default.
 */
export function SourceMarks({
  sources,
}: {
  sources: Array<'claude-code' | 'cursor' | 'codex' | 'unknown'> | undefined
}): ReactElement | null {
  if (sources === undefined || sources.length === 0) return null
  const seen = new Set(sources)
  return (
    <>
      {ORDER.filter((source) => seen.has(source)).map((source) => {
        const alias = sourceAlias(source)
        return (
          <span key={source} className="mark" title={TITLES[alias] ?? alias}>
            {alias}
          </span>
        )
      })}
    </>
  )
}

export function SourceTag({
  source,
}: {
  source: 'claude-code' | 'cursor' | 'codex' | 'unknown'
}): ReactElement {
  const alias = sourceAlias(source)
  return (
    <span className="tag" title={TITLES[alias] ?? alias}>
      {alias}
    </span>
  )
}
