import { useState } from 'react'

import { api } from '../api'
import type { ToolRow } from '../api'
import { Actions } from '../components/Actions'
import { Chrome, Facts, Loading, Problem } from '../components/Chrome'
import { InTokens, Reused, TokenCells, TokenHeaders } from '../components/Tokens'
import { WorkBars } from '../components/WorkBars'
import { ago, count, duration, money, percent, shortId, shortModel, tokens, when } from '../format'
import { go, href, linkProps } from '../router'
import { useData } from '../useData'
import type { ReactElement } from 'react'

/**
 * One project: what its work was, and which sessions it was done in.
 *
 * The distribution comes first because it is the answer to the question the project is here to
 * ask. The session list is how you get from that answer to the work it describes.
 */
export function Project({ slug }: { slug: string }): ReactElement {
  // Bumped after a sync, which is what makes every table on this page re-read the store.
  const [read, setRead] = useState(0)
  const { data, error, loading } = useData(() => api.project(slug), [slug, read])
  const [tab, setTab] = useState<'work' | 'tools'>('work')

  return (
    <>
      <Chrome crumbs={[{ label: data?.project.project ?? slug }]} />
      <main className="page">
        {error !== null && data === null ? (
          <Problem message={error} />
        ) : data === null ? (
          <Loading what="the project" />
        ) : (
          <div className={loading ? 'rereading' : undefined}>
            <div className="head">
              <h1>{data.project.project}</h1>
              {data.project.imported_at === null ? null : (
                <span className="mark" title="Arrived as a file someone exported">
                  imported
                </span>
              )}
              {(data.project.sources ?? []).includes('cursor') ? (
                <span
                  className="mark"
                  title="Includes Cursor sessions. Cursor transcripts do not record token usage or cost."
                >
                  cursor
                </span>
              ) : null}
              <span className="muted mono clip">{data.project.path ?? data.project.key}</span>
              <span className="spacer" style={{ flex: 1 }} />
              {/*
                Two dates, named apart. The projects list has a "last activity" column, and this page
                used to answer it with when probez last *read* the sessions — a different number
                about a different thing, under a name close enough to read as the same one. So the
                work's own date leads, under the name the list gives it, and when probez went looking
                follows it as the separate fact it is. An import was never collected here, and saying
                so would misplace where it came from.
              */}
              <span className="muted nowrap">
                Last activity {ago(data.project.last_ts)} ·{' '}
                {data.project.imported_at === null
                  ? `collected ${ago(data.project.collected_at)}`
                  : `imported ${ago(data.project.imported_at)}`}
              </span>
              <Actions
                slug={slug}
                project={data.project.project}
                renamed={data.project.renamed}
                rounds={data.project.rounds}
                onSynced={() => setRead(read + 1)}
                onRenamed={() => setRead(read + 1)}
                // The page is about a project that no longer exists; the list is where to be next.
                onRemoved={() => go(href.projects())}
              />
            </div>
            <Facts
              items={[
                ['sessions', data.project.sessions],
                ['tasks', data.project.tasks],
                ['rounds', count(data.project.rounds)],
                ['tool calls', count(data.tool_calls)],
                ['in', <InTokens of={data.project} />],
                ['reused', <Reused of={data.project} />, "Share of this project's input tokens that were served from the prompt cache rather than processed fresh. Agents resend the whole conversation every round, so almost all of it is a repeat — and a cache read is billed at about a tenth of the input rate, which is why a huge 'read' figure can still be cheap."],
                ['out', tokens(data.project.out_tokens)],
                ['cost', money(data.cost), "What this cost at the rates under Settings, worked out per round from its own model's prices and summed. Rounds whose model has no rate are left out."],
              ]}
            />
            {(data.project.sources ?? []).includes('cursor') ? (
              <p className="note">
                Cursor transcripts do not record token usage or model names, so those rounds have no
                cost. Shares are of the Claude rounds that do.
              </p>
            ) : null}

            <section>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <h2 style={{ margin: 0 }}>
                  {tab === 'work' ? 'Where agent work goes' : 'What it called'}
                </h2>
                <span className="spacer" style={{ flex: 1 }} />
                <div className="toggle">
                  <button aria-pressed={tab === 'work'} onClick={() => setTab('work')}>
                    work
                  </button>
                  <button aria-pressed={tab === 'tools'} onClick={() => setTab('tools')}>
                    tools
                  </button>
                </div>
              </div>
              {tab === 'work' ? <WorkBars analysis={data.analysis} /> : <Tools slug={slug} read={read} />}
            </section>

            <section>
              <h2>Sessions</h2>
              <table>
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Started</th>
                    <th>Model</th>
                    <th className="r">Tasks</th>
                    <th className="r">Rounds</th>
                    <th className="r">Tools</th>
                    <th>Work</th>
                    <TokenHeaders />
                    <th className="r">Working</th>
                    <th className="r">Elapsed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sessions.map((session) => (
                    <tr
                      key={session.session}
                      className="row"
                      onClick={() => go(href.session(slug, session.session))}
                    >
                      <td className="mono">
                        <a {...linkProps(href.session(slug, session.session))}>
                          {shortId(session.session)}
                        </a>
                      </td>
                      <td className="muted">{when(session.first_ts)}</td>
                      <td className="dim">{shortModel(session.model)}</td>
                      <td className="r num">{session.tasks}</td>
                      <td className="r num">{session.rounds}</td>
                      <td className="r num">
                        {session.tool_calls}
                        {session.errors > 0 ? <span className="bad"> ✗{session.errors}</span> : null}
                      </td>
                      <td className="dim nowrap">
                        {session.work === null
                          ? '—'
                          : `${session.work.short} ${percent(session.work.share)}`}
                      </td>
                      <TokenCells of={session} />
                      <td className="r num dim">{duration(session.active_ms)}</td>
                      <td className="r num dim">{duration(session.elapsed_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        )}
      </main>
    </>
  )
}

/** What Bash actually ran, which is the one tool whose name is not its operation. */
function Tools({ slug, read }: { slug: string; read: number }): ReactElement {
  const { data, error } = useData(() => api.tools(slug), [slug, read])
  const [by, setBy] = useState<'command' | 'kind'>('command')

  if (error !== null && data === null) return <Problem message={error} />
  if (data === null) return <Loading what="the tools" />

  const rows = by === 'command' ? data.tools : data.kinds
  const calls = data.tools.reduce((n, row) => n + row.calls, 0)
  const errors = data.tools.reduce((n, row) => n + row.errors, 0)
  const quiet = data.tools.reduce((n, row) => n + row.quiet, 0)

  return (
    <>
      <div className="toggle" style={{ marginBottom: 10 }}>
        <button aria-pressed={by === 'command'} onClick={() => setBy('command')}>
          by command
        </button>
        <button aria-pressed={by === 'kind'} onClick={() => setBy('kind')}>
          by kind
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Tool</th>
            <th className="r">Calls</th>
            <th className="r">Errors</th>
            <th className="r" title="Calls that wrote to stderr or were cut short while the harness reported no error.">
              Quiet
            </th>
            <th className="r">Result</th>
            <th className="r">Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => [
            <Row key={row.name} row={row} indent={0} />,
            ...(row.sub ?? [])
              .slice(0, 12)
              .map((child) => <Row key={`${row.name}/${child.name}`} row={child} indent={1} />),
          ])}
        </tbody>
      </table>
      <p className="note" style={{ marginTop: 12 }}>
        {rows.length} tools · {count(calls)} calls · {errors} errors · {quiet} quiet. A command is
        counted once per call it appears in, so <span className="mono">cd repo &amp;&amp; npm test</span>{' '}
        counts for both and the sub-rows add up to more than the row above them. Errors, result size
        and time belong to the call, which has one result and one duration, so every command in a
        multi-command call is charged the whole of it. <em>Errors</em> is the harness flag, which
        says the call was accepted rather than that it worked; <em>quiet</em> is the calls that
        wrote to stderr or were cut short without it noticing.
      </p>
    </>
  )
}

function quietTitle(row: ToolRow): string | undefined {
  if (row.quiet === 0) return undefined
  return `${row.quiet} of ${row.calls} calls wrote to stderr or were cut short, with no error reported`
}

function Row({ row, indent }: { row: ToolRow; indent: number }): ReactElement {
  return (
    <tr>
      <td
        className={indent > 0 ? 'dim mono' : undefined}
        style={{ paddingLeft: 10 + indent * 20, fontSize: indent > 0 ? 12 : undefined }}
      >
        {row.name}
        {row.kind === undefined ? null : <span className="muted"> {row.kind}</span>}
      </td>
      <td className="r num">{count(row.calls)}</td>
      <td className={`r num ${row.errors > 0 ? 'bad' : 'muted'}`}>
        {row.errors > 0 ? row.errors : '·'}
      </td>
      <td className={`r num ${row.quiet > 0 ? 'bad' : 'muted'}`} title={quietTitle(row)}>
        {row.quiet > 0 ? row.quiet : '·'}
      </td>
      <td className="r num dim">{tokens(row.result_chars)}</td>
      <td className="r num dim">{duration(row.ms)}</td>
    </tr>
  )
}
