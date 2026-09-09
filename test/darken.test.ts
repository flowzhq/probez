import assert from 'node:assert/strict'
import { test } from 'node:test'

import { documentSub, isProse, pathsIn, targetOf } from '../src/act.js'
import { parseCommands } from '../src/bash.js'
import {
  DARK,
  darkenCommand,
  darkenInput,
  darkenManifest,
  darkenPath,
  darkenRound,
  darkenUnclassified,
  isToken,
  newTokens,
} from '../src/darken.js'
import type { Round, ToolCall } from '../src/types.js'
import { ROUND_DEFAULTS, TOOL_DEFAULTS } from './support.js'

/** A fixed salt, so a test can name the token it expects rather than only its shape. */
const tokens = (): ReturnType<typeof newTokens> => newTokens('', 'a-fixed-salt')

/**
 * Real paths, one per target and then some.
 *
 * The point of the table is breadth: every branch of `targetOf` should be walked by something here,
 * because the invariant below is only as good as the paths it is asked about.
 */
const PATHS = [
  'src/compose/composer.go',
  'internal/loop.ts',
  'lib/render.py',
  'src',
  'components',
  'test/composer_test.go',
  'src/gates.test.ts',
  'tests/e2e/checkout.spec.ts',
  '__tests__/render.tsx',
  'docs/PRD.md',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'notes/design.mdx',
  'package.json',
  'tsconfig.json',
  'vitest.config.ts',
  '.env.local',
  '.prettierrc',
  'go.mod',
  'Dockerfile',
  'docker-compose.yml',
  'k8s/deployment.yaml',
  'terraform/main.tf',
  'deploy/values.yaml',
  '.claude/settings.json',
  '.claude/skills/graphify/SKILL.md',
  'CLAUDE.md',
  'https://example.com/docs/page',
  'some/unreadable/thing',
  'a-bare-word',
]

test('a darkened path is read exactly the way the real one was', () => {
  const t = tokens()
  for (const path of PATHS) {
    const dark = darkenPath(t, path)
    assert.equal(targetOf(dark), targetOf(path), `target changed for ${path} -> ${dark}`)
    assert.equal(isProse(dark), isProse(path), `prose changed for ${path} -> ${dark}`)
    if (isProse(path)) {
      assert.equal(documentSub(dark), documentSub(path), `document kind changed for ${path} -> ${dark}`)
    }
  }
})

test('a darkened path keeps none of the original in it', () => {
  const t = tokens()
  const dark = darkenPath(t, 'src/billing/acme_secret_customer.go')
  assert.ok(!dark.includes('acme'))
  assert.ok(!dark.includes('billing'))
  assert.ok(!dark.includes('secret'))
  assert.equal(targetOf(dark), 'code')
})

test('the same value darkens to the same token, and two values do not collide', () => {
  const t = tokens()
  assert.equal(darkenPath(t, 'src/a.ts'), darkenPath(t, 'src/a.ts'))
  assert.notEqual(darkenPath(t, 'src/a.ts'), darkenPath(t, 'src/b.ts'))
})

test('two exports of the same project share no tokens', () => {
  // Without a fresh salt per export, the same path would darken the same way every time, and a
  // token stable across exports is a name.
  assert.notEqual(darkenPath(newTokens(), 'src/a.ts'), darkenPath(newTokens(), 'src/a.ts'))
})

test('a darkened path carries no character a shell reader would refuse', () => {
  // `pathsIn` drops any argument holding a metacharacter, so a token spelled with asterisks would
  // vanish out of every command it appeared in and take the target axis with it.
  const t = tokens()
  for (const path of PATHS) assert.ok(!/[*?$`(){}<>|&!]/.test(darkenPath(t, path)))
})

const COMMANDS = [
  'git commit -m "fix the auth bug"',
  'git status',
  'npm test',
  'npm run build',
  'tsc --noEmit',
  'cat README.md',
  'grep -rn flush src',
  'head src/loop.ts',
  'cd web && npm run dev',
  'go test ./...',
  'docker build -t thing .',
]

test('a darkened command runs the same commands, of the same kinds', () => {
  const t = tokens()
  for (const command of COMMANDS) {
    const dark = darkenCommand(t, command)
    assert.deepEqual(parseCommands(dark), parseCommands(command), `${command} -> ${dark}`)
  }
})

/** The exclude set `bashActs` builds before reading a call's paths: the command's own words. */
const words = (command: string): Set<string> =>
  new Set(parseCommands(command).flatMap((one) => one.name.split(' ')))

test('the files a command named are still named, and still read the same way', () => {
  const t = tokens()
  for (const command of COMMANDS) {
    const before = pathsIn(command, words(command))
    const dark = darkenCommand(t, command)
    const after = pathsIn(dark, words(dark))
    assert.equal(after.length, before.length, `path count changed for ${command}`)
    for (const [i, path] of before.entries()) {
      assert.equal(targetOf(after[i]!), targetOf(path), `target changed for ${path} in ${command}`)
    }
  }
})

test('what a command carried other than its name and its files is gone', () => {
  const t = tokens()
  const dark = darkenCommand(t, 'git commit -m "revert the acme-billing rollout"')
  assert.ok(!dark.includes('acme'))
  assert.ok(!dark.includes('rollout'))
  assert.ok(dark.startsWith('git commit'))
})

test('a command probez does not recognise is itself replaced', () => {
  const t = tokens()
  const dark = darkenCommand(t, 'acme-deploy --env prod')
  assert.ok(!dark.includes('acme-deploy'))
  assert.ok(!dark.includes('prod'))
  // It classified as `other` before and does now, so the figure it feeds is unchanged.
  assert.deepEqual(
    parseCommands(dark).map((one) => one.kind),
    parseCommands('acme-deploy --env prod').map((one) => one.kind),
  )
})

test('an input is walked by key: paths and commands by their rules, prose blanked', () => {
  const t = tokens()
  const dark = darkenInput(t, {
    file_path: 'src/secret_name.ts',
    old_string: 'const KEY = "sk-live-4242"',
    new_string: 'const KEY = process.env.KEY',
    limit: 200,
    all: true,
    nothing: null,
  }) as Record<string, unknown>

  assert.equal(targetOf(dark.file_path as string), 'code')
  assert.ok(!(dark.file_path as string).includes('secret_name'))
  assert.equal(dark.old_string, DARK)
  assert.equal(dark.new_string, DARK)
  // Keys are the tool's own schema and say nothing about the person; numbers and flags are figures.
  assert.equal(dark.limit, 200)
  assert.equal(dark.all, true)
  assert.equal(dark.nothing, null)
})

test('a search term becomes a token rather than a blank, so a trail can still follow it', () => {
  const t = tokens()
  const one = darkenInput(t, { pattern: 'flushQueue' }) as Record<string, unknown>
  const two = darkenInput(t, { pattern: 'flushQueue' }) as Record<string, unknown>
  const other = darkenInput(t, { pattern: 'drainQueue' }) as Record<string, unknown>
  assert.equal(one.pattern, two.pattern)
  assert.notEqual(one.pattern, other.pattern)
  assert.ok(isToken(one.pattern as string))
})

const tool = (over: Partial<ToolCall>): ToolCall => ({ ...TOOL_DEFAULTS, ...over })

const round = (over: Partial<Round>): Round => ({ ...ROUND_DEFAULTS, ...over })

test('a round keeps every measurement it had, and none of its prose', () => {
  const t = tokens()
  const before = round({
    session: 'a-session',
    id: 'msg_01',
    ts: '2026-09-09T10:00:00.000Z',
    ms: 1200,
    gen_ms: 3400,
    model: 'claude-opus-5',
    in_tokens: 208130,
    in_cache_read: 207020,
    out_tokens: 1307,
    thinking_chars: 940,
    commit: 'a'.repeat(40),
    user_text: 'please fix the acme billing bug',
    text: 'I have changed the composer.',
    tools: [
      tool({
        name: 'Edit',
        id: 'toolu_01',
        input: { file_path: 'internal/acme/billing.go', old_string: 'x' },
        input_chars: 3045,
        result_chars: 175,
      }),
    ],
    events: [
      { type: 'user_message', ts: '2026-09-09T10:00:00.000Z', chars: 31 },
      { type: 'text', ts: '2026-09-09T10:00:02.000Z', chars: 28 },
    ],
  })

  const after = darkenRound(t, before)

  assert.equal(after.darkened, true)
  assert.equal(after.user_text, DARK)
  assert.equal(after.text, DARK)

  // Everything countable, byte for byte. The sizes of the two blanked fields are on the events,
  // which is why blanking them loses nothing.
  for (const key of [
    'session', 'round', 'task', 'agent', 'id', 'ts', 'ms', 'gen_ms', 'wait_ms',
    'first_input', 'model', 'in_tokens', 'in_uncached', 'in_cache_write',
    'in_cache_write_5m', 'in_cache_write_1h', 'in_cache_read', 'out_tokens', 'thinking_chars',
  ] as const) {
    assert.deepEqual(after[key], before[key], `${key} changed`)
  }
  assert.deepEqual(after.events, before.events)

  const [call] = after.tools
  assert.equal(call?.name, 'Edit')
  assert.equal(call?.id, 'toolu_01')
  assert.equal(call?.input_chars, 3045)
  assert.equal(call?.result_chars, 175)
  assert.equal(targetOf((call?.input as { file_path: string }).file_path), 'code')
})

test('an empty prose field stays empty rather than becoming a blank', () => {
  // A round that said nothing is different from one whose words were taken out, and the round
  // counts that read `text` for emptiness should keep seeing what they saw.
  const after = darkenRound(tokens(), round({ user_text: '', text: '' }))
  assert.equal(after.user_text, '')
  assert.equal(after.text, '')
})

test('a commit is replaced by something still shaped like a commit', () => {
  const after = darkenRound(tokens(), round({ commit: 'a'.repeat(40) }))
  assert.match(after.commit ?? '', /^[0-9a-f]{40}$/)
  assert.notEqual(after.commit, 'a'.repeat(40))
})

test('an mcp server and a skill are named by token, not by their own names', () => {
  const t = tokens()
  const after = darkenRound(
    t,
    round({
      mcp_server: 'acme-internal',
      mcp_tool: 'acme-internal__deploy',
      skill: 'acme-runbook',
      tools: [tool({ name: 'mcp__acme-internal__deploy' })],
    }),
  )
  for (const value of [after.mcp_server, after.mcp_tool, after.skill]) {
    assert.ok(!(value ?? '').includes('acme'))
  }
  // Still recognisable as an MCP call, which is what the mcp figures count.
  assert.ok(after.tools[0]?.name?.startsWith('mcp__'))
  assert.ok(!after.tools[0]?.name?.includes('acme'))
})

test('a manifest keeps an identity to be recognised by, and none of the sender paths', () => {
  const t = tokens()
  const dark = darkenManifest(t, {
    project: 'acme-billing',
    path: '/Users/alice/work/acme-billing',
    key: '-Users-alice-work-acme-billing',
    dir: '/Users/alice/.probez/projects/acme-billing-11112222',
    slug: 'acme-billing-11112222',
    source_dir: '/Users/alice/.claude/projects/-Users-alice-work-acme-billing',
    rounds: 652,
    sessions: 8,
  })

  for (const value of Object.values(dark)) {
    if (typeof value === 'string') assert.ok(!value.includes('alice') && !value.includes('acme'))
  }
  // Counts are the point of a manifest and are untouched.
  assert.equal(dark.rounds, 652)
  assert.equal(dark.sessions, 8)
  // Identity survives as a stable token, which is what makes a re-import replace rather than double.
  assert.ok(isToken(dark.slug as string))
  assert.equal(dark.slug, darkenManifest(t, { slug: 'acme-billing-11112222' }).slug)
  assert.equal(typeof dark.darkened_at, 'string')
})

test('the unclassified rows are named by token and keep their weights', () => {
  const t = tokens()
  const rows = darkenUnclassified(t, [
    { name: 'acme-deploy', weight: 12 },
    { name: 'pnpm', weight: 3 },
  ])
  assert.deepEqual(
    rows.map((row) => row.weight),
    [12, 3],
  )
  for (const row of rows) assert.ok(!row.name.includes('acme'))
})

test('nothing a person typed survives anywhere in a darkened round', () => {
  const t = tokens()
  const secrets = ['sk-live-4242', 'acme-billing', 'alice', 'flushQueue', 'revert the rollout']
  const after = darkenRound(
    t,
    round({
      user_text: 'alice here: revert the rollout on acme-billing',
      text: 'I ran flushQueue against sk-live-4242',
      tools: [
        tool({
          name: 'Bash',
          input: { command: 'git commit -m "revert the rollout" acme-billing/src/pay.go' },
        }),
        tool({ name: 'Grep', input: { pattern: 'flushQueue', path: '/Users/alice/work/acme-billing' } }),
        tool({ name: 'Edit', input: { file_path: '/Users/alice/work/acme-billing/src/pay.go', new_string: 'sk-live-4242' } }),
      ],
    }),
  )

  const text = JSON.stringify(after)
  for (const secret of secrets) assert.ok(!text.includes(secret), `${secret} survived darkening`)
})
