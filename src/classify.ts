/**
 * What kind of work a round did.
 *
 * `bash.ts` reads a command string down to the commands it ran. This reads a whole round down to
 * the *work* it was: reconstructing context, writing code, verifying it, shipping it. Nothing here
 * executes or resolves anything, and nothing here calls a model. Every label is a rule over the
 * tool name, the tool input, and where the call sits in its task.
 *
 * Three rules keep the taxonomy honest, and every table below follows them:
 *
 * 1. A category is the shape of the act. The target is what the act was done to. "Read the README"
 *    and "read the router" are the same cell, `reconstruction/read`, and differ only in target.
 * 2. Reading is never writing.
 * 3. Some work is only visible in its neighbourhood. A `git diff` after an edit is review; the same
 *    command before any edit is reconstruction. Ordering is evidence, and it is the only kind of
 *    evidence here that looks outside the call itself.
 *
 * What is deliberately absent is as load-bearing as what is here. There is no `repair` category:
 * `is_error` is a harness-level flag, so a Bash call running a suite with 47 failures comes back
 * `is_error: false`, and the store keeps no exit code to tell the difference. There is no `trace`
 * sub-kind: it would mean "this file was opened because of a symbol found in that one", which needs
 * result bodies the store does not keep. Both would have been buckets that only ever looked full.
 */

import { commandOf, parseCommands, UNPARSED } from './bash.js'
import type { Command } from './bash.js'
import type { Round, ToolCall } from './types.js'

export type Category =
  | 'planning'
  | 'reconstruction'
  | 'implementation'
  | 'verification'
  | 'review'
  | 'documentation'
  | 'delivery'
  | 'environment'
  | 'unclassified'

/** What the act was done to. Orthogonal to the category, and derived from paths and commands. */
export type Target =
  | 'code'
  | 'tests'
  | 'docs'
  | 'config'
  | 'infra'
  | 'agent'
  | 'external'
  | 'unknown'

export const TARGETS: Target[] = [
  'code',
  'tests',
  'docs',
  'config',
  'infra',
  'agent',
  'external',
  'unknown',
]

export interface CategoryInfo {
  id: Category
  /** How the category is written in a table. */
  label: string
  /** How it is written where a column is too narrow for the label. */
  short: string
  /** Every sub-kind the tables below can produce, in the order they are worth reading. */
  subs: string[]
}

/**
 * The categories, in the order work tends to happen.
 *
 * Two of them are small for a reason worth stating rather than hiding. `planning` and `environment`
 * both sit near 1% of a real store, because the only planning a tool log can see is the
 * harness transitions around it: a plan being submitted, a question being asked, a task being
 * opened. The deliberation itself happens in rounds that call no tool at all, and those rounds are
 * excluded from the denominator rather than guessed at. Planning is not rare. It is invisible to
 * this instrument, and the number should be read that way.
 */
export const CATEGORIES: CategoryInfo[] = [
  { id: 'planning', label: 'Planning', short: 'Plan', subs: ['clarify', 'decompose', 'design'] },
  {
    id: 'reconstruction',
    label: 'Reconstruction',
    short: 'Recon',
    subs: ['locate', 'read', 'inspect'],
  },
  {
    id: 'implementation',
    label: 'Implementation',
    short: 'Impl',
    subs: ['create', 'modify', 'refactor'],
  },
  { id: 'verification', label: 'Verification', short: 'Verif', subs: ['test', 'build', 'run'] },
  { id: 'review', label: 'Review', short: 'Review', subs: ['diff', 'read-back'] },
  { id: 'documentation', label: 'Documentation', short: 'Docs', subs: ['system', 'change', 'agent'] },
  { id: 'delivery', label: 'Delivery', short: 'Deliv', subs: ['commit', 'publish', 'branch'] },
  { id: 'environment', label: 'Environment', short: 'Env', subs: ['deps', 'env'] },
  {
    id: 'unclassified',
    label: 'Unclassified',
    short: 'Uncl',
    subs: ['incidental', 'unknown'],
  },
]

const CATEGORY_IDS: Category[] = CATEGORIES.map((info) => info.id)

export function categoryInfo(id: Category): CategoryInfo {
  // Every id in the type has a row, so this is a lookup rather than a search that can fail.
  return CATEGORIES.find((info) => info.id === id) as CategoryInfo
}

export function isCategory(value: string): value is Category {
  return (CATEGORY_IDS as string[]).includes(value)
}

export function isTarget(value: string): value is Target {
  return (TARGETS as string[]).includes(value)
}

/** One labelled unit of work. Weights within a round sum to 1, or to 0 when nothing ran. */
export interface Label {
  category: Category
  sub: string
  target: Target
  weight: number
  /**
   * What produced this label: a tool name, or a command name. Kept so `analyze --unclassified` can
   * name what it could not classify instead of reporting a share with nothing behind it.
   */
  source: string
}

/**
 * What the classifier knows about a call beyond the call itself.
 *
 * Only what rule 3 needs, and it is built in one forward pass per task: the paths already edited,
 * and whether anything has been edited at all. Both answer "is this call looking at work that has
 * already happened", which is what separates reviewing from orienting.
 */
export interface CallContext {
  edited: boolean
  editedPaths: Set<string>
}

export function newContext(): CallContext {
  return { edited: false, editedPaths: new Set() }
}

// ---------------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------------

const SOURCE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'm', 'mm',
  'php', 'ex', 'exs', 'erl', 'clj', 'hs', 'lua', 'dart', 'sql',
  'vue', 'svelte', 'css', 'scss', 'sass', 'less', 'html',
  'sh', 'bash', 'zsh', 'fish',
])

const PROSE_EXTENSIONS = new Set(['md', 'mdx', 'rst', 'adoc', 'org'])

const CONFIG_NAMES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  'pnpm-workspace.yaml', 'turbo.json', 'go.mod', 'go.sum', 'cargo.toml', 'cargo.lock',
  'pyproject.toml', 'requirements.txt', 'gemfile', 'makefile', 'justfile',
  '.gitignore', '.npmrc', '.nvmrc', '.editorconfig', '.prettierrc', '.prettierignore',
])

const INFRA_NAMES = new Set(['dockerfile', 'docker-compose.yml', 'docker-compose.yaml'])

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function baseName(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const cut = trimmed.lastIndexOf('/')
  return cut === -1 ? trimmed : trimmed.slice(cut + 1)
}

/**
 * Directories that say what they hold.
 *
 * A search is usually pointed at a tree rather than a file, and `grep -rn flush src` is exactly the
 * operation the target axis exists to describe. Without this the commonest shape in the store
 * arrives with no target at all.
 */
const DIRECTORY_TARGETS: Record<string, Target> = {
  src: 'code', lib: 'code', app: 'code', apps: 'code', pkg: 'code', packages: 'code',
  cmd: 'code', internal: 'code', components: 'code', server: 'code', client: 'code',
  test: 'tests', tests: 'tests', spec: 'tests', e2e: 'tests', __tests__: 'tests',
  doc: 'docs', docs: 'docs', vault: 'docs',
  k8s: 'infra', kubernetes: 'infra', helm: 'infra', terraform: 'infra', deploy: 'infra',
}

/**
 * What a path is, for the target axis.
 *
 * Order is the whole design here. `tests` is decided before `code` and before `config`, or
 * `gates.test.ts` reads as source and `vitest.config.ts` reads as configuration when both are
 * really the test surface. Paths in the store are absolute and some of them point outside the
 * project entirely, which is what `agent` is for: a plan file or a memory note under the agent's
 * own directory is neither the project's code nor its documentation, and folding it into either
 * would quietly inflate that number.
 */
export function targetOf(path: string): Target {
  if (path === '') return 'unknown'
  // Go spells "and everything under here" as a trailing `/...`, which is a recursion marker rather
  // than a path element. Left on, it hides the directory that says what was being worked on.
  const lower = path.toLowerCase().replace(/\/\.\.\.$/, '')
  const base = baseName(lower)
  const extension = extensionOf(base)

  if (/(^|\/)\.claude\//.test(lower)) return 'agent'
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(lower)) return 'external'

  if (
    /\.(test|spec)\.[a-z]+$/.test(base) ||
    /_test\.[a-z]+$/.test(base) ||
    /(^|\/)(tests?|__tests__|spec|e2e)\//.test(lower)
  ) {
    return 'tests'
  }

  if (
    PROSE_EXTENSIONS.has(extension) ||
    /(^|\/)docs?\//.test(lower) ||
    /^(readme|license|licence|changelog|contributing|authors|notice)($|\.)/.test(base)
  ) {
    return 'docs'
  }

  if (
    INFRA_NAMES.has(base) ||
    base.startsWith('dockerfile') ||
    extension === 'tf' ||
    extension === 'tfvars' ||
    /(^|\/)\.github\/workflows\//.test(lower) ||
    /(^|\/)(k8s|kubernetes|helm|terraform|deploy)\//.test(lower)
  ) {
    return 'infra'
  }

  if (
    CONFIG_NAMES.has(base) ||
    base.startsWith('tsconfig') ||
    base.startsWith('.env') ||
    /\.config\.[a-z]+$/.test(base) ||
    /^(eslint|prettier|biome|vitest|jest|babel|rollup|webpack|vite)\./.test(base) ||
    // A dotfile is a dot followed by a name. `./...` and `..` are neither.
    (/^\.[a-z0-9]/.test(base) && extension === '')
  ) {
    return 'config'
  }

  if (SOURCE_EXTENSIONS.has(extension)) return 'code'
  // No extension left to read, so the last thing the path names is a directory.
  if (extension === '') {
    const named = DIRECTORY_TARGETS[base]
    if (named !== undefined) return named
  }
  return 'unknown'
}

/** Whether a path is prose, which is what separates documentation from implementation. */
function isProse(path: string): boolean {
  const base = baseName(path.toLowerCase())
  return (
    PROSE_EXTENSIONS.has(extensionOf(base)) ||
    /(^|\/)docs?\//.test(path.toLowerCase()) ||
    /^(readme|license|licence|changelog|contributing)($|\.)/.test(base)
  )
}

/** Which kind of document, once a write is known to be prose. */
function documentSub(path: string): string {
  const lower = path.toLowerCase()
  const base = baseName(lower)
  if (/(^|\/)\.claude\//.test(lower) || base === 'claude.md' || base === 'agents.md') return 'agent'
  if (base.startsWith('changelog') || /(^|\/)(pr|commit)[-_.]/.test(base)) return 'change'
  return 'system'
}

/**
 * The part of a command worth reading paths out of.
 *
 * Quoted runs come out first, because they are where the text that only looks like a path lives: a
 * commit message naming `README.md`, a grep pattern, a `sed` script. A heredoc body goes the same
 * way, since it is data rather than an argument list. What is left is the argument list itself.
 */
function scannable(command: string): string {
  const heredoc = command.indexOf('<<')
  const head = heredoc === -1 ? command : command.slice(0, heredoc)
  return head.replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ')
}

/** Flags whose value is prose, not a path. */
const MESSAGE_FLAGS = new Set(['-m', '--message', '-c', '--comment', '-b', '--body', '-e'])

/**
 * The files a command names.
 *
 * Without this the target axis goes dark for every `Bash` call, which is over half of a real store:
 * `cat README.md` and `head src/loop.ts` are the same operation on very different things, and that
 * difference is the whole point of having a target. A token counts only when the target table
 * already recognizes it, so an unreadable argument stays out rather than arriving as a guess.
 */
export function pathsIn(command: string, exclude: Set<string> = new Set()): string[] {
  const out: string[] = []
  const tokens = scannable(command).split(/\s+/)
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? ''
    if (MESSAGE_FLAGS.has(token)) {
      i += 1
      continue
    }
    const cleaned = token.replace(/^[('"]+|[)'",;]+$/g, '')
    if (cleaned === '' || cleaned.startsWith('-')) continue
    if (/[*?$`(){}<>|&!]/.test(cleaned)) continue
    // A bare word is only a path when it is a directory the table already knows, or it would take
    // every argument for one. `grep -rn flush src` names a tree; `grep -rn flush` names a pattern.
    const bare = !cleaned.includes('.') && !cleaned.includes('/')
    if (bare && DIRECTORY_TARGETS[cleaned.toLowerCase()] === undefined) continue
    // A program and its subcommand are not paths, however much `go test` looks like a directory
    // called `test`. The command parser has already named them, so they are known here.
    if (exclude.has(cleaned)) continue
    if (targetOf(cleaned) !== 'unknown') out.push(cleaned)
  }
  return out
}

/** The path a tool call names, for the tools that name one. */
export function pathOf(input: unknown): string {
  if (input === null || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  for (const key of ['file_path', 'notebook_path', 'path', 'url']) {
    const found = record[key]
    if (typeof found === 'string' && found !== '') return found
  }
  return ''
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

/** Read-only history and state. What it means depends on whether an edit has happened yet. */
const GIT_INSPECT = new Set(['log', 'status', 'diff', 'show', 'ls-files', 'blame', 'shortlog'])
const GIT_COMMIT = new Set(['add', 'commit'])
const GIT_PUBLISH = new Set(['push', 'tag'])
const GIT_BRANCH = new Set([
  'branch', 'checkout', 'switch', 'worktree', 'stash', 'merge', 'rebase', 'fetch', 'pull',
  'clone', 'init', 'reset', 'revert', 'restore', 'cherry-pick', 'mv', 'rm', 'apply', 'am',
])
/**
 * Plumbing an agent runs inside a one-liner to orient itself, not work in its own right. Counting
 * `git rev-parse --short HEAD` as delivery would put shell bookkeeping next to shipping code.
 */
const GIT_PLUMBING = new Set([
  'rev-parse', 'merge-base', 'for-each-ref', 'cat-file', 'rev-list', 'ls-tree', 'ls-remote',
  'describe', 'config', 'symbolic-ref', 'update-index', 'check-ignore', 'check-attr', 'reflog',
  'bundle', 'remote', 'var', 'hash-object', 'diff-tree', 'name-rev',
])

/**
 * Programs that read a stream rather than a file.
 *
 * `pnpm test 2>&1 | tail -25` is one act, running the tests, and the `tail` on the end is how the
 * output was looked at rather than a second thing that happened. Downstream of a pipe these are
 * scaffolding, the same as `cd` and `echo`. On their own, `tail -50 src/loop.ts` really is reading
 * a file, so the pipe is what decides it.
 */
const STREAM_FILTERS = new Set([
  'head', 'tail', 'wc', 'less', 'more', 'sort', 'uniq', 'cut', 'tr', 'column', 'jq', 'yq',
  'awk', 'comm', 'paste', 'od', 'xxd',
])

function gitLabel(sub: string, ctx: CallContext): [Category, string] {
  if (GIT_INSPECT.has(sub)) {
    // Rule 3. Looking at a diff after changing something is review; before, it is orientation.
    return ctx.edited ? ['review', 'diff'] : ['reconstruction', 'inspect']
  }
  if (GIT_PLUMBING.has(sub)) return ['unclassified', 'incidental']
  if (GIT_COMMIT.has(sub)) return ['delivery', 'commit']
  if (GIT_PUBLISH.has(sub)) return ['delivery', 'publish']
  if (GIT_BRANCH.has(sub)) return ['delivery', 'branch']
  return ['delivery', 'branch']
}

function ghLabel(sub: string, ctx: CallContext): [Category, string] {
  // `gh pr create` and `gh pr view` both come back as `gh pr`: `nameSegment` only reaches a third
  // token for `run` and `exec`. Shipping is the commoner of the two and 44 calls does not justify
  // changing a parser whose output users filter on.
  if (sub === 'run') return ctx.edited ? ['review', 'diff'] : ['reconstruction', 'inspect']
  if (sub === 'pr' || sub === 'release') return ['delivery', 'publish']
  if (sub === 'repo') return ['delivery', 'branch']
  if (sub === 'auth') return ['environment', 'env']
  return ['reconstruction', 'inspect']
}

function commandLabel(
  command: Command,
  ctx: CallContext,
  writes: string | null,
  piped: boolean,
): [Category, string] {
  const [head, sub] = command.name.split(' ')

  if (head === 'git' || head === 'jj') return gitLabel(sub ?? '', ctx)
  if (head === 'gh') return ghLabel(sub ?? '', ctx)
  if (piped && STREAM_FILTERS.has(command.name)) return ['unclassified', 'incidental']

  switch (command.kind) {
    case 'search':
      return ['reconstruction', 'locate']
    case 'read':
      // A reader with a redirect into a real file is a writer. `cat > notes.md` is not reading.
      return writes === null ? ['reconstruction', 'read'] : ['implementation', 'modify']
    case 'edit':
      // Moving, copying and removing files is restructuring, which is what `refactor` names. The
      // `Edit` tool covers changing what is inside one.
      return ['implementation', 'refactor']
    case 'test':
      return ['verification', 'test']
    case 'build':
      return ['verification', 'build']
    case 'deps':
      return ['environment', 'deps']
    case 'run':
      return writes === null ? ['verification', 'run'] : ['implementation', 'modify']
    case 'net':
      return ['reconstruction', 'read']
    case 'proc':
      return ['environment', 'env']
    case 'nav':
    case 'shell':
      return ['unclassified', 'incidental']
    case 'vcs':
      return ['delivery', 'branch']
    default:
      return ['unclassified', 'unknown']
  }
}

// ---------------------------------------------------------------------------------------------
// Writes hiding inside shell commands
// ---------------------------------------------------------------------------------------------

/** Somewhere output is being put deliberately, as opposed to being thrown away or parked. */
const SCRATCH = /^(\/dev\/null|\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\$TMPDIR)/

/** A heredoc body that changes a file rather than reporting on one. */
const WRITE_VERB =
  /open\s*\([^)]*,\s*['"][wa]|write_text|writeFileSync|appendFileSync|\.write\s*\(|\bdump\s*\(|>>?\s*['"]?[\w./-]/

const REDIRECT = /(^|[^0-9&>])>>?\s*(['"]?)([^\s'"|;&<>]+)\2/g

/**
 * The file a command writes to, or null when it only reads or reports.
 *
 * This is the single largest correction the real data asked for. `python3 - <<'EOF'` is the shape
 * an agent uses both to rewrite a markdown file and to print the dimensions of an image, and
 * `bash.ts` calls both of them `run` because that is what they are at the shell level. Left alone,
 * every one of them counts as verification.
 *
 * So a redirect alone is not enough: capture-to-scratch (`… > /tmp/out.txt`, `… 2>/dev/null`) is
 * everywhere, and treating it as a write would move more calls the wrong way than the rule fixes.
 * A redirect counts only when its destination is a file the target axis recognizes, and a heredoc
 * counts only when its body contains something that actually writes.
 *
 * `sed -i` and `perl -i` are already handled: `bash.ts` reads the in-place flag and calls them
 * `edit`. They must not be handled twice.
 */
export function writesToFile(command: string): string | null {
  for (const match of command.matchAll(REDIRECT)) {
    const path = match[3] ?? ''
    if (path === '' || SCRATCH.test(path) || path.startsWith('&')) continue
    if (targetOf(path) !== 'unknown') return path
  }

  if (!command.includes('<<')) return null
  if (!WRITE_VERB.test(command)) return null
  // The path is usually a quoted literal in the body. Report the write either way: the verb is the
  // evidence, and an unresolved target is better than a missed reclassification.
  for (const match of command.matchAll(/['"]([\w./-]+\.[a-z]{1,5})['"]/gi)) {
    const path = match[1] ?? ''
    if (!SCRATCH.test(path) && targetOf(path) !== 'unknown') return path
  }
  return ''
}

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

const PLANNING_TOOLS: Record<string, string> = {
  AskUserQuestion: 'clarify',
  TaskCreate: 'decompose',
  TaskUpdate: 'decompose',
  TodoWrite: 'decompose',
  Agent: 'decompose',
  Task: 'decompose',
  EnterPlanMode: 'design',
  ExitPlanMode: 'design',
}

/** A write, and whether it created the file or changed one that was there. */
function writeLabel(tool: ToolCall, path: string, creating: boolean): [Category, string] {
  if (isProse(path)) return ['documentation', documentSub(path)]
  if (creating) return ['implementation', 'create']
  // A replace-all edit is a rename or a sweep across the file, which is restructuring rather than
  // a change of behaviour, and it is the one refactor signal the input actually carries.
  const input = tool.input as Record<string, unknown> | null
  if (input !== null && typeof input === 'object' && input.replace_all === true) {
    return ['implementation', 'refactor']
  }
  return ['implementation', 'modify']
}

/** Everything a single tool call was, with weights summing to 1. */
export function classifyCall(tool: ToolCall, ctx: CallContext): Label[] {
  const name = typeof tool.name === 'string' ? tool.name : ''
  if (name === '') return [{ category: 'unclassified', sub: 'unknown', target: 'unknown', weight: 1, source: '(unnamed)' }]

  if (name === 'Bash') return splitCall(tool, ctx)

  const path = pathOf(tool.input)
  const target = path === '' ? 'unknown' : targetOf(path)
  const one = (category: Category, sub: string, at: Target = target): Label[] => [
    { category, sub, target: at, weight: 1, source: name },
  ]

  const planning = PLANNING_TOOLS[name]
  if (planning !== undefined) return one('planning', planning, 'unknown')

  switch (name) {
    case 'Read':
      // Re-opening a file you have already changed is checking your own work.
      return ctx.editedPaths.has(path)
        ? one('review', 'read-back')
        : one('reconstruction', 'read')
    case 'Grep':
    case 'Glob':
      return one('reconstruction', 'locate', 'unknown')
    case 'Write': {
      const [category, sub] = writeLabel(tool, path, true)
      return one(category, sub)
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const [category, sub] = writeLabel(tool, path, false)
      return one(category, sub)
    }
    case 'WebSearch':
    case 'WebFetch':
      return one('reconstruction', 'read', 'external')
    default:
      // MCP servers and harness tools. Their inputs are per-server and unknowable to a built-in
      // table, so they are named rather than guessed at. `analyze --unclassified` lists them.
      return one('unclassified', 'unknown', 'unknown')
  }
}

/**
 * A `Bash` call, split across the commands it ran.
 *
 * Scaffolding is dropped rather than counted. `echo` is the most frequent command in a real store
 * and `cd` is close behind, almost entirely as `echo ---` separators and `cd /repo &&` prefixes,
 * and nearly half of all Bash calls mix them with real work. Splitting a call evenly across
 * everything it ran charges half of `cd /repo && npm test` to navigation, which is how a tenth of a
 * store ends up filed under moving around in it. A call counts as incidental only when there is
 * nothing else in it.
 */
function splitCall(tool: ToolCall, ctx: CallContext): Label[] {
  const raw = commandOf(tool.input)
  const text = typeof raw === 'string' ? raw : ''
  const writes = text === '' ? null : writesToFile(text)
  const commands = parseCommands(raw)

  if (commands.length === 0) {
    return [
      { category: 'unclassified', sub: 'unknown', target: 'unknown', weight: 1, source: UNPARSED },
    ]
  }

  // A write names its own destination. Otherwise the call's first recognizable path stands for what
  // the call was about, which is right for the shapes that dominate: one file read, one tree
  // searched, one suite run.
  const words = new Set(commands.flatMap((command) => command.name.split(' ')))
  const named = writes !== null && writes !== '' ? writes : (pathsIn(text, words)[0] ?? '')
  const target: Target = named === '' ? 'unknown' : targetOf(named)

  // A pipe means whatever follows it is looking at output, not opening a file.
  const piped = text.includes('|')
  const labelled = commands.map((command) => {
    const [category, sub] = commandLabel(command, ctx, writes, piped)
    return { category, sub, target, weight: 0, source: command.name }
  })

  const real = labelled.filter((label) => label.sub !== 'incidental')
  const kept = real.length > 0 ? real : labelled.slice(0, 1)
  const share = 1 / kept.length
  for (const label of kept) label.weight = share
  return kept
}

// ---------------------------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------------------------

/**
 * One round, as the work it did. Weights sum to 1, or to 0 for a round that called no tool.
 *
 * A round of pure prose gets no label at all rather than a guessed one. Roughly one round in
 * eleven is exactly that, and it is where planning, explaining and summarising all live together
 * with no way to tell them apart: the store keeps assistant text but no reasoning, and
 * `thinking_chars` is zero throughout. Counting them all as planning would triple that category on
 * an assumption. They are excluded from the denominator and reported instead, so a share is always
 * a share of rounds that did something a tool can see.
 */
export function classifyRound(round: Round, ctx: CallContext): Label[] {
  const tools = round.tools ?? []
  if (tools.length === 0) return []

  const out: Label[] = []
  const perCall = 1 / tools.length
  for (const tool of tools) {
    for (const label of classifyCall(tool, ctx)) {
      out.push({ ...label, weight: label.weight * perCall })
    }
    advance(tool, ctx)
  }
  return out
}

/**
 * Fold one call into the context the next call sees.
 *
 * Done after the call is classified, never before, or a `git diff` would review an edit that had
 * not happened yet and a `Read` would check work it was actually about to do.
 */
export function advance(tool: ToolCall, ctx: CallContext): void {
  const name = typeof tool.name === 'string' ? tool.name : ''
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') {
    const path = pathOf(tool.input)
    if (path !== '') ctx.editedPaths.add(path)
    ctx.edited = true
    return
  }
  if (name === 'Bash') {
    const raw = commandOf(tool.input)
    const text = typeof raw === 'string' ? raw : ''
    if (text !== '' && writesToFile(text) !== null) {
      ctx.edited = true
      return
    }
    for (const command of parseCommands(raw)) {
      if (command.kind === 'edit') {
        ctx.edited = true
        return
      }
    }
  }
}

/**
 * Every round in order, labelled, with the task context carried along and reset at each task
 * boundary. A task is one user turn and everything it led to, so it is the span over which "has
 * anything been edited yet" is the question rule 3 is asking.
 */
export function classifyRounds(rounds: Round[]): Map<string, Label[]> {
  const out = new Map<string, Label[]>()
  const contexts = new Map<string, CallContext>()
  for (const round of rounds) {
    const key = `${round.session}\0${round.task}`
    let ctx = contexts.get(key)
    if (ctx === undefined) {
      ctx = newContext()
      contexts.set(key, ctx)
    }
    out.set(`${round.session}\0${round.round}`, classifyRound(round, ctx))
  }
  return out
}
