import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
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
