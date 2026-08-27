import { useEffect, useState } from 'react'

import { api } from '../api'
import type { PricedModel, PricingPayload, Rates, ReaderPayload } from '../api'
import { Chrome, Loading, Problem } from '../components/Chrome'
import { DangerZone } from '../components/DangerZone'
import { count } from '../format'
import { href } from '../router'
import type { ReactElement } from 'react'

/** The five rates, in the order money moves: in, cached, back out. */
const FIELDS: Array<{ key: keyof Rates; label: string; hint: string }> = [
  { key: 'in', label: 'Input', hint: 'Tokens the model had not seen before.' },
  {
    key: 'cache_write_5m',
    label: 'Cache write 5m',
    hint: 'Written to a 5-minute cache entry. Usually 1.25× the input rate.',
  },
  {
    key: 'cache_write_1h',
    label: 'Cache write 1h',
    hint: 'Written to a 1-hour cache entry. Usually 2× the input rate, and on most agent traffic this is nearly every write.',
  },
  {
    key: 'cache_read',
    label: 'Cache read',
    hint: 'Served from cache. Usually a tenth of the input rate, and usually most of the tokens.',
  },
  { key: 'out', label: 'Output', hint: 'Tokens the model produced.' },
]

const BLANK: Rates = { in: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, out: 0 }

/**
 * What each model charges, per million tokens.
 *
 * These numbers are not decoration: every share on every "where agent work goes" table is a share
 * of what the work cost, so a wrong rate here is a wrong answer there. They ship at the published
 * list prices and are editable because list prices change, because negotiated rates exist, and
 * because a model probez has never heard of should not be silently free.
 *
 * Edits are held locally until Save, so a half-typed number never becomes the rate that prices a
 * store.
 */
export function Settings(): ReactElement {
  const [data, setData] = useState<PricingPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, Record<string, string>>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  // Bumped after a clear. The rate table counts the rounds each model was used for, and a clear
  // is the one thing on this page that changes them.
  const [read, setRead] = useState(0)

  const load = (payload: PricingPayload): void => {
    setData(payload)
    setDraft(fill(payload.models))
  }

  useEffect(() => {
    let live = true
    api
      .pricing()
      .then((payload) => {
        if (live) load(payload)
      })
      .catch((problem: Error) => {
        if (live) setError(problem.message)
      })
    return () => {
      live = false
    }
    // `load` closes over setters only; the counter is the real key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read])

  const edit = (model: string, field: string, value: string): void => {
    setSaved(null)
    setDraft((current) => ({ ...current, [model]: { ...current[model], [field]: value } }))
  }

  const save = async (): Promise<void> => {
    const models: Record<string, Rates> = {}
    for (const [model, fields] of Object.entries(draft)) {
      const rates: Record<string, number> = {}
      let usable = true
      for (const { key } of FIELDS) {
        const raw = (fields[key] ?? '').trim()
        const value = Number(raw)
        // A blank row is a model nobody has priced, which is a different thing from a model priced
        // at zero — it stays unpriced rather than becoming free.
        if (raw === '' || !Number.isFinite(value) || value < 0) usable = false
        else rates[key] = value
      }
      if (usable) models[model] = rates as unknown as Rates
    }

    setSaving(true)
    setError(null)
    try {
      const payload = await api.savePricing(models)
      load(payload)
      setSaved('Saved. Every share on every page is now a share of these rates.')
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem))
    } finally {
      setSaving(false)
    }
  }

  const reset = (model: string): void => {
    const published = data?.defaults[model]
    if (published === undefined) return
    setSaved(null)
    setDraft((current) => ({ ...current, [model]: asStrings(published) }))
  }

  return (
    <>
      <Chrome crumbs={[{ label: 'Projects', to: href.projects() }, { label: 'Settings' }]} search={{}} />
      <main className="page">
        {error !== null && data === null ? (
          <Problem message={error} />
        ) : data === null ? (
          <Loading what="the rates" />
        ) : (
          <>
            <div className="head">
              <h1>Token pricing</h1>
              <span className="muted">dollars per million tokens</span>
            </div>
            <p className="note">
              Shares under <em>where agent work goes</em> are shares of cost, so these rates decide
              them. They ship at the published list prices; edit any that are wrong for you — a
              negotiated rate, a price that has moved, or a model probez does not know. Stored at{' '}
              <span className="mono">{data.file}</span>, owner-only, and never sent anywhere — like
              everything else probez holds, apart from the one thing the reader below sends when you
              ask it to.
            </p>

            <section>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 210 }}>Model</th>
                    <th className="r" style={{ width: 80 }}>
                      Rounds
                    </th>
                    {FIELDS.map((field) => (
                      <th key={field.key} className="r" title={field.hint}>
                        {field.label}
                      </th>
                    ))}
                    <th style={{ width: 70 }} />
                  </tr>
                </thead>
                <tbody>
                  {data.models.map((model) => (
                    <tr key={model.model}>
                      <td className="mono">
                        {model.model}
                        {model.rates === null ? <span className="bad"> no rate</span> : null}
                        {model.custom ? <span className="muted"> edited</span> : null}
                      </td>
                      <td className="r num dim">{model.rounds === 0 ? '·' : count(model.rounds)}</td>
                      {FIELDS.map((field) => (
                        <td key={field.key} className="r">
                          <input
                            className="rate"
                            inputMode="decimal"
                            aria-label={`${model.model} ${field.label}`}
                            value={draft[model.model]?.[field.key] ?? ''}
                            placeholder="—"
                            onChange={(event) => edit(model.model, field.key, event.target.value)}
                          />
                        </td>
                      ))}
                      <td>
                        {data.defaults[model.model] === undefined ? null : (
                          <button className="ghost" onClick={() => reset(model.model)}>
                            reset
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
                <button className="save" onClick={() => void save()} disabled={saving}>
                  {saving ? 'Saving…' : 'Save rates'}
                </button>
                {saved === null ? null : <span className="muted">{saved}</span>}
                {error === null ? null : <span className="bad">{error}</span>}
              </div>

              <p className="note" style={{ marginTop: 14 }}>
                A cache write has two prices because a cache entry has two lifetimes: the 5-minute
                entry costs about 1.25× the input rate and the 1-hour entry about 2×. Cache reads
                cost about a tenth. Leave a row blank to leave a model unpriced — its rounds are
                then reported as outside the shares rather than counted as free.
              </p>
            </section>

            <hr />
            <Reader />
            <DangerZone onCleared={() => setRead((was) => was + 1)} />
          </>
        )}
      </main>
    </>
  )
}

/**
 * The command `explain` runs, which is the only program probez ever starts.
 *
 * Everything else here reads files and draws them. This is the one setting that gives probez
 * something to execute, so the screen says exactly what that means: it is argv and not a shell
 * line, it runs only when someone presses <em>explain</em> on one question, and the only thing
 * written to its stdin is that question's own calls. Blank it out and there is nothing to run.
 */
function Reader(): ReactElement {
  const [data, setData] = useState<ReaderPayload | null>(null)
  const [command, setCommand] = useState('')
  const [seconds, setSeconds] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = (payload: ReaderPayload): void => {
    setData(payload)
    setCommand(payload.command.join(' '))
    setSeconds(String(Math.round(payload.timeout_ms / 1000)))
  }

  useEffect(() => {
    let live = true
    api
      .reader()
      .then((payload) => {
        if (live) load(payload)
      })
      .catch((problem: Error) => {
        if (live) setError(problem.message)
      })
    return () => {
      live = false
    }
  }, [])

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const wait = Number(seconds)
      const payload = await api.saveReader(
        command.trim() === '' ? [] : command.trim().split(/\s+/),
        Number.isFinite(wait) && wait > 0 ? Math.round(wait * 1000) : 60_000,
      )
      load(payload)
      setSaved(
        payload.command.length === 0
          ? 'Saved. With no command there is nothing probez can run.'
          : `Saved. \`explain\` now runs ${payload.command.join(' ')}.`,
      )
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem))
    } finally {
      setSaving(false)
    }
  }

  if (data === null) return <section />

  return (
    <section>
      <div className="head">
        {/* An h1, like `Token pricing` above it: this is the page's other subject, not a
            subsection of the rates. */}
        <h1>Reader</h1>
        <span className="muted">the command `explain` runs</span>
      </div>
      <p className="note">
        A question is one thing an agent needed to know, and probez says which of six kinds it was
        by a rule. <em>explain</em>, on any question, asks a model instead — and the model is one
        you already have: name the command here and probez writes the question's calls to its stdin
        and keeps the sentence it answers with. <span className="mono">claude -p</span>,{' '}
        <span className="mono">ollama run llama3</span>, anything that reads a prompt and prints an
        answer. Stored at <span className="mono">{data.file}</span>, owner-only.
      </p>
      <p className="note">
        This is <strong>argv, not a shell line</strong>: it is split on spaces and run directly, so
        a pipe, a semicolon or a <span className="mono">$(…)</span> in it is an argument and never a
        second command. It runs only when you press <em>explain</em>, only on the one question you
        pressed it on, and the only thing sent is that question's calls — no prompts you typed, no
        output any tool returned. Leave it blank and probez has nothing to run.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <input
          className="rate"
          style={{ width: 320, textAlign: 'left' }}
          aria-label="Reader command"
          placeholder="claude -p"
          value={command}
          onChange={(event) => {
            setSaved(null)
            setCommand(event.target.value)
          }}
        />
        <label className="muted">
          timeout{' '}
          <input
            className="rate"
            inputMode="numeric"
            aria-label="Reader timeout in seconds"
            value={seconds}
            onChange={(event) => {
              setSaved(null)
              setSeconds(event.target.value)
            }}
          />{' '}
          s
        </label>
        <button className="save" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save reader'}
        </button>
        {saved === null ? null : <span className="muted">{saved}</span>}
        {error === null ? null : <span className="bad">{error}</span>}
      </div>
    </section>
  )
}

function asStrings(rates: Rates): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { key } of FIELDS) out[key] = String(rates[key])
  return out
}

function fill(models: PricedModel[]): Record<string, Record<string, string>> {
  const draft: Record<string, Record<string, string>> = {}
  for (const model of models) {
    draft[model.model] = model.rates === null ? blank() : asStrings(model.rates)
  }
  return draft
}

function blank(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { key } of FIELDS) out[key] = String(BLANK[key] === 0 ? '' : BLANK[key])
  return out
}
