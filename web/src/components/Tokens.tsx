import { percent, tokens } from '../format'
import type { ReactElement } from 'react'

/**
 * Input tokens, and how much of them the model had already seen.
 *
 * The total on its own is close to meaningless as a measure of cost. The three classes behind it
 * are priced roughly 1×, 1.25× and a tenth, and on a real store the tenth-priced one is around 98%
 * of the total — so a project that reads as enormous by input may have processed very little that
 * was new. The share is the honest headline; the exact split is a hover away rather than four
 * numbers competing for the same line.
 */
export function InTokens({ of }: { of: Split }): ReactElement {
  return <span title={splitTitle(of)}>{tokens(of.in_tokens)}</span>
}

/** The reused share, as its own fact. Absent when there was no input to divide. */
export function Reused({ of }: { of: Split }): ReactElement | null {
  if (of.in_tokens <= 0) return null
  return <span title={splitTitle(of)}>{percent(of.in_cache_read / of.in_tokens, 0)}</span>
}

export interface Split {
  in_tokens: number
  in_uncached?: number
  in_cache_write?: number
  in_cache_read: number
}

function splitTitle(split: Split): string {
  const parts = [
    split.in_uncached === undefined ? null : `${tokens(split.in_uncached)} new`,
    split.in_cache_write === undefined ? null : `${tokens(split.in_cache_write)} written to cache`,
    `${tokens(split.in_cache_read)} read from cache`,
  ].filter((part): part is string => part !== null)
  return `${parts.join(' · ')}\nCache reads are billed at a fraction of the rate.`
}

/**
 * Lines a span of work put on disk. Absent when it edited no files.
 *
 * Deliberately not the green-and-red of a diff stat: this palette has one alarm colour and it means
 * something went wrong, which deleting a line does not.
 */
export function Lines({ added, removed }: { added: number; removed: number }): ReactElement | null {
  if (added === 0 && removed === 0) return null
  return (
    <span title={`${added.toLocaleString()} added, ${removed.toLocaleString()} removed`}>
      +{tokens(added)} −{tokens(removed)}
    </span>
  )
}

/**
 * The five classes of token, in the order money moves through a round.
 *
 * They are the same five the Settings screen sets a rate for, under the same names, so a column
 * here and a rate there are visibly the same thing. A cache write appears twice because it is
 * billed twice over: the 5-minute entry at 1.25× the input rate, the 1-hour entry at 2×.
 */
export interface TokenSplit {
  in_uncached: number
  in_cache_write_5m: number
  in_cache_write_1h: number
  in_cache_read: number
  out_tokens: number
}

export const TOKEN_COLUMNS: Array<{
  key: keyof TokenSplit
  label: string
  full: string
}> = [
  { key: 'in_uncached', label: 'Input', full: 'Input the model had not seen before.' },
  {
    key: 'in_cache_write_5m',
    label: 'Write 5m',
    full: 'Cache write, 5-minute entry. Billed at 1.25× the input rate.',
  },
  {
    key: 'in_cache_write_1h',
    label: 'Write 1h',
    full: 'Cache write, 1-hour entry. Billed at 2× the input rate, and usually almost every write.',
  },
  {
    key: 'in_cache_read',
    label: 'Read',
    full: 'Cache read. Billed at a tenth of the input rate, and usually most of the tokens.',
  },
  { key: 'out_tokens', label: 'Output', full: 'Tokens the model produced.' },
]

/** The five headers, so no table spells them differently from another. */
export function TokenHeaders({ width = 68 }: { width?: number }): ReactElement {
  return (
    <>
      {TOKEN_COLUMNS.map((column) => (
        <th key={column.key} className="r" style={{ width }} title={column.full}>
          {column.label}
        </th>
      ))}
    </>
  )
}

/** The five cells, in the same order, for any row that carries the split. */
export function TokenCells({ of, dim = 'dim' }: { of: TokenSplit; dim?: string }): ReactElement {
  return (
    <>
      {TOKEN_COLUMNS.map((column) => (
        <td key={column.key} className={`r num ${dim}`}>
          {tokens(of[column.key])}
        </td>
      ))}
    </>
  )
}
