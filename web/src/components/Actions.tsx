import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { api, exportProject } from '../api'
import type { ExportFormat, SyncResult } from '../api'
import { count, tokens } from '../format'

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

/**
 * The circular arrows a sync draws.
 *
 * It doubles as the menu's "working" mark, because every verb behind the `⋮` is something the
 * store is doing and one turning glyph says that for all of them.
 */
function SyncGlyph({ spinning }: { spinning: boolean }): ReactElement {
  return (
    <Icon spinning={spinning}>
      <path d="M14 8a6 6 0 0 1-10.2 4.2M2 8a6 6 0 0 1 10.2-4.2" />
      <path d="M12.2 1.2v2.6h-2.6M3.8 14.8v-2.6h2.6" />
    </Icon>
  )
}

/**
 * What a sync did, in words.
 *
 * Both controls that can start one report through this, so the menu on a project page and the
 * button on a session page say the same outcome in the same sentence. Three outcomes and not one
 * tick: "already up to date" and "+12 rounds" are different answers, and the first is the common
 * one.
 */
export function syncSaid(result: SyncResult): string {
  if (!result.source_found) {
    return (
      `no agent sessions found for this project` +
      `${result.source_dir === null ? '' : ` at ${result.source_dir}`} — nothing left to ` +
      `collect from. Re-analysed ${count(result.rounds)} stored rounds`
    )
  }
  if (result.new_rounds === 0) {
    return `already up to date · ${count(result.rounds)} rounds, ${result.sessions} sessions`
  }
  const rounds = `${count(result.new_rounds)} round${result.new_rounds === 1 ? '' : 's'}`
  const sessions = `${result.read_sessions} session${result.read_sessions === 1 ? '' : 's'}`
  return `+${rounds} from ${sessions} · ${count(result.rounds)} total`
}

/**
 * Sync, on a page that is about one session rather than the project it belongs to.
 *
 * There is no such thing as collecting a single session: an agent writes its log per project and
 * `collect` reads all of it. So this is the project's sync reached from inside a session — the
 * title says which project it would touch, and the sentence it leaves behind counts project-wide
 * rounds, not this session's.
 *
 * Only the one verb. Rename, Export and Delete are things you do *to* a project and stay on the
 * project's page; sync is here because a session you are still reading is exactly where you notice
 * the agent has kept working since you opened it.
 */
export function SyncButton({
  slug,
  project,
  onSynced,
}: {
  slug: string
  /** Named in the title, so it is plain that a sync from here is the whole project's. */
  project: string
  /** Called after a sync, so the page behind can re-read. */
  onSynced?: () => void
}): ReactElement {
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [bad, setBad] = useState(false)

  // A message about what just happened is worth reading and not worth keeping.
  useEffect(() => {
    if (said === null) return
    const at = window.setTimeout(() => setSaid(null), 8000)
    return () => window.clearTimeout(at)
  }, [said])

  const sync = async (): Promise<void> => {
    setBusy(true)
    setSaid(null)
    setBad(false)
    try {
      setSaid(syncSaid(await api.sync(slug)))
      onSynced?.()
    } catch (problem) {
      setBad(true)
      setSaid((problem as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="actions actions-float">
      <button
        className="action icon"
        onClick={() => void sync()}
        disabled={busy}
        title={`Sync ${project} — collect anything new, then re-analyse. The whole project, not just this session.`}
        aria-label={busy ? 'Working' : `Sync ${project}`}
      >
        <SyncGlyph spinning={busy} />
      </button>
      {said === null ? null : (
        <span className={`said${bad ? ' bad' : ''}`} role="status">
          {said}
        </span>
      )}
    </div>
  )
}

/** Which panel the `⋮` is showing: the list of verbs, or the one thing a verb needs before it runs. */
type Panel = 'menu' | 'rename' | 'remove'

/**
 * The things you can do to a project rather than read about it.
 *
 * All of them live behind one `⋮`. None is what anyone opened the page for — you come to read what
 * the agent did, not to collect or tidy up — and a menu keeps five verbs, two of them irreversible,
 * out of the way of that.
 *
 * **Sync** is `collect` then `analyze`, on this project. It reports what it did in the same words
 * the CLI would — new rounds, sessions read — rather than flashing a tick, because "synced" and
 * "found nothing new" are different outcomes and the second one is the common one.
 *
 * **Rename** sets a label and only a label. A project's directory in the store is a hash of the path
 * an agent ran in, and renaming deliberately does not move it: a name that decided a location would
 * be a name that could be typed on top of another project. Clearing the field puts back the name the
 * path gives it.
 *
 * **Export** hands the data to the browser to save. probez writes only under its own data
 * directory, so it never puts a file in the folder you choose; it gives the bytes to the page and
 * the page asks you where. Two formats, because they answer different questions: `.jsonl` is the
 * store's own file, the contract every stage reads, and `.json` is a bundle to look at, carrying
 * the analysis and the coverage its shares are shares of.
 *
 * Whatever comes out is unredacted — prompts, file paths, shell commands, exactly as typed.
 *
 * **Delete** is the only thing here that destroys anything, and it destroys the whole of what probez
 * recorded for one project. It asks first, in a panel that says what goes and what does not: the
 * agent's own session files are untouched, so a collected project comes back with `probez collect`
 * minus whatever the agent has since pruned. An imported one does not come back at all.
 *
 * What each one *did* is written out in words: an icon can say "sync" but it cannot say "already
 * up to date · 442 rounds", and that sentence is the point of pressing it.
 */
export function Actions({
  slug,
  project,
  renamed = false,
  rounds = null,
  onSynced,
  onRenamed,
  onRemoved,
  compact = false,
}: {
  slug: string
  /** What it is called now, which is what the rename field starts at. */
  project: string
  /** Whether that name was chosen rather than derived, so the panel can offer to put the other back. */
  renamed?: boolean
  /** What deleting would cost, when the page knows. */
  rounds?: number | null
  /** Called after a sync that changed something, so the page behind can re-read. */
  onSynced?: () => void
  onRenamed?: (name: string) => void
  onRemoved?: () => void
  compact?: boolean
}): ReactElement {
  const [busy, setBusy] = useState<'sync' | 'rename' | 'remove' | ExportFormat | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [bad, setBad] = useState(false)
  const [panel, setPanel] = useState<Panel | null>(null)
  const [name, setName] = useState(project)
  const box = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)

  // A message about what just happened is worth reading and not worth keeping.
  useEffect(() => {
    if (said === null) return
    const at = window.setTimeout(() => setSaid(null), 8000)
    return () => window.clearTimeout(at)
  }, [said])

  useEffect(() => {
    if (panel === null) return
    const close = (event: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(event.target as Node)) setPanel(null)
    }
    // Escape closes because two of these panels are questions, and a question you opened by accident
    // should be answerable with the key that means "no" everywhere else.
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPanel(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', key)
    }
  }, [panel])

  // Opening the field on a name that is not the project's current one would be a rename waiting to
  // happen, so it is reset every time rather than kept between openings.
  useEffect(() => {
    if (panel !== 'rename') return
    setName(project)
    field.current?.focus()
    field.current?.select()
  }, [panel, project])

  const report = (message: string, failed = false): void => {
    setBad(failed)
    setSaid(message)
  }

  const sync = async (): Promise<void> => {
    setBusy('sync')
    setSaid(null)
    try {
      report(syncSaid(await api.sync(slug)))
      onSynced?.()
    } catch (problem) {
      report((problem as Error).message, true)
    } finally {
      setBusy(null)
    }
  }

  const save = async (format: ExportFormat): Promise<void> => {
    setPanel(null)
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

  const rename = async (wanted: string): Promise<void> => {
    setPanel(null)
    setBusy('rename')
    setSaid(null)
    try {
      const result = await api.rename(slug, wanted)
      report(
        result.project.renamed
          ? `renamed to ${result.project.project}`
          : `name cleared · back to ${result.project.project}`,
      )
      onRenamed?.(result.project.project)
    } catch (problem) {
      report((problem as Error).message, true)
    } finally {
      setBusy(null)
    }
  }

  const remove = async (): Promise<void> => {
    setPanel(null)
    setBusy('remove')
    setSaid(null)
    try {
      const result = await api.remove(slug)
      report(`deleted ${result.project} · ${count(result.rounds)} rounds gone`)
      onRemoved?.()
    } catch (problem) {
      report((problem as Error).message, true)
      setBusy(null)
    }
    // Deliberately not cleared on success: the row this sits in is about to be taken away, and a
    // button that becomes pressable again in the meantime is a second delete waiting to be sent.
  }

  const stop = (event: { stopPropagation: () => void }): void => event.stopPropagation()
  const show = (next: Panel): void => setPanel(panel === next ? null : next)

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
          onClick={() => show('menu')}
          disabled={busy !== null}
          aria-expanded={panel !== null}
          aria-haspopup="menu"
          aria-label={busy === null ? 'Actions for this project' : 'Working'}
        >
          {busy === null ? (
            <Icon>
              <circle cx="8" cy="3.1" r="0.9" fill="currentColor" stroke="none" />
              <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
              <circle cx="8" cy="12.9" r="0.9" fill="currentColor" stroke="none" />
            </Icon>
          ) : (
            <SyncGlyph spinning />
          )}
        </button>
        {panel === 'menu' ? (
          <div className="menu" role="menu">
            <button
              role="menuitem"
              onClick={() => {
                setPanel(null)
                void sync()
              }}
            >
              <strong>Sync</strong>
              <span className="menu-note">collect anything new, then re-analyse</span>
            </button>
            <button role="menuitem" onClick={() => setPanel('rename')}>
              <strong>Rename…</strong>
              <span className="menu-note">what to call it here; nothing moves</span>
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
            <div className="menu-rule" role="separator" />
            <button className="grave" role="menuitem" onClick={() => setPanel('remove')}>
              <strong>Delete…</strong>
              <span className="menu-note">remove this project from the store</span>
            </button>
          </div>
        ) : null}

        {panel === 'rename' ? (
          <form
            className="menu menu-form"
            onSubmit={(event) => {
              event.preventDefault()
              void rename(name)
            }}
          >
            <label className="menu-label" htmlFor={`rename-${slug}`}>
              Call this project
            </label>
            <input
              id={`rename-${slug}`}
              ref={field}
              className="menu-field"
              value={name}
              maxLength={80}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setName(event.target.value)}
            />
            <p className="menu-note">
              {renamed
                ? 'A name of your own. Clear it to go back to the one its path gives it.'
                : 'A label for this machine. The store directory and every link keep their names.'}
            </p>
            <div className="menu-row">
              <button type="button" className="ghost" onClick={() => setPanel(null)}>
                Cancel
              </button>
              <button type="submit" className="save" disabled={name.trim() === project}>
                Rename
              </button>
            </div>
          </form>
        ) : null}

        {panel === 'remove' ? (
          <div className="menu menu-form" role="dialog" aria-label={`Delete ${project}`}>
            <strong>Delete {project}?</strong>
            <p className="menu-note">
              {rounds === null ? 'Every round' : `All ${count(rounds)} rounds`} probez recorded for
              it, the session copies beside them and the analysis go. There is no undo.
            </p>
            <p className="menu-note">
              The agent's own session files are not touched — probez has only ever read those — so{' '}
              <span className="mono">probez collect</span> brings back whatever the agent still has.
              An import does not come back: the file it arrived as is the only other copy.
            </p>
            <div className="menu-row">
              <button type="button" className="ghost" onClick={() => setPanel(null)}>
                Cancel
              </button>
              <button type="button" className="save grave" onClick={() => void remove()}>
                Delete
              </button>
            </div>
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
