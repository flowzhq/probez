import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { act } from '@testing-library/react'

import { discoverClaudeProjects } from '../../src/discover'
import { startServer } from '../../src/serve'
import type { Serving } from '../../src/serve'
import { collectProject, listStored } from '../../src/store'
import { forgetRounds } from '../../src/viewdata'

/**
 * The page against a real `probez view`.
 *
 * Each test file gets a store collected from the same Claude fixture the server tests use, a server
 * started on it, and the app itself mounted the way `index.html` mounts it. The page's requests go
 * to that server, so what a component renders is what the server actually sends. `fault` makes one
 * request fail, for the outcomes a working server never produces on its own.
 */

/**
 * Files the page handed the browser to save, by name and size, in order.
 *
 * jsdom has no object URLs and does not follow a download link, so both are stood in for here and
 * what was clicked is written down: that is everything a download is, from the page's side.
 */
export const downloads: Array<{ name: string; size: number }> = []
const blobs = new Map<string, Blob>()
URL.createObjectURL = (blob: Blob) => {
  const href = `blob:probez/${blobs.size}`
  blobs.set(href, blob)
  return href
}
URL.revokeObjectURL = (href: string) => {
  blobs.delete(href)
}
const click = HTMLAnchorElement.prototype.click
HTMLAnchorElement.prototype.click = function download(this: HTMLAnchorElement): void {
  if (this.download === '') return click.call(this)
  downloads.push({ name: this.download, size: blobs.get(this.href)?.size ?? -1 })
}

/** A jsdom file's contents, read the way a page would read them. */
function textOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

const FIXTURE = join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'session.jsonl')
export const SESSION = '11111111-0000-0000-0000-000000000000'

export interface App {
  server: Serving
  dataDir: string
  claudeDir: string
  slug: string
  /** Go somewhere in the app the way its own links do. */
  go(path: string): Promise<void>
  /** The next requests whose method and path match fail with this status and error, until undone. */
  fault(method: string, path: RegExp, status: number, error?: string): () => void
  /** Every request the page made, in order, as `METHOD /api/...`. */
  requests: string[]
  close(): Promise<void>
}

/** A store holding one collected project, built from the fixture. */
export async function makeStore(): Promise<{ dataDir: string; claudeDir: string; slug: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'probez-web-test-')))
  const claudeDir = join(root, 'claude')
  const dataDir = join(root, 'data')
  const project = join(root, 'work')
  const sourceDir = join(claudeDir, 'encoded-project-name')
  mkdirSync(project, { recursive: true })
  mkdirSync(sourceDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  // The same rewrite the server tests make: the fixture's working directory, as JSON would spell it.
  const cwd = JSON.stringify(project).slice(1, -1)
  writeFileSync(join(sourceDir, `${SESSION}.jsonl`), readFileSync(FIXTURE, 'utf8').replaceAll('/tmp/demo', cwd))

  const [found] = await discoverClaudeProjects(claudeDir)
  if (found === undefined) throw new Error('the fixture was not discovered')
  await collectProject(found, dataDir)
  const [stored] = await listStored(dataDir)
  return { dataDir, claudeDir, slug: stored!.slug }
}

export async function openApp(path = '/', store?: Awaited<ReturnType<typeof makeStore>>): Promise<App> {
  const { dataDir, claudeDir, slug } = store ?? (await makeStore())
  forgetRounds()
  const server = await startServer({
    dataDir,
    claudeDir,
    cursorDir: '',
    codexDir: '',
    copilotDir: '',
    piDir: '',
    opencodeDir: '',
    gooseDir: '',
    clineDirs: [],
    port: 0,
    pinned: true,
    debug: true,
  })

  const faults: Array<{ method: string; path: RegExp; status: number; error: string }> = []
  const requests: string[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    requests.push(`${method} ${url}`)
    const fault = faults.find((one) => one.method === method && one.path.test(url))
    if (fault !== undefined) {
      return new Response(JSON.stringify({ error: fault.error }), {
        status: fault.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    // A file the page picked is jsdom's, which Node's fetch cannot send; its text is the same body.
    const body = init?.body
    const sent = body instanceof Blob ? { ...init, body: await textOf(body) } : init
    return real(`http://127.0.0.1:${server.port}${url}`, sent)
  }) as typeof fetch

  // The link `probez view` prints, which the page takes its token from and then hides.
  window.history.replaceState(null, '', `${path}${path.includes('?') ? '&' : '?'}t=${server.token}`)
  document.body.innerHTML = '<div id="root"></div>'
  let page: { unmount(): void } | null = null
  await act(async () => {
    ;({ page } = await import('../src/main'))
  })

  return {
    server,
    dataDir,
    claudeDir,
    slug,
    requests,
    async go(to: string) {
      await act(async () => {
        window.history.pushState(null, '', to)
        window.dispatchEvent(new PopStateEvent('popstate'))
      })
    },
    fault(method: string, path: RegExp, status: number, error = `failed with ${status}`) {
      const one = { method, path, status, error }
      faults.push(one)
      return () => {
        faults.splice(faults.indexOf(one), 1)
      }
    },
    async close() {
      // Taken down before anything else goes. The page keeps timers of its own — a sentence it said
      // clears itself after eight seconds — and one that fires after jsdom is gone finds no window.
      act(() => page?.unmount())
      globalThis.fetch = real
      await server.close()
    },
  }
}
