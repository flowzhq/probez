/**
 * What a `Bash` call actually ran.
 *
 * Every other tool is its own operation: a `Read` reads, an `Edit` edits. `Bash` is one name over
 * an entire operating system, so tallying it by tool name says nothing. This turns the command
 * string into the commands it runs, and each command into a kind of work.
 *
 * Nothing here executes, resolves or validates anything. It is a reader of shell syntax, and it is
 * deliberately shallow: a command line that cannot be read confidently yields nothing rather than a
 * guess, since a wrong bucket is worse than a missing one.
 */

import type { ToolCall } from './types.js'

/** The kind of work a command does. `other` means "not in the table", not "unclassifiable". */
export type CommandKind =
  | 'search'
  /**
   * Asked a model of the code rather than the files: a code-graph or code-query tool.
   *
   * Kept apart from `search` because it is the same question answered a different way, and the
   * whole point of measuring it is to see one displace the other. It is still finding out about a
   * repository, so it stays inside Reconstruction rather than beside it — a tool that pulled its
   * own usage out into a category of its own would make Reconstruction fall the moment anybody
   * installed it, which is the one number it exists to move.
   */
  | 'graph'
  | 'read'
  | 'edit'
  | 'vcs'
  | 'test'
  | 'build'
  | 'deps'
  | 'infra'
  | 'run'
  | 'net'
  | 'proc'
  | 'nav'
  | 'shell'
  | 'other'

export const COMMAND_KINDS: CommandKind[] = [
  'search',
  'graph',
  'read',
  'edit',
  'vcs',
  'test',
  'build',
  'deps',
  'infra',
  'run',
  'net',
  'proc',
  'nav',
  'shell',
  'other',
]

export interface Command {
  /** The command as it is worth counting: `grep`, or `git commit` for a multiplexer. */
  name: string
  kind: CommandKind
}

/** The name given to a Bash call whose command string yielded nothing readable. */
export const UNPARSED = '(unparsed)'

/**
 * Container, cluster and cloud tooling.
 *
 * These are multiplexers too, but they are listed apart because they are the one family where the
 * subcommand does not change the kind. `kubectl get` reports on a cluster and `kubectl apply`
 * changes one; `terraform plan` and `terraform apply` are the same pair. Both halves are work on
 * the machines the code runs on rather than on the code, so both are `infra`, and the alternative —
 * a sub-table per CLI, guessing which verbs of thirty clouds are reads and which are writes — buys
 * a distinction nothing downstream asks for. Before this existed they all landed in `other`, which
 * is where a tool nothing recognized lands, and a named 1% is worth more than an unnamed one.
 */
const INFRA = new Set([
  'docker', 'docker-compose', 'podman',
  'kubectl', 'helm', 'kustomize', 'minikube', 'skaffold', 'argocd', 'eksctl',
  'terraform', 'terragrunt', 'tofu', 'pulumi', 'ansible', 'vagrant', 'nomad', 'consul', 'vault',
  'aws', 'gcloud', 'gsutil', 'az', 'doctl',
  'heroku', 'flyctl', 'vercel', 'netlify', 'railway', 'wrangler', 'supabase', 'firebase',
  'systemctl', 'launchctl',
])

/**
 * Programs whose first argument is the real operation. `git` alone merges reading history with
 * committing; `git log` and `git commit` are different work and belong in different rows.
 */
const MULTIPLEXERS = new Set([
  'git', 'gh', 'jj',
  'npm', 'pnpm', 'yarn', 'npx', 'bun', 'deno',
  'cargo', 'go', 'make',
  'brew', 'pip', 'pip3', 'uv', 'poetry',
  ...INFRA,
])

/** Where an unrecognized subcommand of a multiplexer lands. `INFRA` is answered before this. */
const MULTIPLEXER_KIND: Record<string, CommandKind> = {
  git: 'vcs', gh: 'vcs', jj: 'vcs',
  npm: 'build', pnpm: 'build', yarn: 'build', npx: 'build', bun: 'build', deno: 'build',
  cargo: 'build', go: 'build', make: 'build',
  brew: 'deps', pip: 'deps', pip3: 'deps', uv: 'deps', poetry: 'deps',
}

/**
 * Flags that swallow the token after them. Without this, `pnpm --filter @scope/pkg test` names
 * itself after the package rather than after the script it ran.
 */
const FLAGS_WITH_VALUES = new Set([
  '--filter', '-F', '-C', '--prefix', '--cwd', '-w', '--workspace', '-c', '--config', '--chdir',
])

/** Commands that wrap another command and say nothing themselves. */
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'exec', 'command', 'builtin', 'xargs'])

/**
 * Shells that are a wrapper when they are handed a script, and a command when they are not.
 *
 * `bash bin/check graph` and `./bin/check graph` are the same work, and before this they were counted
 * as two different things: the first as `bash`, the second as `q`. Reading through to the script
 * makes them agree, and makes them agree at the script — which is the part that says what was
 * actually done.
 *
 * Not stripped when what follows is a flag. `bash -c "…"` runs a command inside a string this
 * reader does not open, and `bash` on its own started a shell; both are still `bash`.
 */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'ksh', 'dash'])

/** Shell keywords that may lead a segment; what follows them is the command. */
const LEADING_KEYWORDS = new Set(['do', 'then', 'else'])

/** Shell keywords that are not commands at all. */
const KEYWORDS = new Set([
  'for', 'while', 'until', 'if', 'elif', 'fi', 'done', 'case', 'esac', 'in', 'select', 'function',
])

const KIND_BY_NAME: Record<string, CommandKind> = {
  // search
  grep: 'search', egrep: 'search', fgrep: 'search', rg: 'search', ag: 'search', ack: 'search',
  find: 'search', fd: 'search', ls: 'search', tree: 'search', which: 'search', locate: 'search',
  'git grep': 'search',

  // graph: code-query tools, which answer about the code rather than about the files. Only names
  // general enough to mean the same thing on anyone's machine belong here; a repository's own
  // script is named in `<data-dir>/commands.json` instead. See `readCommandKinds`.
  codeql: 'graph', semgrep: 'graph', comby: 'graph', 'ast-grep': 'graph', 'sg': 'graph',

  // read
  cat: 'read', head: 'read', tail: 'read', wc: 'read', less: 'read', more: 'read', jq: 'read',
  yq: 'read', diff: 'read', stat: 'read', file: 'read', du: 'read', df: 'read', od: 'read',
  xxd: 'read', gzcat: 'read', zcat: 'read', column: 'read', sort: 'read', uniq: 'read',
  awk: 'read', cut: 'read', tr: 'read', base64: 'read', sqlite3: 'read', open: 'read',
  comm: 'read', paste: 'read',

  // edit
  mv: 'edit', cp: 'edit', rm: 'edit', rmdir: 'edit', mkdir: 'edit', touch: 'edit', chmod: 'edit',
  chown: 'edit', ln: 'edit', tee: 'edit', patch: 'edit', truncate: 'edit', tar: 'edit',
  unzip: 'edit', zip: 'edit', gzip: 'edit', gunzip: 'edit',

  // vcs: the multiplexer default covers the rest
  'git commit': 'vcs', 'git push': 'vcs',

  // test
  pytest: 'test', jest: 'test', vitest: 'test', mocha: 'test', tap: 'test', ava: 'test',
  playwright: 'test', cypress: 'test', 'go test': 'test', 'cargo test': 'test', 'npm test': 'test',
  'pnpm test': 'test', 'yarn test': 'test', 'bun test': 'test', 'deno test': 'test',

  // build
  tsc: 'build', esbuild: 'build', webpack: 'build', rollup: 'build', vite: 'build', swc: 'build',
  gofmt: 'build', prettier: 'build', eslint: 'build', biome: 'build', ruff: 'build', black: 'build',
  mypy: 'build', clippy: 'build', lint: 'build', format: 'build', typecheck: 'build',
  staticcheck: 'build', deadcode: 'build', 'golangci-lint': 'build',
  'go build': 'build', 'go vet': 'build', 'cargo build': 'build', 'cargo clippy': 'build',
  'go generate': 'build',

  // deps
  'npm install': 'deps', 'npm ci': 'deps', 'npm add': 'deps', 'pnpm install': 'deps',
  'pnpm add': 'deps', 'yarn install': 'deps', 'yarn add': 'deps', 'bun install': 'deps',
  'go install': 'deps', 'go get': 'deps', 'go mod': 'deps', 'cargo add': 'deps',
  'pip install': 'deps', 'pip3 install': 'deps', 'brew install': 'deps',

  // infra: the multiplexers in INFRA cover the rest, whatever their subcommand
  kubectx: 'infra', kubens: 'infra', k9s: 'infra', stern: 'infra', colima: 'infra',
  'ansible-playbook': 'infra', helmfile: 'infra', journalctl: 'infra',

  // run
  node: 'run', python: 'run', python3: 'run', ruby: 'run', bash: 'run', sh: 'run', zsh: 'run',
  osascript: 'run', claude: 'run', 'go run': 'run', 'cargo run': 'run',
  'npm start': 'run', 'pnpm start': 'run', 'npm run': 'build', 'pnpm run': 'build',

  // net
  curl: 'net', wget: 'net', nc: 'net', ping: 'net', dig: 'net', ssh: 'net', scp: 'net',
  rsync: 'net', http: 'net',

  // proc
  ps: 'proc', kill: 'proc', pkill: 'proc', pgrep: 'proc', killall: 'proc', lsof: 'proc',
  sleep: 'proc', top: 'proc', jobs: 'proc', wait: 'proc', trap: 'proc',

  // nav
  cd: 'nav', pushd: 'nav', popd: 'nav', pwd: 'nav', export: 'nav', source: 'nav', '.': 'nav',
  set: 'nav', unset: 'nav', umask: 'nav', alias: 'nav', mktemp: 'nav',

  // shell
  echo: 'shell', printf: 'shell', read: 'shell', true: 'shell', false: 'shell', ':': 'shell',
  eval: 'shell', seq: 'shell', date: 'shell', yes: 'shell', exit: 'shell', shift: 'shell',
}

/**
 * A plausible command name: no quotes, no expansions, no redirection debris. It must start with a
 * letter, which is what stops the `1` in `2>&1` from being read as a program.
 */
const NAME = /^[A-Za-z_][\w.+@-]*$/
/** A subcommand may also carry a colon, as npm script names do, like `test:coverage`. */
const SUBCOMMAND = /^[A-Za-z0-9_][\w.+:@-]*$/

function isFlag(token: string): boolean {
  return token.startsWith('-')
}

/**
 * `sed -n '1,40p'` reads a file and `sed -i` rewrites one. They are the same program and different
 * work, and in a real store `sed` is common enough that folding them together would be the single
 * largest misclassification.
 */
function editsInPlace(argv: string[]): boolean {
  return argv.some((token) => /^--in-place/.test(token) || /^-[A-Za-z]*i/.test(token))
}

/**
 * `label` is the token the work is really named after: the script for `npm run test:unit`, the
 * subcommand for `git commit`. That is not always the token the row is named after.
 */
/**
 * Names this machine knows and the shipped table does not. See `commands.ts`.
 *
 * The one piece of state in this file, and it is here because everything else in it is a pure
 * reader called from a dozen places: threading a lookup table through `subCommands`, `classifyCall`,
 * `actsOf`, `labelRounds` and the index builder would put a parameter nobody reads into five
 * signatures to serve one. It is set once, from the data directory, before anything is classified.
 */
let local: Record<string, CommandKind> = {}

/** Hand `bash.ts` the local table. Called at startup by the CLI and by the server, and by tests. */
export function useCommandKinds(kinds: Record<string, CommandKind>): void {
  local = kinds
}

function kindOf(name: string, head: string, label: string | null, argv: string[]): CommandKind {
  if (head === 'sed' || head === 'perl') return editsInPlace(argv) ? 'edit' : 'read'

  // Over the shipped table rather than under it, so a name can correct one probez ships as well as
  // add one it has never heard of — a `make` that only ever runs tests, say.
  const named = local[name] ?? local[head]
  if (named !== undefined) return named

  const exact = KIND_BY_NAME[name]
  if (exact !== undefined) return exact

  // Asked before the label, or a container named `test-db` in `docker exec test-db psql` would make
  // a shell into a database read as a test run.
  if (INFRA.has(head)) return 'infra'

  if (label !== null) {
    // `npx vitest` and `pnpm eslint` are the tool they name, whatever ran them.
    const byLabel = KIND_BY_NAME[label]
    if (byLabel !== undefined) return byLabel
    // A script called `test:coverage` or `test-graph-core` is a test run under any runner.
    if (/test|spec/i.test(label)) return 'test'
    const byHead = MULTIPLEXER_KIND[head]
    if (byHead !== undefined) return byHead
  }

  return KIND_BY_NAME[head] ?? 'other'
}

/**
 * Name one segment of a command line, or return null when it holds no command worth counting:
 * a comment, a flag continued from a wrapped line, a shell keyword, or a name that only exists
 * after an expansion this reader will not perform.
 */
function nameSegment(segment: string): Command | null {
  let tokens = segment.trim().replace(/^[({!]+\s*/, '').split(/\s+/).filter((t) => t !== '')

  // Leading noise: `do grep …` inside a loop body, environment assignments, and wrappers. Dropping
  // an assignment here keeps `FOO=bar cmd` counted as `cmd`; it is not redaction; this runs at read
  // time on a command already stored verbatim, and probez redacts nothing. See SECURITY.md.
  for (;;) {
    const first = tokens[0]
    if (first === undefined) return null
    if (LEADING_KEYWORDS.has(first) || WRAPPERS.has(first) || /^[A-Za-z_]\w*=/.test(first)) {
      tokens = tokens.slice(1)
      continue
    }
    // A shell handed a script is a wrapper around it. `bash -c` and a bare shell are not.
    if (SHELLS.has(first.includes('/') ? (first.split('/').pop() ?? '') : first)) {
      const next = tokens[1]
      if (next !== undefined && !isFlag(next) && !KEYWORDS.has(next)) {
        tokens = tokens.slice(1)
        continue
      }
    }
    if (first === 'timeout') {
      // `timeout 30 node x.js`: the duration is not a command either.
      tokens = tokens.slice(tokens[1] !== undefined && !isFlag(tokens[1]) ? 2 : 1)
      continue
    }
    break
  }

  const raw = tokens[0]!
  if (raw.startsWith('#')) return null
  if (KEYWORDS.has(raw)) return null

  // A path names its program by its last segment: tools/bin/flowz is flowz.
  const head = raw.includes('/') ? (raw.split('/').pop() ?? '') : raw
  if (!NAME.test(head)) return null

  if (!MULTIPLEXERS.has(head)) return { name: head, kind: kindOf(head, head, null, tokens) }

  let sub: string | null = null
  let at = 0
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!
    if (FLAGS_WITH_VALUES.has(token)) {
      i += 1
      continue
    }
    // A line wrapped with a trailing backslash puts one between the program and its subcommand.
    if (token === '\\' || isFlag(token)) continue
    if (SUBCOMMAND.test(token)) {
      sub = token
      at = i
    }
    break
  }
  if (sub === null) return { name: head, kind: kindOf(head, head, null, tokens) }

  let name = `${head} ${sub}`
  let label = sub
  if ((sub === 'run' || sub === 'exec') && !INFRA.has(head)) {
    // `npm run build` is worth naming; `go run ./cmd/x` is not, since a path is not a script name.
    // Neither is what follows `docker exec` or `kubectl exec`: that is a container or a pod, and
    // naming the row after it gives every pod a row of its own.
    const after = tokens[at + 1]
    if (after !== undefined && !/^[-./]/.test(after) && SUBCOMMAND.test(after)) {
      name += ` ${after}`
      label = after
    }
  }
  return { name, kind: kindOf(name, head, label, tokens) }
}

/** One piece of a command line, with what the shell put in front of it. */
interface Segment {
  text: string
  /** Whether a single `|` preceded this piece, which makes whatever runs here read a stream. */
  piped: boolean
}

/**
 * Cut a command line into the pieces that each begin a command.
 *
 * This has to respect quoting, and the reason is not theoretical: a `;` or a newline inside a
 * string is data, and splitting blindly turns `python3 -c 'import os'` and `echo "Tests: 3 FAIL"`
 * into commands called `import`, `Tests` and `FAIL`. Against a real store that noise was the single
 * largest source of junk rows.
 *
 * Two things are skipped whole rather than read. A command substitution runs real commands, but
 * they decorate the call rather than being it, and reading them costs more than it is worth. A
 * heredoc body is data outright, and its lines otherwise segment into convincing nonsense.
 *
 * Each piece carries whether a pipe preceded it, because the same program is different work on
 * either side of one: `grep -rn flush src` searches a tree, and the `grep` in
 * `npm test | grep "^not ok"` reads output that has already been produced. `||` is not a pipe.
 */
function segments(source: string): Segment[] {
  const out: Segment[] = []
  let start = 0
  let quote: string | null = null
  let depth = 0
  let piped = false

  /** Close the piece that ends here, and say whether the delimiter opens a piped one. */
  const cut = (end: number, next: boolean): void => {
    out.push({ text: source.slice(start, end), piped })
    piped = next
  }

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!
    if (quote !== null) {
      if (ch === '\\' && quote !== "'") i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '$' && source[i + 1] === '(') {
      depth += 1
      i += 1
      continue
    }
    if (depth > 0) {
      if (ch === ')') depth -= 1
      continue
    }
    if (ch === '<' && source[i + 1] === '<') {
      cut(i, false)
      return out
    }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      const doubled = source[i + 1] === ch
      cut(i, ch === '|' && !doubled)
      if (doubled) i += 1
      start = i + 1
    }
  }
  cut(source.length, false)
  return out
}

/**
 * A command, and where in the line it ran.
 *
 * `parseCommands` answers "what did this call use", which is what a tally wants and is why it
 * deduplicates. Reading a call as a step in a search needs the other question — what ran, in order,
 * and on which side of a pipe — so this is the primitive and `parseCommands` folds it.
 */
export interface Placed extends Command {
  /** Whether this command reads a stream rather than the tree. See `segments`. */
  piped: boolean
  /** The piece it was read out of, so a caller can read its arguments without splitting again. */
  text: string
}

/** Every command a Bash invocation runs, in order, undeduplicated and placed. */
export function parsePlaced(command: unknown): Placed[] {
  if (typeof command !== 'string' || command.trim() === '') return []

  const found: Placed[] = []
  for (const segment of segments(command)) {
    const parsed = nameSegment(segment.text)
    if (parsed === null) continue
    found.push({ ...parsed, piped: segment.piped, text: segment.text })
  }
  return found
}

/**
 * Every distinct command a Bash invocation runs, in the order it runs them.
 *
 * Deduplicated within the call, so `grep a | grep b` is one use of `grep`. A call that runs several
 * different commands yields all of them. `cd x && npm test` did both, and dropping either one to
 * pick a "primary" would be a guess about which mattered.
 */
export function parseCommands(command: unknown): Command[] {
  const found: Command[] = []
  const seen = new Set<string>()
  for (const placed of parsePlaced(command)) {
    if (seen.has(placed.name)) continue
    seen.add(placed.name)
    found.push({ name: placed.name, kind: placed.kind })
  }
  return found
}

/** The command string a shell call carries, wherever the tool input happens to be shaped oddly. */
export function commandOf(input: unknown): unknown {
  if (input === null || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const command = record.command ?? record.cmd
  if (Array.isArray(command) && command.every((part) => typeof part === 'string')) {
    return joinShell(command)
  }
  return command
}

/**
 * `bash -lc 'npm test'` is one command, `npm test`, not three tokens. Codex records argv that
 * way; joining blindly would make `bash` the thing that ran.
 */
function joinShell(parts: string[]): string {
  if (
    parts.length >= 3 &&
    (parts[0] === 'bash' || parts[0] === 'zsh' || parts[0] === 'sh') &&
    (parts[1] === '-lc' || parts[1] === '-c')
  ) {
    return parts.slice(2).join(' ')
  }
  return parts.join(' ')
}

/** Tools whose argument is a shell command rather than a file or a query. */
const SHELL_TOOLS = new Set(['Bash', 'shell', 'shell_command', 'exec_command', 'local_shell'])

export function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name)
}

/**
 * Tools whose calls decompose one level further, and how. Shell tools are the members: every
 * other tool's name already is its operation. The registry is what keeps adding another. An MCP
 * server's tools or a `Task`'s subagent type get an entry rather than a second design.
 */
const SUB_LABELS: Record<string, (input: unknown) => Command[]> = {
  Bash: (input) => parseCommands(commandOf(input)),
  shell: (input) => parseCommands(commandOf(input)),
  shell_command: (input) => parseCommands(commandOf(input)),
  exec_command: (input) => parseCommands(commandOf(input)),
  local_shell: (input) => parseCommands(commandOf(input)),
}

/** What one call decomposes into, or an empty list when the tool has no finer level. */
export function subCommands(tool: ToolCall): Command[] {
  const label = tool.name === null ? undefined : SUB_LABELS[tool.name]
  if (label === undefined) return []
  const found = label(tool.input)
  // A call that ran *something* always counts as one row, or the sub-table quietly under-reports.
  return found.length > 0 ? found : [{ name: UNPARSED, kind: 'other' }]
}
