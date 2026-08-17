/**
 * What a call mechanically did.
 *
 * `bash.ts` reads a command string down to the commands it ran. This reads a whole tool call down to
 * the *acts* it performed: opening a file, changing one, running a suite, committing. It has no
 * opinion about what kind of work any of that is — that is `classify.ts`, and keeping the two apart
 * is the point. A verb here is a fact about the call; a category there is a claim about the work.
 *
 * The separation is not cosmetic. When the prose check lived on the tool path only, `Write` on a
 * README was documentation and `cat > README.md` was implementation: the same act, filed two ways,
 * because the question was asked in two places. Here every call arrives as an `Act` carrying a verb
 * and a path, and the question gets asked once.
 *
 * Nothing here executes, resolves or validates anything. A call that cannot be read confidently
 * yields `unknown` rather than a guess, since a wrong bucket is worse than a named hole.
 */

import { commandOf, parseCommands, UNPARSED } from './bash.js'
import type { Command } from './bash.js'
import type { ToolCall } from './types.js'

/**
 * The mechanical operations a call can perform.
 *
 * Every one of these is a fact you could confirm by looking at the call. None of them names a kind
 * of work: `commit` is a commit whether you think committing is delivery or bookkeeping, and
 * `query` is "ran something that reports state" whether that reading is orientation or review.
 */
export type Verb =
  | 'read'      // opened a file, fetched a URL
  | 'search'    // located without opening — Grep, Glob, rg, find, ls
  | 'query'     // ran something that reports state — git log/status/diff, python3 -c, a script
  | 'write'     // created or changed a file, including via a shell redirect
  | 'move'      // mv, cp, rm, sed -i — changed the tree rather than a file's contents
  | 'test'      // ran a test runner
  | 'run'       // ran the project itself — node, go run, npm start
  | 'build'     // tsc, npm run build, cargo build, a linter
  | 'commit'    // git add, git commit
  | 'publish'   // git push, git tag, gh pr, gh release
  | 'branch'    // git checkout, merge, rebase, stash, reset
  | 'install'   // npm install, pip, brew, go get
  | 'env'       // ps, kill, gh auth — the machine rather than the work
  | 'infra'     // docker, kubectl, terraform, aws — the machines the code runs on
  | 'ask'       // AskUserQuestion
  | 'track'     // TodoWrite, TaskCreate, Agent
  | 'plan'      // EnterPlanMode, ExitPlanMode
  | 'noop'      // cd, echo, pipe filters, git plumbing
  | 'unknown'   // MCP servers, unparsed commands

export const VERBS: Verb[] = [
  'read', 'search', 'query', 'write', 'move', 'test', 'run', 'build',
  'commit', 'publish', 'branch', 'install', 'env', 'infra', 'ask', 'track', 'plan',
  'noop', 'unknown',
]

/** What the act was done to. Orthogonal to the verb, and derived from paths and commands. */
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

export function isTarget(value: string): value is Target {
  return (TARGETS as string[]).includes(value)
}

/** One mechanical operation. Weights within a tool call sum to 1. */
export interface Act {
  verb: Verb
  /** The file the act names, or `''` when it names none. */
  path: string
  target: Target
  /** Whether the act brought the file into existence, as opposed to changing one that was there. */
  creating: boolean
  /**
   * What produced this act: a tool name, or a command name. Kept so `analyze --unclassified` can
   * name what it could not read instead of reporting a share with nothing behind it.
   */
  source: string
  weight: number
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

/**
 * Whether a path is prose.
 *
 * This is the one path question the classifier asks that `targetOf` cannot answer, because `docs`
 * is a target and prose is a property. They almost coincide: `AUTHORS` and `NOTICE` are filed under
 * `docs` for the target axis but are not documents anyone writes as work.
 */
export function isProse(path: string): boolean {
  const lower = path.toLowerCase()
  const base = baseName(lower)
  return (
    PROSE_EXTENSIONS.has(extensionOf(base)) ||
    /(^|\/)docs?\//.test(lower) ||
    /^(readme|license|licence|changelog|contributing)($|\.)/.test(base)
  )
}

/** Which kind of document, once an act is known to be prose. */
export function documentSub(path: string): string {
  const lower = path.toLowerCase()
  const base = baseName(lower)
  if (/(^|\/)\.claude\//.test(lower) || base === 'claude.md' || base === 'agents.md') return 'agent'
  if (base.startsWith('changelog') || /(^|\/)(pr|commit)[-_.]/.test(base)) return 'change'
  return 'system'
}

// ---------------------------------------------------------------------------------------------
// Paths hiding inside shell commands
// ---------------------------------------------------------------------------------------------

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
// Writes hiding inside shell commands
// ---------------------------------------------------------------------------------------------

/** Somewhere output is being put deliberately, as opposed to being thrown away or parked. */
const SCRATCH = /^(\/dev\/null|\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\$TMPDIR)/

/**
 * A heredoc body that changes a file rather than reporting on one.
 *
 * The last alternative is a shell redirect inside the body, and it has to be anchored to a position
 * a command could start from with no quote in between. Unanchored, it matches the `>` in
 * `print("wrote > notes.md")` and files a line that reports on a file as one that wrote it.
 *
 * The anchor is not enough on its own, because the body is usually Python and `>` is also how
 * Python compares. `if len(o)>120:` starts a line, carries no quote before the `>`, and used to
 * read as a redirect — which made every script that filters on a length or a count arrive as
 * `implementation/modify` with no target, the commonest false positive in a real store. So the
 * destination has to look like a file: a `.` or a `/` in the token, which a comparison against a
 * number or a bare name does not have. That is the same question the `REDIRECT` scan below asks by
 * running its match through `targetOf`, and a bare `> Makefile` inside a heredoc is the price.
 */
const WRITE_VERB =
  /open\s*\([^)]*,\s*['"][wa]|write_text|writeFileSync|appendFileSync|\.write\s*\(|\bdump\s*\(|(^|[;&|])[^'"\n]*>>?\s*['"]?[\w-]*[./][\w./-]/m

const REDIRECT = /(^|[^0-9&>])>>?\s*(['"]?)([^\s'"|;&<>]+)\2/g

/**
 * The file a command writes to, or null when it only reads or reports.
 *
 * This is the single largest correction the real data asked for. `python3 - <<'EOF'` is the shape
 * an agent uses both to rewrite a markdown file and to print the dimensions of an image, and
 * `bash.ts` calls both of them `run` because that is what they are at the shell level. Left alone,
 * every one of them counts as running something.
 *
 * So a redirect alone is not enough: capture-to-scratch (`… > /tmp/out.txt`, `… 2>/dev/null`) is
 * everywhere, and treating it as a write would move more calls the wrong way than the rule fixes.
 * A redirect counts only when its destination is a file the target axis recognizes, and a heredoc
 * counts only when its body contains something that actually writes.
 *
 * The redirect scan runs over `scannable()` rather than the raw string, so a `>` inside a quoted
 * argument or a heredoc body is data. Without that, `python3 - <<'EOF' print("a > notes.md") EOF`
 * reports a write to `notes.md` and a print is filed as an edit.
 *
 * `sed -i` and `perl -i` are already handled: `bash.ts` reads the in-place flag and calls them
 * `edit`. They must not be handled twice.
 */
export function writesToFile(command: string): string | null {
  for (const match of scannable(command).matchAll(REDIRECT)) {
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
// Commands
// ---------------------------------------------------------------------------------------------

/** Read-only history and state. Reporting on the tree is not changing it. */
const GIT_QUERY = new Set(['log', 'status', 'diff', 'show', 'ls-files', 'blame', 'shortlog'])
const GIT_COMMIT = new Set(['add', 'commit'])
const GIT_PUBLISH = new Set(['push', 'tag'])
const GIT_BRANCH = new Set([
  'branch', 'checkout', 'switch', 'worktree', 'stash', 'merge', 'rebase', 'fetch', 'pull',
  'clone', 'init', 'reset', 'revert', 'restore', 'cherry-pick', 'mv', 'rm', 'apply', 'am',
])
/**
 * Plumbing an agent runs inside a one-liner to orient itself, not work in its own right. Counting
 * `git rev-parse --short HEAD` as an act would put shell bookkeeping next to shipping code.
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

/**
 * Which interpreters count as running the project, and which as running a script at it.
 *
 * `node x.js` is the product; `python3 p.py` is a one-off that computes an answer. The difference is
 * real and it is what separates `run` from `query`, but the signal is weak: this table encodes
 * "the project is written in the first list's languages", which holds for most repos an agent works
 * in and inverts in a Python one, where every real run would arrive as `query`. It is one table and
 * one line to flip, but it is an assumption, not a fact.
 */
const RUNS_PROJECT = new Set([
  'node', 'bun', 'deno', 'ts-node', 'tsx',
  'go run', 'cargo run', 'npm start', 'pnpm start', 'yarn start',
])

function gitVerb(sub: string): Verb {
  if (GIT_QUERY.has(sub)) return 'query'
  if (GIT_PLUMBING.has(sub)) return 'noop'
  if (GIT_COMMIT.has(sub)) return 'commit'
  if (GIT_PUBLISH.has(sub)) return 'publish'
  return 'branch'
}

function ghVerb(sub: string): Verb {
  // `gh pr create` and `gh pr view` both come back as `gh pr`: `nameSegment` only reaches a third
  // token for `run` and `exec`. Shipping is the commoner of the two and 44 calls does not justify
  // changing a parser whose output users filter on.
  if (sub === 'run') return 'query'
  if (sub === 'pr' || sub === 'release') return 'publish'
  if (sub === 'repo') return 'branch'
  if (sub === 'auth') return 'env'
  return 'query'
}

/** What one command inside a Bash call did. */
function verbOf(command: Command, writes: string | null, piped: boolean): Verb {
  const [head, sub] = command.name.split(' ')

  if (head === 'git' || head === 'jj') return gitVerb(sub ?? '')
  if (head === 'gh') return ghVerb(sub ?? '')
  if (piped && STREAM_FILTERS.has(command.name)) return 'noop'

  switch (command.kind) {
    case 'search':
      return 'search'
    case 'read':
      // A reader with a redirect into a real file is a writer. `cat > notes.md` is not reading.
      return writes === null ? 'read' : 'write'
    case 'edit':
      return 'move'
    case 'test':
      return 'test'
    case 'build':
      return 'build'
    case 'deps':
      return 'install'
    case 'infra':
      return 'infra'
    case 'run':
      if (writes !== null) return 'write'
      return RUNS_PROJECT.has(command.name) ? 'run' : 'query'
    case 'net':
      return 'read'
    case 'proc':
      return 'env'
    case 'nav':
    case 'shell':
      return 'noop'
    case 'vcs':
      return 'branch'
    default:
      return 'unknown'
  }
}

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

const TOOL_VERBS: Record<string, Verb> = {
  AskUserQuestion: 'ask',
  TaskCreate: 'track',
  TaskUpdate: 'track',
  TodoWrite: 'track',
  Agent: 'track',
  Task: 'track',
  EnterPlanMode: 'plan',
  ExitPlanMode: 'plan',
  Read: 'read',
  Grep: 'search',
  Glob: 'search',
  Write: 'write',
  Edit: 'write',
  MultiEdit: 'write',
  NotebookEdit: 'write',
  WebSearch: 'read',
  WebFetch: 'read',
}

/** Tools whose target is the query, not a file, however path-shaped their input looks. */
const TARGETLESS = new Set(['Grep', 'Glob', 'AskUserQuestion', 'TaskCreate', 'TaskUpdate',
  'TodoWrite', 'Agent', 'Task', 'EnterPlanMode', 'ExitPlanMode'])

function act(verb: Verb, path: string, source: string, creating = false): Act {
  return { verb, path, target: targetOf(path), creating, source, weight: 1 }
}

/** Everything a single tool call mechanically did, with weights summing to 1. */
export function actsOf(tool: ToolCall): Act[] {
  const name = typeof tool.name === 'string' ? tool.name : ''
  if (name === '') return [act('unknown', '', '(unnamed)')]
  if (name === 'Bash') return bashActs(tool)

  const verb = TOOL_VERBS[name]
  // MCP servers and harness tools. Their inputs are per-server and unknowable to a built-in table,
  // so they are named rather than guessed at. `analyze --unclassified` lists them.
  if (verb === undefined) return [act('unknown', '', name)]

  const path = TARGETLESS.has(name) ? '' : pathOf(tool.input)
  const external = name === 'WebSearch' || name === 'WebFetch'
  const one = act(verb, path, name, name === 'Write')
  if (external) one.target = 'external'
  return [one]
}

/**
 * A `Bash` call, split across the commands it ran.
 *
 * Scaffolding is dropped rather than counted. `echo` is the most frequent command in a real store
 * and `cd` is close behind, almost entirely as `echo ---` separators and `cd /repo &&` prefixes,
 * and nearly half of all Bash calls mix them with real work. Splitting a call evenly across
 * everything it ran charges half of `cd /repo && npm test` to navigation, which is how a tenth of a
 * store ends up filed under moving around in it. A call counts as `noop` only when there is nothing
 * else in it.
 */
function bashActs(tool: ToolCall): Act[] {
  const raw = commandOf(tool.input)
  const text = typeof raw === 'string' ? raw : ''
  const writes = text === '' ? null : writesToFile(text)
  const commands = parseCommands(raw)

  if (commands.length === 0) return [act('unknown', '', UNPARSED)]

  // A write names its own destination. Otherwise the call's first recognizable path stands for what
  // the call was about, which is right for the shapes that dominate: one file read, one tree
  // searched, one suite run.
  const words = new Set(commands.flatMap((command) => command.name.split(' ')))
  const named = writes !== null && writes !== '' ? writes : (pathsIn(text, words)[0] ?? '')

  // A pipe means whatever follows it is looking at output, not opening a file.
  const piped = text.includes('|')
  const all = commands.map((command) => act(verbOf(command, writes, piped), named, command.name))

  const real = all.filter((one) => one.verb !== 'noop')
  const kept = real.length > 0 ? real : all.slice(0, 1)
  const share = 1 / kept.length
  for (const one of kept) one.weight = share
  return kept
}
