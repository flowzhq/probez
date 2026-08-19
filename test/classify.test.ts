import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { actsOf, isProse, targetOf, VERBS, writesToFile } from '../src/act.js'
import type { Act, Verb } from '../src/act.js'
import { CATEGORIES, classifyCall, classifyRound, classifyRounds, labelOf } from '../src/classify.js'
import type { Label } from '../src/classify.js'
import type { Round, ToolCall } from '../src/types.js'
import { ROUND_DEFAULTS, TOOL_DEFAULTS } from './support.js'

function tool(name: string, input: unknown, extra: Partial<ToolCall> = {}): ToolCall {
  return { ...TOOL_DEFAULTS, name, input, result_chars: 0, is_error: false, ms: 0, ...extra }
}

function bash(command: string): ToolCall {
  return tool('Bash', { command })
}

function round(partial: Partial<Round> & { session: string; round: number }): Round {
  return { ...ROUND_DEFAULTS, id: `msg_${partial.round}`, ...partial }
}

/** `category/sub` for each label, which is what the tables show. */
function cells(labels: Label[]): string[] {
  return labels.map((label) => `${label.category}/${label.sub}`)
}

/** The one label a single-command call produces, for the cases where the mapping is the point. */
function cell(call: ToolCall): string | undefined {
  return cells(classifyCall(call))[0]
}

/** The verbs a call parsed to, before anything decided what kind of work they were. */
function verbs(call: ToolCall): Verb[] {
  return actsOf(call).map((one) => one.verb)
}

function weight(labels: Label[]): number {
  return labels.reduce((sum, label) => sum + label.weight, 0)
}

// --- targets ---------------------------------------------------------------------------------

test('a path is a test before it is source', () => {
  // `gates.test.ts` carries a source extension, so without the tests rule running first it would
  // read as code and the two would be indistinguishable.
  assert.equal(targetOf('/repo/packages/domain/src/gates.test.ts'), 'tests')
  assert.equal(targetOf('/repo/packages/domain/src/gates.ts'), 'code')
  assert.equal(targetOf('/repo/test/fixtures/session.jsonl'), 'tests')
  // A test runner's configuration is configuration. Changing it changes the setup, not the
  // coverage, and it belongs beside tsconfig.json rather than beside the tests it runs.
  assert.equal(targetOf('/repo/vitest.config.ts'), 'config')
})

test('the agent’s own directory is neither the code nor the docs', () => {
  assert.equal(targetOf('/Users/x/.claude/plans/lovely.md'), 'agent')
  assert.equal(targetOf('/Users/x/.claude/projects/-repo/memory/MEMORY.md'), 'agent')
  // The same file inside the project is documentation, because there it is the project's own.
  assert.equal(targetOf('/repo/docs/PRD.md'), 'docs')
})

test('targets read the file, not the folder it happens to sit in', () => {
  assert.equal(targetOf('/repo/README.md'), 'docs')
  assert.equal(targetOf('/repo/package.json'), 'config')
  assert.equal(targetOf('/repo/tsconfig.base.json'), 'config')
  assert.equal(targetOf('/repo/eslint.config.js'), 'config')
  assert.equal(targetOf('/repo/.prettierrc'), 'config')
  assert.equal(targetOf('/repo/Dockerfile'), 'infra')
  assert.equal(targetOf('/repo/.github/workflows/ci.yml'), 'infra')
  assert.equal(targetOf('https://example.com/page'), 'external')
  // Not in any table is `unknown`, which is a fact about the table rather than about the file.
  assert.equal(targetOf('/repo/out.log'), 'unknown')
  assert.equal(targetOf(''), 'unknown')
})

test('prose is a property of the file, and docs is a target that nearly matches it', () => {
  // The two axes agree almost everywhere, which is why one used to stand in for the other.
  assert.ok(isProse('/repo/README.md'))
  assert.ok(isProse('/repo/docs/anything.txt'))
  assert.ok(!isProse('/repo/src/a.ts'))
  // `AUTHORS` files under `docs` for the target axis, but nobody writes one as documentation work.
  assert.equal(targetOf('/repo/AUTHORS'), 'docs')
  assert.ok(!isProse('/repo/AUTHORS'))
})

// --- writes hiding in shell commands ---------------------------------------------------------

test('a redirect counts as a write only when it lands somewhere that matters', () => {
  assert.equal(writesToFile('printf "x" >> vault/ledger.md'), 'vault/ledger.md')
  assert.equal(writesToFile('cat > src/index.ts'), 'src/index.ts')
  // Capture-to-scratch is everywhere, and it is not the agent changing the project.
  assert.equal(writesToFile('pnpm test 2>&1 | tail -25'), null)
  assert.equal(writesToFile('pnpm format:fix >/dev/null 2>&1'), null)
  assert.equal(writesToFile('node build.js > /tmp/out.txt'), null)
  assert.equal(writesToFile('npm run build > out.log'), null)
})

test('a heredoc is a write only when its body writes', () => {
  const writing = "python3 - <<'EOF'\np='docs/ADR-001.md'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF"
  assert.equal(writesToFile(writing), 'docs/ADR-001.md')

  // The same shape is also how an agent inspects an image and prints what it found.
  const reading = "python3 - <<'EOF'\nfrom PIL import Image\nim=Image.open('shot.webp')\nprint('size', im.size)\nEOF"
  assert.equal(writesToFile(reading), null)
})

test('a redirect inside a quoted string or a heredoc body is data, not a redirect', () => {
  // The scan runs over the argument list only. Without that, printing a `>` reports a write and a
  // command that reports on the project is filed as one that changed it.
  assert.equal(writesToFile(`python3 - <<'EOF'\nprint("wrote > notes.md")\nEOF`), null)
  assert.equal(writesToFile('git commit -m "redirect output > report.md"'), null)
})

test('a greater-than in a heredoc body is a comparison, not a redirect', () => {
  // Both of these read a store and print what they found. The `>` is Python comparing a length,
  // and reading it as a redirect filed a script that inspects the project as one that changed it.
  const truncating =
    "python3 - <<'EOF'\nimport json\nd=json.loads(open('rounds.jsonl').readline())\n" +
    "def trunc(o):\n    if isinstance(o,str) and len(o)>120: return o[:120]\n    return o\n" +
    'print(json.dumps(trunc(d),indent=2))\nEOF'
  assert.equal(writesToFile(truncating), null)
  assert.equal(cell(bash(truncating)), 'reconstruction/inspect')

  const filtering =
    "python3 - <<'EOF'\nfor t in tools:\n    val=t.get('content') or ''\n" +
    "    if len(str(val))>200:\n        print(t['name'], len(str(val)))\nEOF"
  assert.equal(writesToFile(filtering), null)
  assert.equal(cell(bash(filtering)), 'reconstruction/inspect')

  // A destination that names a file still reads as a write, which is what the rule is for. The
  // body names no quoted path, so the write is reported with the target left unresolved.
  assert.equal(writesToFile("bash <<'EOF'\ndate > docs/log.md\nEOF"), '')
})

test('sed in place is left to the command parser, which already reads the flag', () => {
  // `bash.ts` calls this `edit`; the write-sniff must not claim it a second time.
  assert.equal(writesToFile("sed -i '' 's/a/b/' notes.md"), null)
})

// --- the parser: what a call mechanically did ------------------------------------------------

test('a call parses to verbs before anything decides what kind of work they are', () => {
  assert.deepEqual(verbs(bash('git diff')), ['query'])
  assert.deepEqual(verbs(bash('git commit -m "x"')), ['commit'])
  assert.deepEqual(verbs(bash('npm test')), ['test'])
  assert.deepEqual(verbs(bash('cat README.md')), ['read'])
  assert.deepEqual(verbs(tool('Edit', { file_path: '/repo/src/a.ts' })), ['write'])
  assert.deepEqual(verbs(tool('StrReplace', { path: '/repo/src/a.ts' })), ['write'])
  assert.deepEqual(verbs(tool('Grep', { pattern: 'flush' })), ['search'])
})

test('an act carries the file it named, which is what the category rules ask about', () => {
  const [read] = actsOf(tool('Read', { file_path: '/repo/README.md' }))
  assert.equal(read?.path, '/repo/README.md')
  assert.equal(read?.target, 'docs')
  assert.equal(read?.creating, false)

  const [made] = actsOf(tool('Write', { file_path: '/repo/src/a.ts' }))
  assert.equal(made?.creating, true)

  // A search names a pattern, not a file, whatever its input happens to hold.
  const [found] = actsOf(tool('Grep', { pattern: 'flush', path: '/repo/src' }))
  assert.equal(found?.path, '')
  assert.equal(found?.target, 'unknown')
})

test('shell scaffolding is dropped from a call that also did something', () => {
  assert.deepEqual(verbs(bash('cd /repo && npm test')), ['test'])
  assert.deepEqual(verbs(bash('echo --- && grep -rn flush src')), ['search'])
  // A call that is only scaffolding has nothing else to be.
  assert.deepEqual(verbs(bash('cd src')), ['noop'])
})

test('what follows a pipe is looking at output, not opening a file', () => {
  // `2>&1 | tail -25` is on a large share of the Bash calls in a real store. Counting the `tail`
  // as reading a file put several points of the distribution in the wrong category.
  assert.deepEqual(cells(classifyCall(bash('pnpm test 2>&1 | tail -25'))), ['testing/test'])
  assert.deepEqual(cells(classifyCall(bash('go test ./... 2>&1 | tail -40'))), ['testing/test'])
  // Without a pipe the same program really is reading a file.
  assert.equal(cell(bash('tail -50 src/loop.ts')), 'reconstruction/read')
})

test('a directory argument still says what was worked on', () => {
  const [label] = classifyCall(bash('grep -rn flush src'))
  assert.equal(label?.target, 'code')
  const [docs] = classifyCall(bash('grep -rn adr docs'))
  assert.equal(docs?.target, 'docs')
  // `./...` is not a dotfile, whatever it looks like to a rule that only checks the leading dot.
  const [none] = classifyCall(bash('go build ./...'))
  assert.equal(none?.target, 'unknown')
})

test('a call that ran several real commands splits its weight between them', () => {
  const labels = classifyCall(bash('pnpm lint && pnpm test'))
  assert.deepEqual(cells(labels), ['delivery/build', 'testing/test'])
  assert.equal(weight(labels), 1)
  assert.equal(labels[0]?.weight, 0.5)
})

test('git is routed by what the subcommand does, not by the kind the parser gives it', () => {
  // `git diff` comes back from `bash.ts` as kind `read`, so a mapping keyed on kind alone would
  // file it under reading a file rather than reporting on the tree.
  assert.equal(cell(bash('git commit -m "x"')), 'delivery/commit')
  assert.equal(cell(bash('git add -A')), 'delivery/commit')
  assert.equal(cell(bash('git push origin main')), 'delivery/publish')
  assert.equal(cell(bash('git checkout -b topic')), 'delivery/branch')
  assert.equal(cell(bash('gh pr create --fill')), 'delivery/publish')
  // Plumbing inside a one-liner is bookkeeping, not shipping.
  assert.equal(cell(bash('git rev-parse --short HEAD')), 'unclassified/incidental')
  assert.equal(cell(bash('git merge-base main HEAD')), 'unclassified/incidental')
})

test('reading the repository is reconstruction wherever it sits in a task', () => {
  // This used to depend on whether anything had been edited yet, which meant a round could not be
  // labelled without replaying its whole task. Read-only git is now the same act either way.
  assert.equal(cell(bash('git diff')), 'reconstruction/inspect')
  assert.equal(cell(bash('git status')), 'reconstruction/inspect')
  assert.equal(cell(bash('git log --oneline')), 'reconstruction/inspect')
  assert.equal(cell(bash('git blame src/a.ts')), 'reconstruction/inspect')
})

test('kinds follow what the command does', () => {
  assert.equal(cell(bash('grep -rn foo src')), 'reconstruction/locate')
  assert.equal(cell(bash('cat src/a.ts')), 'reconstruction/read')
  assert.equal(cell(bash('go test ./...')), 'testing/test')
  assert.equal(cell(bash('pnpm install')), 'environment/deps')
  assert.equal(cell(bash('curl -s https://example.com')), 'reconstruction/read')
  // Moving files about changes the tree rather than a file's contents; both are implementation.
  assert.equal(cell(bash('mv src/a.ts src/b.ts')), 'implementation/modify')
  // An unrecognized program is unknown, not a guess at what it might do.
  assert.equal(cell(bash('flowz scan')), 'unclassified/unknown')
})

test('working on the machines the code runs on is environment, not nothing', () => {
  assert.equal(cell(bash('kubectl get pods -n prod')), 'environment/infra')
  assert.equal(cell(bash('kubectl apply -f k8s/deploy.yaml')), 'environment/infra')
  assert.equal(cell(bash('aws sts get-caller-identity')), 'environment/infra')
  assert.equal(cell(bash('terraform apply')), 'environment/infra')
  assert.equal(cell(bash('docker compose up -d')), 'environment/infra')
  assert.equal(cell(bash('flyctl deploy')), 'environment/infra')
  // Installing a dependency is still the other half of the category, not this one.
  assert.equal(cell(bash('brew install jq')), 'environment/deps')
})

test('the target of an infra command is still read off the path it names', () => {
  // The category comes from the command and the target from the file, the way both axes always
  // work: `kubectl apply -f` names a manifest, and a manifest is infrastructure.
  const [label] = classifyCall(bash('kubectl apply -f k8s/deploy.yaml'))
  assert.equal(label?.target, 'infra')
  assert.equal(classifyCall(bash('kubectl get pods'))[0]?.target, 'unknown')
})

test('compiling is part of shipping, and running a suite is not', () => {
  assert.equal(cell(bash('npm run build')), 'delivery/build')
  assert.equal(cell(bash('npx tsc --noEmit')), 'delivery/build')
  // Linters and typecheckers stay with build: splitting them out produced a sub-kind too small to
  // read, and half of it was compilation rather than linting.
  assert.equal(cell(bash('npx eslint .')), 'delivery/build')
  assert.equal(cell(bash('npm test')), 'testing/test')
})

test('running the project is testing and running a script at it is reconstruction', () => {
  // The signal is the interpreter, which encodes "the project is written in the first list's
  // languages". True of most repos an agent works in, and false in a Python one.
  assert.equal(cell(bash('node scripts/check.mjs')), 'testing/run')
  assert.equal(cell(bash('npm start')), 'testing/run')
  assert.equal(cell(bash('python3 scripts/count.py')), 'reconstruction/inspect')
  assert.equal(cell(bash('python3 -c "import json; print(1)"')), 'reconstruction/inspect')
})

test('a shell command that writes a file is judged by the file, exactly like the tool would be', () => {
  // The prose question is asked once, against the path, so these cannot disagree with `Write`.
  assert.equal(cell(bash("python3 - <<'EOF'\np='a.md'\nopen(p,'w').write('x')\nEOF")), 'documentation/system')
  assert.equal(cell(bash('cat > README.md')), 'documentation/system')
  assert.equal(cell(tool('Write', { file_path: 'README.md' })), 'documentation/system')
  assert.equal(cell(bash('cat > src/index.ts')), 'implementation/modify')
})

// --- tools -----------------------------------------------------------------------------------

test('reading is never writing', () => {
  assert.equal(cell(tool('Read', { file_path: '/repo/src/a.ts' })), 'reconstruction/read')
  assert.equal(cell(tool('Write', { file_path: '/repo/src/a.ts' })), 'implementation/create')
  assert.equal(cell(tool('Read', { file_path: '/repo/README.md' })), 'planning/read')
  assert.equal(cell(tool('Write', { file_path: '/repo/README.md' })), 'documentation/system')
})

test('reading prose is planning and reading code is reconstruction', () => {
  assert.equal(cell(tool('Read', { file_path: '/repo/docs/PRD.md' })), 'planning/read')
  assert.equal(cell(tool('Read', { file_path: '/repo/CLAUDE.md' })), 'planning/read')
  assert.equal(cell(bash('head -20 README.md')), 'planning/read')
  assert.equal(cell(tool('Read', { file_path: '/repo/package.json' })), 'reconstruction/read')
})

test('writing prose is documentation and writing code is implementation', () => {
  assert.equal(cell(tool('Edit', { file_path: '/repo/docs/PRD.md' })), 'documentation/system')
  assert.equal(cell(tool('Edit', { file_path: '/repo/CHANGELOG.md' })), 'documentation/change')
  assert.equal(cell(tool('Edit', { file_path: '/repo/CLAUDE.md' })), 'documentation/agent')
  assert.equal(cell(tool('Edit', { file_path: '/repo/src/a.ts' })), 'implementation/modify')
  // Creating the file is the one thing that separates the two implementation sub-kinds.
  assert.equal(cell(tool('Write', { file_path: '/repo/src/a.ts' })), 'implementation/create')
})

test('a file is labelled the same however many times it has already been touched', () => {
  // Re-reading your own edit used to be its own category. It cost every round its task history.
  const labels = classifyRound(
    round({
      session: 's',
      round: 1,
      tools: [
        tool('Edit', { file_path: '/repo/src/a.ts' }),
        tool('Read', { file_path: '/repo/src/a.ts' }),
      ],
    }),
  )
  assert.deepEqual(cells(labels), ['implementation/modify', 'reconstruction/read'])
})

test('the planning a tool log can see is the harness moving around it', () => {
  assert.equal(cell(tool('AskUserQuestion', { questions: [] })), 'planning/clarify')
  assert.equal(cell(tool('ExitPlanMode', { plan: 'x' })), 'planning/design')
  assert.equal(cell(tool('TaskCreate', { subject: 'x' })), 'planning/decompose')
  assert.equal(cell(tool('Agent', { prompt: 'x' })), 'planning/decompose')
})

test('a tool with no table entry is named rather than guessed at', () => {
  const labels = classifyCall(tool('SomeHarnessTool', { id: '1' }))
  assert.deepEqual(cells(labels), ['unclassified/unknown'])
  // The name survives, so `analyze --unclassified` can say what the hole is made of.
  assert.equal(labels[0]?.source, 'SomeHarnessTool')
})

test('a call to an MCP server is reconstruction, and says so rather than being a hole', () => {
  // The namespace is the whole signal: the tool after `mcp__<server>__` is whatever someone
  // configured, so the verb records that a server was reached and stops there.
  assert.deepEqual(verbs(tool('mcp__figma__get_design_context', { id: '1' })), ['mcp'])
  assert.equal(cell(tool('mcp__figma__get_design_context', { id: '1' })), 'reconstruction/mcp')
  assert.equal(cell(tool('mcp__claude-in-chrome__navigate', { url: 'https://x.test' })), 'reconstruction/mcp')

  // The full name survives as the source, the same as it did when this was a hole.
  const [label] = classifyCall(tool('mcp__figma__get_design_context', { id: '1' }))
  assert.equal(label?.source, 'mcp__figma__get_design_context')

  // The input shape is per-server, so no target is read off it — an unset target beats a guessed
  // one, and `mcp__x__navigate`'s `url` is not the project's.
  assert.equal(label?.target, 'unknown')
})

test('only the mcp namespace is an MCP call', () => {
  // A built-in keeps its own row, and a name that merely mentions mcp is not namespaced by it.
  assert.deepEqual(verbs(tool('Read', { file_path: '/repo/mcp__notes.ts' })), ['read'])
  assert.deepEqual(verbs(tool('McpThing', { id: '1' })), ['unknown'])
  assert.deepEqual(verbs(bash('npm run mcp__build')), ['build'])
})

// --- rounds ----------------------------------------------------------------------------------

test('a round’s labels always account for exactly one round', () => {
  const worked = round({
    session: 's',
    round: 1,
    tools: [
      tool('Read', { file_path: '/repo/src/a.ts' }),
      tool('Read', { file_path: '/repo/src/b.ts' }),
      bash('grep -rn flush src'),
      tool('Edit', { file_path: '/repo/src/a.ts' }),
    ],
  })
  const labels = classifyRound(worked)
  assert.equal(weight(labels), 1)
  assert.deepEqual(cells(labels), [
    'reconstruction/read',
    'reconstruction/read',
    'reconstruction/locate',
    'implementation/modify',
  ])
})

test('a round that called no tool is not classified at all', () => {
  // Roughly one round in eleven is pure prose. Splitting it between planning and explaining would
  // be an assumption, so it carries no weight and is reported as coverage instead.
  const talked = round({ session: 's', round: 2, text: 'Here is what I found.' })
  assert.deepEqual(classifyRound(talked), [])
})

test('a round is labelled the same alone as it is among its neighbours', () => {
  // The property that removing `review` bought: no rule reaches outside the call it is looking at,
  // so `probez round` does not have to replay a whole project to label one round.
  const edit = round({
    session: 's',
    round: 1,
    task: 1,
    tools: [tool('Edit', { file_path: '/repo/src/a.ts' })],
  })
  const diff = round({ session: 's', round: 2, task: 1, tools: [bash('git diff')] })

  const together = classifyRounds([edit, diff])
  assert.deepEqual(cells(together.get('s 2') ?? []), cells(classifyRound(diff)))
  assert.deepEqual(cells(classifyRound(diff)), ['reconstruction/inspect'])
})

// --- the taxonomy holds together -------------------------------------------------------------

/** Every label the classifier can produce, over every verb and every path shape. */
function reachable(): Set<string> {
  const paths = ['', '/repo/src/a.ts', '/repo/README.md', '/repo/CHANGELOG.md', '/repo/CLAUDE.md']
  const out = new Set<string>()
  for (const verb of VERBS) {
    for (const path of paths) {
      for (const creating of [false, true]) {
        const one: Act = { verb, path, target: targetOf(path), creating, source: 'x', weight: 1 }
        const label = labelOf(one)
        out.add(`${label.category}/${label.sub}`)
      }
    }
  }
  return out
}

test('every sub-kind the classifier emits is declared, and every declared one is reachable', () => {
  // A count of sub-kinds says nothing about whether they agree. This is the invariant that
  // actually holds the table to the taxonomy, in both directions.
  const declared = new Set(
    CATEGORIES.flatMap((info) => info.subs.map((sub) => `${info.id}/${sub}`)),
  )
  const emitted = reachable()
  assert.deepEqual([...emitted].filter((c) => !declared.has(c)), [], 'emitted but not declared')
  assert.deepEqual([...declared].filter((c) => !emitted.has(c)), [], 'declared but unreachable')
})

test('the view’s copy of the taxonomy matches this one', () => {
  // `web/src/categories.ts` is built separately and cannot import from `classify.ts`, and its
  // `styleOf` falls back to a neutral for an id it does not know. A drift would show up as a grey
  // chart rather than an error, so it is checked here instead.
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', '..', 'web', 'src', 'categories.ts'), 'utf8')
  const table = source.slice(source.indexOf('export const CATEGORIES'))
  const ids = [...table.matchAll(/id: '([a-z]+)'/g)].map((match) => match[1])
  assert.deepEqual(
    ids.slice(0, CATEGORIES.length),
    CATEGORIES.map((info) => info.id),
  )
})

test('a subcommand is not a directory, however much it looks like one', () => {
  // `go test` names an operation. Reading its second word as a folder called `test` put the target
  // of every Go test run on the test surface rather than leaving it unknown.
  const [label] = classifyCall(bash('go test ./... 2>&1 | tail -40'))
  assert.equal(`${label?.category}/${label?.sub}`, 'testing/test')
  assert.equal(label?.target, 'unknown')
  // A real directory argument still resolves.
  const [real] = classifyCall(bash('go test ./internal/...'))
  assert.equal(real?.target, 'code')
})
