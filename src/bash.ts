/**
 * What a `Bash` call actually ran.
 *
 * Every other tool is its own operation — a `Read` reads, an `Edit` edits. `Bash` is one name over
 * an entire operating system, so tallying it by tool name says nothing. This turns the command
 * string into the commands it runs, and each command into a kind of work.
 *
 * Nothing here executes, resolves or validates anything. It is a reader of shell syntax, and it is
 * deliberately shallow: a command line that cannot be read confidently yields nothing rather than a
 * guess, since a wrong bucket is worse than a missing one.
 */

/** The kind of work a command does. `other` means "not in the table", not "unclassifiable". */
export type CommandKind =
  | 'search'
  | 'read'
  | 'edit'
  | 'vcs'
  | 'test'
  | 'build'
  | 'deps'
  | 'run'
  | 'net'
  | 'proc'
  | 'nav'
  | 'shell'
  | 'other'

export const COMMAND_KINDS: CommandKind[] = [
  'search',
  'read',
  'edit',
  'vcs',
  'test',
  'build',
  'deps',
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
 * Programs whose first argument is the real operation. `git` alone merges reading history with
 * committing; `git log` and `git commit` are different work and belong in different rows.
 */
const MULTIPLEXERS = new Set([
  'git', 'gh', 'jj',
  'npm', 'pnpm', 'yarn', 'npx', 'bun', 'deno',
  'cargo', 'go', 'make',
  'docker', 'kubectl', 'terraform', 'gcloud', 'aws',
  'brew', 'pip', 'pip3', 'uv', 'poetry',
])

/** Where an unrecognized subcommand of a multiplexer lands. */
const MULTIPLEXER_KIND: Record<string, CommandKind> = {
  git: 'vcs', gh: 'vcs', jj: 'vcs',
  npm: 'build', pnpm: 'build', yarn: 'build', npx: 'build', bun: 'build', deno: 'build',
  cargo: 'build', go: 'build', make: 'build',
  docker: 'other', kubectl: 'other', terraform: 'other', gcloud: 'other', aws: 'other',
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

  // vcs — the multiplexer default covers the rest
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

  // run
  node: 'run', python: 'run', python3: 'run', ruby: 'run', bash: 'run', sh: 'run', zsh: 'run',
  osascript: 'run', claude: 'run', 'go run': 'run', 'cargo run': 'run', 'docker run': 'run',
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
/** A subcommand may also carry a colon, as npm script names do — `test:coverage`. */
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
 * `label` is the token the work is really named after — the script for `npm run test:unit`, the
 * subcommand for `git commit` — which is not always the token the row is named after.
 */
function kindOf(name: string, head: string, label: string | null, argv: string[]): CommandKind {
  if (head === 'sed' || head === 'perl') return editsInPlace(argv) ? 'edit' : 'read'

  const exact = KIND_BY_NAME[name]
  if (exact !== undefined) return exact

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
 * Name one segment of a command line, or return null when it holds no command worth counting —
 * a comment, a flag continued from a wrapped line, a shell keyword, or a name that only exists
 * after an expansion this reader will not perform.
 */
function nameSegment(segment: string): Command | null {
  let tokens = segment.trim().replace(/^[({!]+\s*/, '').split(/\s+/).filter((t) => t !== '')

  // Leading noise: `do grep …` inside a loop body, environment assignments, and wrappers. An
  // assignment is dropped before anything is named, so an inline credential never reaches a row.
  for (;;) {
    const first = tokens[0]
    if (first === undefined) return null
    if (LEADING_KEYWORDS.has(first) || WRAPPERS.has(first) || /^[A-Za-z_]\w*=/.test(first)) {
      tokens = tokens.slice(1)
      continue
    }
    if (first === 'timeout') {
      // `timeout 30 node x.js` — the duration is not a command either.
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
  if (sub === 'run' || sub === 'exec') {
    // `npm run build` is worth naming; `go run ./cmd/x` is not — a path is not a script name.
    const after = tokens[at + 1]
    if (after !== undefined && !/^[-./]/.test(after) && SUBCOMMAND.test(after)) {
      name += ` ${after}`
      label = after
    }
  }
  return { name, kind: kindOf(name, head, label, tokens) }
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
 */
function segments(source: string): string[] {
  const out: string[] = []
  let start = 0
  let quote: string | null = null
  let depth = 0

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
      out.push(source.slice(start, i))
      return out
    }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      out.push(source.slice(start, i))
      if (source[i + 1] === ch) i += 1
      start = i + 1
    }
  }
  out.push(source.slice(start))
  return out
}

/**
 * Every distinct command a Bash invocation runs, in the order it runs them.
 *
 * Deduplicated within the call, so `grep a | grep b` is one use of `grep`. A call that runs several
 * different commands yields all of them — `cd x && npm test` did both, and dropping either one to
 * pick a "primary" would be a guess about which mattered.
 */
export function parseCommands(command: unknown): Command[] {
  if (typeof command !== 'string' || command.trim() === '') return []

  const found: Command[] = []
  const seen = new Set<string>()
  for (const segment of segments(command)) {
    const parsed = nameSegment(segment)
    if (parsed === null || seen.has(parsed.name)) continue
    seen.add(parsed.name)
    found.push(parsed)
  }
  return found
}

/** The command string a `Bash` call carries, wherever the tool input happens to be shaped oddly. */
export function commandOf(input: unknown): unknown {
  if (input === null || typeof input !== 'object') return null
  return (input as Record<string, unknown>).command
}
