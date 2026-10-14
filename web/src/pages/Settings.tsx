import { useEffect, useState } from 'react'

import { api } from '../api'
import type { PricedModel, PricingPayload, Rates, ReaderPayload } from '../api'
import { Chrome, Loading, Problem } from '../components/Chrome'
import { CommandKinds } from '../components/CommandKinds'
import { DangerZone } from '../components/DangerZone'
import { naturalFor, ordered, SortHead, useSort } from '../components/SortHead'
import { count } from '../format'
import { forgetProjectList } from '../components/ScopeBar'
import { href, linkProps, SETTINGS_TABS } from '../router'
import type { SettingsTab } from '../router'
import { useData } from '../useData'
import { forgetIdentity, useDebug } from '../meta'
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

type RateSort = 'model' | 'rounds' | keyof Rates

const rateNatural = naturalFor<RateSort>('model')

/**
 * What a column of the rate table sorts by. A rate is the saved one rather than the one being
 * typed, so a row stays put under the cursor until Save; an unpriced model sorts last.
 */
function rateValue(model: PricedModel, key: RateSort): number | string | null {
  if (key === 'model') return model.model
  if (key === 'rounds') return model.rounds
  return model.rates === null ? null : model.rates[key]
}

const BLANK: Rates ={ in: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, out: 0 }

/**
 * What each model charges, per million tokens.
 *
 * These numbers are not decoration: every share on every "where agent work goes" table with a cost
 * to divide is a share of what the work cost, so a wrong rate here is a wrong answer there. A table
 * with nothing priced at all falls back to the round share and marks itself. They ship at the published
 * list prices and are editable because list prices change, because negotiated rates exist, and
 * because a model probez has never heard of should not be silently free.
 *
 * Edits are held locally until Save, so a half-typed number never becomes the rate that prices a
 * store.
 */
function Pricing(): ReactElement {
  const [data, setData] = useState<PricingPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, Record<string, string>>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [sorted, sortBy] = useSort<RateSort>(rateNatural)
  /**
   * Models named here rather than found in the store.
   *
   * The table is otherwise built from three things that have all already happened: models with
   * rounds collected, models the rate file names, and models with a published price. None of them
   * can contain a model you have not run yet — so before this there was no way to price Codex on a
   * machine that had not collected any Codex sessions, and no way to price anything probez does not
   * ship a rate for until after the bill had been run up.
   */
  const [added, setAdded] = useState<string[]>([])
  const [naming, setNaming] = useState('')

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
    // `load` closes over setters only. A clear, which changes the round counts, is on another tab,
    // so arriving here after one reads them afresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const edit = (model: string, field: string, value: string): void => {
    setSaved(null)
    setDraft((current) => ({ ...current, [model]: { ...current[model], [field]: value } }))
  }

  const save = async (): Promise<void> => {
    const models: Record<string, Rates | null> = {}
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
      // A blank goes as an explicit null, never by being left out. Omitting it used to be how a row
      // was blanked, back when the file was the whole truth; now an omission means "never heard of
      // it" and the published rate would come straight back on the next read.
      models[model] = usable ? (rates as unknown as Rates) : null
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
              Share under <em>where agent work goes</em> is a share of cost, so these rates decide
              it — and where nothing is priced there is no cost to divide, so that table falls back
              to the round share. Tokens is a separate column over input+output volume and does not
              use these rates. They ship at the published list prices; edit any that are wrong for you — a
              negotiated rate, a price that has moved, or a model probez does not know. Stored at{' '}
              <span className="mono">{data.file}</span>, owner-only, and never sent anywhere — like
              everything else probez holds, apart from the one thing the reader below sends when you
              ask it to.
            </p>

            <section>
              <table>
                <thead>
                  <tr>
                    <SortHead label="Model" head="model" sorted={sorted} onSort={sortBy} style={{ width: 210 }} />
                    <SortHead label="Rounds" head="rounds" sorted={sorted} onSort={sortBy} className="r" style={{ width: 80 }} />
                    {FIELDS.map((field) => (
                      <SortHead
                        key={field.key}
                        label={field.label}
                        head={field.key}
                        sorted={sorted}
                        onSort={sortBy}
                        className="r"
                        title={`${field.hint} Sorts by the saved rate, so a row does not move while you type.`}
                      />
                    ))}
                    <th style={{ width: 70 }} />
                  </tr>
                </thead>
                <tbody>
                  {ordered(
                    [
                      ...data.models,
                      // Shown as a row like any other, with no rounds behind it, so it is priced and
                      // saved by exactly the controls the rest of the table uses.
                      ...added
                        .filter((one) => !data.models.some((model) => model.model === one))
                        .map((one): PricedModel => ({ model: one, rounds: 0, rates: null, custom: false })),
                    ],
                    sorted,
                    rateValue,
                  ).map((model) => (
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

              <form
                className="add-model"
                onSubmit={(event) => {
                  event.preventDefault()
                  const name = naming.trim()
                  if (name === '') return
                  setAdded((was) => (was.includes(name) ? was : [...was, name]))
                  setDraft((current) => ({ ...current, [name]: current[name] ?? blank() }))
                  setNaming('')
                  setSaved(null)
                }}
              >
                <input
                  className="mono"
                  value={naming}
                  spellCheck={false}
                  placeholder="gpt-5"
                  aria-label="Add a model by name"
                  onChange={(event) => setNaming(event.target.value)}
                />
                <button type="submit" className="ghost" disabled={naming.trim() === ''}>
                  Add a model
                </button>
                <span className="muted">
                  For a model you have not run yet, or one probez ships no rate for. The name has to
                  be the one the agent records — <span className="mono">gpt-5</span> for Codex.
                </span>
              </form>

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

          </>
        )}
    </>
  )
}

const TAB_LABEL: Record<SettingsTab, string> = {
  pricing: 'Pricing',
  commands: 'Commands',
  findings: 'Findings',
  reader: 'Reader',
  data: 'Data',
}

/**
 * Settings, as five tabs rather than one long page.
 *
 * They are five unrelated things — what every token costs, what this machine's commands are, where
 * a finding starts, what probez may run, and the store itself — and one scroll put the button that
 * clears every project a long way under the rate for a model. Each tab is its own address, so a
 * finding can send you straight to the line it was drawn at.
 */
export function Settings({ tab }: { tab: SettingsTab }): ReactElement {
  const debug = useDebug()
  return (
    <>
      <Chrome crumbs={[{ label: 'Settings' }, { label: TAB_LABEL[tab] }]} search={{}} scope="none" />
      <main className="page">
        <div className="head">
          <h1>Settings</h1>
        </div>
        <div className="tabs" role="tablist" aria-label="Settings">
          {/* The reader explains questions, which exist under `probez view --debug` only. */}
          {SETTINGS_TABS.filter((one) => debug || one !== 'reader' || tab === 'reader').map((one) => (
            <a
              key={one}
              role="tab"
              aria-selected={one === tab}
              className={one === tab ? 'tab on' : 'tab'}
              {...linkProps(href.settings(one))}
            >
              {TAB_LABEL[one]}
            </a>
          ))}
        </div>
        <div role="tabpanel" aria-label={TAB_LABEL[tab]}>
          {tab === 'pricing' ? (
            <Pricing />
          ) : tab === 'commands' ? (
            <CommandKinds />
          ) : tab === 'findings' ? (
            <FindingsSettings />
          ) : tab === 'reader' ? (
            <Reader />
          ) : (
            <>
              <Identity />
              <DangerZone onCleared={() => forgetProjectList()} />
            </>
          )}
        </div>
      </main>
    </>
  )
}

/**
 * Who this machine's rounds belong to.
 *
 * Every export names its rounds for this, so whoever merges the file can tell your work from
 * theirs and filter to either. Left blank, it is git's `user.name`, or the account name.
 */
function Identity(): ReactElement {
  const { data, error } = useData(() => api.identity(), [])
  const [name, setName] = useState<string | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [bad, setBad] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (data !== null) setName(data.chosen ? data.committer : '')
  }, [data])

  if (error !== null && data === null) return <Problem message={error} />
  if (data === null || name === null) return <Loading what="who you are" />

  const save = async (wanted: string): Promise<void> => {
    setSaving(true)
    setSaid(null)
    setBad(null)
    try {
      const saved = await api.saveIdentity(wanted)
      setName(saved.chosen ? saved.committer : '')
      setSaid(`Saved. Your exports name their rounds ${saved.committer}.`)
      forgetIdentity()
    } catch (problem) {
      setBad(problem instanceof Error ? problem.message : String(problem))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section>
      <h2>Who you are</h2>
      <p className="note">
        The name this machine's rounds go out under. Every export carries it, so when someone merges your
        export into their copy of a project — <span className="mono">⋮ › Merge from another computer</span> —
        your work and theirs can be told apart, and the charts filtered to either. Rounds merged in from
        elsewhere keep the name they arrived with.
      </p>
      <label className="threshold">
        <span>
          <strong>Your name</strong>
          <span className="muted">
            {data.chosen ? 'Clear it to go back to the one git gives.' : `Blank is ${data.committer}, from git or this account.`}
          </span>
        </span>
        <span className="threshold-input">
          <input
            className="rate"
            style={{ width: 220, textAlign: 'left' }}
            aria-label="Your name"
            value={name}
            maxLength={80}
            placeholder={data.chosen ? '' : data.committer}
            onChange={(event) => {
              setSaid(null)
              setName(event.target.value)
            }}
          />
        </span>
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
        <button className="save" onClick={() => void save(name)} disabled={saving}>
          {saving ? 'Saving…' : 'Save name'}
        </button>
        {said === null ? null : <span className="muted">{said}</span>}
        {bad === null ? null : <span className="bad">{bad}</span>}
      </div>
    </section>
  )
}

/**
 * The two lines a finding is drawn at, as percentages.
 *
 * Typed as whole percentages because that is how the Findings page states them, and stored as
 * shares because that is what the comparison needs. Held locally until Save, like the rates.
 */
function FindingsSettings(): ReactElement {
  const { data, error } = useData(() => api.thresholds(), [])
  const [draft, setDraft] = useState<{ reconstruction: string; context: string } | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [bad, setBad] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (data === null) return
    setDraft({
      reconstruction: String(Math.round(data.thresholds.reconstruction * 100)),
      context: String(Math.round(data.thresholds.context * 100)),
    })
  }, [data])

  if (error !== null && data === null) return <Problem message={error} />
  if (data === null || draft === null) return <Loading what="the thresholds" />

  const save = async (values: { reconstruction: string; context: string }): Promise<void> => {
    const reconstruction = Number(values.reconstruction) / 100
    const context = Number(values.context) / 100
    setBad(null)
    setSaid(null)
    // Checked here in the units the fields are typed in. The server checks again, in shares.
    for (const [name, share] of [
      ['Reconstruction share', reconstruction],
      ['Context occupancy', context],
    ] as const) {
      if (!Number.isFinite(share) || share <= 0 || share >= 1) {
        setBad(`${name} must be a percentage above 0 and below 100.`)
        return
      }
    }
    setSaving(true)
    try {
      const saved = await api.saveThresholds({ reconstruction, context })
      setDraft({
        reconstruction: String(Math.round(saved.thresholds.reconstruction * 100)),
        context: String(Math.round(saved.thresholds.context * 100)),
      })
      setSaid('Saved. The Findings page now draws at these lines.')
    } catch (problem) {
      setBad(problem instanceof Error ? problem.message : String(problem))
    } finally {
      setSaving(false)
    }
  }

  const field = (key: 'reconstruction' | 'context', label: string, hint: string): ReactElement => (
    <label className="threshold">
      <span>
        <strong>{label}</strong>
        <span className="muted">{hint}</span>
      </span>
      <span className="threshold-input">
        <input
          className="rate"
          inputMode="numeric"
          aria-label={`${label}, percent`}
          value={draft[key]}
          onChange={(event) => {
            setSaid(null)
            setDraft({ ...draft, [key]: event.target.value })
          }}
        />
        %
      </span>
    </label>
  )

  return (
    <section>
      <h2>Where a finding starts</h2>
      <p className="note">
        Two of the findings are a matter of degree, so they need a line. Each finding names the line it was drawn
        at, so a change here shows on the Findings page and not only on this one. Kept at{' '}
        <span className="mono">{data.file}</span>, owner-only, beside the rates.
      </p>
      {field(
        'reconstruction',
        'Reconstruction share',
        `A session is a finding when more than this share of its cost went on finding its way around code. Default ${Math.round(data.defaults.reconstruction * 100)}%.`,
      )}
      {field(
        'context',
        'Context occupancy',
        `A task is a finding when a round filled more than this share of its model's input window. Default ${Math.round(data.defaults.context * 100)}%.`,
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
        <button className="save" onClick={() => void save(draft)} disabled={saving}>
          {saving ? 'Saving…' : 'Save thresholds'}
        </button>
        <button
          className="ghost"
          onClick={() =>
            void save({
              reconstruction: String(Math.round(data.defaults.reconstruction * 100)),
              context: String(Math.round(data.defaults.context * 100)),
            })
          }
          disabled={saving}
        >
          Reset to defaults
        </button>
        {said === null ? null : <span className="muted">{said}</span>}
        {bad === null ? null : <span className="bad">{bad}</span>}
      </div>
    </section>
  )
}

/**
 * The command `explain` runs: the only program probez starts at a person's direction, and the only
 * one that could reach off the machine. (Collection starts one other, `git log`, in a project whose
 * reflog cannot date a task — local, read-only, and nothing anyone configures.)
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
        {/* The command most people here already have, one click from typed. It fills the field
            rather than saving, so what will run is still read before it is kept. */}
        {command.trim() === '' ? (
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setSaved(null)
              setCommand('claude -p')
            }}
          >
            Use Claude Code (claude -p)
          </button>
        ) : null}
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
