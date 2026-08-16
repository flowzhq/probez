import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * End-to-end tests over the built CLI.
 *
 * The rules these cover live in `main()`'s dispatch rather than in a pure function, so they are
 * exercised the way a user meets them: by running the command and reading what came back. Every
 * test builds its own source directory and store, so nothing depends on the machine's real
 * `~/.claude` or `~/.probez`.
 */

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'src', 'cli.js')
const FIXTURE = join(here, '..', '..', 'test', 'fixtures', 'session.jsonl')

interface Run {
  status: number
  stdout: string
  stderr: string
}

function run(args: string[]): Run {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const e = error as { status: number; stdout: string; stderr: string }
    return { status: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

/**
 * A source tree of `sessions` sessions, each a copy of the fixture rewritten to a fresh id and to a
 * working directory this test owns.
 */
function makeSource(sessions: number): { claudeDir: string; dataDir: string; project: string } {
  // The agent records `cwd` with symlinks already resolved, and on macOS the temp directory is one
  // (/var -> /private/var). Without this the stored path would never match the target.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'probez-cli-test-')))
  const claudeDir = join(root, 'claude')
  const dataDir = join(root, 'data')
  const project = join(root, 'work')
  mkdirSync(project, { recursive: true })
  const sourceDir = join(claudeDir, 'encoded-project-name')
  mkdirSync(sourceDir, { recursive: true })

  const template = readFileSync(FIXTURE, 'utf8')
  for (let i = 0; i < sessions; i++) {
    const id = `${String(i).repeat(8)}-0000-0000-0000-000000000000`
    writeFileSync(join(sourceDir, `${id}.jsonl`), template.replaceAll('/tmp/demo', project))
  }
  return { claudeDir, dataDir, project }
}

function collect(env: ReturnType<typeof makeSource>, extra: string[] = []): Run {
  return run(['collect', env.project, '--data-dir', env.dataDir, '--claude-dir', env.claudeDir, ...extra])
}

/** `<command> <project> [id] [flags]`, which is the order the detail commands expect. */
function read(env: ReturnType<typeof makeSource>, args: string[]): Run {
  const [command, ...rest] = args
  return run([
    command!,
    env.project,
    ...rest,
    '--data-dir',
    env.dataDir,
    '--claude-dir',
    env.claudeDir,
  ])
}

/** Every path under the store, so a test can assert about all of them at once. */
function walk(dir: string): string[] {
  const out: string[] = [dir]
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    out.push(path)
    if (entry.isDirectory()) out.push(...walk(path).slice(1))
  }
  return out
}

const SHARED_BITS = 0o077

test('a new store is readable only by its owner', () => {
  const env = makeSource(1)
  assert.equal(collect(env).status, 0)

  const shared = walk(env.dataDir).filter((p) => (statSync(p).mode & SHARED_BITS) !== 0)
  assert.deepEqual(shared, [], 'no path in the store may be group- or world-accessible')
})

test('collect repairs a store that was left world-readable', () => {
  const env = makeSource(1)
  assert.equal(collect(env).status, 0)

  // A store written before probez set a mode: directories traversable, rounds.jsonl readable.
  for (const path of walk(env.dataDir)) {
    chmodSync(path, statSync(path).isDirectory() ? 0o755 : 0o644)
  }
  assert.ok(walk(env.dataDir).some((p) => (statSync(p).mode & SHARED_BITS) !== 0))

  // Nothing new to read, so the repair has to happen on a run that collects nothing.
  const again = collect(env)
  assert.equal(again.status, 0)
  assert.match(again.stdout, /up to date/)

  const shared = walk(env.dataDir).filter((p) => (statSync(p).mode & SHARED_BITS) !== 0)
  assert.deepEqual(shared, [], 'a re-collect tightens what it owns')
})

test('a flag a command does not use is refused, not ignored', () => {
  const env = makeSource(1)
  assert.equal(collect(env).status, 0)

  const refused = read(env, ['sessions', '--kinds'])
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /--kinds does not apply to `probez sessions`/)
  assert.match(refused.stderr, /belongs to `tools`/)

  // The same flag on the command that owns it is fine.
  assert.equal(read(env, ['tools', '--kinds']).status, 0)
})

test('--limit is honoured by the list commands, and says what it withheld', () => {
  const env = makeSource(3)
  assert.equal(collect(env).status, 0)

  const all = read(env, ['sessions'])
  assert.match(all.stdout, /3 sessions/)

  const limited = read(env, ['sessions', '--limit', '2'])
  assert.match(limited.stdout, /showing 2 of 3 sessions/)
  assert.match(limited.stdout, /--limit 0 for all/)

  // Totals describe the project, not the page.
  assert.match(all.stdout, /· (\d+) rounds/)
  assert.equal(
    all.stdout.match(/· (\d+) rounds/)![1],
    limited.stdout.match(/· (\d+) rounds/)![1],
    'the rounds total must not shrink with the page',
  )
})

test('a detail view shows everything unless --limit is typed', () => {
  const env = makeSource(1)
  assert.equal(collect(env).status, 0)

  const whole = read(env, ['task', '1'])
  assert.equal(whole.status, 0, whole.stderr)
  assert.match(whole.stdout, /rounds · task 1 of/, 'the footer proves the view actually rendered')
  assert.doesNotMatch(whole.stdout, /showing/, 'a detail view is complete by default')

  const paged = read(env, ['task', '1', '--limit', '1'])
  assert.equal(paged.status, 0, paged.stderr)
  assert.match(paged.stdout, /showing 1 of \d+ rounds/)
})

test('--session narrows `tasks` rather than being validated and dropped', () => {
  const env = makeSource(2)
  assert.equal(collect(env).status, 0)

  const everything = read(env, ['tasks'])
  const one = read(env, ['tasks', '--session', '00000000'])
  assert.equal(one.status, 0)

  const count = (out: string): number => (out.match(/^\s{2}\d{8}#\d/gm) ?? []).length
  assert.ok(
    count(everything.stdout) > count(one.stdout),
    'filtering to one session must drop the other',
  )
  assert.ok(count(one.stdout) > 0, 'and must still show that session')

  // An id that matches nothing is still an error rather than a silent full listing.
  assert.equal(read(env, ['tasks', '--session', 'ffffffff']).status, 2)
})

test('`analyze` reports a distribution and says what it is a distribution of', () => {
  const env = makeSource(2)
  assert.equal(collect(env).status, 0)

  const out = read(env, ['analyze'])
  assert.equal(out.status, 0)
  assert.match(out.stdout, /WORK\s+ROUNDS\s+SHARE\s+ERRORS\s+TIME\s+OUT/)
  // The coverage line is part of the answer, not a footnote: a share with no denominator behind it
  // reads as a share of everything, and rounds that called no tool are outside it.
  assert.match(out.stdout, /rounds did something a tool can see, out of \d+\. Shares are of those/)
  assert.match(out.stdout, /of work has a known target/)
})

test('`analyze` writes its cache owner-only, and writing it again changes nothing', () => {
  const env = makeSource(1)
  assert.equal(collect(env).status, 0)
  assert.equal(read(env, ['analyze']).status, 0)

  const file = walk(env.dataDir).find((path) => path.endsWith('analysis.jsonl'))
  assert.ok(file !== undefined, 'analyze must leave an analysis.jsonl for the next stage')
  assert.equal(statSync(file).mode & 0o777, 0o600)

  const header = JSON.parse(readFileSync(file, 'utf8').split('\n')[0]!) as Record<string, unknown>
  assert.equal(typeof header.analyzer_version, 'number')
  assert.equal(typeof header.rounds, 'number')

  // Only `analyzed_at` may move: the labels are a pure function of the rounds.
  const first = readFileSync(file, 'utf8').split('\n').slice(1).join('\n')
  assert.equal(read(env, ['analyze']).status, 0)
  assert.equal(readFileSync(file, 'utf8').split('\n').slice(1).join('\n'), first)
})

test('`analyze --json` carries the coverage numbers as fields', () => {
  const env = makeSource(1)
  assert.equal(collect(env).status, 0)

  const out = read(env, ['analyze', '--json'])
  assert.equal(out.status, 0)
  const parsed = JSON.parse(out.stdout) as {
    name: string
    categories: { name: string; rounds: number }[]
    coverage: { rounds: number; classified: number; toolless: number }
  }[]
  assert.ok(Array.isArray(parsed) && parsed.length === 1)
  assert.ok(parsed[0]!.categories.length > 0, 'a collected project must classify to something')
  assert.equal(
    parsed[0]!.coverage.classified + parsed[0]!.coverage.toolless,
    parsed[0]!.coverage.rounds,
    'every round is either classified or reported as having called no tool',
  )
})

test('a category names the rounds behind it, and a value that is not one is refused', () => {
  const env = makeSource(1)
  assert.equal(collect(env).status, 0)

  const all = read(env, ['rounds', '--limit', '0'])
  const some = read(env, ['rounds', '--category', 'reconstruction', '--limit', '0'])
  assert.equal(some.status, 0)
  const count = (out: string): number => (out.match(/^\s{2}\d+\.\d+\s/gm) ?? []).length
  assert.ok(count(some.stdout) > 0, 'reconstruction must match some rounds')
  assert.ok(count(some.stdout) <= count(all.stdout))

  const bad = read(env, ['rounds', '--category', 'nonsense'])
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /--category takes one of/)
})

test('a flag belonging to analyze is refused elsewhere, and says where it belongs', () => {
  const env = makeSource(1)
  assert.equal(collect(env).status, 0)

  const wrong = read(env, ['sessions', '--split', 'target'])
  assert.equal(wrong.status, 2)
  assert.match(wrong.stderr, /--split/)
  assert.match(wrong.stderr, /analyze/)
})

/**
 * Age a store back to the schema before this one: the version markers say v1, and the rounds carry
 * only the fields v1 knew about. This is what a store collected by an earlier probez looks like.
 */
function ageStore(env: ReturnType<typeof makeSource>): string {
  const dir = readdirSync(join(env.dataDir, 'projects'))[0]!
  const store = join(env.dataDir, 'projects', dir)
  for (const name of ['state.json', 'manifest.json']) {
    const path = join(store, name)
    const json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    json.schema_version = 1
    writeFileSync(path, JSON.stringify(json, null, 2) + '\n')
  }
  const rounds = join(store, 'rounds.jsonl')
  const aged = readFileSync(rounds, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const round = JSON.parse(line) as Record<string, unknown>
      for (const key of ['in_uncached', 'in_cache_write', 'in_cache_read', 'gen_ms', 'wait_ms', 'first_input', 'events', 'mcp_server', 'mcp_tool', 'skill']) {
        delete round[key]
      }
      return JSON.stringify(round)
    })
  writeFileSync(rounds, aged.join('\n') + '\n')
  return store
}

function storedRounds(store: string): Array<Record<string, unknown>> {
  return readFileSync(join(store, 'rounds.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

test('a store from an older schema is rebuilt, not appended to', () => {
  const env = makeSource(2)
  assert.equal(collect(env).status, 0)
  const store = ageStore(env)
  const before = storedRounds(store).length

  const again = collect(env)
  assert.equal(again.status, 0)
  assert.match(again.stdout, /rebuilt for the current schema/)

  const after = storedRounds(store)
  // Appending would have doubled the file, since the old rounds are never removed and the new ones
  // are not duplicates of anything the filter recognises.
  assert.equal(after.length, before, 'a rebuild replaces the rounds rather than adding to them')
  assert.ok(after.every((round) => Array.isArray(round.events)), 'every round is the new shape')
  assert.ok(after.every((round) => typeof round.in_cache_read === 'number'))
})

test('a rebuild keeps rounds whose session the agent has since pruned', () => {
  const env = makeSource(2)
  assert.equal(collect(env).status, 0)
  const store = ageStore(env)
  const before = storedRounds(store)

  // The agent prunes old sessions; the store's own copy is what survives that.
  const sourceDir = join(env.claudeDir, 'encoded-project-name')
  const pruned = readdirSync(sourceDir)[0]!
  rmSync(join(sourceDir, pruned))

  assert.equal(collect(env).status, 0)

  const after = storedRounds(store)
  assert.equal(after.length, before.length, 'the pruned session is rebuilt from the archived copy')
  const sessions = new Set(after.map((round) => round.session))
  assert.equal(sessions.size, 2)
  assert.ok(after.every((round) => Array.isArray(round.events)))
})

test('a rebuild drops the analysis computed from the rounds it replaced', () => {
  const env = makeSource(1)
  assert.equal(collect(env).status, 0)
  assert.equal(read(env, ['analyze']).status, 0)
  const store = ageStore(env)
  assert.ok(existsSync(join(store, 'analysis.jsonl')))

  assert.equal(collect(env).status, 0)
  assert.equal(
    existsSync(join(store, 'analysis.jsonl')),
    false,
    'the cache described rounds that no longer exist in that shape',
  )
})
