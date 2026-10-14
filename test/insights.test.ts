import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'

import { DEFAULT_THRESHOLDS, findingsFile, readThresholds, thresholdsFrom, writeThresholds } from '../src/findings.js'
import {
  findingsPayload,
  insideOf,
  insightsPayload,
  questionsListPayload,
  scopeOf,
  sessionsPayload,
  severityOf,
  trailsListPayload,
} from '../src/insights.js'
import { costOf, defaultPricing } from '../src/pricing.js'
import { startServer } from '../src/serve.js'
import type { Serving } from '../src/serve.js'
import { SCHEMA_VERSION } from '../src/store.js'
import type { Round, ToolCall } from '../src/types.js'
import { BadRequest, forgetRounds, NotFound } from '../src/viewdata.js'

/**
 * The store-wide half of the view, over a store written by hand.
 *
 * Built directly rather than by `collect`, so the rounds are exactly the ones each assertion is
 * about: a session that only read, one that failed a call, one on a model nothing prices, and one
 * whose context nearly filled its window, in two projects and two agents.
 */

const NOW = Date.parse('2026-10-11T12:00:00.000Z')
const DAY = 86_400_000
const MODEL = 'claude-sonnet-4-5'

function tool(name: string, input: unknown, failed = false): ToolCall {
  return {
    name,
    id: `${name}-${Math.random().toString(36).slice(2)}`,
    input,
    input_chars: JSON.stringify(input).length,
    result_chars: 100,
    is_error: failed,
    error_kind: null,
    stderr_chars: null,
    interrupted: null,
    patch: null,
    emitted_at: null,
    result_at: null,
    ms: 10,
  } as ToolCall
}

function round(over: Partial<Round> & { session: string; round: number; ts: string }): Round {
  return {
    task: 1,
    commit: null,
    agent: 'main',
    source: 'claude-code',
    id: `${over.session}#${over.round}`,
    ms: 1000,
    gen_ms: 1000,
    wait_ms: 0,
    first_input: 'tool_result',
    model: MODEL,
    in_tokens: 10_000,
    in_uncached: 1_000,
    in_cache_write: 0,
    in_cache_write_5m: 0,
    in_cache_write_1h: 0,
    in_cache_read: 9_000,
    out_tokens: 500,
    compaction: null,
    mcp_server: null,
    mcp_tool: null,
    skill: null,
    user_text: '',
    text: '',
    thinking_chars: 0,
    tools: [],
    events: [],
    file: 'x.jsonl',
    size: 0,
    ...over,
  } as Round
}

const at = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString()

function project(dataDir: string, slug: string, name: string, path: string, rounds: Round[]): void {
  const dir = join(dataDir, 'projects', slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'rounds.jsonl'), rounds.map((one) => JSON.stringify(one)).join('\n') + '\n')
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      schema_version: SCHEMA_VERSION,
      project: name,
      path,
      key: path,
      collected_at: at(1),
      rounds: rounds.length,
      sources: [...new Set(rounds.map((one) => one.source))],
      last_ts: rounds.map((one) => one.ts).sort().at(-1),
    }),
  )
}

/** Two projects. `shop` reads a lot and fails once; `api` edits, runs one Cursor session, and fills its context. */
function makeStore(): { dataDir: string; rounds: Round[] } {
  const dataDir = mkdtempSync(join(tmpdir(), 'probez-insights-'))
  const shop = [
    // A session that did nothing but find its way around: reconstruction all of it.
    round({ session: 'aaaa0001', round: 0, ts: at(2), tools: [tool('Read', { file_path: '/w/shop/a.ts' })] }),
    round({ session: 'aaaa0001', round: 1, ts: at(2), tools: [tool('Grep', { pattern: 'cart' })] }),
    round({ session: 'aaaa0001', round: 2, ts: at(2), tools: [tool('Grep', { pattern: 'cart' })] }),
    // One that failed a call.
    round({ session: 'aaaa0002', round: 0, ts: at(3), tools: [tool('Bash', { command: 'npm test' }, true)] }),
    // One on a model nothing prices.
    round({ session: 'aaaa0003', round: 0, ts: at(4), model: 'mystery-model-9' }),
    // Long ago: outside the last 30 days, inside the 30 before them.
    round({ session: 'aaaa0004', round: 0, ts: at(45), tools: [tool('Read', { file_path: '/w/shop/b.ts' })] }),
  ]
  const api = [
    round({
      session: 'bbbb0001',
      round: 0,
      ts: at(1),
      tools: [tool('Edit', { file_path: '/w/api/x.ts', old_string: 'a', new_string: 'b' })],
    }),
    // Near the top of a 200K window.
    round({ session: 'bbbb0001', round: 1, ts: at(1), in_tokens: 190_000, in_uncached: 1_000, in_cache_read: 189_000 }),
    round({ session: 'bbbb0002', round: 0, ts: at(5), source: 'cursor', model: null, in_tokens: null, in_uncached: null, in_cache_read: null, out_tokens: null }),
    // A subagent of bbbb0001.
    round({ session: 'bbbb0001/subagents/agent-c1', round: 0, ts: at(1), agent: 'sub', tools: [tool('Read', { file_path: '/w/api/y.ts' })] }),
  ]
  project(dataDir, 'shop-1', 'shop', '/w/shop', shop)
  project(dataDir, 'api-1', 'api', '/w/api', api)
  forgetRounds()
  return { dataDir, rounds: [...shop, ...api] }
}

const scope = (query: string) => scopeOf(new URLSearchParams(query), NOW)
const pricing = defaultPricing()

test('the scope opens on the last 30 days of everything, and refuses a range it does not offer', () => {
  assert.deepEqual(scope(''), { range: '30d', source: null, project: null, committer: null, now: NOW })
  assert.equal(scope('committer=Dana').committer, 'Dana')
  assert.equal(scope('range=7d&source=cursor&project=api-1').source, 'cursor')
  assert.throws(() => scope('range=1y'), BadRequest)
  assert.throws(() => scope('source=emacs'), BadRequest)
})

test('Overview totals are the rounds in range, priced the way every other page prices them', async () => {
  const { dataDir, rounds } = makeStore()
  const data = await insightsPayload(dataDir, scope(''))
  const inRange = rounds.filter((one) => Date.parse(one.ts!) >= NOW - 30 * DAY)
  const cost = inRange.reduce((sum, one) => sum + (costOf(one, pricing) ?? 0), 0)
  assert.equal(data.totals.rounds, inRange.length)
  assert.ok(Math.abs(data.totals.cost - cost) < 1e-9)
  // The mystery model and the Cursor round that recorded no usage are outside the cost, and said to be.
  assert.equal(data.totals.unpriced, 2)
  assert.equal(data.scope.from, '2026-09-12')
  assert.equal(data.scope.to, '2026-10-11')
  // Every day is drawn, empty ones too, so the axis is time rather than activity.
  assert.equal(data.days.length, 30)
  assert.ok(Math.abs(data.days.reduce((sum, day) => sum + day.cost, 0) - cost) < 1e-9)
})

test('the previous period is the same length immediately before, and all time has none', async () => {
  const { dataDir } = makeStore()
  const thirty = await insightsPayload(dataDir, scope(''))
  assert.equal(thirty.previous?.rounds, 1)
  const all = await insightsPayload(dataDir, scope('range=all'))
  assert.equal(all.previous, null)
  assert.equal(all.totals.rounds, 10)
})

test('every split divides the same total, and the work split adds back up to it', async () => {
  const { dataDir } = makeStore()
  const data = await insightsPayload(dataDir, scope('range=all'))
  for (const by of ['project', 'model', 'source', 'category'] as const) {
    const sum = data.splits[by].reduce((total, row) => total + row.cost, 0)
    assert.ok(Math.abs(sum - data.totals.cost) < 1e-9, by)
  }
  assert.deepEqual(
    data.splits.source.map((row) => row.key),
    ['claude', 'cursor'],
  )
  // A round that called nothing is prose, not unclassified.
  assert.ok(data.splits.category.some((row) => row.key === 'prose'))
  assert.ok(data.splits.category.some((row) => row.key === 'reconstruction'))
  // Ranked by cost.
  const costs = data.splits.project.map((row) => row.cost)
  assert.deepEqual(costs, [...costs].sort((a, b) => b - a))
})

test('the agent and project filters narrow every figure', async () => {
  const { dataDir } = makeStore()
  const cursor = await insightsPayload(dataDir, scope('range=all&source=cursor'))
  assert.equal(cursor.totals.rounds, 1)
  assert.deepEqual(cursor.splits.project.map((row) => row.key), ['api-1'])
  const shop = await insightsPayload(dataDir, scope('range=all&project=shop-1'))
  assert.equal(shop.totals.rounds, 6)
  await assert.rejects(insightsPayload(dataDir, scope('project=nowhere')), NotFound)
})

test('a range with nothing in it still says when the last thing ran', async () => {
  const { dataDir } = makeStore()
  const data = await insightsPayload(dataDir, scopeOf(new URLSearchParams('range=7d'), NOW + 400 * DAY))
  assert.equal(data.totals.rounds, 0)
  assert.equal(data.latest, at(1))
})

test('the cache figures price fresh input twice: as it was billed, and as cache reads', async () => {
  const { dataDir } = makeStore()
  const data = await insightsPayload(dataDir, scope('range=all'))
  assert.ok(data.cache.fresh > 0 && data.cache.reused > data.cache.fresh)
  assert.ok(data.cache.fresh_cost > data.cache.fresh_at_read)
  assert.deepEqual(
    data.cache.by_project.map((row) => row.slug).sort(),
    ['api-1', 'shop-1'],
  )
})

test('a task whose round filled most of its window is over the context line', async () => {
  const { dataDir } = makeStore()
  const data = await insightsPayload(dataDir, scope('range=all'))
  assert.equal(data.context.threshold, DEFAULT_THRESHOLDS.context)
  assert.equal(data.context.over.length, 1)
  assert.equal(data.context.over[0]!.session, 'bbbb0001')
  assert.equal(data.context.over[0]!.round, 1)
  assert.ok(data.context.over[0]!.share > 0.8)
})

test('the sessions list spans projects, costliest first, with each cost split by work', async () => {
  const { dataDir } = makeStore()
  const data = await sessionsPayload(dataDir, scope('range=all'))
  assert.equal(data.sessions.length, 7)
  const costs = data.sessions.map((one) => one.cost)
  assert.deepEqual(costs, [...costs].sort((a, b) => b - a))
  for (const session of data.sessions) {
    const split = Object.values(session.cost_by_category).reduce((sum, cost) => sum + cost, 0)
    assert.ok(Math.abs(split - session.cost) < 1e-9, session.session)
  }
  const sub = data.sessions.find((one) => one.session === 'bbbb0001/subagents/agent-c1')
  assert.equal(sub?.parent, 'bbbb0001')
  assert.equal(sub?.slug, 'api-1')
  assert.deepEqual(data.projects.map((one) => one.slug).sort(), ['api-1', 'shop-1'])
})

test('findings count the signals in scope and price them, costliest first', async () => {
  const { dataDir } = makeStore()
  const data = await findingsPayload(dataDir, scope('range=all'))
  const byId = new Map(data.findings.map((one) => [one.id, one]))
  const recon = byId.get('reconstruction')
  assert.ok(recon !== undefined)
  // aaaa0001 read and searched and did nothing else; aaaa0004 and the subagent only read.
  assert.equal(recon.count, 3)
  assert.equal(recon.threshold, 0.4)
  assert.equal(byId.get('errors')?.count, 1)
  assert.match(byId.get('errors')!.detail, /Bash/)
  assert.equal(byId.get('context')?.count, 1)
  const unpriced = byId.get('unpriced')
  assert.equal(unpriced?.severity, 'info')
  assert.equal(unpriced?.cost, null)
  assert.match(unpriced!.detail, /mystery-model-9/)
  // The hole in the pricing is last, whatever it touched; the rest are ranked by what they cost.
  assert.equal(data.findings.at(-1)?.id, 'unpriced')
  const priced = data.findings.filter((one) => one.cost !== null).map((one) => one.cost!)
  assert.deepEqual(priced, [...priced].sort((a, b) => b - a))
  assert.equal(data.synced_at, at(1))
})

test('a threshold moved in Settings moves the finding drawn at it', async () => {
  const { dataDir } = makeStore()
  await writeThresholds(dataDir, { reconstruction: 0.99, context: 0.99 })
  const data = await findingsPayload(dataDir, scope('range=all'))
  assert.equal(data.findings.find((one) => one.id === 'context'), undefined)
  assert.equal(data.thresholds.reconstruction, 0.99)
})

test('thresholds are shares strictly between nothing and everything, and default when unsaved', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'probez-thresholds-'))
  assert.deepEqual(await readThresholds(dataDir), DEFAULT_THRESHOLDS)
  assert.equal(typeof thresholdsFrom({ reconstruction: 1.4, context: 0.8 }), 'string')
  assert.equal(typeof thresholdsFrom({ reconstruction: 0, context: 0.8 }), 'string')
  assert.equal(typeof thresholdsFrom({ reconstruction: '0.4', context: 0.8 }), 'string')
  assert.equal(typeof thresholdsFrom([]), 'string')
  assert.deepEqual(thresholdsFrom({ reconstruction: 0.3, context: 0.9 }), { reconstruction: 0.3, context: 0.9 })
  await writeThresholds(dataDir, { reconstruction: 0.3, context: 0.9 })
  assert.deepEqual(await readThresholds(dataDir), { reconstruction: 0.3, context: 0.9 })
  // One bad value falls back on its own.
  writeFileSync(findingsFile(dataDir), JSON.stringify({ reconstruction: 7, context: 0.7 }))
  assert.deepEqual(await readThresholds(dataDir), { reconstruction: 0.4, context: 0.7 })
  assert.match(readFileSync(findingsFile(dataDir), 'utf8'), /0\.7/)
})

test('the thresholds file is owner-only', { skip: process.platform === 'win32' }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'probez-thresholds-'))
  await writeThresholds(dataDir, DEFAULT_THRESHOLDS)
  assert.equal(statSync(findingsFile(dataDir)).mode & 0o777, 0o600)
})

test('severity is a share of the spend in scope', () => {
  assert.equal(severityOf(6, 100), 'high')
  assert.equal(severityOf(2, 100), 'med')
  assert.equal(severityOf(0.5, 100), 'low')
  assert.equal(severityOf(5, 0), 'low')
})

test('store-wide questions and trails carry their project and a cost', async () => {
  const { dataDir } = makeStore()
  const questions = await questionsListPayload(dataDir, scope('range=all'))
  assert.ok(questions.total > 0)
  assert.ok(questions.questions.every((one) => one.slug !== '' && one.cost >= 0))
  const repeated = questions.questions.find((one) => one.repeats > 0)
  assert.ok(repeated !== undefined, 'grepping cart twice is a question asked again')
  assert.equal(questions.reasked, 1)
  const trails = await trailsListPayload(dataDir, scope('range=all'))
  assert.equal(trails.total, trails.trails.length)
})

test('a path in a store-wide list is written relative to its project', () => {
  assert.equal(insideOf('/w/shop', '/w/shop/src/a.ts'), 'src/a.ts')
  assert.equal(insideOf('C:\\Users\\me\\repo', 'c:\\users\\me\\repo\\src\\a.ts'), 'src/a.ts')
  assert.equal(insideOf('/w/shop', '/w/shopping/a.ts'), '/w/shopping/a.ts')
  assert.equal(insideOf(null, 'src/a.ts'), 'src/a.ts')
  assert.equal(insideOf('/w/shop', ''), '')
})

/** Every file in a tree, by size and modification time: what "left it alone" means. */
function snapshot(dir: string): Record<string, string> {
  const seen: Record<string, string> = {}
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) walk(path)
      else {
        const info = statSync(path)
        seen[relative(dir, path)] = `${info.size}:${info.mtimeMs}`
      }
    }
  }
  walk(dir)
  return seen
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The payloads are checked field by field, which is the assertion; typing them here is not. */
const json = (response: Response): Promise<any> => response.json()
/* eslint-enable @typescript-eslint/no-explicit-any */

async function serving(dataDir: string, debug = false): Promise<Serving> {
  forgetRounds()
  return startServer({
    debug,
    dataDir,
    claudeDir: '',
    cursorDir: '',
    codexDir: '',
    copilotDir: '',
    piDir: '',
    opencodeDir: '',
    gooseDir: '',
    clineDirs: [],
    port: 0,
    pinned: true,
  })
}

test('the store-wide routes answer with the token, refuse without it, and only read', async () => {
  const { dataDir } = makeStore()
  const before = snapshot(dataDir)
  const server = await serving(dataDir, true)
  const url = (path: string, token = true): string =>
    `http://127.0.0.1:${server.port}${path}${token ? `${path.includes('?') ? '&' : '?'}t=${server.token}` : ''}`
  try {
    for (const route of ['insights', 'sessions', 'questions', 'trails', 'findings']) {
      const ok = await fetch(url(`/api/${route}?range=all`))
      assert.equal(ok.status, 200, route)
      assert.equal((await json(ok)).scope.range, 'all', route)
      assert.equal((await fetch(url(`/api/${route}`, false))).status, 403, `${route} without the token`)
      assert.equal((await fetch(url(`/api/${route}`), { method: 'POST' })).status, 405, `POST ${route}`)
    }
    const bad = await fetch(url('/api/insights?range=forever'))
    assert.equal(bad.status, 400)
    assert.match((await json(bad)).error, /range must be one of/)
    assert.equal((await fetch(url('/api/sessions?project=nowhere'))).status, 404)
  } finally {
    await server.close()
  }
  assert.deepEqual(snapshot(dataDir), before)
})

test('thresholds are read with GET, saved with POST, and refused when they are not shares', async () => {
  const { dataDir } = makeStore()
  const server = await serving(dataDir)
  const url = `http://127.0.0.1:${server.port}/api/thresholds?t=${server.token}`
  const send = (body: unknown): Promise<Response> =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const read = await json(await fetch(url))
    assert.deepEqual(read.thresholds, DEFAULT_THRESHOLDS)
    assert.deepEqual(read.defaults, DEFAULT_THRESHOLDS)
    const saved = await send({ reconstruction: 0.25, context: 0.9 })
    assert.equal(saved.status, 200)
    assert.deepEqual((await json(saved)).thresholds, { reconstruction: 0.25, context: 0.9 })
    const refused = await send({ reconstruction: 25, context: 0.9 })
    assert.equal(refused.status, 400)
    assert.deepEqual(await readThresholds(dataDir), { reconstruction: 0.25, context: 0.9 })
    const without = await fetch(`http://127.0.0.1:${server.port}/api/thresholds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(DEFAULT_THRESHOLDS),
    })
    assert.equal(without.status, 403)
    assert.deepEqual(await readThresholds(dataDir), { reconstruction: 0.25, context: 0.9 })
  } finally {
    await server.close()
  }
})

test('trails and questions answer only under --debug, and the findings drawn from them with them', async () => {
  const { dataDir } = makeStore()
  const plain = await serving(dataDir)
  const url = (server: Serving, path: string): string =>
    `http://127.0.0.1:${server.port}${path}${path.includes('?') ? '&' : '?'}t=${server.token}`
  try {
    assert.equal((await json(await fetch(url(plain, '/api/meta')))).debug, false)
    for (const path of [
      '/api/questions?range=all',
      '/api/trails?range=all',
      '/api/projects/shop-1/trails',
      '/api/projects/shop-1/questions',
      '/api/search?q=tool:Grep&in=trails',
    ]) {
      const refused = await fetch(url(plain, path))
      assert.equal(refused.status, 404, path)
      assert.match((await json(refused)).error, /--debug/, path)
    }
    // Searching rounds is not a trail and is not refused.
    assert.equal((await fetch(url(plain, '/api/search?q=tool:Grep'))).status, 200)
    const findings = await json(await fetch(url(plain, '/api/findings?range=all')))
    assert.ok(!findings.findings.some((one: { id: string }) => one.id === 'reasked' || one.id === 'abandoned'))
  } finally {
    await plain.close()
  }
  const debug = await serving(dataDir, true)
  try {
    assert.equal((await json(await fetch(url(debug, '/api/meta')))).debug, true)
    assert.equal((await fetch(url(debug, '/api/projects/shop-1/trails'))).status, 200)
    const findings = await json(await fetch(url(debug, '/api/findings?range=all')))
    assert.ok(findings.findings.some((one: { id: string }) => one.id === 'reasked'))
  } finally {
    await debug.close()
    // The flag is the process's, so put it back for the tests after this one.
    await (await serving(dataDir)).close()
  }
})

test("the committer scope keeps one person's rounds, counting this machine's own as its name", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'probez-insights-'))
  writeFileSync(join(dataDir, 'identity.json'), JSON.stringify({ name: 'Itay' }))
  project(dataDir, 'mixed-1', 'mixed', '/w/mixed', [
    round({ session: 'cccc0001', round: 0, ts: at(1) }),
    round({ session: 'cccc0001', round: 1, ts: at(1) }),
    round({ session: 'dddd0001', round: 0, ts: at(2), committer: 'Dana' }),
  ])
  forgetRounds()
  const everyone = await insightsPayload(dataDir, scope('range=all'))
  const mine = await insightsPayload(dataDir, scope('range=all&committer=Itay'))
  const hers = await insightsPayload(dataDir, scope('range=all&committer=Dana'))
  assert.equal(everyone.totals.rounds, 3)
  assert.equal(mine.totals.rounds, 2)
  assert.equal(hers.totals.rounds, 1)
  assert.equal(hers.scope.committer, 'Dana')
  const sessions = await sessionsPayload(dataDir, scope('range=all&committer=Dana'))
  assert.deepEqual(sessions.sessions.map((one) => one.session), ['dddd0001'])
})
