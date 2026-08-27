import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { startServer } from '../src/serve.js'
import type { Serving } from '../src/serve.js'
import { forgetRounds } from '../src/viewdata.js'

/**
 * The local server, exercised the way the browser meets it.
 *
 * Two things here are not ordinary endpoint tests and are the reason this file exists. The refusals
 * are checked as behaviour, because a token that is only *usually* required is not a token. And the
 * store is compared before and after, because `view` reading a project must leave nothing behind:
 * `analyze` caches its work as a side effect of reading, and this deliberately does not.
 */

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'src', 'cli.js')
const FIXTURE = join(here, '..', '..', 'test', 'fixtures', 'session.jsonl')
const SUBAGENT_FIXTURE = join(here, '..', '..', 'test', 'fixtures', 'claude-subagent.jsonl')
const VIEW = join(here, '..', 'view')

/** A collected store of one project, built by running the real `collect`. */
function makeStore(delegated = false): {
  dataDir: string
  claudeDir: string
  sourceDir: string
  slug: string
  session: string
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'probez-view-test-')))
  const claudeDir = join(root, 'claude')
  const dataDir = join(root, 'data')
  const project = join(root, 'work')
  const sourceDir = join(claudeDir, 'encoded-project-name')
  mkdirSync(project, { recursive: true })
  mkdirSync(sourceDir, { recursive: true })

  const session = '11111111-0000-0000-0000-000000000000'
  writeFileSync(
    join(sourceDir, `${session}.jsonl`),
    readFileSync(FIXTURE, 'utf8').replaceAll('/tmp/demo', project),
  )
  if (delegated) {
    const under = join(sourceDir, session, 'subagents')
    mkdirSync(under, { recursive: true })
    writeFileSync(
      join(under, 'agent-a1234567.jsonl'),
      readFileSync(SUBAGENT_FIXTURE, 'utf8').replaceAll('/tmp/demo', project),
    )
  }
  const cursorDir = join(root, 'cursor')
  mkdirSync(cursorDir, { recursive: true })
  execFileSync(
    process.execPath,
    [
      CLI,
      'collect',
      project,
      '--data-dir',
      dataDir,
      '--claude-dir',
      claudeDir,
      '--cursor-dir',
      cursorDir,
      '--codex-dir',
      join(root, 'codex'),
    ],
    { encoding: 'utf8' },
  )

  const slug = readdirSync(join(dataDir, 'projects'))[0]!
  return { dataDir, claudeDir, sourceDir, slug, session }
}

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

async function serving(dataDir: string, claudeDir = ''): Promise<Serving> {
  forgetRounds()
  return startServer({ dataDir, claudeDir, cursorDir: '', codexDir: '', port: 0, pinned: true })
}

const get = (server: Serving, path: string, init?: RequestInit): Promise<Response> =>
  fetch(`http://127.0.0.1:${server.port}${path}`, init)

const withToken = (server: Serving, path: string): Promise<Response> =>
  get(server, `${path}${path.includes('?') ? '&' : '?'}t=${server.token}`)

/**
 * A request with headers exactly as given.
 *
 * `fetch` refuses to let a caller set `Host`, which is the whole point of the rebinding test: the
 * check has to be exercised by a client that can lie about where it thought it was going.
 */
function rawGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      res.resume()
      res.on('end', () => ok(res.statusCode ?? 0))
    })
    req.on('error', fail)
    req.end()
  })
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The payloads are checked field by field below, which is the assertion; typing them here is not. */
async function body(response: Promise<Response>): Promise<any> {
  return (await response).json()
}

test('every level answers, and its numbers are the ones the store holds', async () => {
  const { dataDir, slug, session } = makeStore()
  const server = await serving(dataDir)
  try {
    const projects = await body(withToken(server, '/api/projects'))
    assert.equal(projects.projects.length, 1)
    assert.equal(projects.projects[0].slug, slug)
    assert.equal(projects.projects[0].rounds, 5)

    const project = await body(withToken(server, `/api/projects/${slug}`))
    assert.equal(project.sessions.length, 1)
    assert.equal(project.sessions[0].session, session)
    assert.equal(project.analysis.coverage.rounds, 5)

    const one = await body(withToken(server, `/api/projects/${slug}/sessions/${session}`))
    assert.equal(one.trace.rounds.length, 5)
    assert.ok(one.tasks.length >= 1)

    const task = await body(
      withToken(server, `/api/projects/${slug}/sessions/${session}/tasks/1`),
    )
    assert.equal(task.task.task, 1)
    assert.equal(task.trace.rounds.length, task.task.rounds)

    const round = await body(
      withToken(server, `/api/projects/${slug}/sessions/${session}/rounds/0`),
    )
    assert.equal(round.round.round, 0)
    // The full record, not a summary of it: the inspector shows what each tool was given.
    assert.ok(Array.isArray(round.round.tools))
    // The compaction a round followed travels with it, and the share of the window it filled is
    // computed here rather than in the browser, so the model table has one home.
    assert.ok('compaction' in round.round, 'the payload drops the compaction field')
    assert.ok('context_share' in round, 'the payload does not say how full the window was')
    // And every label names the call that produced it, which is what lets the inspector mark the
    // calls themselves rather than only the round they add up to.
    assert.ok(round.labels.length > 0)
    for (const label of round.labels) {
      assert.ok(Number.isInteger(label.call), 'a label with no call behind it')
      assert.ok(round.round.tools[label.call] !== undefined, `no call ${label.call} in this round`)
    }

    const tools = await body(withToken(server, `/api/projects/${slug}/tools`))
    assert.ok(tools.tools.length > 0)

    // Questions travel with the task, unlike trails, because they need no second pass over the
    // logs — and a task page that had to fetch them separately would render its own section empty.
    assert.ok(Array.isArray(task.questions), 'the task payload carries no questions')
    const questions = await body(withToken(server, `/api/projects/${slug}/questions`))
    assert.ok(Array.isArray(questions.questions))
    assert.equal(
      questions.calls,
      questions.questions.reduce((sum: number, one: { calls: unknown[] }) => sum + one.calls.length, 0),
      'the denominator is not the calls the questions are made of',
    )
    // A round can start two questions, so the name a person reads cannot address one. `at` can,
    // and the view's links are built from it.
    const seen = new Set(questions.questions.map((one: { session: string; at: number }) => `${one.session}\0${one.at}`))
    assert.equal(seen.size, questions.questions.length, 'two questions share an address')
  } finally {
    await server.close()
  }
})

test('the paths it hands the browser are the short ones', async () => {
  const { dataDir, slug } = makeStore()
  const server = await serving(dataDir)
  try {
    // `shorten` writes a path under home as `~/…` and one under the temp directory as `$TMPDIR/…`,
    // so on any machine what the view prints stops being absolute. A screenshot of it should not
    // carry whoever's home directory it ran in.
    const projects = await body(withToken(server, '/api/projects'))
    assert.ok(!projects.data_dir.startsWith('/'), projects.data_dir)
    assert.ok(!projects.projects[0].path.startsWith('/'), projects.projects[0].path)

    const project = await body(withToken(server, `/api/projects/${slug}`))
    assert.ok(!project.project.path.startsWith('/'), project.project.path)

    const pricing = await body(withToken(server, '/api/pricing'))
    assert.ok(!pricing.file.startsWith('/'), pricing.file)
  } finally {
    await server.close()
  }
})

test('the data does not answer without the token it printed', async () => {
  const { dataDir, slug } = makeStore()
  const server = await serving(dataDir)
  try {
    assert.equal((await get(server, '/api/projects')).status, 403)
    assert.equal((await get(server, '/api/projects?t=not-the-token')).status, 403)
    assert.equal((await get(server, `/api/projects/${slug}?t=`)).status, 403)
    // The header is the same key by another route, for a client that would rather not put it in a URL.
    const byHeader = await get(server, '/api/projects', {
      headers: { 'x-probez-token': server.token },
    })
    assert.equal(byHeader.status, 200)
  } finally {
    await server.close()
  }
})

test('a request that arrived by another name is refused', async () => {
  const { dataDir } = makeStore()
  const server = await serving(dataDir)
  try {
    // The shape of DNS rebinding: a page whose own domain resolves to 127.0.0.1, talking to this
    // from inside the browser. The token would travel with it if the page could guess it; the Host
    // header is what it cannot forge.
    const rebound = await rawGet(server.port, `/api/projects?t=${server.token}`, {
      host: 'probez.example.com',
    })
    assert.equal(rebound, 403)
    assert.equal(await rawGet(server.port, '/', { host: 'probez.example.com' }), 403)
    // The two names the browser can legitimately have reached us by both work.
    assert.equal(await rawGet(server.port, '/api/projects', { host: `localhost:${server.port}`, 'x-probez-token': server.token }), 200)
  } finally {
    await server.close()
  }
})

test('the routes that write are the only ones that are not GETs, and none of them can be one', async () => {
  const { dataDir, slug } = makeStore()
  const server = await serving(dataDir)
  try {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await get(server, `/api/projects?t=${server.token}`, { method })
      assert.equal(response.status, 405, `${method} should not be served`)
      assert.equal(response.headers.get('allow'), 'GET')
    }

    // Collecting, renaming or deleting on GET would mean a URL that does it when merely visited,
    // which is a URL that can be put in an <img> tag on any page you happen to open. Deleting is
    // the one where that would cost something nobody can put back.
    for (const verb of ['sync', 'rename', 'delete', 'explain']) {
      const asGet = await get(server, `/api/projects/${slug}/${verb}?t=${server.token}`)
      assert.equal(asGet.status, 405, `GET ${verb}`)
      assert.equal(asGet.headers.get('allow'), 'POST', `GET ${verb}`)

      for (const method of ['PUT', 'DELETE', 'PATCH']) {
        const response = await get(server, `/api/projects/${slug}/${verb}?t=${server.token}`, {
          method,
        })
        assert.equal(response.status, 405, `${method} should not ${verb}`)
        assert.equal(response.headers.get('allow'), 'GET, POST')
      }
    }
  } finally {
    await server.close()
  }
  // Nothing above was accepted, so the project it was all aimed at is still there.
  assert.ok(existsSync(join(dataDir, 'projects', slug, 'rounds.jsonl')))
})

test('renaming and deleting need the token, and without it write nothing', async () => {
  const { dataDir, slug } = makeStore()
  const before = snapshot(dataDir)
  const server = await serving(dataDir)
  try {
    const renamed = await get(server, `/api/projects/${slug}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'not mine to name' }),
    })
    assert.equal(renamed.status, 403)
    const removed = await get(server, `/api/projects/${slug}/delete`, { method: 'POST' })
    assert.equal(removed.status, 403)
  } finally {
    await server.close()
  }
  assert.deepEqual(snapshot(dataDir), before, 'a refused rename or delete must not have written')
})

test('a rename is a label: the project answers to it, and nothing moved', async () => {
  const { dataDir, claudeDir, slug } = makeStore()
  const server = await serving(dataDir, claudeDir)
  const rename = (name: string): Promise<Response> =>
    get(server, `/api/projects/${slug}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-probez-token': server.token },
      body: JSON.stringify({ name }),
    })

  try {
    const result = await body(rename('  Someone   elses  '))
    assert.equal(result.project.project, 'Someone elses')
    assert.equal(result.project.renamed, true)
    // The store directory is a hash of the path an agent ran in. A name that moved it would be a
    // name that could be typed on top of another project.
    assert.equal(result.project.slug, slug)
    assert.ok(existsSync(join(dataDir, 'projects', slug, 'rounds.jsonl')))

    const listed = await body(withToken(server, '/api/projects'))
    assert.equal(listed.projects[0].project, 'Someone elses')

    // `collect` derives the name from the directory every time it runs. A rename that a sync undid
    // would last until the next time anyone pressed the button beside it.
    await get(server, `/api/projects/${slug}/sync`, {
      method: 'POST',
      headers: { 'x-probez-token': server.token },
    })
    const after = await body(withToken(server, `/api/projects/${slug}`))
    assert.equal(after.project.project, 'Someone elses')

    // Clearing the field is a revert rather than a project with no name.
    const reverted = await body(rename('   '))
    assert.equal(reverted.project.renamed, false)
    assert.notEqual(reverted.project.project, '')
    assert.equal(reverted.project.project, JSON.parse(
      readFileSync(join(dataDir, 'projects', slug, 'manifest.json'), 'utf8'),
    ).project)

    assert.equal((await withToken(server, '/api/projects/nothing-here/rename')).status, 405)
  } finally {
    await server.close()
  }
})

test('deleting takes the project and everything under it, and nothing else', async () => {
  const { dataDir, slug } = makeStore()
  const server = await serving(dataDir)
  try {
    const result = await body(
      get(server, `/api/projects/${slug}/delete`, {
        method: 'POST',
        headers: { 'x-probez-token': server.token },
      }),
    )
    // It reports what went, because "deleted" and "deleted 5 rounds" are different sentences and
    // only the second one lets you notice you deleted the wrong project.
    assert.equal(result.rounds, 5)
    assert.equal(result.sessions, 1)

    // The whole directory: rounds, the session copies beside them, the manifest.
    assert.equal(existsSync(join(dataDir, 'projects', slug)), false)
    // And the store around it is still a store.
    assert.equal(existsSync(join(dataDir, 'projects')), true)

    assert.equal((await withToken(server, `/api/projects/${slug}`)).status, 404)
    const listed = await body(withToken(server, '/api/projects'))
    assert.equal(listed.projects.length, 0)

    // Deleting what is already gone is a 404, not a second delete.
    const again = await get(server, `/api/projects/${slug}/delete`, {
      method: 'POST',
      headers: { 'x-probez-token': server.token },
    })
    assert.equal(again.status, 404)
  } finally {
    await server.close()
  }
})

test('a delete cannot be aimed out of the store', async () => {
  const { dataDir, slug } = makeStore()
  const server = await serving(dataDir)
  try {
    // A slug names a directory and arrives from a URL, so a name that climbs is refused before it
    // is resolved rather than after. Which refusal it gets depends on where it stops being a path
    // this server has — `.` and `..` are normalised away by the URL parser and land on no route at
    // all — so what is asserted is that none of them is served, and that the store is untouched.
    for (const name of ['..%2f..', '.', '..', '%2e%2e', 'projects', '.probez']) {
      const response = await get(server, `/api/projects/${name}/delete`, {
        method: 'POST',
        headers: { 'x-probez-token': server.token },
      })
      assert.notEqual(response.status, 200, name)
    }
    assert.ok(existsSync(join(dataDir, 'projects', slug, 'rounds.jsonl')))
    assert.ok(existsSync(dataDir))
  } finally {
    await server.close()
  }
})

test('a result body is served from the archived session, and only when asked for', async () => {
  const { dataDir, slug, session } = makeStore()
  const server = await serving(dataDir)
  try {
    // The round carries the size and not the text. That is the whole reason the route below
    // exists, so it is asserted rather than assumed.
    const round = await body(
      withToken(server, `/api/projects/${slug}/sessions/${session}/rounds/0`),
    )
    const call = round.round.tools.find((tool: any) => tool.id === 'tu_1')
    assert.equal(call.result_chars, 30)
    assert.equal('result' in call, false, 'the round payload carries a result body')

    const result = await body(
      withToken(server, `/api/projects/${slug}/sessions/${session}/results/tu_1`),
    )
    assert.equal(result.body, 'x'.repeat(30))
    assert.equal(result.chars, 30)
    assert.equal(result.truncated, false)
    assert.equal(result.tool, 'Read')
    assert.equal(result.session, session)
    // Shortened like every other path the view hands over, so a screenshot of it carries no home
    // directory.
    assert.ok(!result.file.startsWith('/Users'), result.file)

    // The harness's own flag travels with the body, since a failed call is the one you open.
    const failed = await body(
      withToken(server, `/api/projects/${slug}/sessions/${session}/results/tu_2`),
    )
    assert.equal(failed.body, 'boom')
    assert.equal(failed.is_error, true)

    // A prefix addresses a session here as it does everywhere else.
    const byPrefix = await body(
      withToken(server, `/api/projects/${slug}/sessions/${session.slice(0, 8)}/results/tu_3`),
    )
    assert.equal(byPrefix.body, 'ok')
  } finally {
    await server.close()
  }
})

test('a subagent session answers, and its archived copy is found by the name it was stored under', async () => {
  const store = makeStore(true)
  const server = await serving(store.dataDir)
  const session = `${store.session}/subagents/agent-a1234567`
  const encoded = encodeURIComponent(session)
  try {
    // The id is a path, so it travels as one segment and the server puts it back together. Sent
    // unencoded it would be read as three route segments and answer for something else.
    const one = await body(withToken(server, `/api/projects/${store.slug}/sessions/${encoded}`))
    assert.equal(one.session.session, session)
    assert.equal(one.session.agent, 'sub')
    assert.equal(one.session.rounds, 2)

    const task = await body(
      withToken(server, `/api/projects/${store.slug}/sessions/${encoded}/tasks/1`),
    )
    assert.equal(task.session, session)
    assert.equal(task.trace.rounds.length, 2)

    // The archived copy is stored under a flattened name. Looked up by the id itself this would
    // be a path into a directory the store never wrote, and the body would read as absent.
    const result = await body(
      withToken(server, `/api/projects/${store.slug}/sessions/${encoded}/results/call_s1`),
    )
    assert.equal(result.body, 'export const CATEGORIES = []')
  } finally {
    await server.close()
  }
})

test('a result is only readable through a call the store recorded', async () => {
  const { dataDir, slug, session } = makeStore()
  const server = await serving(dataDir)
  try {
    // The id is resolved against the rounds before the file is opened, which is what stops this
    // being a way to look for an arbitrary string in a session log.
    assert.equal(
      (await withToken(server, `/api/projects/${slug}/sessions/${session}/results/tu_99`)).status,
      404,
    )
    assert.equal(
      (await withToken(server, `/api/projects/${slug}/sessions/no-such-session/results/tu_1`))
        .status,
      404,
    )
    // And the session is a name matched against the store, never a path: a traversal reaches no
    // round, so it never reaches a file either.
    assert.equal(
      (await withToken(server, `/api/projects/${slug}/sessions/..%2f..%2fetc/results/tu_1`)).status,
      404,
    )
    // Naming no call at all is a bad request rather than a missing one, which is how the numbered
    // children of a session answer the same shape.
    assert.equal(
      (await withToken(server, `/api/projects/${slug}/sessions/${session}/results/`)).status,
      400,
    )
    // A body is data, so it needs the token like the rest of the store does.
    assert.equal(
      (await get(server, `/api/projects/${slug}/sessions/${session}/results/tu_1`)).status,
      403,
    )
  } finally {
    await server.close()
  }
})

test('a name that is not in the store is a 404, and one that climbs out is refused', async () => {
  const { dataDir, slug } = makeStore()
  const server = await serving(dataDir)
  try {
    assert.equal((await withToken(server, '/api/projects/nothing-here')).status, 404)
    assert.equal(
      (await withToken(server, `/api/projects/${slug}/sessions/no-such-session`)).status,
      404,
    )
    assert.equal(
      (await withToken(server, `/api/projects/${slug}/sessions/${'1'.repeat(8)}/tasks/99`)).status,
      404,
    )
    // A slug is a directory name that arrived from a URL, so it is checked rather than trusted.
    assert.equal((await withToken(server, '/api/projects/..%2f..%2fetc')).status, 404)
    assert.equal((await get(server, '/..%2f..%2fetc%2fpasswd')).status, 404)
  } finally {
    await server.close()
  }
})

test('the write path needs the token too', async () => {
  const { dataDir, claudeDir, slug } = makeStore()
  const before = snapshot(dataDir)
  const server = await serving(dataDir, claudeDir)
  try {
    // Reading your prompts is one thing to keep behind the token; running a collection is another.
    const refused = await get(server, `/api/projects/${slug}/sync`, { method: 'POST' })
    assert.equal(refused.status, 403)
  } finally {
    await server.close()
  }
  assert.deepEqual(snapshot(dataDir), before, 'a refused sync must not have written')
})

test('sync collects what is new and rebuilds the analysis', async () => {
  const { dataDir, claudeDir, sourceDir, slug } = makeStore()
  const server = await serving(dataDir, claudeDir)
  try {
    // Nothing has changed since collect ran, so this is the idempotent case.
    const first = await body(
      get(server, `/api/projects/${slug}/sync`, {
        method: 'POST',
        headers: { 'x-probez-token': server.token },
      }),
    )
    assert.equal(first.source_found, true)
    assert.equal(first.new_rounds, 0)
    assert.equal(first.rounds, 5)
    // `analyze` writes this cache on its way through; sync is the view's way to the same file.
    assert.ok(existsSync(join(dataDir, 'projects', slug, 'analysis.jsonl')))

    // A second session appears the way one really does: a new file in the agent's directory.
    writeFileSync(
      join(sourceDir, '22222222-0000-0000-0000-000000000000.jsonl'),
      readFileSync(join(sourceDir, '11111111-0000-0000-0000-000000000000.jsonl'), 'utf8')
        .replaceAll('11111111-0000-0000-0000-000000000000', '22222222-0000-0000-0000-000000000000')
        .replaceAll('msg_', 'msg2_'),
    )
    const second = await body(
      get(server, `/api/projects/${slug}/sync`, {
        method: 'POST',
        headers: { 'x-probez-token': server.token },
      }),
    )
    assert.equal(second.new_rounds, 5)
    assert.equal(second.rounds, 10)
    assert.equal(second.sessions, 2)

    // And the pages behind it see the new rounds, not the ones cached before the sync.
    const project = await body(withToken(server, `/api/projects/${slug}`))
    assert.equal(project.sessions.length, 2)
    assert.equal(project.analysis.coverage.rounds, 10)
  } finally {
    await server.close()
  }
})

test('sync says so when the sessions it would collect from are gone', async () => {
  const { dataDir, slug } = makeStore()
  // A claude directory with nothing in it: the store is still readable, there is just no source.
  const server = await serving(dataDir, join(dataDir, 'not-a-claude-dir'))
  try {
    const result = await body(
      get(server, `/api/projects/${slug}/sync`, {
        method: 'POST',
        headers: { 'x-probez-token': server.token },
      }),
    )
    assert.equal(result.source_found, false)
    assert.equal(result.new_rounds, 0)
    // What was collected is still there, and analysing it is still worth doing.
    assert.equal(result.rounds, 5)
  } finally {
    await server.close()
  }
})

test('export hands over the store\'s own bytes, and a bundle to look at', async () => {
  const { dataDir, slug } = makeStore()
  const server = await serving(dataDir)
  try {
    const raw = await withToken(server, `/api/projects/${slug}/export?format=jsonl`)
    assert.equal(raw.status, 200)
    assert.match(raw.headers.get('content-disposition') ?? '', /attachment; filename="/)
    // Verbatim: the export is the contract file, not a re-serialization of it.
    assert.equal(await raw.text(), readFileSync(join(dataDir, 'projects', slug, 'rounds.jsonl'), 'utf8'))

    const bundle = await body(withToken(server, `/api/projects/${slug}/export?format=json`))
    assert.equal(bundle.rounds.length, 5)
    assert.equal(bundle.manifest.slug, slug)
    // The shares travel with the coverage they are a share of, or they are not worth exporting.
    assert.equal(bundle.analysis.coverage.rounds, 5)

    assert.equal((await withToken(server, `/api/projects/${slug}/export?format=csv`)).status, 400)
  } finally {
    await server.close()
  }
})

test('browsing a store leaves it exactly as it was', async () => {
  const { dataDir, slug, session } = makeStore()
  const before = snapshot(dataDir)
  const server = await serving(dataDir)
  try {
    for (const path of [
      '/api/projects',
      `/api/projects/${slug}`,
      `/api/projects/${slug}/tools`,
      `/api/projects/${slug}/sessions/${session}`,
      `/api/projects/${slug}/sessions/${session}/tasks/1`,
      `/api/projects/${slug}/sessions/${session}/rounds/0`,
      `/api/projects/${slug}/sessions/${session}/results/tu_1`,
      `/api/projects/${slug}/export?format=jsonl`,
      `/api/projects/${slug}/export?format=json`,
      `/api/projects/${slug}/readings`,
      '/api/reader',
      '/api/search?q=tool:Bash',
      `/api/search?q=is:error&project=${slug}`,
      '/api/facets',
      `/api/facets?key=tool&project=${slug}`,
    ]) {
      assert.equal((await withToken(server, path)).status, 200, path)
    }
  } finally {
    await server.close()
  }
  // `analyze` writes analysis.jsonl on the way through. Reading is not a reason to write, and
  // exporting is reading. Only sync writes, and only when asked.
  assert.deepEqual(snapshot(dataDir), before)
})

test('explaining needs the token, a reader, and a question that exists', async () => {
  const { dataDir, slug } = makeStore()
  const before = snapshot(dataDir)
  const server = await serving(dataDir)
  const explain = (body: unknown, token = true): Promise<Response> =>
    get(server, `/api/projects/${slug}/explain${token ? `?t=${server.token}` : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  try {
    const questions = await body(withToken(server, `/api/projects/${slug}/questions`))
    const one = questions.questions[0]
    assert.ok(one !== undefined, 'the fixture asked nothing')

    // The token stands between a page you did not open and a program running on this machine.
    assert.equal((await explain({ session: one.session, task: one.task, at: one.at }, false)).status, 403)

    // With no reader there is nothing to run, and the answer names the file to write.
    const none = await explain({ session: one.session, task: one.task, at: one.at })
    assert.equal(none.status, 400)
    assert.match(String((await none.json() as { error: string }).error), /no reader configured/)

    // A reader that would answer, so what is refused next is refused for its own reason.
    writeFileSync(
      join(dataDir, 'reader.json'),
      JSON.stringify({ command: [process.execPath, '-e', 'process.stdout.write("{}")'] }) + '\n',
    )
    const missing = await explain({ session: 'nobody', task: 1, at: 0 })
    assert.equal(missing.status, 404)
    assert.equal((await explain({ session: 'nobody' })).status, 400)
  } finally {
    await server.close()
  }
  // Every one of those was refused, so nothing about the project moved. The reader config is the
  // one file written here, and it is not part of any project.
  const after = snapshot(dataDir)
  delete after['reader.json']
  assert.deepEqual(after, before, 'a refused explain must not have written')
})

test('the prompt is served without a reader, and runs nothing', async () => {
  const { dataDir, slug } = makeStore()
  const before = snapshot(dataDir)
  const server = await serving(dataDir)
  try {
    const questions = await body(withToken(server, `/api/projects/${slug}/questions`))
    const one = questions.questions[0]
    assert.ok(one !== undefined, 'the fixture asked nothing')
    const where = `session=${encodeURIComponent(String(one.session))}&task=${String(one.task)}&at=${String(one.at)}`

    // No reader is configured, and that is the point: copying the prompt is the way to ask when
    // there is nothing on this machine to run.
    const got = await body(withToken(server, `/api/projects/${slug}/prompt?${where}`))
    assert.equal(got.key, `${String(one.session)}#${String(one.task)}.${String(one.at)}`)
    assert.match(String(got.prompt), /A coding agent made the tool calls below/)
    // What is sent is the calls and nothing else, which is the promise the button makes.
    assert.ok(String(got.prompt).includes(String(one.calls[0].text)), 'the calls are in it')

    // A question that is not there is a 404, and a query that names none is a 400 — the same two
    // sentences `explain` answers with, because it is the same lookup.
    assert.equal((await withToken(server, `/api/projects/${slug}/prompt?session=nobody&task=1&at=0`)).status, 404)
    assert.equal((await withToken(server, `/api/projects/${slug}/prompt?task=1&at=0`)).status, 400)
    assert.equal((await withToken(server, `/api/projects/${slug}/prompt?${where.replace(/task=\d+/, 'task=nope')}`)).status, 400)
  } finally {
    await server.close()
  }
  assert.deepEqual(snapshot(dataDir), before, 'reading the prompt must not have written')
})

test('a reader answers one question, and what it said is kept where the project is', async () => {
  const { dataDir, slug, session } = makeStore()
  const server = await serving(dataDir)
  try {
    const questions = await body(withToken(server, `/api/projects/${slug}/questions`))
    const one = questions.questions[0]
    assert.ok(one !== undefined, 'the fixture asked nothing')
    assert.deepEqual(questions.readings, {}, 'nothing has been explained yet')
    assert.equal(questions.reader, null, 'no reader is configured yet')

    writeFileSync(
      join(dataDir, 'reader.json'),
      JSON.stringify({
        command: [
          process.execPath,
          '-e',
          'process.stdout.write(JSON.stringify({asked:"What is this?",kind:"refs",why:"a word, a tree"}))',
        ],
      }) + '\n',
    )

    const answered = await body(
      get(server, `/api/projects/${slug}/explain?t=${server.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: one.session, task: one.task, at: one.at }),
      }),
    )
    assert.equal(answered.asked, true)
    assert.equal(answered.reading.asked, 'What is this?')
    assert.equal(answered.reading.kind, 'refs')

    // It is kept beside the rounds it is about, so it is there on the next read and goes with the
    // project if the project goes.
    const again = await body(withToken(server, `/api/projects/${slug}/readings`))
    assert.equal(again.readings[answered.key].asked, 'What is this?')
    assert.ok(existsSync(join(dataDir, 'projects', slug, 'readings.json')))

    // And it travels with the task, so the panel draws it without a second fetch.
    const task = await body(
      withToken(server, `/api/projects/${slug}/sessions/${session}/tasks/${one.task}`),
    )
    assert.equal(task.readings[answered.key].asked, 'What is this?')
    assert.deepEqual(task.stale, [], 'a reading made from these calls is not stale')
  } finally {
    await server.close()
  }
})

test('the reader is argv, and setting it is a POST', async () => {
  const { dataDir } = makeStore()
  const server = await serving(dataDir)
  try {
    assert.deepEqual((await body(withToken(server, '/api/reader'))).command, [])

    const saved = await body(
      get(server, `/api/reader?t=${server.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: '  claude   -p  ', timeout_ms: 5000 }),
      }),
    )
    assert.deepEqual(saved.command, ['claude', '-p'])
    assert.equal(saved.timeout_ms, 5000)
    // Blanking it is how a person turns the reader off, and it leaves nothing runnable behind.
    const cleared = await body(
      get(server, `/api/reader?t=${server.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: [] }),
      }),
    )
    assert.deepEqual(cleared.command, [])
  } finally {
    await server.close()
  }
})

test('the assets it serves are typed, so a browser will use them', async () => {
  const { dataDir } = makeStore()
  const server = await serving(dataDir)
  try {
    // `nosniff` is set on every response, so anything served as octet-stream is a file the browser
    // will refuse to use. The favicon and the logos went out that way until .png was in the table.
    for (const [path, type] of [
      ['/', 'text/html'],
      ['/icon.png', 'image/png'],
      ['/logo-light.png', 'image/png'],
      ['/logo-dark.png', 'image/png'],
    ]) {
      const response = await get(server, path!)
      assert.equal(response.status, 200, path)
      assert.match(response.headers.get('content-type') ?? '', new RegExp(`^${type}`), path)
    }
  } finally {
    await server.close()
  }
})

test('the page it serves loads nothing from anywhere else', () => {
  const index = join(VIEW, 'index.html')
  assert.ok(existsSync(index), 'the frontend must be built before it can be served')
  // `xmlns="http://www.w3.org/2000/svg"` is an identifier, not an address, and appears inside the
  // inline favicon. What matters is whether anything is *loaded* from off-origin, so look at the
  // attributes that load things.
  const html = readFileSync(index, 'utf8')
  const remoteTag = /(?:src|href)\s*=\s*["']https?:\/\//.exec(html)
  assert.equal(remoteTag, null, `the served page loads ${remoteTag?.[0] ?? ''}`)
  assert.equal(/@import\s+(?:url\()?["']?https?:/.test(html), false, 'no remote stylesheet')

  for (const name of readdirSync(join(VIEW, 'assets'), { withFileTypes: true })) {
    if (!name.isFile() || !/\.(js|css)$/.test(name.name)) continue
    const body = readFileSync(join(VIEW, 'assets', name.name), 'utf8')
    // A URL in a comment or a source map name is not a fetch, so only look for one being loaded.
    const remote = /(?:fetch|src|href)\s*[=(]\s*['"`]https?:\/\//.exec(body)
    assert.equal(remote, null, `${name.name} loads ${remote?.[0] ?? ''}`)
  }
})

test('a query is answered over the store, and over one project when named', async () => {
  const { dataDir, slug } = makeStore()
  const server = await serving(dataDir)
  try {
    const all = await body(withToken(server, '/api/search?q=tool:Bash'))
    assert.equal(all.entity, 'rounds')
    assert.ok(all.totals.rounds > 0)
    // The share is the point of the payload: the matched rounds against what was searched.
    assert.ok(all.scope.rounds >= all.totals.rounds)
    assert.equal(all.share.rounds, all.totals.rounds / all.scope.rounds)
    assert.equal(all.scope_slug, null)

    const one = await body(withToken(server, `/api/search?q=tool:Bash&project=${slug}`))
    assert.equal(one.scope_slug, slug)
    assert.equal(one.totals.rounds, all.totals.rounds)

    // The entity is carried beside the query rather than written into it, so what the page shows
    // back is what was typed.
    const grouped = await body(withToken(server, '/api/search?q=tool:Bash&in=sessions'))
    assert.equal(grouped.entity, 'sessions')
    assert.equal(grouped.query, 'tool:Bash')
    assert.ok(grouped.hits.every((hit: { of: number; rounds: number }) => hit.of >= hit.rounds))
  } finally {
    await server.close()
  }
})

test('a query that cannot be read entirely still answers, and says what it could not read', async () => {
  const { dataDir } = makeStore()
  const server = await serving(dataDir)
  try {
    const found = await body(withToken(server, '/api/search?q=categoy:test%20cost:%3E'))
    assert.equal(found.diagnostics.length, 2)
    assert.match(found.diagnostics[0].hint, /category/)
    // Spans point into the query as it was typed, which is what lets the page underline them.
    assert.equal(found.query.slice(found.diagnostics[0].at.from, found.diagnostics[0].at.to), 'categoy:test')

    const empty = await body(withToken(server, '/api/search?q='))
    assert.match(empty.error, /nothing to look for/)
    assert.equal((await withToken(server, '/api/search?q=x&in=widgets')).status, 400)
  } finally {
    await server.close()
  }
})

test('the facets are what a query can name, and what this store holds for it', async () => {
  const { dataDir, slug } = makeStore()
  const server = await serving(dataDir)
  try {
    const fields = await body(withToken(server, '/api/facets'))
    // The same table the parser validates against, so a key offered is a key that exists.
    assert.ok(fields.fields.length > 20)
    assert.ok(fields.fields.some((one: { key: string }) => one.key === 'tool'))
    assert.deepEqual(fields.values, [])

    const tools = await body(withToken(server, `/api/facets?key=tool&project=${slug}`))
    assert.ok(tools.values.length > 0)
    assert.ok(tools.values.every((one: { rounds: number }) => one.rounds > 0))
    // Most used first, which is the order that makes a list of them worth reading.
    const counts = tools.values.map((one: { rounds: number }) => one.rounds)
    assert.deepEqual(counts, [...counts].sort((a: number, b: number) => b - a))
  } finally {
    await server.close()
  }
})

test('searching and its facets refuse a POST, like every other route that only reads', async () => {
  const { dataDir } = makeStore()
  const server = await serving(dataDir)
  try {
    for (const path of ['/api/search?q=tool:Bash', '/api/facets?key=tool']) {
      const refused = await get(server, `${path}&t=${server.token}`, { method: 'POST' })
      assert.equal(refused.status, 405, path)
    }
  } finally {
    await server.close()
  }
})

test('searching needs the token, like everything else the store answers', async () => {
  const { dataDir } = makeStore()
  const server = await serving(dataDir)
  try {
    assert.equal((await get(server, '/api/search?q=tool:Bash')).status, 403)
    assert.equal((await get(server, '/api/facets?key=tool')).status, 403)
  } finally {
    await server.close()
  }
})

test('compiling a sentence is a POST, needs a reader, and hands back a query', async () => {
  const { dataDir } = makeStore()
  const server = await serving(dataDir)
  const compile = (body: unknown): Promise<Response> =>
    get(server, `/api/compile?t=${server.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  try {
    // It starts a program, so visiting it must never be enough.
    assert.equal((await withToken(server, '/api/compile')).status, 405)
    assert.equal((await get(server, '/api/compile', { method: 'POST' })).status, 403)

    // With no reader there is nothing to run, and it says so rather than falling back.
    const nothing = await body(compile({ sentence: 'where did the time go' }))
    assert.match(nothing.error, /no reader configured/)

    writeFileSync(
      join(dataDir, 'reader.json'),
      JSON.stringify({
        command: [
          process.execPath,
          '-e',
          'process.stdout.write(JSON.stringify({query:"tool:Bash is:error",why:"failing calls"}))',
        ],
      }) + '\n',
    )

    const read = await body(compile({ sentence: 'what failed' }))
    assert.equal(read.query, 'tool:Bash is:error')
    assert.equal(read.why, 'failing calls')
    assert.equal(read.ran, true)
    // Asked once and then held: a question costs somebody's tokens, so asking it twice is a thing
    // they have to ask for.
    assert.equal((await body(compile({ sentence: 'what failed' }))).ran, false)
    assert.equal((await body(compile({ sentence: 'what failed', again: true }))).ran, true)

    // And what it compiled to is answered by the ordinary search path, with the same numbers a
    // typed query gives. Nothing the reader said reaches a figure.
    const asked = await body(withToken(server, `/api/search?q=${encodeURIComponent(read.query)}`))
    const typed = await body(withToken(server, '/api/search?q=tool%3ABash%20is%3Aerror'))
    assert.deepEqual(asked.totals, typed.totals)

    assert.equal((await body(compile({ sentence: '   ' }))).error, 'that has no question in it')
  } finally {
    await server.close()
  }
})

test('a reader that answers with an unreadable query is refused rather than run', async () => {
  const { dataDir } = makeStore()
  writeFileSync(
    join(dataDir, 'reader.json'),
    JSON.stringify({
      command: [
        process.execPath,
        '-e',
        'process.stdout.write(JSON.stringify({query:"categoy:test"}))',
      ],
    }) + '\n',
  )
  const server = await serving(dataDir)
  try {
    const refused = await body(
      get(server, `/api/compile?t=${server.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sentence: 'anything' }),
      }),
    )
    assert.match(refused.error, /cannot read/)
    assert.equal(existsSync(join(dataDir, 'asked.json')), false, 'a refused answer was kept')
  } finally {
    await server.close()
  }
})
