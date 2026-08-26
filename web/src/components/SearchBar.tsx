import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'

import { api } from '../api'
import type { FacetPayload } from '../api'
import { count } from '../format'
import { go, href } from '../router'
import type { Entity } from '../router'

/**
 * The query bar, on every page.
 *
 * Two things make it worth having rather than a box that filters the table underneath it.
 *
 * **It completes from what the store actually holds.** `tool:` offers the eleven tools this project
 * has really called, with how many rounds each is in, because a list of tools in general is a list
 * you still have to know the answer to use. That is what the index is for as much as speed: the
 * counts are a pass over a column, so offering them costs nothing.
 *
 * **It never punishes you for being half-way through.** Nothing is submitted until Enter, the
 * suggestions narrow as you type, and a key that is nearly a field is offered rather than refused.
 * The parser behind it is written to the same rule — a value that has not arrived yet narrows
 * nothing instead of matching nothing — so a query in progress is always a query.
 *
 * It is deliberately not a live-searching box. A keystroke that reads every project in the store is
 * a keystroke that can take a second, and a list that reorders under your hands while you are still
 * describing what you want is worse than one that waits to be asked.
 */
export function SearchBar({ slug, initial }: { slug?: string | null; initial?: string }): ReactElement {
  const [text, setText] = useState(initial ?? '')
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState(0)
  const [facets, setFacets] = useState<FacetPayload | null>(null)
  /** Set while the reader is being asked, and to whatever it refused with. */
  const [asking, setAsking] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)

  // The query in the address bar is the query in the box: arriving at a result by link, or by the
  // back button, has to leave the bar saying what produced what is on screen.
  useEffect(() => setText(initial ?? ''), [initial])

  // `/` and ⌘K are the two shortcuts people already try. `/` only outside a field, or it would
  // steal the key from anything else on the page that takes text.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if ((event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        input.current?.focus()
        input.current?.select()
        return
      }
      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        input.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Clicking anywhere else closes the menu. Blur alone would fire before a click on a suggestion.
  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [])

  const word = wordAt(text)
  const colon = word.text.indexOf(':')
  const key = colon === -1 ? null : word.text.slice(0, colon)
  const typed = colon === -1 ? word.text : word.text.slice(colon + 1)

  // The field list is the same table the parser validates against, fetched once; a field's values
  // are fetched when a colon says which field is being talked about.
  useEffect(() => {
    let live = true
    api
      .facets(key ?? undefined, slug)
      .then((found) => {
        if (live) setFacets(found)
      })
      .catch(() => {
        if (live) setFacets(null)
      })
    return () => {
      live = false
    }
  }, [key, slug])

  const options = suggest(facets, key, typed)
  useEffect(() => setAt(0), [word.text])

  const put = (value: string): void => {
    const next = text.slice(0, word.from) + value + text.slice(word.to)
    setText(next)
    input.current?.focus()
    // The caret goes after what was just completed, so the next thing typed continues the query.
    window.requestAnimationFrame(() => {
      const to = word.from + value.length
      input.current?.setSelectionRange(to, to)
    })
  }

  const submit = (value: string): void => {
    const asked = value.trim()
    if (asked === '') return
    setOpen(false)
    setRefused(null)
    input.current?.blur()
    go(href.search(asked, { slug }))
  }

  /**
   * Hand the sentence to the reader, and go to what it read.
   *
   * What comes back is a *query*, so what this navigates to is an ordinary result URL that anyone
   * can re-run without a reader. The sentence travels beside it as a caption. Nothing the model
   * says reaches a number — every figure on the page is still derived from the rounds.
   */
  const ask = (value: string): void => {
    const question = value.trim()
    if (question === '' || asking) return
    setOpen(false)
    setRefused(null)
    setAsking(true)
    api
      .compile(question, slug)
      .then((read) => {
        setAsking(false)
        go(href.search(read.query, { slug, from: read.sentence }))
      })
      .catch((problem: Error) => {
        setAsking(false)
        setRefused(problem.message)
      })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      if (open) setOpen(false)
      else input.current?.blur()
      return
    }
    if (open && options.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setAt((was) => (was + 1) % options.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setAt((was) => (was - 1 + options.length) % options.length)
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        put(options[at]!.insert)
        return
      }
      // Enter takes the highlighted suggestion only when one has been moved to. Otherwise it runs
      // the query, because pressing Enter on something you typed in full must not silently replace
      // it with whatever happened to be first in a list.
      if (event.key === 'Enter' && at > 0) {
        event.preventDefault()
        put(options[at]!.insert)
        return
      }
    }
    // ⌘↵ asks; ↵ searches. Two keys rather than one control that changes meaning, because the
    // difference between them is what is about to happen to your tokens.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      ask(text)
      return
    }
    if (event.key === 'Enter') submit(text)
  }

  return (
    <div className="find" ref={box}>
      <svg className="find-mark" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.4 10.4 L14 14" strokeLinecap="round" />
      </svg>
      <input
        ref={input}
        type="search"
        className="find-in"
        value={text}
        spellCheck={false}
        autoComplete="off"
        placeholder={slug === undefined || slug === null ? 'Search every project' : 'Search this project'}
        aria-label="Search"
        onChange={(event) => {
          setText(event.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {text === '' ? <kbd className="find-key">/</kbd> : null}
      {/* Only once there is something to ask about. A question is a different act from a query —
          it spends tokens on somebody else's program — so it is a button you press rather than
          something that happens when a box stops looking like a query. */}
      {text.trim() === '' ? null : (
        <button
          type="button"
          className="find-ask"
          disabled={asking}
          title="Read this as a question (⌘↵)"
          onClick={() => ask(text)}
        >
          {asking ? '…' : 'Ask'}
        </button>
      )}
      {refused === null ? null : (
        <p className="find-refused" role="alert">
          {refused}
        </p>
      )}
      {open && options.length > 0 ? (
        <ul className="find-menu" role="listbox">
          {options.map((option, index) => (
            <li key={option.insert + option.label}>
              <button
                type="button"
                role="option"
                aria-selected={index === at}
                className={index === at ? 'on' : undefined}
                onMouseEnter={() => setAt(index)}
                onClick={() => put(option.insert)}
              >
                <span className="find-name">{option.label}</span>
                <span className="find-says">{option.says}</span>
                {option.rounds === undefined ? null : (
                  <span className="find-count">{count(option.rounds)}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** What a search counts, offered as tabs on the results page rather than typed as `in:`. */
export const ENTITY_LABEL: Record<Entity, string> = {
  rounds: 'Rounds',
  tasks: 'Tasks',
  sessions: 'Sessions',
  projects: 'Projects',
  questions: 'Questions',
  trails: 'Trails',
}

interface Option {
  label: string
  says: string
  insert: string
  rounds?: number
}

/** The word the caret is in, which is the only part of a query a completion may replace. */
function wordAt(text: string): { text: string; from: number; to: number } {
  let from = text.length
  while (from > 0 && !/\s/.test(text[from - 1]!)) from -= 1
  return { text: text.slice(from), from, to: text.length }
}

/**
 * What to offer for what has been typed so far.
 *
 * Before a colon, the fields whose name or description matches. After one, that field's values —
 * from the index where it has them, and from the parser's own table where the field is an enum, so
 * `agent:` and `is:` complete even in a store with nothing collected in it yet.
 */
function suggest(facets: FacetPayload | null, key: string | null, typed: string): Option[] {
  if (facets === null) return []
  const wanted = typed.toLowerCase()

  if (key === null) {
    if (wanted === '') return []
    return facets.fields
      .filter((field) => field.key.startsWith(wanted) || field.says.toLowerCase().includes(wanted))
      .slice(0, 8)
      .map((field) => ({ label: `${field.key}:`, says: field.says, insert: `${field.key}:` }))
  }

  const field = facets.fields.find((one) => one.key === key)
  if (field === undefined) return []

  // An enum's values are the parser's, not the store's: they are the whole of what the field can
  // take, and offering only the ones a project happens to contain would hide the rest.
  const listed =
    field.values.length > 0
      ? field.values.map((value) => ({ value, rounds: undefined as number | undefined }))
      : facets.values.map((one) => ({ value: one.value, rounds: one.rounds as number | undefined }))

  return listed
    .filter((one) => one.value.toLowerCase().startsWith(wanted))
    .slice(0, 8)
    .map((one) => ({
      label: `${key}:${one.value}`,
      // Blank rather than the field's description: repeated down eleven rows it says nothing about
      // any of them, and the count on the right is the part worth reading.
      says: '',
      // A value with a space in it has to be quoted, or the query reads it as two atoms.
      insert: `${key}:${/\s/.test(one.value) ? `"${one.value}"` : one.value}`,
      ...(one.rounds === undefined ? {} : { rounds: one.rounds }),
    }))
}
