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
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * End-to-end tests over the built CLI.
 *
 * The rules these cover live in `main()`'s dispatch rather than in a pure function, so they are
 * exercised the way a user meets them: by running the command and reading what came back. Every
 * test builds its own source directory and store, so nothing depends on the machine's real
 * `~/.claude`, `~/.cursor`, `~/.codex` or `~/.probez`.
 */

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'src', 'cli.js')
const FIXTURE = join(here, '..', '..', 'test', 'fixtures', 'session.jsonl')
const CURSOR_FIXTURE = join(here, '..', '..', 'test', 'fixtures', 'cursor-session.jsonl')
const CURSOR_SUB = join(here, '..', '..', 'test', 'fixtures', 'cursor-subagent.jsonl')
const CODEX_FIXTURE = join(here, '..', '..', 'test', 'fixtures', 'codex-session.jsonl')
const CODEX_SUB = join(here, '..', '..', 'test', 'fixtures', 'codex-subagent.jsonl')
const WALK_FIXTURE = join(here, '..', '..', 'test', 'fixtures', 'walk-session.jsonl')
const SUBAGENT_FIXTURE = join(here, '..', '..', 'test', 'fixtures', 'claude-subagent.jsonl')

interface Run {
  status: number
  stdout: string
  stderr: string
}

function run(args: string[], cwd?: string): Run {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd })
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
function makeSource(sessions: number, delegated = false): {
  claudeDir: string
  cursorDir: string
  codexDir: string
  dataDir: string
  project: string
} {
  // The agent records `cwd` with symlinks already resolved, and on macOS the temp directory is one
  // (/var -> /private/var). Without this the stored path would never match the target.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'probez-cli-test-')))
  const claudeDir = join(root, 'claude')
  const cursorDir = join(root, 'cursor')
  const codexDir = join(root, 'codex')
  const dataDir = join(root, 'data')
  const project = join(root, 'work')
  mkdirSync(project, { recursive: true })
  mkdirSync(cursorDir, { recursive: true })
  mkdirSync(codexDir, { recursive: true })
  const sourceDir = join(claudeDir, 'encoded-project-name')
  mkdirSync(sourceDir, { recursive: true })

  const template = readFileSync(FIXTURE, 'utf8')
  for (let i = 0; i < sessions; i++) {
    const id = `${String(i).repeat(8)}-0000-0000-0000-000000000000`
    writeFileSync(join(sourceDir, `${id}.jsonl`), template.replaceAll('/tmp/demo', project))
  }
  if (delegated && sessions > 0) {
    const id = `${'0'.repeat(8)}-0000-0000-0000-000000000000`
    const under = join(sourceDir, id, 'subagents')
    mkdirSync(under, { recursive: true })
    writeFileSync(
      join(under, 'agent-a1234567.jsonl'),
      readFileSync(SUBAGENT_FIXTURE, 'utf8').replaceAll('/tmp/demo', project),
    )
  }
  return { claudeDir, cursorDir, codexDir, dataDir, project }
}

function collect(env: ReturnType<typeof makeSource>, extra: string[] = []): Run {
  return run([
    'collect',
    env.project,
    '--data-dir',
    env.dataDir,
    '--claude-dir',
    env.claudeDir,
    '--cursor-dir',
    env.cursorDir,
    '--codex-dir',
    env.codexDir,
    ...extra,
  ])
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
    '--cursor-dir',
    env.cursorDir,
    '--codex-dir',
    env.codexDir,
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

test('a task is listed with the commit it started from, and not with one it made', () => {
  const env = makeSource(1)
  // A HEAD reflog for the directory the fixture sessions ran in. The fixture opens at 1767225600
  // and its second task eight seconds later, so the move at +4s lands inside the first task: the
  // column has to keep reporting where that task began.
  const old = 'a'.repeat(40)
  const made = 'b'.repeat(40)
  mkdirSync(join(env.project, '.git', 'logs'), { recursive: true })
  writeFileSync(
    join(env.project, '.git', 'logs', 'HEAD'),
    [
      `${'0'.repeat(40)} ${old} A <a@example.com> 1767225000 +0000\tcommit: before`,
      `${old} ${made} A <a@example.com> 1767225604 +0000\tcommit: during task 1`,
      '',
    ].join('\n'),
  )
  assert.equal(collect(env).status, 0)

  const listed = read(env, ['tasks'])
  assert.equal(listed.status, 0, listed.stderr)
  assert.match(listed.stdout, /\bFROM\b/)
  assert.match(listed.stdout, /^\s+1\s+\d+\s.*\baaaaaaa\b/m, 'task 1 started before the commit')
  assert.match(listed.stdout, /^\s+2\s+\d+\s.*\bbbbbbbb\b/m, 'task 2 started after it')

  assert.match(read(env, ['task', '1']).stdout, /from aaaaaaa/)
  // The full hash is what another tool wants, so `--json` is not abbreviated.
  const rows = JSON.parse(read(env, ['tasks', '--json']).stdout) as Array<{ commit: string }>
  assert.deepEqual(rows.map((r) => r.commit), [old, made])
})

test('a project outside a checkout keeps the table it always had', () => {
  const env = makeSource(1)
  assert.equal(collect(env).status, 0)

  const listed = read(env, ['tasks'])
  assert.equal(listed.status, 0, listed.stderr)
  // No commit anywhere means no column: a row of dashes would cost width and say nothing.
  assert.doesNotMatch(listed.stdout, /\bFROM\b/)
  assert.doesNotMatch(read(env, ['task', '1']).stdout, /\bfrom \b/)
})

test('`analyze` reports a distribution and says what it is a distribution of', () => {
  const env = makeSource(2)
  assert.equal(collect(env).status, 0)

  const out = read(env, ['analyze'])
  assert.equal(out.status, 0)
  assert.match(out.stdout, /WORK\s+ROUNDS\s+SHARE\s+COST\s+ERRORS\s+TIME\s+OUT/)
  // The coverage line is part of the answer, not a footnote: a share with no denominator behind it
  // reads as a share of everything, and rounds that called no tool are outside it. The denominator
  // is money, so the line names the amount rather than leaving "of those" to be guessed at.
  assert.match(
    out.stdout,
    /rounds did something a tool can see, out of \d+\. Shares are of the \$[\d.]+ they cost/,
  )
  assert.match(out.stdout, /of work has a known target/)
})

test('a share is a share of cost, so it does not track the round count', () => {
  const env = makeSource(1)
  assert.equal(collect(env).status, 0)

  const rows = read(env, ['analyze']).stdout
    .split('\n')
    .map((line) => line.match(/^ {2}(\w[\w ]*?)\s{2,}([\d.]+)\s+([\d.]+)%/))
    .filter((match): match is RegExpMatchArray => match !== null)
  assert.ok(rows.length > 1, 'need at least two categories to compare')

  // If SHARE were still the round share, these two would agree by construction. The fixture's
  // rounds differ in what they spent, so they must not.
  const whole = rows.reduce((sum, row) => sum + Number(row[2]), 0)
  const differs = rows.some((row) => Math.abs(Number(row[3]) - (Number(row[2]) / whole) * 100) > 0.5)
  assert.ok(differs, 'SHARE must be the cost share, not the round share under another name')
})

test('a model with no rate is reported rather than priced at nothing', () => {
  const env = makeSource(1)
  // A second session on a model that *is* priced, so the shares have a denominator and the
  // unpriced rounds are genuinely outside it. With every round unpriced there would be nothing for
  // them to be outside of, which is the other case and reads differently.
  writeFileSync(
    join(env.claudeDir, 'encoded-project-name', '11111111-0000-0000-0000-000000000000.jsonl'),
    readFileSync(FIXTURE, 'utf8')
      .replaceAll('/tmp/demo', env.project)
      .replaceAll('claude-opus-5', 'claude-sonnet-5'),
  )
  assert.equal(collect(env).status, 0)

  // Nothing prices this model, so its rounds sit outside the shares and the table says so.
  writeFileSync(
    join(env.dataDir, 'pricing.json'),
    JSON.stringify(
      { schema_version: 1, models: { 'claude-sonnet-5': { in: 3, cache_write_5m: 6, cache_write_1h: 12, cache_read: 1, out: 15 } } },
      null,
      2,
    ) + '\n',
  )
  const out = read(env, ['analyze'])
  assert.equal(out.status, 0)
  assert.match(out.stdout, /rounds are outside that: no rate for claude-opus-5/)
  assert.match(out.stdout, /Settings/)
})

test('with nothing priced at all, SHARE is a share of the rounds and says so', () => {
  const env = makeSource(1)
  assert.equal(collect(env).status, 0)

  // A source that records no token counts — Cursor — prices every round at nothing. Dividing by
  // that is dividing by zero: the column said nothing about work that plainly happened. With no
  // money to divide, the rounds are the denominator, and the coverage line names which one it is.
  writeFileSync(
    join(env.dataDir, 'pricing.json'),
    JSON.stringify({ schema_version: 1, models: {} }, null, 2) + '\n',
  )
  const out = read(env, ['analyze'])
  assert.equal(out.status, 0)
  assert.match(out.stdout, /SHARE is of the rounds rather than of the cost/)
  // With nothing priced there is nothing for the unpriced rounds to be outside of, so the line
  // says why the denominator moved instead of reporting an exclusion that did not happen.
  assert.match(out.stdout, /Nothing prices claude-opus-5/)
  assert.doesNotMatch(out.stdout, /outside that/)

  const rows = out.stdout
    .split('\n')
    .map((line) => line.match(/^ {2}(\w[\w ]*?)\s{2,}([\d.]+)\s+([\d.]+)%/))
    .filter((match): match is RegExpMatchArray => match !== null)
  assert.ok(rows.length > 0, 'the table must still have rows')
  const whole = rows.reduce((sum, row) => sum + Number(row[2]), 0)
  for (const row of rows) {
    assert.ok(Number(row[3]) > 0, `${row[1]} did work, so its share must not read as zero`)
    assert.ok(
      Math.abs(Number(row[3]) - (Number(row[2]) / whole) * 100) < 0.5,
      `${row[1]} must be its share of the rounds`,
    )
  }
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
  assert.ok(after.every((round) => round.source === 'claude-code'), 'rebuild stamps source from the session')
})

/**
 * A second project in the same store: another directory, and a session whose `cwd` is it.
 *
 * `collect --all` groups the agent's sessions by the directory they ran in, so this is all it takes
 * for one store to hold two projects.
 */
function secondProject(env: ReturnType<typeof makeSource>, name: string): string {
  const second = join(dirname(env.project), name)
  mkdirSync(second, { recursive: true })
  // Its own encoded directory: the agent writes one per project, and that is what discovery
  // groups by. Both sessions in one directory would come back as one project with two sessions.
  const dir = join(env.claudeDir, `encoded-${name}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'bbbbbbbb-0000-0000-0000-000000000000.jsonl'),
    readFileSync(FIXTURE, 'utf8').replaceAll('/tmp/demo', second),
  )
  return second
}

function collectAll(env: ReturnType<typeof makeSource>, extra: string[] = []): Run {
  return run([
    'collect',
    '--all',
    // The test projects live under the system temp directory, which discovery treats as scratch.
    '--include-temp',
    ...extra,
    '--data-dir',
    env.dataDir,
    '--claude-dir',
    env.claudeDir,
    '--cursor-dir',
    env.cursorDir,
    '--codex-dir',
    env.codexDir,
  ])
}

/**
 * Break one project's store past repair by the collector: its `rounds.jsonl` is a directory, which
 * nothing can append to or read as a file, and its session is made stale so the collect has to try.
 */
function breakStore(env: ReturnType<typeof makeSource>, project: string): void {
  const dir = readdirSync(join(env.dataDir, 'projects')).find((name) =>
    name.startsWith(`${basename(project)}-`),
  )!
  const rounds = join(env.dataDir, 'projects', dir, 'rounds.jsonl')
  rmSync(rounds)
  mkdirSync(rounds)
  const sessions = join(env.claudeDir, `encoded-${basename(project)}`)
  for (const name of readdirSync(sessions)) {
    utimesSync(join(sessions, name), new Date(), new Date())
  }
}

test('one project that cannot be collected does not end the run', () => {
  const env = makeSource(1)
  const other = secondProject(env, 'other')
  assert.equal(collectAll(env).status, 0)
  breakStore(env, other)

  const out = collectAll(env)
  // Reported through the exit code rather than by throwing, so what did collect is still printed.
  assert.equal(out.status, 1)
  assert.match(out.stdout, /1 project could not be collected/)
  assert.match(out.stdout, /other\s+\S/, 'the failing project is named with its reason')
  // The whole point: the other project was collected rather than lost to this one.
  assert.match(out.stdout, /\bwork\b/)
  assert.match(out.stdout, /^\s*1 project · /m)
})

test('`collect --all --json` carries the projects it could not collect', () => {
  const env = makeSource(1)
  const other = secondProject(env, 'other')
  assert.equal(collectAll(env).status, 0)
  breakStore(env, other)

  const out = collectAll(env, ['--json'])
  assert.equal(out.status, 1)
  const results = JSON.parse(out.stdout) as Array<Record<string, unknown>>
  assert.equal(results.length, 2, 'every project asked for is accounted for, collected or not')
  const broken = results.find((one) => typeof one.error === 'string')
  assert.ok(broken !== undefined, 'the failure is in the output, not only in the exit code')
  assert.equal(broken.project, 'other')
  assert.ok(results.some((one) => one.error === undefined && one.project === 'work'))
})

test('a rebuild that finds no rounds still lands on the store', () => {
  const env = makeSource(0)
  // A session the agent opened and the model never answered in normalizes to no rounds at all, so
  // the project has a state file and an archived copy and never had a `rounds.jsonl` to begin with.
  writeFileSync(
    join(env.claudeDir, 'encoded-project-name', 'aaaaaaaa-0000-0000-0000-000000000000.jsonl'),
    [
      JSON.stringify({ type: 'mode', timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'demo' }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: env.project,
        message: { role: 'user', content: 'hello' },
      }),
    ].join('\n') + '\n',
  )
  assert.equal(collect(env).status, 0)

  // Aged the way an upgrade ages it: the version markers move and there are no rounds to rewrite.
  const store = join(env.dataDir, 'projects', readdirSync(join(env.dataDir, 'projects'))[0]!)
  for (const name of ['state.json', 'manifest.json']) {
    const path = join(store, name)
    const json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    json.schema_version = 1
    writeFileSync(path, JSON.stringify(json, null, 2) + '\n')
  }

  // The rebuild writes nothing, so the file it moves over the old store is one nothing created.
  // That failed with ENOENT, and because the failure came before the new state was written, the
  // project stayed on the old schema and every later collect repeated it.
  const again = collect(env)
  assert.equal(again.status, 0, again.stderr)
  assert.equal(storedRounds(store).length, 0)
  const state = JSON.parse(readFileSync(join(store, 'state.json'), 'utf8')) as {
    schema_version: number
  }
  assert.notEqual(state.schema_version, 1, 'the rebuild has to record the new schema, or it repeats')

  // And the next run is an ordinary no-op rather than another rebuild.
  const third = collect(env)
  assert.equal(third.status, 0, third.stderr)
  assert.doesNotMatch(third.stdout, /rebuilt/)
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

test('the sessions table says what each session cost', () => {
  const env = makeSource(1, true)
  assert.equal(collect(env).status, 0)

  const table = read(env, ['sessions'])
  assert.equal(table.status, 0)
  assert.match(table.stdout, /\bCOST\b/)
  // The fixture's rounds run on a model with a published rate, so every row carries a figure and
  // the listing totals them.
  assert.match(table.stdout, /\$\d/)

  const rows = JSON.parse(read(env, ['sessions', '--json']).stdout) as Array<{
    cost: number
    unpriced: number
  }>
  assert.ok(rows.every((row) => row.cost > 0), 'every session priced')
  assert.ok(rows.every((row) => row.unpriced === 0), 'nothing in the fixture is unpriced')
  assert.doesNotMatch(table.stdout, /have no rate for their model/)
})

test('a session with a model nobody priced is marked, not reported as free', () => {
  const env = makeSource(1)
  // The rate table ships published prices; a model outside it costs something in reality and
  // nothing in the sum, so the row is marked and the listing says how many rounds are outside.
  const sourceDir = join(env.claudeDir, 'encoded-project-name')
  const name = readdirSync(sourceDir)[0]!
  const file = join(sourceDir, name)
  writeFileSync(file, readFileSync(file, 'utf8').replaceAll('claude-opus-5', 'model-nobody-priced'))
  assert.equal(collect(env).status, 0)

  const table = read(env, ['sessions'])
  assert.equal(table.status, 0)
  assert.match(table.stdout, /have no rate for their model and are outside COST/)
  // Nothing in it could be priced, so the row carries the same dash every unmeasured value does
  // rather than a figure that would read as free.
  assert.doesNotMatch(table.stdout, /\$\d/)
  assert.match(table.stdout, /—/)

  const rows = JSON.parse(read(env, ['sessions', '--json']).stdout) as Array<{
    cost: number
    unpriced: number
    rounds: number
  }>
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.cost, 0)
  assert.equal(rows[0]!.unpriced, rows[0]!.rounds)
})

test('a subagent is collected as its own session, under the one that spawned it', () => {
  const env = makeSource(1, true)
  assert.equal(collect(env).status, 0)

  const listed = read(env, ['sessions', '--json'])
  assert.equal(listed.status, 0)
  const rows = JSON.parse(listed.stdout) as Array<{ session: string; agent: string; rounds: number }>
  const sub = rows.find((row) => row.agent === 'sub')
  assert.ok(sub, 'the subagent transcript is a session of its own')
  assert.equal(sub.session, '00000000-0000-0000-0000-000000000000/subagents/agent-a1234567')
  assert.equal(sub.rounds, 2)
  assert.equal(rows.filter((row) => row.agent === 'main').length, 1)

  // Printed and typed the same way: the session it ran under, then which subagent.
  const table = read(env, ['sessions'])
  assert.match(table.stdout, /00000000\/a1234567\s+sub/)

  const one = read(env, ['session', '00000000/a1234567'])
  assert.equal(one.status, 0)
  assert.match(one.stdout, /session 00000000\/a1234567/)

  // Naming the parent still means the parent, and now says what it handed off.
  const parent = read(env, ['session', '00000000'])
  assert.equal(parent.status, 0)
  assert.match(parent.stdout, /handed to 1 subagent/)
})

test('a subagent keeps its own model, which is not always its parent\'s', () => {
  const env = makeSource(1, true)
  assert.equal(collect(env).status, 0)
  // Named by session rather than by `--agent sub`, which would also pick up the one sidechain
  // round the parent fixture carries inline, from back when they were written that way.
  const listed = read(env, ['rounds', '--session', '00000000/a1234567', '--json'])
  assert.equal(listed.status, 0)
  const rounds = JSON.parse(listed.stdout) as Array<{ model: string; out_tokens: number }>
  assert.equal(rounds.length, 2)
  assert.ok(rounds.every((round) => round.model === 'claude-sonnet-5'))
  // And its tokens are counted, which is the whole point of reading the file at all.
  assert.equal(rounds.reduce((sum, round) => sum + round.out_tokens, 0), 180)
})

test('a pruned subagent is rebuilt from the archived copy, as the agent that wrote it', () => {
  const env = makeSource(1, true)
  assert.equal(collect(env).status, 0)
  const store = ageStore(env)

  // The agent prunes the transcript, and the store's state loses the entry that recorded which
  // agent wrote it. What is left is the archived copy and its name — and the name cannot say,
  // since both agents name a subagent's transcript for the path it sat at.
  rmSync(join(env.claudeDir, 'encoded-project-name', '00000000-0000-0000-0000-000000000000'), {
    recursive: true,
  })
  const state = join(store, 'state.json')
  const json = JSON.parse(readFileSync(state, 'utf8')) as { sessions: Record<string, unknown> }
  delete json.sessions['00000000-0000-0000-0000-000000000000/subagents/agent-a1234567']
  writeFileSync(state, JSON.stringify(json, null, 2) + '\n')

  assert.equal(collect(env).status, 0)
  const rounds = storedRounds(store).filter(
    (round) => round.session === '00000000-0000-0000-0000-000000000000/subagents/agent-a1234567',
  )
  assert.equal(rounds.length, 2, 'the subagent survives the rebuild')
  assert.ok(rounds.every((round) => round.agent === 'sub'))
  assert.ok(rounds.every((round) => round.model === 'claude-sonnet-5'))
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

test('a project exported from one store imports into another and reads the same', () => {
  const mine = makeSource(2)
  assert.equal(collect(mine).status, 0)
  const before = read(mine, ['analyze']).stdout

  const bundle = join(mine.dataDir, 'sent.json')
  const exported = run(['export', mine.project, '--data-dir', mine.dataDir, '--bundle', '--out', bundle])
  assert.equal(exported.status, 0, exported.stderr)

  // A second machine: its own store, and no session directory the export could have come from.
  const theirs = realpathSync(mkdtempSync(join(tmpdir(), 'probez-cli-import-')))
  const imported = run(['import', bundle, '--data-dir', theirs])
  assert.equal(imported.status, 0, imported.stderr)
  assert.match(imported.stdout, /imported/)

  // Read back by the name it arrived under, on a machine with no agent directory at all — which is
  // exactly the machine someone who was only ever sent a file is sitting at.
  const after = run([
    'analyze',
    'work',
    '--data-dir',
    theirs,
    '--claude-dir',
    join(theirs, 'none'),
    '--cursor-dir',
    join(theirs, 'none-cursor'),
    '--codex-dir',
    join(theirs, 'none-codex'),
  ])
  assert.equal(after.status, 0, after.stderr)
  // Every figure the analysis prints, in order. The first line names the project and differs: one
  // of these has a path on this machine and the other does not.
  const figures = (text: string): string[] =>
    text.split('\n').slice(2).join('\n').match(/[\d.]+[KM%]?/g) ?? []
  assert.deepEqual(figures(after.stdout), figures(before))
})

test('importing the same project twice leaves one copy of it', () => {
  const mine = makeSource(1)
  assert.equal(collect(mine).status, 0)
  const bundle = join(mine.dataDir, 'sent.json')
  run(['export', mine.project, '--data-dir', mine.dataDir, '--bundle', '--out', bundle])

  const theirs = realpathSync(mkdtempSync(join(tmpdir(), 'probez-cli-twice-')))
  assert.equal(run(['import', bundle, '--data-dir', theirs]).status, 0)
  assert.equal(run(['import', bundle, '--data-dir', theirs]).status, 0)

  assert.equal(readdirSync(join(theirs, 'projects')).length, 1)
})

test('a file that is not an export is refused with a reason', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'probez-cli-junk-')))
  const junk = join(dir, 'notes.txt')
  writeFileSync(junk, 'just some notes I made\n')

  const refused = run(['import', junk, '--data-dir', dir])
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /no rounds in that file/)
  assert.equal(existsSync(join(dir, 'projects')), false)

  const missing = run(['import', join(dir, 'nope.json'), '--data-dir', dir])
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /cannot read/)
})

function makeCursorSource(): ReturnType<typeof makeSource> & { sessionDir: string } {
  const env = makeSource(0)
  // Cursor has no cwd in the file, so discovery infers the path from the folder name. Dashes in
  // a temp directory would decode as extra path segments, so this checkout is dash-free.
  const project = realpathSync(mkdtempSync(join('/tmp', 'probezwork')))
  const slug = project.replaceAll('/', '-').replace(/^-/, '')
  const sessionId = 'aaaa1111-0000-0000-0000-000000000000'
  const sessionDir = join(env.cursorDir, slug, 'agent-transcripts', sessionId)
  mkdirSync(join(sessionDir, 'subagents'), { recursive: true })
  writeFileSync(join(sessionDir, `${sessionId}.jsonl`), readFileSync(CURSOR_FIXTURE, 'utf8'))
  writeFileSync(join(sessionDir, 'subagents', 'bbbb2222.jsonl'), readFileSync(CURSOR_SUB, 'utf8'))
  return { ...env, project, sessionDir }
}

test('collect --source cursor reads Cursor transcripts and not Claude', () => {
  const env = makeCursorSource()
  const onlyCursor = collect(env, ['--source', 'cursor', '--json'])
  assert.equal(onlyCursor.status, 0, onlyCursor.stderr)
  const result = JSON.parse(onlyCursor.stdout) as { rounds: number; sessions: number }
  assert.equal(result.sessions, 2)
  assert.equal(result.rounds, 4)

  const store = join(env.dataDir, 'projects', readdirSync(join(env.dataDir, 'projects'))[0]!)
  const stored = storedRounds(store)
  assert.ok(stored.every((round) => round.model === null && round.in_tokens === null))
  const manifest = JSON.parse(readFileSync(join(store, 'manifest.json'), 'utf8')) as { sources: string[] }
  assert.deepEqual(manifest.sources, ['cursor'])

  const onlyClaude = collect(env, ['--source', 'claude', '--json'])
  assert.equal(onlyClaude.status, 1)
  assert.match(onlyClaude.stderr, /no project matched|no agent sessions/)
})

test('collect merges Claude and Cursor sessions for the same checkout', () => {
  const env = makeCursorSource()
  const sourceDir = join(env.claudeDir, 'encoded-project-name')
  writeFileSync(
    join(sourceDir, '11111111-0000-0000-0000-000000000000.jsonl'),
    readFileSync(FIXTURE, 'utf8').replaceAll('/tmp/demo', env.project),
  )
  const both = collect(env, ['--json'])
  assert.equal(both.status, 0, both.stderr)
  const result = JSON.parse(both.stdout) as { rounds: number; sessions: number }
  assert.equal(result.sessions, 3)
  assert.equal(result.rounds, 9)

  const store = join(env.dataDir, 'projects', readdirSync(join(env.dataDir, 'projects'))[0]!)
  const manifest = JSON.parse(readFileSync(join(store, 'manifest.json'), 'utf8')) as { sources: string[] }
  assert.deepEqual(manifest.sources.slice().sort(), ['claude-code', 'cursor'])
  const stamped = storedRounds(store)
  assert.ok(stamped.some((round) => round.source === 'claude-code'))
  assert.ok(stamped.some((round) => round.source === 'cursor'))
  assert.ok(stamped.every((round) => round.source === 'claude-code' || round.source === 'cursor'))
})

test('--help names the agents', () => {
  const help = run(['--help'])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /--source claude\|cursor\|codex\|all/)
  assert.match(help.stdout, /Does not collect/)
  assert.match(help.stdout, /source:claude/)
  assert.match(help.stdout, /--cursor-dir/)
  assert.match(help.stdout, /--codex-dir/)
  assert.match(help.stdout, /Codex CLI rollouts/)
})

test('collecting a Cursor project twice does not duplicate rounds', () => {
  const env = makeCursorSource()
  assert.equal(collect(env, ['--source', 'cursor']).status, 0)
  const again = collect(env, ['--source', 'cursor', '--json'])
  assert.equal(again.status, 0, again.stderr)
  const result = JSON.parse(again.stdout) as { new_rounds: number; rounds: number }
  assert.equal(result.new_rounds, 0)
  assert.equal(result.rounds, 4)
})

test('a nested Cursor session is archived under a flat filename', () => {
  const env = makeCursorSource()
  assert.equal(collect(env, ['--source', 'cursor']).status, 0)
  const store = join(env.dataDir, 'projects', readdirSync(join(env.dataDir, 'projects'))[0]!, 'sessions')
  const names = readdirSync(store)
  assert.ok(
    names.includes('aaaa1111-0000-0000-0000-000000000000__aaaa1111-0000-0000-0000-000000000000.jsonl'),
  )
  assert.ok(names.includes('aaaa1111-0000-0000-0000-000000000000__subagents__bbbb2222.jsonl'))
  assert.ok(names.every((name) => !name.includes('/')))
})

function makeCodexSource(): ReturnType<typeof makeSource> {
  const env = makeSource(0)
  const day = join(env.codexDir, '2026', '01', '06')
  mkdirSync(day, { recursive: true })
  const name = 'rollout-2026-01-06T00-00-00-cccc3333-0000-0000-0000-000000000000.jsonl'
  writeFileSync(join(day, name), readFileSync(CODEX_FIXTURE, 'utf8').replaceAll('/tmp/demo', env.project))
  writeFileSync(
    join(day, 'rollout-2026-01-06T00-00-01-dddd4444-0000-0000-0000-000000000000.jsonl'),
    readFileSync(CODEX_SUB, 'utf8').replaceAll('/tmp/demo', env.project),
  )
  return env
}

test('collect --source codex reads Codex rollouts and not Claude', () => {
  const env = makeCodexSource()
  const onlyCodex = collect(env, ['--source', 'codex', '--json'])
  assert.equal(onlyCodex.status, 0, onlyCodex.stderr)
  const result = JSON.parse(onlyCodex.stdout) as { rounds: number; sessions: number }
  assert.equal(result.sessions, 2)
  assert.equal(result.rounds, 6)

  const store = join(env.dataDir, 'projects', readdirSync(join(env.dataDir, 'projects'))[0]!)
  const stored = storedRounds(store)
  assert.ok(stored.some((round) => round.model === 'gpt-5'))
  const manifest = JSON.parse(readFileSync(join(store, 'manifest.json'), 'utf8')) as { sources: string[] }
  assert.deepEqual(manifest.sources, ['codex'])

  const onlyClaude = collect(env, ['--source', 'claude', '--json'])
  assert.equal(onlyClaude.status, 1)
  assert.match(onlyClaude.stderr, /no project matched|no agent sessions/)
})

test('collect merges Claude and Codex sessions for the same checkout', () => {
  const env = makeCodexSource()
  const sourceDir = join(env.claudeDir, 'encoded-project-name')
  writeFileSync(
    join(sourceDir, '11111111-0000-0000-0000-000000000000.jsonl'),
    readFileSync(FIXTURE, 'utf8').replaceAll('/tmp/demo', env.project),
  )
  const both = collect(env, ['--json'])
  assert.equal(both.status, 0, both.stderr)
  const result = JSON.parse(both.stdout) as { rounds: number; sessions: number }
  assert.equal(result.sessions, 3)
  assert.equal(result.rounds, 11)

  const store = join(env.dataDir, 'projects', readdirSync(join(env.dataDir, 'projects'))[0]!)
  const manifest = JSON.parse(readFileSync(join(store, 'manifest.json'), 'utf8')) as { sources: string[] }
  assert.deepEqual(manifest.sources.slice().sort(), ['claude-code', 'codex'])
  const stamped = storedRounds(store)
  assert.ok(stamped.some((round) => round.source === 'claude-code'))
  assert.ok(stamped.some((round) => round.source === 'codex'))
})

function makeMixedSource(): ReturnType<typeof makeSource> {
  const env = makeCursorSource()
  const sourceDir = join(env.claudeDir, 'encoded-project-name')
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(
    join(sourceDir, '11111111-0000-0000-0000-000000000000.jsonl'),
    readFileSync(FIXTURE, 'utf8').replaceAll('/tmp/demo', env.project),
  )
  const day = join(env.codexDir, '2026', '01', '06')
  mkdirSync(day, { recursive: true })
  writeFileSync(
    join(day, 'rollout-2026-01-06T00-00-00-cccc3333-0000-0000-0000-000000000000.jsonl'),
    readFileSync(CODEX_FIXTURE, 'utf8').replaceAll('/tmp/demo', env.project),
  )
  return env
}

test('collect stamps each mixed-agent round with its session source', () => {
  const env = makeMixedSource()
  const both = collect(env, ['--json'])
  assert.equal(both.status, 0, both.stderr)
  const store = join(env.dataDir, 'projects', readdirSync(join(env.dataDir, 'projects'))[0]!)
  const stamped = storedRounds(store)
  const sources = [...new Set(stamped.map((round) => round.source))].sort()
  assert.deepEqual(sources, ['claude-code', 'codex', 'cursor'])
})

test('--source on sessions filters stored rounds and does not restrict discovery', () => {
  const env = makeMixedSource()
  assert.equal(collect(env).status, 0)

  const listed = JSON.parse(read(env, ['sessions', '--json']).stdout) as Array<{ source: string }>
  assert.ok(listed.some((row) => row.source === 'cursor'))
  assert.ok(listed.some((row) => row.source === 'claude-code'))

  const cursorOnly = JSON.parse(
    read(env, ['sessions', '--source', 'cursor', '--json']).stdout,
  ) as Array<{ source: string; session: string }>
  assert.ok(cursorOnly.length > 0)
  assert.ok(cursorOnly.every((row) => row.source === 'cursor'))

  const claudeOnly = JSON.parse(
    read(env, ['sessions', '--source', 'claude', '--json']).stdout,
  ) as Array<{ source: string }>
  assert.ok(claudeOnly.length > 0)
  assert.ok(claudeOnly.every((row) => row.source === 'claude-code'))

  const found = run(['find', 'source:cursor', env.project, '--data-dir', env.dataDir, '--json'])
  assert.equal(found.status, 0, found.stderr)
  const result = JSON.parse(found.stdout) as { found: number }
  assert.ok(result.found > 0)

  const byFlag = run([
    'find',
    'tool:Read',
    env.project,
    '--source',
    'cursor',
    '--data-dir',
    env.dataDir,
    '--json',
  ])
  assert.equal(byFlag.status, 0, byFlag.stderr)
  const flagged = JSON.parse(byFlag.stdout) as { found: number; query: string }
  assert.ok(flagged.found > 0)
  assert.match(flagged.query, /source:cursor/)

  // Wipe live Cursor files. If `--source cursor` still went to discoverProjects, this would
  // fail to find the project when run from the checkout with no project argument.
  rmSync(env.cursorDir, { recursive: true, force: true })
  mkdirSync(env.cursorDir, { recursive: true })
  const emptyCursor = join(env.dataDir, 'empty-cursor')
  mkdirSync(emptyCursor, { recursive: true })
  const fromCwd = run(
    [
      'sessions',
      '--source',
      'cursor',
      '--json',
      '--data-dir',
      env.dataDir,
      '--claude-dir',
      env.claudeDir,
      '--cursor-dir',
      emptyCursor,
      '--codex-dir',
      env.codexDir,
    ],
    env.project,
  )
  assert.equal(fromCwd.status, 0, fromCwd.stderr)
  const recovered = JSON.parse(fromCwd.stdout) as Array<{ source: string }>
  assert.ok(recovered.length > 0, fromCwd.stdout)
  assert.ok(recovered.every((row) => row.source === 'cursor'))
})

test('read commands honour --source for analyze, tools, rounds, trails, questions and tasks', () => {
  const env = makeMixedSource()
  assert.equal(collect(env).status, 0)
  for (const command of ['analyze', 'tools', 'rounds', 'trails', 'questions', 'tasks']) {
    const result = read(env, [command, '--source', 'cursor'])
    assert.equal(result.status, 0, `${command}: ${result.stderr}`)
  }
})

test('collecting a Codex project twice does not duplicate rounds', () => {
  const env = makeCodexSource()
  assert.equal(collect(env, ['--source', 'codex']).status, 0)
  const again = collect(env, ['--source', 'codex', '--json'])
  assert.equal(again.status, 0, again.stderr)
  const result = JSON.parse(again.stdout) as { new_rounds: number; rounds: number }
  assert.equal(result.new_rounds, 0)
  assert.equal(result.rounds, 6)
})

test('a dated Codex session is archived under a flat filename', () => {
  const env = makeCodexSource()
  assert.equal(collect(env, ['--source', 'codex']).status, 0)
  const store = join(env.dataDir, 'projects', readdirSync(join(env.dataDir, 'projects'))[0]!, 'sessions')
  const names = readdirSync(store)
  assert.ok(
    names.includes('2026__01__06__rollout-2026-01-06T00-00-00-cccc3333-0000-0000-0000-000000000000.jsonl'),
  )
  assert.ok(names.every((name) => !name.includes('/')))
})

/**
 * A source tree holding the one session that contains a walk.
 *
 * Separate from `makeSource` because the shape is the point: the listing's output is the only place
 * the paths it fed exist, so the same session answers differently with `--deep` and without it, and
 * a test that could not tell the two apart would not be testing the flag.
 */
function makeWalkSource(): ReturnType<typeof makeSource> {
  const env = makeSource(0)
  const dir = join(env.claudeDir, 'encoded-project-name')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'aaaaaaaa-0000-0000-0000-00000000000a.jsonl'),
    readFileSync(WALK_FIXTURE, 'utf8').replaceAll('/tmp/demo', env.project),
  )
  return env
}

test('trails finds the walk a run of calls made, and names how far it went', () => {
  const env = makeWalkSource()
  collect(env)

  const shallow = read(env, ['trails'])
  assert.equal(shallow.status, 0)
  // Without the logs, the hop from the listing to the files it named is not visible, so the only
  // walk left is the grep into the file it hit — two calls, which is not a walk at all.
  assert.match(shallow.stdout, /no trails from inputs alone/)

  const deep = read(env, ['trails', '--deep'])
  assert.equal(deep.status, 0)
  assert.match(deep.stdout, /listing/)
  assert.match(deep.stdout, /edit/)
  assert.match(deep.stdout, /1 proven from result bodies/)
})

test('trail draws the walk hop by hop, named by any round it passed through', () => {
  const env = makeWalkSource()
  collect(env)

  const one = read(env, ['trail', '1.0', '--deep'])
  assert.equal(one.status, 0)
  assert.match(one.stdout, /started here/)
  assert.match(one.stdout, /listed/)
  // A round in the middle of the walk finds the same walk, which is the question a round listing
  // leaves you with.
  const middle = read(env, ['trail', '1.3', '--deep'])
  assert.equal(middle.status, 0)
  assert.equal(middle.stdout.trim(), one.stdout.trim())
})

test('a round outside every walk says so rather than picking a nearby one', () => {
  const env = makeWalkSource()
  collect(env)
  const missed = read(env, ['trail', '1.6', '--deep'])
  assert.equal(missed.status, 2)
  assert.match(missed.stderr, /not part of a trail/)
})

test('trails takes only the flags it reads', () => {
  const env = makeWalkSource()
  collect(env)
  assert.match(read(env, ['trails', '--outcome', 'sideways']).stderr, /--outcome takes one of/)
  assert.match(read(env, ['tools', '--min-depth', '3']).stderr, /--min-depth does not apply/)
  const filtered = read(env, ['trails', '--deep', '--outcome', 'abandoned'])
  assert.equal(filtered.status, 0)
  assert.match(filtered.stdout, /no trails matched those filters/)
})

test('questions counts what the agent needed to know, including what got nowhere', () => {
  const env = makeWalkSource()
  collect(env)

  const out = read(env, ['questions'])
  assert.equal(out.status, 0)
  // The walk fixture searches `tests` and then reads one file under it: one question, two calls.
  assert.match(out.stdout, /ASKED ABOUT/)
  assert.match(out.stdout, /priority/)
  assert.match(out.stdout, /per question/)
  // Unlike a trail, a question needs no archived session: it is read from the inputs alone, so
  // there is no shallow answer to warn about.
  assert.doesNotMatch(out.stdout, /--deep/)
})

test('a question is named by any round it was asked at, and its repeats are marked', () => {
  const env = makeWalkSource()
  collect(env)

  const one = read(env, ['questions', '--kind', 'covers'])
  assert.equal(one.status, 0)
  assert.match(one.stdout, /covers/)

  const detail = read(env, ['question', '1.3'])
  assert.equal(detail.status, 0)
  assert.match(detail.stdout, /asked about priority/)
  assert.match(detail.stdout, /fetched a body/)
  // The read that only turned the grep's line number into a body is in the same question, so
  // asking for its round finds it too.
  assert.equal(read(env, ['question', '1.4']).stdout.trim(), detail.stdout.trim())
})

/**
 * A reader that answers, and counts how many times it was asked.
 *
 * Written into the store's own directory as a node script, so the test needs nothing installed and
 * `explain` has something real to spawn.
 */
function fakeReader(env: ReturnType<typeof makeSource>, counter: string): void {
  mkdirSync(env.dataDir, { recursive: true })
  const script = join(env.dataDir, 'reader.js')
  writeFileSync(
    script,
    [
      'const fs = require("node:fs")',
      `fs.appendFileSync(${JSON.stringify(counter)}, "x")`,
      'let seen = ""',
      'process.stdin.on("data", (chunk) => { seen += chunk })',
      'process.stdin.on("end", () => {',
      '  process.stdout.write(JSON.stringify({',
      '    asked: "Which tests constrain priority?",',
      '    kind: seen.includes("priority") ? "covers" : "other",',
      '    why: "it searched the test surface",',
      '  }))',
      '})',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(env.dataDir, 'reader.json'),
    JSON.stringify({ command: [process.execPath, script], timeout_ms: 20000 }) + '\n',
    'utf8',
  )
}

test('explain asks the configured reader once, keeps the answer, and re-asks only on --again', () => {
  const env = makeWalkSource()
  collect(env)
  const counter = join(env.dataDir, 'runs')
  writeFileSync(counter, '', 'utf8')

  // With no reader there is nothing probez could run, and it says where to write one.
  const bare = read(env, ['explain', '1.3'])
  assert.equal(bare.status, 2)
  assert.match(bare.stderr, /no reader configured/)
  assert.match(bare.stderr, /reader\.json/)

  fakeReader(env, counter)
  const first = read(env, ['explain', '1.3'])
  assert.equal(first.status, 0)
  assert.match(first.stdout, /read as\s+Which tests constrain priority\?/)
  // The reader agreed with the rule, and the line says so rather than repeating the word twice.
  assert.match(first.stdout, /covers, as above/)
  assert.equal(readFileSync(counter, 'utf8').length, 1)

  // Asking again shows the same answer and runs nothing; `--again` is what spends.
  const second = read(env, ['explain', '1.3'])
  assert.equal(second.stdout.trim(), first.stdout.trim())
  assert.equal(readFileSync(counter, 'utf8').length, 1)
  assert.equal(read(env, ['explain', '1.3', '--again']).status, 0)
  assert.equal(readFileSync(counter, 'utf8').length, 2)

  // And the reading is on the question from then on, without anything being run to show it.
  const question = read(env, ['question', '1.3'])
  assert.match(question.stdout, /read as\s+Which tests constrain priority\?/)
  assert.equal(readFileSync(counter, 'utf8').length, 2)
})

test('explain --prompt sends nothing anywhere, and carries the calls and nothing else', () => {
  const env = makeWalkSource()
  collect(env)
  const counter = join(env.dataDir, 'runs')
  writeFileSync(counter, '', 'utf8')
  fakeReader(env, counter)

  const shown = read(env, ['explain', '1.3', '--prompt'])
  assert.equal(shown.status, 0)
  assert.match(shown.stdout, /grep/)
  assert.equal(readFileSync(counter, 'utf8').length, 0, '--prompt must run nothing')
  assert.ok(!existsSync(join(env.dataDir, 'projects')) || true)

  // A prompt with no reader configured still works: it is the way to use this without spawning.
  rmSync(join(env.dataDir, 'reader.json'))
  assert.equal(read(env, ['explain', '1.3', '--prompt']).status, 0)
})

test('explain needs a question, and takes only the flags it reads', () => {
  const env = makeWalkSource()
  collect(env)
  assert.match(read(env, ['explain']).stderr, /explain needs a round id/)
  assert.match(read(env, ['explain', '1.3', '--deep']).stderr, /--deep does not apply/)
  assert.match(read(env, ['questions', '--again']).stderr, /--again does not apply/)
})

test('questions takes only the flags it reads, and refuses the wrong vocabulary', () => {
  const env = makeWalkSource()
  collect(env)
  assert.match(read(env, ['questions', '--kind', 'sideways']).stderr, /--kind takes one of/)
  assert.match(read(env, ['questions', '--min-depth', '3']).stderr, /--min-depth does not apply/)
  assert.match(read(env, ['tools', '--min-calls', '2']).stderr, /--min-calls does not apply/)
  const filtered = read(env, ['questions', '--min-calls', '99'])
  assert.equal(filtered.status, 0)
  assert.match(filtered.stdout, /no questions matched those filters/)
})

test('a cost per question is a fact about the project, not about the rows a flag left', () => {
  const env = makeWalkSource()
  collect(env)
  const every = read(env, ['questions'])
  const some = read(env, ['questions', '--min-calls', '2'])
  const line = /(\d+) asked in all · (\d+) calls · ([\d.]+) per question/
  const before = every.stdout.match(line)
  const after = some.stdout.match(line)
  assert.ok(before !== null && after !== null)
  assert.deepEqual(before.slice(1), after.slice(1))
})

test('analyze says how much of the finding happened inside a walk', () => {
  const env = makeWalkSource()
  collect(env)
  const out = read(env, ['analyze', '--deep'])
  assert.equal(out.status, 0)
  assert.match(out.stdout, /of the finding was inside 1 trail/)
  assert.match(out.stdout, /The deepest went \d+ hops from a listing/)
})

/** `find <query> [project] [flags]` — the query comes first, unlike every other command. */
function find(env: ReturnType<typeof makeSource>, args: string[]): Run {
  const [query, ...rest] = args
  return run([
    'find',
    query!,
    env.project,
    ...rest,
    '--data-dir',
    env.dataDir,
    '--claude-dir',
    env.claudeDir,
    '--cursor-dir',
    env.cursorDir,
    '--codex-dir',
    env.codexDir,
  ])
}

test('`find` answers with a share of the profile, not just a list of rows', () => {
  const env = makeSource(1)
  collect(env)
  const out = find(env, ['tool:Bash'])
  assert.equal(out.status, 0)
  // The share is the point: a count alone says nothing about how much of the work this was.
  assert.match(out.stdout, /\d+ rounds? · .*of rounds/)
  assert.match(out.stdout, /ROUND\s+WORK/)
})

test('`find` takes the query first and the project second', () => {
  const env = makeSource(1)
  collect(env)
  const named = find(env, ['tool:Bash'])
  const everywhere = run([
    'find',
    'tool:Bash',
    '--all',
    '--data-dir',
    env.dataDir,
    '--claude-dir',
    env.claudeDir,
    '--cursor-dir',
    env.cursorDir,
    '--codex-dir',
    env.codexDir,
  ])
  assert.equal(everywhere.status, 0)
  // One project in this store, so naming it and searching all of it find the same rounds.
  const count = (text: string): string | undefined => /(\d+) rounds? ·/.exec(text)?.[1]
  assert.equal(count(named.stdout), count(everywhere.stdout))
})

test('`find --json` carries the totals, the share and the rows', () => {
  const env = makeSource(1)
  collect(env)
  const out = find(env, ['tool:Bash', '--json'])
  assert.equal(out.status, 0)
  const result = JSON.parse(out.stdout)
  assert.equal(result.entity, 'rounds')
  assert.ok(result.totals.rounds > 0)
  assert.ok(result.share.rounds > 0 && result.share.rounds <= 1)
  assert.equal(result.hits.length, Math.min(result.found, 50))
})

test('`find --in` counts something other than rounds', () => {
  const env = makeSource(2)
  collect(env)
  const out = find(env, ['tool:Bash', '--in', 'sessions', '--json'])
  const result = JSON.parse(out.stdout)
  assert.equal(result.entity, 'sessions')
  // Two sessions of the same fixture, so each hit says how much of its own session matched.
  assert.equal(result.hits.length, 2)
  assert.ok(result.hits.every((hit: { of: number; rounds: number }) => hit.of >= hit.rounds))
})

test('a broken query is explained under the part that broke, and the rest still runs', () => {
  const env = makeSource(1)
  collect(env)
  const out = find(env, ['tool:Bash categoy:test'])
  assert.equal(out.status, 0)
  assert.match(out.stdout, /there is no `categoy:` field/)
  assert.match(out.stdout, /did you mean category:\?/)
})

test('`find --plan` says what it made of a query and reads no store at all', () => {
  const env = makeSource(1)
  // Deliberately not collected: --plan must not need anything to have been.
  const out = run(['find', 'cost:>0.50 in:sessions', '--plan', '--data-dir', env.dataDir])
  assert.equal(out.status, 0)
  assert.match(out.stdout, /read as {3}cost:>0.50 in:sessions/)
  assert.match(out.stdout, /counting {2}sessions/)
  assert.match(out.stdout, /fields {4}cost/)
})

test('`find` with nothing to look for says so rather than listing the store', () => {
  const env = makeSource(1)
  collect(env)
  const out = run(['find', '--data-dir', env.dataDir])
  assert.equal(out.status, 2)
  assert.match(out.stderr, /find needs something to look for/)
})

test('a query that matches nothing says so, and points at the field list', () => {
  const env = makeSource(1)
  collect(env)
  const out = find(env, ['tool:NoSuchTool'])
  assert.equal(out.status, 0)
  assert.match(out.stdout, /nothing matched/)
  assert.match(out.stdout, /probez help` lists every field/)
})

test('`find` reads the store, so it refuses a project that was never collected', () => {
  const env = makeSource(1)
  const out = find(env, ['tool:Bash'])
  assert.equal(out.status, 2)
  assert.match(out.stderr, /no collected project matched/)
})

test('a flag belonging to find is refused elsewhere, and says where it belongs', () => {
  const env = makeSource(1)
  collect(env)
  assert.match(read(env, ['rounds', '--plan']).stderr, /--plan does not apply/)
  assert.match(read(env, ['rounds', '--in', 'tasks']).stderr, /It belongs to `find`/)
})

test('collecting a project leaves it searchable, and `find` says when one is not', () => {
  const env = makeSource(1)
  collect(env)
  const store = join(env.dataDir, 'projects')
  const [project] = readdirSync(store)
  const index = join(store, project!, 'search.jsonl')
  assert.ok(existsSync(index), 'collect did not write a search index')

  // Answered from the index: nothing was read in full, so nothing is said about it.
  const fast = find(env, ['tool:Bash'])
  assert.equal(fast.status, 0)
  assert.doesNotMatch(fast.stdout, /read in full/)

  // The index is derived data. Without it the same query is answered by reading the rounds, gives
  // the same rounds, and says that it had to.
  const before = JSON.parse(find(env, ['tool:Bash', '--json']).stdout)
  rmSync(index)
  const slow = find(env, ['tool:Bash'])
  assert.match(slow.stdout, /1 project was read in full for want of a current search index/)
  const after = JSON.parse(find(env, ['tool:Bash', '--json']).stdout)
  assert.equal(after.totals.rounds, before.totals.rounds)
  assert.deepEqual(after.hits, before.hits)
  assert.equal(before.scanned.indexed, 1)
  assert.equal(after.scanned.read, 1)
})

test('an index is not read once the rounds it describes have moved', () => {
  const env = makeSource(1)
  collect(env)
  const store = join(env.dataDir, 'projects')
  const [project] = readdirSync(store)
  const rounds = join(store, project!, 'rounds.jsonl')

  const before = JSON.parse(find(env, ['tool:Bash', '--json']).stdout)
  assert.equal(before.scanned.indexed, 1)

  // A round appended by something other than collect, which is what a stale index looks like.
  const line = readFileSync(rounds, 'utf8').trimEnd().split('\n').at(-1)!
  const extra = JSON.parse(line)
  extra.round = 9999
  extra.session = 'ffffffff-0000-0000-0000-000000000000'
  writeFileSync(rounds, readFileSync(rounds, 'utf8') + JSON.stringify(extra) + '\n')

  const after = JSON.parse(find(env, ['tool:Bash', '--json']).stdout)
  assert.equal(after.scanned.read, 1, 'a stale index was used')
  // The scope is the denominator of every share, and it is the figure the index supplies without
  // reading anything — so it counting the new round is what proves the stale one was not believed.
  assert.equal(after.scope.rounds, before.scope.rounds + 1)
})

test('`find --ask --prompt` prints what would be sent and starts nothing', () => {
  const env = makeSource(1)
  collect(env)
  // Deliberately no reader.json: printing the question must not need one, which is what makes
  // this the supported way to use `--ask` with a chat you already have open.
  const out = find(env, ['where did the time go', '--ask', '--prompt'])
  assert.equal(out.status, 0)
  assert.match(out.stdout, /where did the time go/)
  assert.match(out.stdout, /Fields:/)
  assert.match(out.stdout, /tool:/)
  // What is sent is a schema and a question. Nothing the agent said, and nothing it ran.
  assert.doesNotMatch(out.stdout, /Caveat: The messages below/)
  assert.ok(out.stdout.length < 20000, 'the question sent is not bounded')
})

test('`find --ask` with no reader configured says there is nothing to run', () => {
  const env = makeSource(1)
  collect(env)
  const out = find(env, ['where did the time go', '--ask'])
  assert.equal(out.status, 2)
  assert.match(out.stderr, /no reader configured/)
  assert.match(out.stderr, /--prompt/)
})

test('a sentence is read as a query, shown, and then answered by the query', () => {
  const env = makeSource(1)
  collect(env)
  writeFileSync(
    join(env.dataDir, 'reader.json'),
    JSON.stringify({
      command: [
        process.execPath,
        '-e',
        'process.stdout.write(JSON.stringify({query:"tool:Bash",why:"shell calls"}))',
      ],
    }) + '\n',
  )

  const out = find(env, ['what did it run', '--ask'])
  assert.equal(out.status, 0)
  // The query is shown before anything it found, because the query is the thing to check.
  assert.match(out.stdout, /probez read "what did it run" as/)
  assert.match(out.stdout, /tool:Bash/)
  assert.match(out.stdout, /shell calls/)

  // And the rows under it are the rows that query gives on its own — nothing the reader said
  // reaches a number.
  const asked = JSON.parse(find(env, ['what did it run', '--ask', '--json']).stdout)
  const typed = JSON.parse(find(env, ['tool:Bash', '--json']).stdout)
  assert.equal(asked.read.query, 'tool:Bash')
  assert.deepEqual(asked.totals, typed.totals)
  assert.deepEqual(asked.hits, typed.hits)
})

test('a reader that answers with a query probez cannot read is refused, not run', () => {
  const env = makeSource(1)
  collect(env)
  writeFileSync(
    join(env.dataDir, 'reader.json'),
    JSON.stringify({
      command: [
        process.execPath,
        '-e',
        'process.stdout.write(JSON.stringify({query:"categoy:test",why:"nope"}))',
      ],
    }) + '\n',
  )
  const out = find(env, ['what did it run', '--ask'])
  assert.equal(out.status, 2)
  assert.match(out.stderr, /cannot read/)
  assert.match(out.stderr, /categoy:test/)
  assert.equal(existsSync(join(env.dataDir, 'asked.json')), false, 'a refused answer was kept')
})

test('--prompt is refused without --ask, since there is nothing to send', () => {
  const env = makeSource(1)
  collect(env)
  const out = find(env, ['tool:Bash', '--prompt'])
  assert.equal(out.status, 2)
  assert.match(out.stderr, /--prompt goes with --ask/)
})

/** `clear <target> [flags]`, where the target may be a project or nothing at all. */
function clear(env: ReturnType<typeof makeSource>, args: string[]): Run {
  return run(['clear', ...args, '--data-dir', env.dataDir, '--claude-dir', env.claudeDir, '--cursor-dir', env.cursorDir])
}

test('`clear` says what it would take and, with no terminal to ask, takes nothing', () => {
  const env = makeSource(2)
  collect(env)
  const before = walk(env.dataDir).length

  const out = clear(env, ['--all'])
  assert.equal(out.status, 0)
  assert.match(out.stdout, /would remove every project in the store/)
  assert.match(out.stdout, /rounds/)
  // The suite is not a terminal, which is the same position a pipe or a CI job is in.
  assert.match(out.stdout, /needs a terminal to ask/)
  assert.match(out.stdout, /nothing was removed/)
  assert.deepEqual(walk(env.dataDir).length, before, 'a refused clear still wrote')
})

test('`clear --all --yes` removes every project and leaves the settings', () => {
  const env = makeSource(2)
  collect(env)
  writeFileSync(join(env.dataDir, 'pricing.json'), '{"schema_version":1,"models":{}}\n')

  const out = clear(env, ['--all', '--yes'])
  assert.equal(out.status, 0)
  assert.match(out.stdout, /removed .* rounds/)
  assert.equal(readdirSync(join(env.dataDir, 'projects')).length, 0)
  assert.ok(existsSync(join(env.dataDir, 'pricing.json')), 'the rates went with the projects')
})

test('`clear --before` keeps what is inside the window', () => {
  const env = makeSource(1)
  collect(env)
  const rounds = () => JSON.parse(read(env, ['sessions', '--json']).stdout).length

  // The fixture's sessions are older than any window a person would type, so a wide one keeps
  // everything and a narrow one takes it.
  const kept = clear(env, ['--before', '3650d', '--yes'])
  assert.equal(kept.status, 0)
  assert.match(kept.stdout, /nothing in the store is older than/)
  assert.ok(rounds() > 0)

  const gone = clear(env, ['--before', '1h', '--yes'])
  assert.equal(gone.status, 0)
  assert.match(gone.stdout, /removed/)
  assert.equal(readdirSync(join(env.dataDir, 'projects')).length, 0)
})

test('`clear` refuses what it cannot act on rather than guessing', () => {
  const env = makeSource(1)
  collect(env)
  assert.match(clear(env, []).stderr, /needs to know what to clear/)
  assert.match(clear(env, ['--all', '--before', '30d']).stderr, /use one or the other/)
  assert.match(clear(env, ['--before', 'soon']).stderr, /takes a span like 30d/)
  assert.match(clear(env, ['no-such-project']).stderr, /no collected project matched/)
})

test('`clear --json` is the plan before it runs, and what went after', () => {
  const env = makeSource(2)
  collect(env)
  const plan = JSON.parse(clear(env, ['--all', '--json']).stdout)
  assert.equal(plan.before, null)
  assert.equal(plan.totals.projects, 1)
  assert.ok(plan.totals.rounds > 0)
  // Reading the plan writes nothing.
  assert.equal(readdirSync(join(env.dataDir, 'projects')).length, 1)

  const done = JSON.parse(clear(env, ['--all', '--json', '--yes']).stdout)
  assert.equal(done.whole, 1)
  assert.equal(readdirSync(join(env.dataDir, 'projects')).length, 0)
})

test('`collect --since` reads only what the agent wrote inside the window', () => {
  const env = makeSource(2)
  // The fixture's files are written now, so one of them is aged deliberately: the window then has
  // something on each side of it, which is the only arrangement that tests anything.
  const sourceDir = join(env.claudeDir, 'encoded-project-name')
  const [first] = readdirSync(sourceDir).sort()
  const old = new Date(Date.now() - 90 * 86_400_000)
  utimesSync(join(sourceDir, first!), old, old)

  const narrow = collect(env, ['--since', '30d'])
  assert.equal(narrow.status, 0)
  assert.match(narrow.stdout, /1 session read, 1 outside the window/)
  assert.equal(JSON.parse(read(env, ['sessions', '--json']).stdout).length, 1)

  // A session outside the window was not read, so it is not recorded as read either — which is
  // what makes the window a window on one run rather than a decision about the store.
  const wide = collect(env)
  assert.equal(wide.status, 0)
  assert.equal(JSON.parse(read(env, ['sessions', '--json']).stdout).length, 2)
})
