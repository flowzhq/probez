import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import { api } from '../api'
import type { CommandsPayload } from '../api'
import { count } from '../format'

/**
 * Command names this machine knows and probez does not.
 *
 * probez ships a table of commands general enough to mean the same thing anywhere: `grep` is a
 * search wherever it runs. A repository's own script is not like that — and probez only ever sees a
 * command's last path segment, so `bin/check` arrives as `check`, a name far too generic to put in a
 * table shared with every other machine. Naming it here is the alternative to leaving it in
 * `unclassified`, which is where it sits until somebody does.
 *
 * The list underneath is the point: it is what this store has actually run and nothing has
 * classified, most-used first. Naming a command you have never run is possible and rarely what
 * anyone wants.
 */
export function CommandKinds(): ReactElement {
  const [data, setData] = useState<CommandsPayload | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [bad, setBad] = useState(false)

  const load = (payload: CommandsPayload): void => {
    setData(payload)
    setDraft(payload.commands)
  }

  useEffect(() => {
    let live = true
    api
      .commands()
      .then((payload) => {
        if (live) load(payload)
      })
      .catch((problem: Error) => {
        if (live) {
          setSaid(problem.message)
          setBad(true)
        }
      })
    return () => {
      live = false
    }
  }, [])

  if (data === null) return <section />

  const set = (name: string, kind: string): void => {
    setSaid(null)
    setDraft((current) => {
      const next = { ...current }
      // Choosing the blank option is how a name is taken back off the table.
      if (kind === '') delete next[name]
      else next[name] = kind
      return next
    })
  }

  const save = (): void => {
    setSaving(true)
    setBad(false)
    api
      .saveCommands(draft)
      .then((payload) => {
        setSaving(false)
        load(payload)
        setSaid('Saved. Rounds are counted under these from the next analyze.')
      })
      .catch((problem: Error) => {
        setSaving(false)
        setSaid(problem.message)
        setBad(true)
      })
  }

  // Everything named, plus everything unnamed the store has actually run.
  const rows = [
    ...Object.keys(draft).sort(),
    ...data.unnamed.map((one) => one.name).filter((name) => draft[name] === undefined),
  ]
  const callsOf = new Map(data.unnamed.map((one) => [one.name, one.calls]))

  return (
    <section>
      <h2>What this machine calls things</h2>
      <p className="note">
        probez classifies a command by name, and it only ever sees the last part of a path, so a
        repository's own <span className="mono">bin/check</span> arrives as{' '}
        <span className="mono">check</span>. A name that generic cannot go in the table probez
        ships, where it would relabel an unrelated one on somebody else's machine, so names that
        mean something here go in{' '}
        <span className="mono">{data.file}</span>. Anything left blank stays unclassified, which is
        reported rather than guessed at. This only decides which column a round is counted in; it
        cannot make probez run, read or send anything.
      </p>

      {rows.length === 0 ? (
        <p className="note">Nothing this store has run is unclassified. There is nothing to name.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th style={{ width: 240 }}>Command</th>
              <th className="r" style={{ width: 90 }}>
                Calls
              </th>
              <th style={{ width: 160 }}>Counts as</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((name) => (
              <tr key={name}>
                <td className="mono">{name}</td>
                <td className="r num dim">
                  {callsOf.get(name) === undefined ? '·' : count(callsOf.get(name)!)}
                </td>
                <td>
                  <select
                    value={draft[name] ?? ''}
                    aria-label={`What ${name} counts as`}
                    onChange={(event) => set(name, event.target.value)}
                  >
                    <option value="">unclassified</option>
                    {data.kinds
                      .filter((kind) => kind !== 'other')
                      .map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                  </select>
                </td>
                <td className="muted">
                  {draft[name] === undefined ? '' : 'named here'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
        <button className="save" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save names'}
        </button>
        {said === null ? null : <span className={bad ? 'bad' : 'muted'}>{said}</span>}
      </div>
    </section>
  )
}
