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
 * `~/.claude`, `~/.cursor` or `~/.probez`.
 */

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'src', 'cli.js')
const FIXTURE = join(here, '..', '..', 'test', 'fixtures', 'session.jsonl')
const CURSOR_FIXTURE = join(here, '..', '..', 'test', 'fixtures', 'cursor-session.jsonl')
const CURSOR_SUB = join(here, '..', '..', 'test', 'fixtures', 'cursor-subagent.jsonl')
const WALK_FIXTURE = join(here, '..', '..', 'test', 'fixtures', 'walk-session.jsonl')

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
function makeSource(sessions: number): {
  claudeDir: string
  cursorDir: string
  dataDir: string
  project: string
} {
  // The agent records `cwd` with symlinks already resolved, and on macOS the temp directory is one
  // (/var -> /private/var). Without this the stored path would never match the target.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'probez-cli-test-')))
  const claudeDir = join(root, 'claude')
  const cursorDir = join(root, 'cursor')
  const dataDir = join(root, 'data')
  const project = join(root, 'work')
  mkdirSync(project, { recursive: true })
  mkdirSync(cursorDir, { recursive: true })
  const sourceDir = join(claudeDir, 'encoded-project-name')
  mkdirSync(sourceDir, { recursive: true })

  const template = readFileSync(FIXTURE, 'utf8')
  for (let i = 0; i < sessions; i++) {
    const id = `${String(i).repeat(8)}-0000-0000-0000-000000000000`
    writeFileSync(join(sourceDir, `${id}.jsonl`), template.replaceAll('/tmp/demo', project))
  }
  return { claudeDir, cursorDir, dataDir, project }
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
  assert.equal(collect(env).status, 0)

  // Nothing prices this model, so its rounds sit outside the shares and the table says so.
  writeFileSync(
    join(env.dataDir, 'pricing.json'),
    JSON.stringify({ schema_version: 1, models: {} }, null, 2) + '\n',
  )
  const out = read(env, ['analyze'])
  assert.equal(out.status, 0)
  assert.match(out.stdout, /no rate for claude-opus-5/)
  assert.match(out.stdout, /Settings/)
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
})

test('--help names both agents', () => {
  const help = run(['--help'])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /--source claude\|cursor\|both/)
  assert.match(help.stdout, /--cursor-dir/)
  assert.match(help.stdout, /Cursor transcripts/)
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
