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
  /**
   * Asked a running system about itself: `kubectl get`, `aws … describe-*`, `terraform plan`.
   *
   * The same split `read` is to `edit`, one layer out. It was deliberately absent — the note on
   * `INFRA` below argued that reporting on a cluster and changing one are both work on the machines
   * the code runs on, and that a sub-table per CLI bought a distinction nothing asked for. That
   * held while infra was a named 1%. In a store where it is a sixth of the spend it inverts: at
   * that size the unsplit category is itself the thing that hides the finding, because half of what
   * is in it is an agent reading a cluster to work out what is going on, which is reconstruction by
   * every other measure this tool applies.
   */
  | 'probe'
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
  'probe',
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
 * These are multiplexers too, and they were listed apart because they looked like the one family
 * where the subcommand does not change the kind: `kubectl get` reports on a cluster and `kubectl
 * apply` changes one, both work on the machines the code runs on rather than on the code, so both
 * were `infra`. The cost of splitting them — a sub-table per CLI, guessing which verbs of thirty
 * clouds read and which write — was not worth a distinction nothing downstream asked for.
 *
 * A store where infra ran to a sixth of the spend is what changed the arithmetic. At that size the
 * unsplit row is the finding it hides: about half of it was `kubectl get`, `aws … describe-*` and
 * `terraform plan`, an agent working out what a cluster is doing, which every other axis here would
 * call reconstruction. And it did not need thirty sub-tables. `INFRA_READ` below is one list of
 * subcommands plus one regular expression over the hyphenated cloud verbs, and between them they
 * decide the great majority of what a real store holds. What neither recognizes stays `infra`,
 * which is the direction to be wrong in: an unread verb is filed as changing the machine, not as
 * reading it.
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

/**
 * The same, for the cloud and cluster CLIs only.
 *
 * `kubectl -n ocana-agents get pods` is the commonest shape there is in a store that touches a
 * cluster, and without this the namespace is read as the subcommand: the row comes back named
 * `kubectl ocana-agents`, one row per namespace, and the verb that says whether the call read or
 * changed anything is never seen at all. Kept apart from `FLAGS_WITH_VALUES` because these letters
 * mean other things elsewhere — `make -n` is a dry run and takes no value, and swallowing the token
 * after it would lose the target it names.
 */
const INFRA_FLAGS_WITH_VALUES = new Set([
  '-n', '--namespace', '--context', '--kubeconfig', '--cluster', '-l', '--selector', '-o',
  '--output', '--region', '--profile', '--project', '--zone', '--query', '--endpoint-url',
  '--container', '--field-selector',
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

  // infra: the multiplexers in INFRA cover the rest, and `infraKind` splits them by subcommand
  kubectx: 'infra', kubens: 'infra', k9s: 'infra', colima: 'infra',
  'ansible-playbook': 'infra', helmfile: 'infra',
  // These two only ever read: `stern` tails pod logs and `journalctl` reads the system journal.
  stern: 'probe', journalctl: 'probe',

  // run
  node: 'run', python: 'run', python3: 'run', ruby: 'run', bash: 'run', sh: 'run', zsh: 'run',
  osascript: 'run', claude: 'run', 'go run': 'run', 'cargo run': 'run',
  'npm start': 'run', 'pnpm start': 'run', 'npm run': 'build', 'pnpm run': 'build',

  // net
  curl: 'net', wget: 'net', nc: 'net', ping: 'net', dig: 'net', ssh: 'net', scp: 'net',
  rsync: 'net', http: 'net',

  // proc: looking at, or acting on, what is running on this machine
  ps: 'proc', kill: 'proc', pkill: 'proc', pgrep: 'proc', killall: 'proc', lsof: 'proc',
  top: 'proc',

  // nav
  cd: 'nav', pushd: 'nav', popd: 'nav', pwd: 'nav', export: 'nav', source: 'nav', '.': 'nav',
  set: 'nav', unset: 'nav', umask: 'nav', alias: 'nav', mktemp: 'nav',

  // shell. `sleep` and its relatives sit here rather than under `proc`: waiting is not work on the
  // machine, it is the pause between two calls that are. They were the largest single row in a
  // store's whole environment category, almost entirely as the `sleep 3` between an `aws ssm
  // send-command` and the `aws ssm get-command-invocation` that collects its output — and at one
  // weight per command in a call, that pause was charged half of the work it was waiting for.
  echo: 'shell', printf: 'shell', read: 'shell', true: 'shell', false: 'shell', ':': 'shell',
  eval: 'shell', seq: 'shell', date: 'shell', yes: 'shell', exit: 'shell', shift: 'shell',
  sleep: 'shell', jobs: 'shell', wait: 'shell', trap: 'shell',
}

/**
 * Infra subcommands that report rather than change.
 *
 * One list rather than one per CLI, because the vocabulary barely varies: `get`, `describe`,
 * `list`, `status`, `logs` and `show` mean the same thing to kubectl, helm, docker, systemctl and
 * gcloud alike. `plan`, `validate` and `fmt` are terraform's members of the same family — a plan
 * writes nothing but a plan file, and reading what an apply *would* do is the clearest case of
 * finding out rather than changing.
 */
const INFRA_READ = new Set([
  'get', 'describe', 'logs', 'log', 'top', 'explain', 'events', 'wait', 'diff', 'view', 'show',
  'status', 'list', 'ls', 'inspect', 'info', 'version', 'history', 'search', 'cat', 'read',
  'access', 'output', 'api-resources', 'api-versions', 'cluster-info', 'plan', 'validate', 'fmt',
  'graph', 'providers', 'template', 'lint', 'console', 'ps', 'images', 'stats', 'port', 'whoami',
])

/**
 * Infra subcommands that change something.
 *
 * Only needed to stop a later word in the same line from being read as the verb: `aws ecs
 * update-service --service list` has to settle on `update-service`, and a scan that only knew how
 * to recognize reads would run past it to the `list`. Anything in neither set falls through to
 * `infra` anyway, so this list is short on purpose and holds only the verbs that actually collide.
 *
 * `rollout` is deliberately absent. `kubectl rollout status` reads and `kubectl rollout restart`
 * writes, and leaving the multiplexer out lets the word after it decide.
 */
const INFRA_WRITE = new Set([
  'apply', 'create', 'delete', 'patch', 'scale', 'edit', 'annotate', 'label', 'set', 'cordon',
  'drain', 'uncordon', 'taint', 'replace', 'expose', 'autoscale', 'destroy', 'import', 'init',
  'build', 'buildx', 'push', 'pull', 'rm', 'rmi', 'up', 'down', 'restart', 'start', 'stop',
  'install', 'upgrade', 'uninstall', 'rollback', 'login', 'deploy', 'cp', 'mv', 'sync', 'enable',
  'disable', 'add', 'remove', 'kill', 'exec', 'run', 'attach', 'port-forward', 'proxy',
])

/**
 * The hyphenated verb an AWS-style CLI puts in front of its resource: `describe-instances`,
 * `get-secret-value`, `list-objects-v2`. One regular expression covers every service, which is the
 * whole reason the split turned out to be affordable.
 */
const CLOUD_READ = /^(describe|list|get|head|scan|query|lookup|filter|search|select|export|batch-get|check|estimate|preview)-/
const CLOUD_WRITE = /^(create|delete|put|update|run|start|stop|terminate|attach|detach|modify|set|register|deregister|associate|disassociate|tag|untag|copy|import|upload|invalidate|reboot|restore|enable|disable|add|remove|replace|revoke|authorize|apply|deploy|publish|send|cancel|purge|reset|rotate|move)-/

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

/**
 * The words of an infra command line that could be its verb, in order, flags and their values gone.
 *
 * Capped, because the verb is always near the front — `aws ec2 describe-instances` puts it second,
 * `gcloud secrets versions access latest` fourth — and everything past that is arguments, where a
 * resource happening to be called `list` would be read as the operation.
 */
function infraWords(argv: string[], limit = 4): string[] {
  const out: string[] = []
  for (let i = 1; i < argv.length && out.length < limit; i += 1) {
    const token = argv[i] ?? ''
    if (INFRA_FLAGS_WITH_VALUES.has(token) || FLAGS_WITH_VALUES.has(token)) {
      i += 1
      continue
    }
    if (token === '\\' || token === '' || isFlag(token)) continue
    if (!SUBCOMMAND.test(token)) continue
    out.push(token.toLowerCase())
  }
  return out
}

/** Whether an infra command line reports on the machines or changes them. */
function infraKind(argv: string[]): CommandKind {
  for (const word of infraWords(argv)) {
    if (INFRA_READ.has(word) || CLOUD_READ.test(word)) return 'probe'
    if (INFRA_WRITE.has(word) || CLOUD_WRITE.test(word)) return 'infra'
  }
  return 'infra'
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
  if (INFRA.has(head)) return infraKind(argv)

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
      // `FOO=$(aws ssm send-command …)` is an assignment whose value is a command, and the command
      // is the part worth counting. Dropping the token whole took the program with it and left the
      // subcommand standing alone as the name: rows called `ssm`, `get` and `secretsmanager`, of a
      // kind nothing recognized. `FOO=bar cmd` and `FOO=$BAR cmd` still drop, since neither holds
      // a command — only the substitution forms do.
      const inner = /^[A-Za-z_]\w*=["']?(?:\$\(|`)(.+)$/.exec(first)
      tokens = inner === null ? tokens.slice(1) : [inner[1] ?? '', ...tokens.slice(1)]
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
  const swallows = INFRA.has(head) ? INFRA_FLAGS_WITH_VALUES : FLAGS_WITH_VALUES
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!
    if (swallows.has(token) || FLAGS_WITH_VALUES.has(token)) {
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
  const kind = kindOf(name, head, label, tokens)
  // A call that hands a command to another machine is named after the handing-off — one row for
  // `kubectl exec`, not one per pod — but counted as what it actually ran there.
  return { name, kind: remoteKind(head, sub, segment) ?? kind }
}

/**
 * What a remote-execution call ran on the other machine, when that can be read.
 *
 * `kubectl exec … -- cat /opt/app/config.json` opens a file and `aws ssm send-command … 'commands=
 * ["grep -E … /var/log/app.log"]'` searches one. Mechanically they are a `Read` and a `Grep` with a
 * cluster in the middle, and filing them by the outermost token alone put a large share of a real
 * store's file reading under infrastructure work.
 *
 * Only a payload this reader can name overrides the outer call. `docker exec test-db psql -c
 * "select 1"` comes back `other`, and an unrecognized inner command is not evidence about the outer
 * one — so `null` here leaves the call as whatever it was, which is the same rule the rest of this
 * file follows.
 */
function remoteKind(head: string, sub: string | null, segment: string): CommandKind | null {
  if (!INFRA.has(head)) return null
  const payload = sub === 'exec' ? afterDoubleDash(segment) : remoteScript(segment)
  if (payload === null) return null
  for (const command of parseCommands(unwrapShellC(payload))) {
    // The payload is a script, and it opens the way any script does. `export KUBECONFIG=…` before
    // the real command is the same scaffolding `bashActs` skips one level up.
    if (command.kind === 'nav' || command.kind === 'shell') continue
    return command.kind === 'other' ? null : command.kind
  }
  return null
}

/**
 * The command inside `sh -c "…"`, when that is the whole of a forwarded payload.
 *
 * `bash -c` is left closed everywhere else — the note on `SHELLS` above says why, and a bare `sh -c`
 * on a command line is a shell someone started. A payload is different: `kubectl exec … -- sh -c
 * 'cd /app && ls'` names its shell only because a pod needs one to chain two commands, and stopping
 * at the `sh` would report a shell being started where a directory was being listed.
 */
function unwrapShellC(payload: string): string {
  const found = /^\s*(?:\/\S+\/)?(?:bash|sh|zsh|ksh|dash)\s+-[a-z]*c\s+(['"])([\s\S]*)\1\s*$/.exec(payload)
  return found?.[2] ?? payload
}

/** What follows a standalone `--`, which is where `kubectl exec` puts the command it forwards. */
function afterDoubleDash(segment: string): string | null {
  const at = segment.search(/(^|\s)--(\s|$)/)
  if (at === -1) return null
  const rest = segment.slice(at).replace(/^\s*--\s*/, '')
  return rest.trim() === '' ? null : rest
}

/**
 * The script inside `aws ssm send-command --parameters 'commands=["…"]'`.
 *
 * The same payload arrives spelled four ways in one store — `commands=[…]`, `{"commands":[…]}`, and
 * both again with the quotes escaped through a second level of shell — so this looks for the key
 * and the bracket and gives up on anything else, including the `$(python3 -c …)` form where the
 * array is built by a subshell and there is no literal script to read.
 */
function remoteScript(segment: string): string | null {
  const found = /commands\\?["']?\s*[:=]\s*\[\s*\\?["']/.exec(segment)
  if (found === null) return null
  const body = segment.slice(found.index + found[0].length, found.index + found[0].length + 400)
  // The array holds one string per line of the script, so its element boundaries are the newlines
  // `parseCommands` splits on. Without this the whole array reads as a single command, and a
  // payload that opens with `export HOME=…` before doing anything reports itself as an export.
  const script = body.replace(/\\(["'\\])/g, '$1').replace(/["']\s*,\s*["']/g, '\n')
  return script.trim() === '' ? null : script
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

/**
 * Tools whose argument is a shell command rather than a file or a query.
 *
 * Spelling is per harness and there is no convention to lean on: Claude Code calls it `Bash`,
 * Codex `shell` and `local_shell`, Cursor `Shell` and sometimes `bash`. A name missing from this
 * set is not a small loss — the call goes in whole as one unreadable act, and `Shell` alone was the
 * largest single source of `unclassified` in a store with Cursor sessions in it, a sixth of all
 * labelled weight, almost all of it `ls`, `rg` and `grep`.
 */
const SHELL_TOOLS = new Set([
  'Bash', 'Shell', 'bash', 'shell', 'shell_command', 'exec_command', 'local_shell',
])

export function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name)
}

/**
 * Tools whose calls decompose one level further, and how. Shell tools are the members: every
 * other tool's name already is its operation. The registry is what keeps adding another. An MCP
 * server's tools or a `Task`'s subagent type get an entry rather than a second design.
 */
const SUB_LABELS: Record<string, (input: unknown) => Command[]> = Object.fromEntries(
  [...SHELL_TOOLS].map((name) => [name, (input: unknown) => parseCommands(commandOf(input))]),
)

/** What one call decomposes into, or an empty list when the tool has no finer level. */
export function subCommands(tool: ToolCall): Command[] {
  const label = tool.name === null ? undefined : SUB_LABELS[tool.name]
  if (label === undefined) return []
  const found = label(tool.input)
  // A call that ran *something* always counts as one row, or the sub-table quietly under-reports.
  return found.length > 0 ? found : [{ name: UNPARSED, kind: 'other' }]
}
