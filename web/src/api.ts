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

/** One category's slice of a piece of work. Shares are weighted, and sum to 1. */
export interface Share {
  category: string
  label: string
  short: string
  share: number
}

export interface CategoryRow {
  name: string
  label: string
  rounds: number
  errors: number
  ms: number
  in_tokens: number
  in_uncached: number
  in_cache_write_5m: number
  in_cache_write_1h: number
  in_cache_read: number
  out_tokens: number
  cost: number
  sub?: CategoryRow[]
}

export interface Coverage {
  rounds: number
  classified: number
  toolless: number
  weight: number
  unclassified: number
  targeted: number
  /** Dollars across the classified rounds — the denominator for every share. */
  cost: number
  /** Classified rounds whose model has no rate, and so are outside `cost`. */
  unpriced: number
}

export interface Analysis {
  rows: CategoryRow[]
  coverage: Coverage
  unknown: Array<{ name: string; weight: number }>
  unpriced: Array<{ model: string; rounds: number }>
}

export interface StoredProject {
  slug: string
  dir: string
  /** What to call it: the name someone chose, or the one its path gave it. */
  project: string
  /** Whether that name was chosen here, which is what makes the rename revertible. */
  renamed: boolean
  path: string | null
  key: string
  sessions: number
  rounds: number
  tasks: number
  in_tokens: number
  in_uncached: number
  in_cache_write: number
  in_cache_write_5m: number
  in_cache_write_1h: number
  in_cache_read: number
  out_tokens: number
  first_ts: string | null
  last_ts: string | null
  collected_at: string | null
  /** When this arrived as an export, or null when it was collected on this machine. */
  imported_at: string | null
  sources: Array<'claude-code' | 'cursor'>
}

export interface TraceRound {
  session: string
  round: number
  task: number
  agent: 'main' | 'sub'
  ref: string
  ts: string | null
  ms: number | null
  gen_ms: number | null
  in_tokens: number | null
  in_cache_read: number | null
  out_tokens: number | null
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

/** One call, as somewhere the agent went. Mirrors `Call` in src/trail.ts. */
export interface Call {
  session: string
  round: number
  task: number
  ref: string
  at: number
  id: string | null
  tool: string
  /** The command name, or the tool's. */
  name: string
  /** The call as it was made — the command, or the tool and what it was pointed at. */
  text: string
  verb: string
  scope: 'tree' | 'dir' | 'file' | 'span'
  sites: string[]
  probes: string[]
  share: number
  ms: number | null
  result_chars: number | null
}

/** One call as a node in a trail: where it went, plus what put it there. Mirrors `Step`. */
export interface TrailStep extends Call {
  source: number | null
  edge: 'listed' | 'probe' | 'narrow' | null
  via: string
}

/** Which of the six questions a run of calls was asking. Mirrors `Ask` in src/question.ts. */
export type Ask = 'define' | 'refs' | 'outline' | 'flow' | 'touches' | 'covers' | 'other'

/**
 * One thing the agent needed to know, and every call it spent finding out. Mirrors `Question`.
 */
export interface Question {
  session: string
  task: number
  /** What it is called: `<task>.<round>` of its first call. Not unique — see `at`. */
  ref: string
  /** Position of its first call within the task, which addresses one exactly. */
  at: number
  last: string
  kind: Ask
  terms: string[]
  files: string[]
  calls: Call[]
  repeats: number
  fetches: number
  sweeps: number
  ms: number
  in_tokens: number
  out_tokens: number
}

/**
 * One model's reading of one question. Mirrors `Reading` in src/reading.ts.
 *
 * Shown beside `kind`, never instead of it: `kind` is a rule anyone can check against the calls and
 * this is a sentence a model wrote about them. Nothing derived from one enters a number on any page.
 */
export interface Reading {
  asked: string
  /** The model's read of the kind, or null when it named nothing in the table. */
  kind: Ask | null
  why: string
  /** The reader that answered, as it was configured. */
  by: string
  at: string
  evidence: string
}

/** How a reading is addressed. Mirrors `readingKey` in src/reading.ts. */
export function readingKey(session: string, task: number, at: number): string {
  return `${session}#${task}.${at}`
}

/** A run of calls that followed one another into the repository. Mirrors `Trail` in src/trail.ts. */
export interface Trail {
  session: string
  task: number
  ref: string
  last: string
  steps: TrailStep[]
  depth: number
  breadth: number
  root: 'listing' | 'probe' | 'doc' | 'path'
  paths: number
  revisits: number
  outcome: 'edit' | 'test' | 'abandoned'
  ended_on: string
  ms: number
  in_tokens: number
  out_tokens: number
  confidence: 'proven' | 'inferred'
}

/** What a span of rounds cost and changed. Mirrors `Totals` in src/inspect.ts. */
export interface Totals {
  in_tokens: number
  in_uncached: number
  in_cache_write: number
  in_cache_write_5m: number
  in_cache_write_1h: number
  in_cache_read: number
  out_tokens: number
  cost: number
  gen_ms: number
  wait_ms: number
  added: number
  removed: number
}

export interface ViewSession extends Totals {
  session: string
  /** "sub" when a subagent ran this session, matching the field a round carries. */
  agent: 'main' | 'sub'
  rounds: number
  /** Rounds whose model has no rate, and which therefore added nothing to `cost`. */
  unpriced: number
  tasks: number
  tool_calls: number
  errors: number
  first_ts: string | null
  last_ts: string | null
  model: string | null
  elapsed_ms: number
  active_ms: number
  work: Dominant | null
  /** The whole distribution behind `work`, which the sessions table draws as a bar. */
  mix: Share[]
}

export interface ViewTask extends Totals {
  session: string
  task: number
  rounds: number
  ms: number
  first_ts: string | null
  asked: string
  /** The commit the checkout was on when the task started. Null when nothing recorded one. */
  commit: string | null
  tool_calls: number
  errors: number
  elapsed_ms: number
  work: Dominant | null
  /** The whole distribution behind `work`, drawn as a bar in the tasks table. */
  mix: Share[]
}

export interface ToolRow {
  name: string
  calls: number
  errors: number
  /** Calls that failed without the harness saying so: stderr, or cut short. */
  quiet: number
  result_chars: number
  ms: number
  kind?: string
  sub?: ToolRow[]
}

export interface Patch {
  files: number
  added: number
  removed: number
}

export interface ToolCall {
  name: string | null
  id: string | null
  input: unknown
  input_chars: number
  result_chars: number | null
  is_error: boolean | null
  stderr_chars: number | null
  interrupted: boolean | null
  patch: Patch | null
  emitted_at: string | null
  result_at: string | null
  ms: number | null
}

export interface RoundEvent {
  type: 'user_message' | 'tool_result' | 'reasoning' | 'text' | 'tool_call'
  ts: string
  chars?: number
  tool_call_id?: string
}

export interface Rates {
  in: number
  cache_write_5m: number
  cache_write_1h: number
  cache_read: number
  out: number
}

export interface PricedModel {
  model: string
  rounds: number
  rates: Rates | null
  custom: boolean
}

export interface PricingPayload {
  file: string
  models: PricedModel[]
  defaults: Record<string, Rates>
}

/** A compaction the harness ran, carried by the round that came after it. */
export interface Compaction {
  trigger: string | null
  pre_tokens: number | null
  post_tokens: number | null
  dropped_tokens: number | null
  ms: number | null
  ts: string | null
}

export interface Round {
  session: string
  round: number
  task: number
  agent: 'main' | 'sub'
  id: string
  ts: string | null
  ms: number | null
  gen_ms: number | null
  wait_ms: number | null
  first_input: 'user_message' | 'tool_result' | null
  model: string | null
  in_tokens: number | null
  in_uncached: number | null
  in_cache_write: number | null
  in_cache_write_5m: number | null
  in_cache_write_1h: number | null
  in_cache_read: number | null
  out_tokens: number | null
  compaction: Compaction | null
  mcp_server: string | null
  mcp_tool: string | null
  skill: string | null
  user_text: string
  text: string
  thinking_chars: number
  tools: ToolCall[]
  events: RoundEvent[]
}

export interface Label {
  category: string
  sub: string
  target: string
  weight: number
  source: string
  /** Which call in `round.tools` produced this label, zero-based. */
  call: number
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
  cost: number
  unpriced: number
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
  trails: Trail[]
  questions: Question[]
  /** Readings already asked for, keyed by `readingKey`. */
  readings: Record<string, Reading>
  /** Keys of the readings whose calls have changed since they were made. */
  stale: string[]
  /** The configured reader, or null when there is nothing probez could run. */
  reader: string | null
}

export interface RoundPayload {
  project: StoredProject
  round: Round
  labels: Label[]
  /** How full the model's window this round's input was, 0 to 1. Null when the window is unknown. */
  context_share: number | null
}

export interface ToolsPayload {
  project: StoredProject
  tools: ToolRow[]
  kinds: ToolRow[]
}

export interface TrailsPayload {
  project: StoredProject
  trails: Trail[]
  steps: number
  finding: number
}

export interface QuestionsPayload {
  project: StoredProject
  questions: Question[]
  /** Readings already asked for, keyed by `readingKey`. */
  readings: Record<string, Reading>
  /** Keys of the readings whose calls have changed since they were made. */
  stale: string[]
  /** The configured reader, or null when there is nothing probez could run. */
  reader: string | null
  calls: number
  repeats: number
  fetches: number
  sweeps: number
  reasked: number
}

/** What `explain` came back with. Mirrors `ExplainPayload` in src/viewdata.ts. */
export interface ExplainPayload {
  key: string
  reading: Reading
  /** False when it came out of the store and nothing was run. */
  asked: boolean
  stale: boolean
}

/** What would be sent, unsent. Mirrors `PromptPayload` in src/viewdata.ts. */
export interface PromptPayload {
  project: StoredProject
  key: string
  prompt: string
}

/** The command `explain` runs. Mirrors `ReaderPayload` in src/viewdata.ts. */
export interface ReaderPayload {
  file: string
  /** argv, empty when nothing is configured. */
  command: string[]
  timeout_ms: number
}

/** One tool result's body, fetched on request. Nothing renders it until someone asks. */
export interface ResultPayload {
  project: StoredProject
  session: string
  tool_use_id: string
  tool: string | null
  chars: number
  body: string
  truncated: boolean
  cap: number
  is_error: boolean
  omitted: string[]
  file: string
}

export interface ImportResult {
  slug: string
  dir: string
  project: string
  name: string
  rounds: number
  sessions: number
  tasks: number
  skipped: number
  replaced: boolean
}

export interface RenameResult {
  project: StoredProject
}

/** What was given up, so the report can name it rather than tick. */
export interface RemoveResult {
  slug: string
  project: string
  dir: string
  rounds: number
  sessions: number
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

async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: {
      ...(token === null ? {} : { 'x-probez-token': token }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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
  rename: (slug: string, name: string) =>
    post<RenameResult>(`/projects/${slug}/rename`, { name }),
  remove: (slug: string) => post<RemoveResult>(`/projects/${slug}/delete`),
  projects: () => get<ProjectsPayload>('/projects'),
  project: (slug: string) => get<ProjectPayload>(`/projects/${slug}`),
  session: (slug: string, session: string) =>
    get<SessionPayload>(`/projects/${slug}/sessions/${encodeURIComponent(session)}`),
  task: (slug: string, session: string, task: number) =>
    get<TaskPayload>(`/projects/${slug}/sessions/${encodeURIComponent(session)}/tasks/${task}`),
  round: (slug: string, session: string, round: number) =>
    get<RoundPayload>(`/projects/${slug}/sessions/${encodeURIComponent(session)}/rounds/${round}`),
  tools: (slug: string) => get<ToolsPayload>(`/projects/${slug}/tools`),
  // Reads every archived session in the project, so like `tools` it is fetched on the tab rather
  // than on the way to the page.
  trails: (slug: string) => get<TrailsPayload>(`/projects/${slug}/trails`),
  // Read from `rounds.jsonl` alone, unlike `trails`, but over every round in the project — so it
  // is fetched on the tab for the same reason.
  questions: (slug: string) => get<QuestionsPayload>(`/projects/${slug}/questions`),
  // Deliberately not folded into `round`: the bodies are the bulk of a session file, and the
  // inspector opens without paying for any of them.
  result: (slug: string, session: string, toolUseId: string) =>
    get<ResultPayload>(
      `/projects/${slug}/sessions/${encodeURIComponent(session)}/results/${encodeURIComponent(toolUseId)}`,
    ),
  // The one call in the view that runs a program on this machine: it hands one question's calls to
  // the command in `reader.json` and keeps what it answers. A POST for that reason, like `sync`.
  explain: (slug: string, session: string, task: number, at: number, again = false) =>
    post<ExplainPayload>(`/projects/${slug}/explain`, { session, task, at, again }),
  // The same text `explain` would send, for anyone who would rather paste it into a chat they
  // already have open. It runs nothing, so unlike `explain` it is a GET and needs no reader.
  prompt: (slug: string, session: string, task: number, at: number) =>
    get<PromptPayload>(
      `/projects/${slug}/prompt?session=${encodeURIComponent(session)}` +
        `&task=${String(task)}&at=${String(at)}`,
    ),
  pricing: () => get<PricingPayload>('/pricing'),
  reader: () => get<ReaderPayload>('/reader'),
  saveReader: (command: string[], timeoutMs: number) =>
    post<ReaderPayload>('/reader', { command, timeout_ms: timeoutMs }),
  savePricing: (models: Record<string, Rates>) => post<PricingPayload>('/pricing', { models }),
  import: (text: string, from: string) => post<ImportResult>('/import', { text, from }),
}
