import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { api, exportProject } from '../api'
import type { ExportFormat } from '../api'
import { count, tokens } from '../format'

/**
 * The two things you can do to a project rather than read about it.
 *
 * Both live behind one `⋮`. Neither is what anyone opened the page for — you come to read what the
 * agent did, not to collect — and a menu keeps two irreversible-ish verbs out of the way of that.
 *
 * **Sync** is `collect` then `analyze`, on this project, and it is one of two writes the view can
 * make. It reports what it did in the same words the CLI would — new rounds, sessions read — rather
 * than flashing a tick, because "synced" and "found nothing new" are different outcomes and the
 * second one is the common one.
 *
 * **Export** hands the data to the browser to save. probez writes only under its own data
 * directory, so it never puts a file in the folder you choose; it gives the bytes to the page and
 * the page asks you where. Two formats, because they answer different questions: `.jsonl` is the
 * store's own file, the contract every stage reads, and `.json` is a bundle to look at, carrying
 * the analysis and the coverage its shares are shares of.
 *
 * Whatever comes out is unredacted — prompts, file paths, shell commands, exactly as typed.
 *
 * What they *did* is still written out in words: an icon can say "sync" but it cannot say "already
 * up to date · 442 rounds", and that sentence is the point of pressing it.
 */
/** One glyph, drawn the same way as the theme icons so the header reads as one set. */
function Icon({
  children,
  spinning = false,
}: {
  children: ReactElement | ReactElement[]
  spinning?: boolean
}): ReactElement {
  return (
    <svg
      className={spinning ? 'spin' : undefined}
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

export function Actions({
  slug,
  onSynced,
  compact = false,
}: {
  slug: string
  /** Called after a sync that changed something, so the page behind can re-read. */
  onSynced?: () => void
  compact?: boolean
}): ReactElement {
  const [busy, setBusy] = useState<'sync' | ExportFormat | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [bad, setBad] = useState(false)
  const [menu, setMenu] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  // A message about what just happened is worth reading and not worth keeping.
  useEffect(() => {
    if (said === null) return
    const at = window.setTimeout(() => setSaid(null), 8000)
    return () => window.clearTimeout(at)
  }, [said])

  useEffect(() => {
    if (!menu) return
    const close = (event: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(event.target as Node)) setMenu(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const report = (message: string, failed = false): void => {
    setBad(failed)
    setSaid(message)
  }

  const sync = async (): Promise<void> => {
    setBusy('sync')
    setSaid(null)
    try {
      const result = await api.sync(slug)
      if (!result.source_found) {
        report(
          `no agent sessions found for this project${result.source_dir === null ? '' : ` at ${result.source_dir}`} — nothing left to collect from. Re-analysed ${count(result.rounds)} stored rounds`,
        )
      } else if (result.new_rounds === 0) {
        report(`already up to date · ${count(result.rounds)} rounds, ${result.sessions} sessions`)
      } else {
        const rounds = `${count(result.new_rounds)} round${result.new_rounds === 1 ? '' : 's'}`
        const sessions = `${result.read_sessions} session${result.read_sessions === 1 ? '' : 's'}`
        report(`+${rounds} from ${sessions} · ${count(result.rounds)} total`)
      }
      onSynced?.()
    } catch (problem) {
      report((problem as Error).message, true)
    } finally {
      setBusy(null)
    }
  }

  const save = async (format: ExportFormat): Promise<void> => {
    setMenu(false)
    setBusy(format)
    setSaid(null)
    try {
      const result = await exportProject(slug, format)
      report(
        result.saved === 'cancelled'
          ? 'export cancelled'
          : `${result.saved === 'picked' ? 'saved' : 'downloaded'} ${result.filename} · ${tokens(result.bytes)}B`,
      )
    } catch (problem) {
      report((problem as Error).message, true)
    } finally {
      setBusy(null)
    }
  }

  const stop = (event: { stopPropagation: () => void }): void => event.stopPropagation()
  const exporting = busy === 'jsonl' || busy === 'json'

  return (
    <div
      className={`actions${compact ? ' actions-compact' : ''}`}
      ref={box}
      onClick={stop}
      onMouseDown={stop}
    >
      <div className="menu-anchor">
        <button
          className="action icon"
          onClick={() => setMenu(!menu)}
          disabled={busy !== null}
          aria-expanded={menu}
          aria-haspopup="menu"
          aria-label={busy === null ? 'Actions for this project' : 'Working'}
        >
          <Icon spinning={busy !== null}>
            {busy === null ? (
              <>
                <circle cx="8" cy="3.1" r="0.9" fill="currentColor" stroke="none" />
                <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
                <circle cx="8" cy="12.9" r="0.9" fill="currentColor" stroke="none" />
              </>
            ) : (
              <>
                <path d="M14 8a6 6 0 0 1-10.2 4.2M2 8a6 6 0 0 1 10.2-4.2" />
                <path d="M12.2 1.2v2.6h-2.6M3.8 14.8v-2.6h2.6" />
              </>
            )}
          </Icon>
        </button>
        {menu ? (
          <div className="menu" role="menu">
            <button
              role="menuitem"
              onClick={() => {
                setMenu(false)
                void sync()
              }}
            >
              <strong>Sync</strong>
              <span className="menu-note">collect anything new, then re-analyse</span>
            </button>
            <div className="menu-rule" role="separator" />
            <button role="menuitem" onClick={() => void save('jsonl')}>
              <strong>Export rounds</strong> <span className="mono muted">.jsonl</span>
              <span className="menu-note">the store's own file, one round per line</span>
            </button>
            <button role="menuitem" onClick={() => void save('json')}>
              <strong>Export bundle</strong> <span className="mono muted">.json</span>
              <span className="menu-note">manifest, analysis and rounds in one document</span>
            </button>
          </div>
        ) : null}
      </div>

      {said === null ? null : (
        <span className={`said${bad ? ' bad' : ''}`} role="status">
          {said}
        </span>
      )}
    </div>
  )
}
