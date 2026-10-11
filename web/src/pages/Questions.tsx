import { useState } from 'react'
import type { ReactElement } from 'react'

import { api } from '../api'
import type { StoreQuestion } from '../api'
import { askTitle } from '../categories'
import { Chrome, Info, Loading, Problem } from '../components/Chrome'
import { OpenInExplorer } from '../components/OpenInExplorer'
import { naturalFor, ordered, SortHead, useSort } from '../components/SortHead'
import { clip, count, duration, money, shortId, tokens } from '../format'
import { go, href, linkProps } from '../router'
import { changeFilters, useFilter, useScope } from '../scope'
import { useData } from '../useData'
import { scopeLine } from './Overview'

type QuestionSort = 'about' | 'project' | 'kind' | 'calls' | 'again' | 'cost' | 'in' | 'time'

const questionNatural = naturalFor<QuestionSort>('about', 'project', 'kind')

function about(question: StoreQuestion): string {
  if (question.terms.length > 0) return question.terms.join(' ')
  return question.files[0] ?? ''
}

function questionValue(question: StoreQuestion, key: QuestionSort): number | string | null {
  switch (key) {
    case 'about':
      return about(question)
    case 'project':
      return question.project
    case 'kind':
      return question.kind
    case 'calls':
      return question.calls.length
    case 'again':
      return question.repeats
    case 'cost':
      return question.cost
    case 'in':
      return question.in_tokens
    case 'time':
      return question.ms
  }
}

/**
 * Investigate › Questions: what agents kept needing to know, across the store, costliest first.
 *
 * The project page's questions tab at store scope. A row opens the task it was asked in, with the
 * question selected — which is also where *explain* is, since a reading belongs to one project.
 */
export function Questions(): ReactElement {
  const scope = useScope()
  const reasked = useFilter('reasked')
  const { data, error, loading } = useData(() => api.storeQuestions(scope), [scope.range, scope.source, scope.project])
  const [sorted, sortBy] = useSort<QuestionSort>(questionNatural, { key: 'cost', dir: 'desc' })

  const shown = (data?.questions ?? []).filter((question) => reasked === null || question.repeats > 0)
  // A hundred at a time: the tail of a store's questions is thousands of one-call reads, and the
  // costly ones the page exists for are at the top of it.
  const [limit, setLimit] = useState(100)

  return (
    <>
      <Chrome crumbs={[{ label: 'Investigate' }, { label: 'Questions' }]} scope="store" search={{ slug: scope.project }} />
      <main className="page">
        {error !== null && data === null ? (
          <Problem message={error} />
        ) : data === null ? (
          <Loading what="the questions" />
        ) : (
          <div className={loading ? 'rereading' : undefined}>
            <div className="head">
              <h1>Questions</h1>
              <span className="muted">
                {count(data.total)} asked · {count(data.reasked)} asked again · {scopeLine(scope)}
              </span>
            </div>
            <div className="fbar">
              <button
                type="button"
                className={reasked === null ? 'chip' : 'chip filter'}
                aria-pressed={reasked !== null}
                onClick={() => changeFilters({ reasked: reasked === null ? '1' : null })}
              >
                Asked again ↺{reasked === null ? null : <span aria-hidden> ✕</span>}
              </button>
              <span className="spacer" />
              <OpenInExplorer scope={scope} entity="questions" filters={{ reasked }} />
            </div>
            {shown.length === 0 ? (
              <p className="note">
                {data.total === 0 ? 'Nothing in this scope went looking for anything.' : 'No question here was asked again.'}
              </p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <SortHead label="Question" head="about" sorted={sorted} onSort={sortBy} />
                    <SortHead label="Project" head="project" sorted={sorted} onSort={sortBy} />
                    <SortHead label="Kind" head="kind" sorted={sorted} onSort={sortBy} />
                    <SortHead label="Calls" head="calls" sorted={sorted} onSort={sortBy} className="r" />
                    <SortHead
                      label="Again"
                      head="again"
                      sorted={sorted}
                      onSort={sortBy}
                      className="r"
                      title="Calls that asked, word for word and place for place, something this question had already asked"
                    />
                    <SortHead label="Cost" head="cost" sorted={sorted} onSort={sortBy} className="r" title="Each call's share of its round's cost, summed" />
                    <SortHead label="In" head="in" sorted={sorted} onSort={sortBy} className="r" />
                    <SortHead label="Time" head="time" sorted={sorted} onSort={sortBy} className="r" />
                  </tr>
                </thead>
                <tbody>
                  {ordered(shown, sorted, questionValue).slice(0, limit).map((question) => {
                    const to = href.task(question.slug, question.session, question.task, undefined, null, question.at)
                    return (
                      <tr key={`${question.slug}/${question.session}/${question.task}/${question.at}`} className="row" onClick={() => go(to)}>
                        <td>
                          <a {...linkProps(to)} title={`${shortId(question.session)} · ${question.ref}`}>
                            {about(question) === '' ? <span className="muted">{question.ref}</span> : clip(about(question), 60)}
                          </a>
                        </td>
                        <td className="dim nowrap">{question.project}</td>
                        <td className="dim" title={askTitle(question.kind)}>
                          {question.kind}
                        </td>
                        <td className="r num">{question.calls.length}</td>
                        <td className={`r num ${question.repeats > 0 ? 'bad' : 'muted'}`}>
                          {question.repeats > 0 ? `↺ ${question.repeats}` : '·'}
                        </td>
                        <td className="r num">
                          <strong>{money(question.cost)}</strong>
                        </td>
                        <td className="r num dim">{tokens(question.in_tokens)}</td>
                        <td className="r num dim">{duration(question.ms)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            {shown.length > limit ? (
              <button type="button" className="ghost" style={{ marginTop: 12 }} onClick={() => setLimit((was) => was + 100)}>
                Show {Math.min(100, shown.length - limit)} more of {count(shown.length - limit)}
              </button>
            ) : null}
            <p className="note" style={{ marginTop: 12 }}>
              {data.total > data.questions.length
                ? `The ${count(data.questions.length)} costliest of ${count(data.total)} questions are listed; narrow the scope to see the rest. `
                : null}
              A question is a run of calls asking the same thing of the code: a word searched for, a place
              opened. <Info says="Cost is each call's share of its round, the same even split the work shares use. Explain, which asks your own LLM what a question was after, is on the task page a row opens." />
            </p>
          </div>
        )}
      </main>
    </>
  )
}
