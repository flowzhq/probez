/**
 * Talking to the local server.
 *
 * The token arrives once, in the URL probez printed, and is then taken out of the address bar: it
 * is a key to your own prompts and shell commands, and an address bar is the most-copied string on
 * a screen. It lives in `sessionStorage` so a reload still works, and travels as a header.
 */

const KEY = 'probez.token'

function claimToken(): string | null {
  const url = new URL(window.location.href)
  const given = url.searchParams.get('t')
  if (given !== null && given !== '') {
    window.sessionStorage.setItem(KEY, given)
    url.searchParams.delete('t')
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    return given
  }
  return window.sessionStorage.getItem(KEY)
}

const token = claimToken()

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: token === null ? {} : { 'x-probez-token': token },
    cache: 'no-store',
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(
      body?.error ??
        (response.status === 403
          ? 'this page needs the link probez printed. Restart `probez view` and use the URL it gives you'
          : `the server answered ${response.status}`),
      response.status,
    )
  }
  return (await response.json()) as T
}

/* The payload types, mirroring src/viewdata.ts. Derivation happens in Node; this only renders. */

export interface Dominant {
  category: string
  short: string
  share: number
}

export interface CategoryRow {
  name: string
  label: string
  rounds: number
  errors: number
  ms: number
  out_tokens: number
  sub?: CategoryRow[]
}

export interface Coverage {
  rounds: number
  classified: number
  toolless: number
  weight: number
  unclassified: number
  targeted: number
}

export interface Analysis {
  rows: CategoryRow[]
  coverage: Coverage
  unknown: Array<{ name: string; weight: number }>
}

export interface StoredProject {
  slug: string
  dir: string
  project: string
  path: string | null
  key: string
  sessions: number
  rounds: number
  tasks: number
  in_tokens: number
  out_tokens: number
  first_ts: string | null
  last_ts: string | null
  collected_at: string | null
}

export interface TraceRound {
  session: string
  round: number
  task: number
  agent: 'main' | 'sub'
  ref: string
  ts: string | null
  ms: number | null
  in_tokens: number
  out_tokens: number
  thinking_chars: number
  tools: number
  errors: number
  dominant: Dominant | null
  phase: Dominant | null
  weights: Array<{ category: string; weight: number }>
}

export interface TraceRun {
  category: string | null
  short: string
  from: number
  to: number
  rounds: number
}

export interface Trace {
  rounds: TraceRound[]
  runs: TraceRun[]
  window: number
  span: { first: string | null; last: string | null; elapsed_ms: number; active_ms: number }
}

export interface ViewSession {
  session: string
  rounds: number
  tasks: number
  tool_calls: number
  errors: number
  in_tokens: number
  out_tokens: number
  first_ts: string | null
  last_ts: string | null
  model: string | null
  elapsed_ms: number
  active_ms: number
  work: Dominant | null
}

export interface ViewTask {
  session: string
  task: number
  rounds: number
  in_tokens: number
  out_tokens: number
  ms: number
  first_ts: string | null
  asked: string
  tool_calls: number
  errors: number
  elapsed_ms: number
  work: Dominant | null
}

export interface ToolRow {
  name: string
  calls: number
  errors: number
  result_chars: number
  ms: number
  kind?: string
  sub?: ToolRow[]
}

export interface ToolCall {
  name: string | null
  input: unknown
  result_chars: number | null
  is_error: boolean | null
  ms: number | null
}

export interface Round {
  session: string
  round: number
  task: number
  agent: 'main' | 'sub'
  id: string
  ts: string | null
  ms: number | null
  model: string | null
  in_tokens: number
  out_tokens: number
  user_text: string
  text: string
  thinking_chars: number
  tools: ToolCall[]
}

export interface Label {
  category: string
  sub: string
  target: string
  weight: number
  source: string
  errored: boolean
}

export interface ProjectsPayload {
  data_dir: string
  projects: Array<
    StoredProject & {
      work: Dominant | null
      mix: Array<{ category: string; label: string; share: number }>
    }
  >
}

export interface ProjectPayload {
  project: StoredProject
  tool_calls: number
  errors: number
  analysis: Analysis
  sessions: ViewSession[]
}

export interface SessionPayload {
  project: StoredProject
  session: ViewSession
  analysis: Analysis
  tasks: ViewTask[]
  trace: Trace
}

export interface TaskPayload {
  project: StoredProject
  session: string
  task: ViewTask
  analysis: Analysis
  trace: Trace
}

export interface RoundPayload {
  project: StoredProject
  round: Round
  labels: Label[]
}

export interface ToolsPayload {
  project: StoredProject
  tools: ToolRow[]
  kinds: ToolRow[]
}

export interface SyncResult {
  slug: string
  project: string
  source_found: boolean
  source_dir: string | null
  new_rounds: number
  read_sessions: number
  skipped_sessions: number
  rounds: number
  sessions: number
  tasks: number
  collected_at: string | null
}

async function post<T>(path: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: token === null ? {} : { 'x-probez-token': token },
    cache: 'no-store',
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(body?.error ?? `the server answered ${response.status}`, response.status)
  }
  return (await response.json()) as T
}

export type ExportFormat = 'jsonl' | 'json'

/**
 * Fetch an export, and let the browser write it wherever you say.
 *
 * probez itself writes only under its own data directory, so it does not put this file anywhere:
 * it hands over the bytes and the browser does the writing, which is also the only way a page can
 * put a file on your disk. Where a folder picker exists, you get one; where it does not, it lands
 * wherever downloads land.
 */
export async function exportProject(
  slug: string,
  format: ExportFormat,
): Promise<{ filename: string; bytes: number; saved: 'picked' | 'downloaded' | 'cancelled' }> {
  const response = await fetch(`/api/projects/${slug}/export?format=${format}`, {
    headers: token === null ? {} : { 'x-probez-token': token },
    cache: 'no-store',
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(body?.error ?? `the server answered ${response.status}`, response.status)
  }

  const disposition = response.headers.get('content-disposition') ?? ''
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `${slug}.${format}`
  const blob = await response.blob()

  const picker = (
    window as unknown as {
      showSaveFilePicker?: (options: unknown) => Promise<FileSystemFileHandle>
    }
  ).showSaveFilePicker

  if (typeof picker === 'function') {
    try {
      const handle = await picker({
        suggestedName: filename,
        types: [
          {
            description: format === 'jsonl' ? 'JSON Lines' : 'JSON',
            accept: { [blob.type.split(';')[0] ?? 'application/json']: [`.${format}`] },
          },
        ],
      })
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      return { filename, bytes: blob.size, saved: 'picked' }
    } catch (problem) {
      // Choosing not to save is not a failure. Anything else falls through to a plain download.
      if ((problem as DOMException).name === 'AbortError') {
        return { filename, bytes: blob.size, saved: 'cancelled' }
      }
    }
  }

  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(href), 30_000)
  return { filename, bytes: blob.size, saved: 'downloaded' }
}

export const api = {
  sync: (slug: string) => post<SyncResult>(`/projects/${slug}/sync`),
  projects: () => get<ProjectsPayload>('/projects'),
  project: (slug: string) => get<ProjectPayload>(`/projects/${slug}`),
  session: (slug: string, session: string) =>
    get<SessionPayload>(`/projects/${slug}/sessions/${session}`),
  task: (slug: string, session: string, task: number) =>
    get<TaskPayload>(`/projects/${slug}/sessions/${session}/tasks/${task}`),
  round: (slug: string, session: string, round: number) =>
    get<RoundPayload>(`/projects/${slug}/sessions/${session}/rounds/${round}`),
  tools: (slug: string) => get<ToolsPayload>(`/projects/${slug}/tools`),
}
