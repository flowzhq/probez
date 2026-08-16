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
const VIEW = join(here, '..', 'view')

/** A collected store of one project, built by running the real `collect`. */
function makeStore(): {
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
  execFileSync(
    process.execPath,
    [CLI, 'collect', project, '--data-dir', dataDir, '--claude-dir', claudeDir],
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
  return startServer({ dataDir, claudeDir, port: 0, pinned: true })
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

    const tools = await body(withToken(server, `/api/projects/${slug}/tools`))
    assert.ok(tools.tools.length > 0)
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
    for (const verb of ['sync', 'rename', 'delete']) {
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
      `/api/projects/${slug}/export?format=jsonl`,
      `/api/projects/${slug}/export?format=json`,
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
