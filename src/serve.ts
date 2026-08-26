import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { extname, join, resolve, sep } from 'node:path'

import {
  BadRequest,
  compileSentenceFor,
  explainOne,
  exportProject,
  facetsPayload,
  importExport,
  NotFound,
  pricingPayload,
  projectPayload,
  projectsPayload,
  promptPayload,
  removeStored,
  renameStored,
  resultPayload,
  roundPayload,
  savePricing,
  searchPayload,
  sessionPayload,
  syncProject,
  taskPayload,
  toolsPayload,
  questionsPayload,
  readerPayload,
  readingsPayload,
  saveReaderConfig,
  trailsPayload,
} from './viewdata.js'

/**
 * The local profiler's server.
 *
 * probez makes no outbound connections; this listens, on the loopback address only, and serves one
 * machine's own store back to one browser on it. Three things keep that from being a wider door
 * than it sounds:
 *
 * - It binds `127.0.0.1`, so it is not reachable from the network at all.
 * - Every `/api` request must carry the token printed with the URL, which is new on every run. A
 *   page you did not open cannot read your prompts, and — since one route serves the body of a
 *   tool result straight out of an archived session — cannot read what your tools returned either.
 * - Every request's `Host` header must be the address it bound. That is the defence against DNS
 *   rebinding, where a hostile page resolves its own domain to 127.0.0.1 and talks to this from
 *   inside your browser's origin. The token alone would not stop it.
 *
 * Reading never writes. `analyze` caches its work as a side effect of being run; every `GET` here
 * refuses to, so browsing leaves the store exactly as it found it.
 *
 * Six routes write, and every one of them is a `POST`: `sync` on a project does what `collect` and
 * `analyze` do, `rename` sets a label, `delete` removes a project and everything recorded for it,
 * `import` takes in a file, `pricing` stores rates, and `reader` stores the command `explain` runs.
 * A seventh, `explain`, keeps what a reader answered about one question — and is the one thing here
 * that runs a program, which is why it is a `POST` although what a person means by it is "read this
 * one to me". It is worth being clear about what that
 * costs. Before any of them, the token and the `Host` check stood between a page you did not open
 * and *reading* your prompts; now they also stand between it and collecting, and between it and
 * deleting. Which is why `POST` is accepted on those paths and nowhere else, why they refuse `GET`
 * outright rather than merely not answering it, and why every other method is refused everywhere.
 *
 * `explain` raises that stake once more: behind the token and the `Host` check now sits a command
 * on this machine. So it is reachable by nothing but a `POST` carrying the token, it runs only the
 * argv the person wrote into `reader.json`, it sends that command nothing but the calls the
 * question is made of, and with no reader configured there is nothing it can run at all.
 */

const HOST = '127.0.0.1'

export interface ServeOptions {
  dataDir: string
  /** Where Claude Code sessions live. Only `sync` reads it; browsing a store never does. */
  claudeDir: string
  /** Where Cursor project folders live. Same as `claudeDir`: only `sync` reads it. */
  cursorDir: string
  /** Port to listen on. 0 lets the OS choose, which is what the tests want. */
  port?: number
  /** Fail rather than move to another port. True when `--port` was typed. */
  pinned?: boolean
}

export interface Serving {
  url: string
  port: number
  token: string
  close(): Promise<void>
}

export const DEFAULT_PORT = 7373
/** How far to walk up from the default before giving up on finding a free port. */
const PORT_ATTEMPTS = 20

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/**
 * The built frontend, which tsc does not produce and does not copy. `vite build` writes it to
 * `dist/view`, a sibling of the `dist/src` this file is compiled into.
 */
function assetRoot(): string {
  return fileURLToPath(new URL('../view/', import.meta.url))
}

/**
 * A page served from here may load only from here. Inline styles are allowed because the chart
 * components set them per element; nothing else is.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
): void {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': CSP,
  })
  res.end(body)
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value))
}

/** Compared in constant time, so a wrong token cannot be found one character at a time. */
function sameToken(given: string, wanted: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(wanted)
  return a.length === b.length && timingSafeEqual(a, b)
}

function tokenOf(req: IncomingMessage, url: URL): string | null {
  const header = req.headers['x-probez-token']
  if (typeof header === 'string') return header
  return url.searchParams.get('t')
}

/**
 * The address the browser asked for, which must be the one we bound.
 *
 * A request that arrives with any other `Host` reached us through a name that resolves here, which
 * is exactly the shape of a rebinding attack and never the shape of clicking the printed link.
 */
function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host
  if (typeof host !== 'string') return false
  return host === `${HOST}:${port}` || host === `localhost:${port}`
}

/** One path segment as it was written, or as-is when it is not valid percent-encoding. */
function decodeSegment(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

async function serveAsset(res: ServerResponse, pathname: string): Promise<void> {
  const root = resolve(assetRoot())
  const wanted = pathname === '/' ? '/index.html' : pathname
  const file = resolve(root, `.${wanted}`)
  // A path that climbed out of the asset directory is not a path we have anything at.
  if (file !== root && !file.startsWith(root + sep)) {
    send(res, 403, 'text/plain; charset=utf-8', 'forbidden\n')
    return
  }

  const body = await readFile(file).catch(() => null)
  if (body !== null) {
    send(res, 200, MIME[extname(file)] ?? 'application/octet-stream', body)
    return
  }

  // Routes like /p/<slug>/s/<id> are the app's, not the filesystem's, so anything without a file
  // extension falls back to the shell and lets the router sort it out.
  if (extname(wanted) === '') {
    const index = await readFile(join(root, 'index.html')).catch(() => null)
    if (index !== null) {
      send(res, 200, MIME['.html']!, index)
      return
    }
    send(
      res,
      500,
      'text/plain; charset=utf-8',
      'probez view has no built frontend. Run `npm run build`.\n',
    )
    return
  }

  send(res, 404, 'text/plain; charset=utf-8', 'not found\n')
}

/**
 * The paths under one project that write, matched exactly.
 *
 * All three refuse GET as well as accepting POST, which is the part that matters: a URL that
 * collects, renames or deletes when it is merely visited is a URL that can be put in an `<img>` tag
 * on any page you happen to open.
 */
const PROJECT_WRITES = new Set(['sync', 'rename', 'delete', 'explain'])

function isProjectWritePath(parts: string[]): boolean {
  return parts.length === 3 && parts[0] === 'projects' && PROJECT_WRITES.has(parts[2]!)
}

/** Rates: readable with GET, writable with POST. */
function isPricingPath(parts: string[]): boolean {
  return parts.length === 1 && parts[0] === 'pricing'
}

/** The command `explain` runs: readable with GET, writable with POST. Same shape as pricing. */
function isReaderPath(parts: string[]): boolean {
  return parts.length === 1 && parts[0] === 'reader'
}

/**
 * Reading a sentence as a query. POST only, because it starts a program.
 *
 * The second thing in probez that spawns anything, after `explain`, and it is a POST for the same
 * reason: a URL that runs something when it is merely visited is a URL that can be put in an
 * `<img>` tag on any page you happen to open. See CONTRIBUTING § rule 2.
 */
function isCompilePath(parts: string[]): boolean {
  return parts.length === 1 && parts[0] === 'compile'
}

/** Taking in an exported project. POST only: it writes. */
function isImportPath(parts: string[]): boolean {
  return parts.length === 1 && parts[0] === 'import'
}

/** Every path that accepts a POST. */
function isWritePath(parts: string[]): boolean {
  return (
    isProjectWritePath(parts) ||
    isPricingPath(parts) ||
    isReaderPath(parts) ||
    isCompilePath(parts) ||
    isImportPath(parts)
  )
}

/**
 * How much of a request body is worth reading.
 *
 * A rate table is a few hundred bytes; an exported project is the whole of someone's rounds, and a
 * large one runs to tens of megabytes. The cap is what stops a body being read until this process
 * runs out of memory, so it is generous rather than absent.
 */
const MAX_BODY = 64 * 1024
const MAX_IMPORT_BODY = 256 * 1024 * 1024

/**
 * Read a JSON body, refusing anything oversized.
 *
 * The only body this server accepts is a table of numbers, so the cap is generous by two orders of
 * magnitude and still small enough that nothing can be pushed into memory here.
 */
async function readJsonBody(req: IncomingMessage, cap = MAX_BODY): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > cap) throw new Error(`that file is larger than ${Math.round(cap / 1024 / 1024)} MB`)
    chunks.push(buffer)
  }
  if (size === 0) return null
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * A whole number out of a query string, or nothing.
 *
 * Anything that is not one comes back `undefined` rather than `NaN`, so a mistyped query is
 * refused by the same sentence that refuses a missing one instead of hunting for question −1.
 */
function asIndex(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const index = Number(value)
  return Number.isInteger(index) ? index : undefined
}

async function serveApi(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServeOptions,
  parts: string[],
  url: URL,
): Promise<void> {
  const method = req.method ?? 'GET'
  // /api/compile                                              POST
  // /api/search?q=&project=&in=&limit=
  // /api/facets?key=&project=
  // /api/projects
  // /api/projects/<slug>
  // /api/projects/<slug>/tools
  // /api/projects/<slug>/trails, /api/projects/<slug>/questions
  // /api/projects/<slug>/readings
  // /api/projects/<slug>/prompt?session=&task=&at=
  // /api/projects/<slug>/explain                                POST
  // /api/projects/<slug>/export?format=jsonl|json
  // /api/projects/<slug>/sync                                   POST
  // /api/projects/<slug>/rename                                 POST
  // /api/projects/<slug>/delete                                 POST
  // /api/projects/<slug>/sessions/<session>
  // /api/projects/<slug>/sessions/<session>/tasks/<task>
  // /api/projects/<slug>/sessions/<session>/rounds/<round>
  // /api/projects/<slug>/sessions/<session>/results/<tool_use_id>
  const dataDir = options.dataDir
  const [group, slug, kind, id, leaf, leafId] = parts

  if (group === 'import' && slug === undefined) {
    // Reachable only as POST; the method check upstream has already refused a GET here.
    let body: unknown
    try {
      body = await readJsonBody(req, MAX_IMPORT_BODY)
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'unreadable body' })
      return
    }
    sendJson(res, 200, await importExport(dataDir, body))
    return
  }

  // Searching and the values a search can name. Both are reads, so both are GET and neither
  // writes anything — not even the index, which `sync` builds beside the analysis cache.
  if (group === 'search' && slug === undefined) {
    sendJson(
      res,
      200,
      await searchPayload(dataDir, {
        q: url.searchParams.get('q') ?? '',
        slug: url.searchParams.get('project') ?? undefined,
        entity: url.searchParams.get('in') ?? undefined,
        limit: asIndex(url.searchParams.get('limit')),
      }),
    )
    return
  }

  if (group === 'facets' && slug === undefined) {
    sendJson(
      res,
      200,
      await facetsPayload(dataDir, {
        key: url.searchParams.get('key') ?? undefined,
        slug: url.searchParams.get('project') ?? undefined,
      }),
    )
    return
  }

  if (group === 'compile' && slug === undefined) {
    // Reachable only as POST; the method check upstream has already refused a GET here.
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'unreadable body' })
      return
    }
    sendJson(res, 200, await compileSentenceFor(dataDir, body))
    return
  }

  if (group === 'pricing' && slug === undefined) {
    if (method === 'POST') {
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'unreadable body' })
        return
      }
      sendJson(res, 200, await savePricing(dataDir, body))
      return
    }
    sendJson(res, 200, await pricingPayload(dataDir))
    return
  }

  if (group === 'reader' && slug === undefined) {
    if (method === 'POST') {
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'unreadable body' })
        return
      }
      sendJson(res, 200, await saveReaderConfig(dataDir, body))
      return
    }
    sendJson(res, 200, await readerPayload(dataDir))
    return
  }

  if (group !== 'projects') {
    sendJson(res, 404, { error: `no endpoint /api/${parts.join('/')}` })
    return
  }
  if (slug === undefined) {
    sendJson(res, 200, await projectsPayload(dataDir))
    return
  }
  if (kind === undefined) {
    sendJson(res, 200, await projectPayload(dataDir, slug))
    return
  }
  if (kind === 'sync' && id === undefined) {
    // Reachable only as POST; the method check upstream has already refused a GET here.
    sendJson(res, 200, await syncProject(dataDir, options.claudeDir, options.cursorDir, slug))
    return
  }
  if (kind === 'rename' && id === undefined) {
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'unreadable body' })
      return
    }
    sendJson(res, 200, await renameStored(dataDir, slug, body))
    return
  }
  if (kind === 'delete' && id === undefined) {
    sendJson(res, 200, await removeStored(dataDir, slug))
    return
  }
  if (kind === 'export' && id === undefined) {
    const format = url.searchParams.get('format') ?? 'jsonl'
    if (format !== 'jsonl' && format !== 'json') {
      sendJson(res, 400, { error: `format must be jsonl or json, got "${format}"` })
      return
    }
    const file = await exportProject(dataDir, slug, format)
    // The filename is built from the slug, which is already restricted to characters a header can
    // carry, so there is nothing here to escape.
    res.writeHead(200, {
      'content-type': file.type,
      'content-length': Buffer.byteLength(file.body),
      'content-disposition': `attachment; filename="${file.filename}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(file.body)
    return
  }
  if (kind === 'tools' && id === undefined) {
    sendJson(res, 200, await toolsPayload(dataDir, slug))
    return
  }
  if (kind === 'questions' && id === undefined) {
    sendJson(res, 200, await questionsPayload(dataDir, slug))
    return
  }
  if (kind === 'trails' && id === undefined) {
    sendJson(res, 200, await trailsPayload(dataDir, slug))
    return
  }
  if (kind === 'readings' && id === undefined) {
    sendJson(res, 200, await readingsPayload(dataDir, slug))
    return
  }
  // What `explain` would send, without sending it: a read, so a GET, and it needs no reader. The
  // question is named in the query rather than a body for the same reason — nothing here writes.
  if (kind === 'prompt' && id === undefined) {
    sendJson(
      res,
      200,
      await promptPayload(dataDir, slug, {
        session: url.searchParams.get('session') ?? undefined,
        task: asIndex(url.searchParams.get('task')),
        at: asIndex(url.searchParams.get('at')),
      }),
    )
    return
  }
  if (kind === 'explain' && id === undefined) {
    // Reachable only as POST; the method check upstream has already refused a GET here.
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'unreadable body' })
      return
    }
    sendJson(res, 200, await explainOne(dataDir, slug, body))
    return
  }
  if (kind !== 'sessions' || id === undefined) {
    sendJson(res, 404, { error: `no endpoint /api/${parts.join('/')}` })
    return
  }
  if (leaf === undefined) {
    sendJson(res, 200, await sessionPayload(dataDir, slug, id))
    return
  }

  // Not a numbered child of the session like tasks and rounds are, so it is answered before the
  // index is parsed: what addresses a result is the id its call was made with.
  if (leaf === 'results') {
    if (leafId === undefined || leafId === '') {
      sendJson(res, 400, { error: 'that request names no tool call' })
      return
    }
    sendJson(res, 200, await resultPayload(dataDir, slug, id, leafId))
    return
  }

  const index = Number(leafId)
  if (!Number.isInteger(index) || index < 0) {
    sendJson(res, 400, { error: `"${leafId ?? ''}" is not a whole number` })
    return
  }
  if (leaf === 'tasks') {
    sendJson(res, 200, await taskPayload(dataDir, slug, id, index))
    return
  }
  if (leaf === 'rounds') {
    sendJson(res, 200, await roundPayload(dataDir, slug, id, index))
    return
  }
  sendJson(res, 404, { error: `no endpoint /api/${parts.join('/')}` })
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((ok, fail) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening)
      fail(error)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      const address = server.address()
      ok(typeof address === 'object' && address !== null ? address.port : port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, HOST)
  })
}

export async function startServer(options: ServeOptions): Promise<Serving> {
  const token = randomUUID()
  const wanted = options.port ?? DEFAULT_PORT
  let port = wanted

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'probez view failed to answer' })
      else res.end()
    })
  })

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${HOST}:${port}`)
    // A session id can be a path — a subagent's transcript is named for where it sits — so the
    // client percent-encodes each id and the segments are decoded back here. `pathname` keeps the
    // escapes, so splitting on `/` still lands on the route's own separators and not on an id's.
    const parts = url.pathname
      .split('/')
      .filter((part) => part !== '')
      .slice(1)
      .map(decodeSegment)
    const isApi = url.pathname.startsWith('/api/') || url.pathname === '/api'

    // GET everywhere, and POST on the one route that writes. Anything else has no implementation
    // to reach, which is a shorter thing to reason about than a set of handlers that check.
    const allowed = isApi && isWritePath(parts) ? 'GET, POST' : 'GET'
    const wanted = req.method ?? ''
    if (wanted !== 'GET' && !(wanted === 'POST' && allowed === 'GET, POST')) {
      res.writeHead(405, { allow: allowed, 'content-length': 0 })
      res.end()
      return
    }
    // Collecting, renaming and removing are writes, one of them destroys data, and compiling a
    // sentence starts a program. None of them may be reachable by a GET: a URL that does any of it
    // when merely visited can be put in an <img> tag on a page you did not write.
    if (
      wanted === 'GET' &&
      isApi &&
      (isProjectWritePath(parts) || isImportPath(parts) || isCompilePath(parts))
    ) {
      res.writeHead(405, { allow: 'POST', 'content-length': 0 })
      res.end()
      return
    }

    if (!hostAllowed(req, port)) {
      send(res, 403, 'text/plain; charset=utf-8', 'forbidden\n')
      return
    }

    if (!isApi) {
      await serveAsset(res, url.pathname)
      return
    }

    const given = tokenOf(req, url)
    if (given === null || !sameToken(given, token)) {
      sendJson(res, 403, { error: 'probez view needs the token from the URL it printed' })
      return
    }

    try {
      await serveApi(req, res, options, parts, url)
    } catch (error) {
      if (error instanceof NotFound) sendJson(res, 404, { error: error.message })
      else if (error instanceof BadRequest) sendJson(res, 400, { error: error.message })
      else throw error
    }
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      port = await listen(server, port)
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const canMove = code === 'EADDRINUSE' && options.pinned !== true && attempt < PORT_ATTEMPTS
      if (!canMove) throw error
      port = wanted + attempt + 1
    }
  }

  return {
    url: `http://${HOST}:${port}/?t=${token}`,
    port,
    token,
    close: () =>
      new Promise((ok) => {
        server.close(() => ok())
        server.closeAllConnections?.()
      }),
  }
}
