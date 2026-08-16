import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { api } from '../api'
import { count } from '../format'

/**
 * Take in a project someone exported.
 *
 * It belongs to the store rather than to any one project — importing *makes* a project, so putting
 * it under an existing project's menu would be a category error, and it would also be unreachable
 * on the empty store where it is most needed.
 *
 * The browser reads the file the person picked and sends its text. probez never learns the path it
 * came from and could not open it if it did; the only thing that crosses is the bytes.
 *
 * What arrives is somebody else's work. probez cannot check any of it, and shows it as faithfully
 * as it shows your own — prompts, commands and all. See SECURITY.md.
 */
export function Import({ onImported }: { onImported?: () => void }): ReactElement {
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [bad, setBad] = useState(false)
  const file = useRef<HTMLInputElement>(null)

  // A message about what just happened is worth reading and not worth keeping.
  useEffect(() => {
    if (said === null) return
    const at = window.setTimeout(() => setSaid(null), 10000)
    return () => window.clearTimeout(at)
  }, [said])

  const take = async (picked: File): Promise<void> => {
    setBusy(true)
    setSaid(null)
    setBad(false)
    try {
      const result = await api.import(await picked.text(), picked.name)
      const what = `${count(result.rounds)} rounds, ${result.sessions} sessions`
      const lost = result.skipped > 0 ? ` · ${result.skipped} records skipped` : ''
      setSaid(`${result.replaced ? 'replaced' : 'imported'} ${result.name} · ${what}${lost}`)
      onImported?.()
    } catch (problem) {
      setBad(true)
      setSaid((problem as Error).message)
    } finally {
      setBusy(false)
      // Cleared so picking the same file twice fires a change event the second time too.
      if (file.current !== null) file.current.value = ''
    }
  }

  return (
    <div className="actions actions-float">
      <button
        className="action"
        onClick={() => file.current?.click()}
        disabled={busy}
        title="Read a project someone exported, from .json or .jsonl"
      >
        {busy ? 'Importing…' : 'Import'}
      </button>
      <input
        ref={file}
        type="file"
        accept=".json,.jsonl,application/json,application/x-ndjson"
        hidden
        onChange={(event) => {
          const picked = event.target.files?.[0]
          if (picked !== undefined) void take(picked)
        }}
      />
      {said === null ? null : (
        <span className={`said${bad ? ' bad' : ''}`} role="status">
          {said}
        </span>
      )}
    </div>
  )
}
