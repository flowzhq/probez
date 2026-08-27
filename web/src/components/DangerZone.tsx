import { useState } from 'react'
import type { ReactElement } from 'react'

import { api } from '../api'
import type { ClearPayload } from '../api'
import { count } from '../format'

/**
 * The two things in probez that destroy more than one project.
 *
 * They live at the bottom of Settings, behind their own heading, because everything else on this
 * page is a preference and these are not: a rate typed wrong is corrected by typing it again, and
 * a store cleared by mistake is only as recoverable as the agent's own files still are.
 *
 * Neither button acts. Pressing one asks the server what would go and shows it — the same plan the
 * command prints — and only the second press, in a panel that has the figures in it, removes
 * anything. That is the whole design: you cannot get here without having been shown the size of
 * what you are about to lose.
 */
const WINDOWS = [
  { id: '30d', label: 'older than 30 days' },
  { id: '90d', label: 'older than 90 days' },
  { id: '180d', label: 'older than 180 days' },
  { id: '365d', label: 'older than a year' },
]

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export function DangerZone({ onCleared }: { onCleared: () => void }): ReactElement {
  const [scope, setScope] = useState<'all' | 'before'>('before')
  const [window, setWindow] = useState('90d')
  const [asked, setAsked] = useState<ClearPayload | null>(null)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [bad, setBad] = useState(false)

  const report = (message: string, failed = false): void => {
    setSaid(message)
    setBad(failed)
  }

  const look = (which: 'all' | 'before'): void => {
    setScope(which)
    setBusy(true)
    setSaid(null)
    api
      .clear(which, which === 'before' ? { before: window } : {})
      .then((found) => {
        setBusy(false)
        setAsked(found)
      })
      .catch((problem: Error) => {
        setBusy(false)
        report(problem.message, true)
      })
  }

  const run = (): void => {
    setBusy(true)
    api
      .clear(scope, { ...(scope === 'before' ? { before: window } : {}), apply: true })
      .then((found) => {
        setBusy(false)
        setAsked(null)
        const done = found.done
        report(
          done === null
            ? 'nothing was removed'
            : `removed ${count(done.sessions)} sessions · ${count(done.rounds)} rounds · ${bytes(done.bytes)} freed`,
        )
        onCleared()
      })
      .catch((problem: Error) => {
        setBusy(false)
        report(problem.message, true)
      })
  }

  const plan = asked?.plan ?? null

  return (
    <section className="danger">
      <h2>Danger zone</h2>
      <p className="note">
        These remove what probez has recorded. The agent's own session files are never touched — so
        a project cleared by mistake comes back with <span className="mono">probez collect</span>,
        minus whatever the agent has pruned since. An imported project does not come back: the file
        it arrived as is the only other copy. Neither button acts on its first press.
      </p>

      <div className="danger-row">
        <div>
          <strong>Trim old history</strong>
          <p className="menu-note">
            Clears whole sessions whose last round is older than the window, and the archived
            transcripts beside them — which are the great majority of what a store weighs. A project
            with any newer work keeps it.
          </p>
        </div>
        <select
          value={window}
          aria-label="How much to keep"
          onChange={(event) => {
            setWindow(event.target.value)
            setAsked(null)
          }}
        >
          {WINDOWS.map((one) => (
            <option key={one.id} value={one.id}>
              {one.label}
            </option>
          ))}
        </select>
        <button type="button" className="ghost" disabled={busy} onClick={() => look('before')}>
          Show what would go
        </button>
      </div>

      <div className="danger-row">
        <div>
          <strong>Clear the whole store</strong>
          <p className="menu-note">
            Every project probez has recorded, its rounds, its archived sessions and its analysis.
            Your rates and your reader stay.
          </p>
        </div>
        <button type="button" className="ghost grave" disabled={busy} onClick={() => look('all')}>
          Show what would go
        </button>
      </div>

      {plan === null ? null : (
        <div className="danger-plan" role="dialog" aria-label="What would be removed">
          {plan.totals.projects === 0 ? (
            <>
              <strong>Nothing to remove.</strong>
              <p className="menu-note">
                {scope === 'all'
                  ? 'The store is already empty.'
                  : 'Nothing in the store is older than that.'}
              </p>
              <div className="menu-row">
                <button type="button" className="ghost" onClick={() => setAsked(null)}>
                  Close
                </button>
              </div>
            </>
          ) : (
            <>
              <strong>
                {scope === 'all'
                  ? `Remove all ${count(plan.totals.projects)} projects?`
                  : `Remove ${count(plan.totals.sessions)} sessions from ${count(plan.totals.projects)} projects?`}
              </strong>
              <p className="menu-note">
                {count(plan.totals.rounds)} rounds · {bytes(plan.totals.bytes)} freed
                {plan.totals.whole > 0
                  ? ` · ${count(plan.totals.whole)} projects would go entirely`
                  : ''}
                . There is no undo.
              </p>
              {/* The biggest few by name, because a total is a number and a name is a thing you
                  recognise. Somebody about to lose a project should see it called what they call
                  it, not counted. */}
              <ul className="danger-list">
                {[...plan.projects]
                  .sort((a, b) => b.bytes - a.bytes)
                  .slice(0, 6)
                  .map((one) => (
                    <li key={one.slug}>
                      <span className="danger-name">{one.project}</span>
                      <span className="muted">
                        {one.whole ? 'all of it' : `${count(one.sessions)} sessions`} ·{' '}
                        {count(one.rounds)} rounds · {bytes(one.bytes)}
                      </span>
                    </li>
                  ))}
                {plan.projects.length > 6 ? (
                  <li className="muted">… and {count(plan.projects.length - 6)} more</li>
                ) : null}
              </ul>
              <div className="menu-row">
                <button type="button" className="ghost" onClick={() => setAsked(null)}>
                  Cancel
                </button>
                <button type="button" className="save grave" disabled={busy} onClick={run}>
                  {busy ? 'Removing…' : 'Remove'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {said === null ? null : (
        <p className={`said${bad ? ' bad' : ''}`} role="status">
          {said}
        </p>
      )}
    </section>
  )
}
