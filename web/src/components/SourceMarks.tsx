import type { ReactElement } from 'react'

import { sourceAlias } from '../source'

const TITLES: Record<string, string> = {
  claude: 'Claude Code sessions',
  cursor: 'Cursor sessions. Token usage comes from `probez hook` when installed (not retroactive); transcripts alone have none.',
  codex: 'Codex CLI sessions',
  copilot: 'GitHub Copilot CLI sessions. Output tokens are recorded per round, but input tokens only as a session-wide total, so Tokens and Cost stay blank.',
  pi: 'Pi coding-agent sessions',
  opencode: 'OpenCode sessions',
  goose: 'Goose sessions. Sessions from Goose versions that did not yet record usage per model call have no tokens, so Tokens and Cost stay blank for them.',
  cline: 'Cline sessions, from its CLI and VS Code extension. Tasks the extension wrote before its SDK record when commands, MCP calls and browser actions answered, but not when other tools did.',
  unknown: 'Sessions whose agent could not be determined',
}

const ORDER = ['claude-code', 'cursor', 'codex', 'copilot', 'pi', 'opencode', 'goose', 'cline', 'unknown'] as const

/**
 * Every agent source present, as compact marks. Claude is shown like the others — it is not an
 * invisible default.
 */
export function SourceMarks({
  sources,
}: {
  sources: Array<'claude-code' | 'cursor' | 'codex' | 'copilot' | 'pi' | 'opencode' | 'goose' | 'cline' | 'unknown'> | undefined
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
  source: 'claude-code' | 'cursor' | 'codex' | 'copilot' | 'pi' | 'opencode' | 'goose' | 'cline' | 'unknown'
}): ReactElement {
  const alias = sourceAlias(source)
  return (
    <span className="tag" title={TITLES[alias] ?? alias}>
      {alias}
    </span>
  )
}
