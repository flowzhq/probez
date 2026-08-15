import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CATEGORIES,
  advance,
  classifyCall,
  classifyRound,
  classifyRounds,
  newContext,
  targetOf,
  writesToFile,
} from '../src/classify.js'
import type { CallContext, Label } from '../src/classify.js'
import type { Round, ToolCall } from '../src/types.js'

function tool(name: string, input: unknown, extra: Partial<ToolCall> = {}): ToolCall {
  return { name, input, result_chars: 0, is_error: false, ms: 0, ...extra }
}

function bash(command: string): ToolCall {
  return tool('Bash', { command })
}

function round(partial: Partial<Round> & { session: string; round: number }): Round {
  return {
    task: 1,
    agent: 'main',
    id: `msg_${partial.round}`,
    ts: null,
    ms: null,
    model: null,
    in_tokens: 0,
    out_tokens: 0,
    user_text: '',
    text: '',
    thinking_chars: 0,
    tools: [],
    ...partial,
  }
}

/** `category/sub` for each label, which is what the tables show. */
function cells(labels: Label[]): string[] {
  return labels.map((label) => `${label.category}/${label.sub}`)
}

/** The one label a single-command call produces, for the cases where the mapping is the point. */
function cell(call: ToolCall, ctx: CallContext = newContext()): string | undefined {
  return cells(classifyCall(call, ctx))[0]
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

test('sed in place is left to the command parser, which already reads the flag', () => {
  // `bash.ts` calls this `edit`; the write-sniff must not claim it a second time.
  assert.equal(writesToFile("sed -i '' 's/a/b/' notes.md"), null)
})

// --- commands --------------------------------------------------------------------------------

test('shell scaffolding is dropped from a call that also did something', () => {
  assert.deepEqual(cells(classifyCall(bash('cd /repo && npm test'), newContext())), [
    'verification/test',
  ])
  assert.deepEqual(cells(classifyCall(bash('echo --- && grep -rn flush src'), newContext())), [
    'reconstruction/locate',
  ])
  // A call that is only scaffolding has nothing else to be.
  assert.deepEqual(cells(classifyCall(bash('cd src'), newContext())), ['unclassified/incidental'])
})

test('what follows a pipe is looking at output, not opening a file', () => {
  // `2>&1 | tail -25` is on a large share of the Bash calls in a real store. Counting the `tail`
  // as reading a file put several points of the distribution in the wrong category.
  assert.deepEqual(cells(classifyCall(bash('pnpm test 2>&1 | tail -25'), newContext())), [
    'verification/test',
  ])
  assert.deepEqual(cells(classifyCall(bash('go test ./... 2>&1 | tail -40'), newContext())), [
    'verification/test',
  ])
  // Without a pipe the same program really is reading a file.
  assert.equal(cell(bash('tail -50 src/loop.ts')), 'reconstruction/read')
  assert.equal(cell(bash('head -20 README.md')), 'reconstruction/read')
})

test('a directory argument still says what was worked on', () => {
  const [label] = classifyCall(bash('grep -rn flush src'), newContext())
  assert.equal(label?.target, 'code')
  const [docs] = classifyCall(bash('grep -rn adr docs'), newContext())
  assert.equal(docs?.target, 'docs')
  // `./...` is not a dotfile, whatever it looks like to a rule that only checks the leading dot.
  const [none] = classifyCall(bash('go build ./...'), newContext())
  assert.equal(none?.target, 'unknown')
})

test('a call that ran several real commands splits its weight between them', () => {
  const labels = classifyCall(bash('pnpm lint && pnpm test'), newContext())
  assert.deepEqual(cells(labels), ['verification/build', 'verification/test'])
  assert.equal(weight(labels), 1)
  assert.equal(labels[0]?.weight, 0.5)
})

test('git is routed by what the subcommand does, not by the kind the parser gives it', () => {
  // `git diff` comes back from `bash.ts` as kind `read`, so a mapping keyed on kind alone would
  // file it under reconstruction no matter where it sat.
  assert.equal(cell(bash('git commit -m "x"')), 'delivery/commit')
  assert.equal(cell(bash('git add -A')), 'delivery/commit')
  assert.equal(cell(bash('git push origin main')), 'delivery/publish')
  assert.equal(cell(bash('git checkout -b topic')), 'delivery/branch')
  assert.equal(cell(bash('gh pr create --fill')), 'delivery/publish')
  // Plumbing inside a one-liner is bookkeeping, not shipping.
  assert.equal(cell(bash('git rev-parse --short HEAD')), 'unclassified/incidental')
  assert.equal(cell(bash('git merge-base main HEAD')), 'unclassified/incidental')
})

test('looking at the repository means orientation before an edit and review after one', () => {
  const before = newContext()
  assert.equal(cell(bash('git diff'), before), 'reconstruction/inspect')
  assert.equal(cell(bash('git status'), before), 'reconstruction/inspect')

  const after = newContext()
  advance(tool('Edit', { file_path: '/repo/src/a.ts' }), after)
  assert.equal(cell(bash('git diff'), after), 'review/diff')
  assert.equal(cell(bash('git log --oneline'), after), 'review/diff')
})

test('kinds follow what the command does', () => {
  assert.equal(cell(bash('grep -rn foo src')), 'reconstruction/locate')
  assert.equal(cell(bash('cat README.md')), 'reconstruction/read')
  assert.equal(cell(bash('go test ./...')), 'verification/test')
  assert.equal(cell(bash('npm run build')), 'verification/build')
  // Linters and typecheckers stay with build: splitting them out produced a sub-kind too small to
  // read, and half of it was compilation rather than linting.
  assert.equal(cell(bash('npx tsc --noEmit')), 'verification/build')
  assert.equal(cell(bash('npx eslint .')), 'verification/build')
  assert.equal(cell(bash('pnpm install')), 'environment/deps')
  assert.equal(cell(bash('curl -s https://example.com')), 'reconstruction/read')
  // Moving files about is restructuring, which is what refactor names.
  assert.equal(cell(bash('mv src/a.ts src/b.ts')), 'implementation/refactor')
  // An unrecognized program is unknown, not a guess at what it might do.
  assert.equal(cell(bash('flowz scan')), 'unclassified/unknown')
})

test('a shell command that writes to a real file is implementation, not a test run', () => {
  assert.equal(cell(bash("python3 - <<'EOF'\np='a.md'\nopen(p,'w').write('x')\nEOF")), 'implementation/modify')
  assert.equal(cell(bash('cat > src/index.ts')), 'implementation/modify')
  // Running something and watching what it says is still verification.
  assert.equal(cell(bash('node scripts/check.mjs')), 'verification/run')
})

// --- tools -----------------------------------------------------------------------------------

test('reading and writing are never the same operation', () => {
  assert.equal(cell(tool('Read', { file_path: '/repo/README.md' })), 'reconstruction/read')
  assert.equal(cell(tool('Write', { file_path: '/repo/README.md' })), 'documentation/system')
  assert.equal(cell(tool('Read', { file_path: '/repo/src/a.ts' })), 'reconstruction/read')
  assert.equal(cell(tool('Write', { file_path: '/repo/src/a.ts' })), 'implementation/create')
})

test('writing prose is documentation and writing code is implementation', () => {
  assert.equal(cell(tool('Edit', { file_path: '/repo/docs/PRD.md' })), 'documentation/system')
  assert.equal(cell(tool('Edit', { file_path: '/repo/CHANGELOG.md' })), 'documentation/change')
  assert.equal(cell(tool('Edit', { file_path: '/repo/CLAUDE.md' })), 'documentation/agent')
  assert.equal(cell(tool('Edit', { file_path: '/repo/src/a.ts' })), 'implementation/modify')
  // A replace-all edit is a sweep across the file rather than a change of behaviour.
  assert.equal(
    cell(tool('Edit', { file_path: '/repo/src/a.ts', replace_all: true })),
    'implementation/refactor',
  )
})

test('re-opening a file you already changed is checking your own work', () => {
  const ctx = newContext()
  assert.equal(cell(tool('Read', { file_path: '/repo/src/a.ts' }), ctx), 'reconstruction/read')
  advance(tool('Edit', { file_path: '/repo/src/a.ts' }), ctx)
  assert.equal(cell(tool('Read', { file_path: '/repo/src/a.ts' }), ctx), 'review/read-back')
  // A file you have not touched is still just being read.
  assert.equal(cell(tool('Read', { file_path: '/repo/src/b.ts' }), ctx), 'reconstruction/read')
})

test('the planning a tool log can see is the harness moving around it', () => {
  assert.equal(cell(tool('AskUserQuestion', { questions: [] })), 'planning/clarify')
  assert.equal(cell(tool('ExitPlanMode', { plan: 'x' })), 'planning/design')
  assert.equal(cell(tool('TaskCreate', { subject: 'x' })), 'planning/decompose')
  assert.equal(cell(tool('Agent', { prompt: 'x' })), 'planning/decompose')
})

test('a tool with no table entry is named rather than guessed at', () => {
  const labels = classifyCall(tool('mcp__figma__use_figma', { id: '1' }), newContext())
  assert.deepEqual(cells(labels), ['unclassified/unknown'])
  // The name survives, so `analyze --unclassified` can say what the hole is made of.
  assert.equal(labels[0]?.source, 'mcp__figma__use_figma')
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
  const labels = classifyRound(worked, newContext())
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
  assert.deepEqual(classifyRound(talked, newContext()), [])
})

test('context is carried across rounds within a task and reset between tasks', () => {
  const first = round({
    session: 's',
    round: 1,
    task: 1,
    tools: [tool('Edit', { file_path: '/repo/src/a.ts' })],
  })
  const second = round({ session: 's', round: 2, task: 1, tools: [bash('git diff')] })
  const third = round({ session: 's', round: 3, task: 2, tools: [bash('git diff')] })

  const labelled = classifyRounds([first, second, third])
  // The edit happened earlier in the same task, so the diff reviews it.
  assert.deepEqual(cells(labelled.get('s\u00002') ?? []), ['review/diff'])
  // A new task starts over: nothing has been edited yet, so the same command is orientation.
  assert.deepEqual(cells(labelled.get('s\u00003') ?? []), ['reconstruction/inspect'])
})

test('every category is decomposed, and every sub-kind belongs to its category', () => {
  // A flat bucket beside a decomposed one would mean only one of them was taken seriously.
  for (const info of CATEGORIES) {
    assert.ok(info.subs.length >= 2, `${info.id} has fewer than two sub-kinds`)
  }
})

test('a subcommand is not a directory, however much it looks like one', () => {
  // `go test` names an operation. Reading its second word as a folder called `test` put the target
  // of every Go test run on the test surface rather than leaving it unknown.
  const [label] = classifyCall(bash('go test ./... 2>&1 | tail -40'), newContext())
  assert.equal(`${label?.category}/${label?.sub}`, 'verification/test')
  assert.equal(label?.target, 'unknown')
  // A real directory argument still resolves.
  const [real] = classifyCall(bash('go test ./internal/...'), newContext())
  assert.equal(real?.target, 'code')
})
