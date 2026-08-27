import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  discoverClaudeProjects,
  discoverCodexProjects,
  discoverCursorProjects,
  discoverProjects,
  matchProjects,
  mergeProjects,
} from '../src/discover.js'
import { pathFromCursorSlug } from '../src/agents/paths.js'
import type { Project } from '../src/types.js'

function workspace(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'probez-discover-')))
}

test('Cursor discovery walks nested agent-transcripts including subagents', async () => {
  const root = workspace()
  const cursorDir = join(root, 'cursor')
  const slug = 'Users-me-Dev-demo'
  const session = join(cursorDir, slug, 'agent-transcripts', 'aaaa1111-0000-0000-0000-000000000000')
  mkdirSync(join(session, 'subagents'), { recursive: true })
  writeFileSync(join(session, 'aaaa1111-0000-0000-0000-000000000000.jsonl'), ' {}\n')
  writeFileSync(join(session, 'subagents', 'bbbb2222.jsonl'), ' {}\n')

  const projects = await discoverCursorProjects(cursorDir)
  assert.equal(projects.length, 1)
  assert.equal(projects[0]!.path, pathFromCursorSlug(slug))
  assert.equal(projects[0]!.path_inferred, true)
  assert.deepEqual(projects[0]!.sources, ['cursor'])
  const ids = projects[0]!.sessions.map((s) => s.id).sort()
  assert.deepEqual(ids, [
    'aaaa1111-0000-0000-0000-000000000000/aaaa1111-0000-0000-0000-000000000000',
    'aaaa1111-0000-0000-0000-000000000000/subagents/bbbb2222',
  ])
  assert.ok(projects[0]!.sessions.every((s) => s.source === 'cursor'))
})

test('Claude discovery finds the subagents beside the session that spawned them', async () => {
  const root = workspace()
  const claudeDir = join(root, 'claude')
  const project = join(claudeDir, '-tmp-demo')
  const uuid = 'aaaa1111-0000-0000-0000-000000000000'
  mkdirSync(join(project, uuid, 'subagents'), { recursive: true })
  writeFileSync(join(project, `${uuid}.jsonl`), '{"cwd": "/tmp/demo"}\n')
  writeFileSync(join(project, uuid, 'subagents', 'agent-bbbb2222.jsonl'), '{"cwd": "/tmp/demo"}\n')
  // Only `subagents/` is followed. Anything else the agent keeps beside its transcripts is not a
  // session, and picking one up would make it one — named, archived and listed like the rest.
  mkdirSync(join(project, 'memory'), { recursive: true })
  writeFileSync(join(project, 'memory', 'notes.jsonl'), '{"cwd": "/tmp/demo"}\n')

  const projects = await discoverClaudeProjects(claudeDir)
  assert.equal(projects.length, 1)
  assert.deepEqual(projects[0]!.sessions.map((s) => s.id).sort(), [
    uuid,
    `${uuid}/subagents/agent-bbbb2222`,
  ])
  assert.ok(projects[0]!.sessions.every((s) => s.source === 'claude-code'))
})

test('Claude and Cursor checkouts of the same path merge into one project', async () => {
  const root = workspace()
  // Cursor infers the path from the folder name, and dashes in a temp directory would decode as
  // extra segments. A dash-free checkout is the case where the two sources actually agree.
  const project = realpathSync(mkdtempSync(join('/tmp', 'probezwork')))

  const claudeDir = join(root, 'claude')
  mkdirSync(join(claudeDir, 'encoded'), { recursive: true })
  writeFileSync(
    join(claudeDir, 'encoded', 'sess.jsonl'),
    `{"type":"user","cwd":${JSON.stringify(project)},"message":{"role":"user","content":"hi"}}\n`,
  )

  const cursorDir = join(root, 'cursor')
  const slug = project.replaceAll('/', '-').replace(/^-/, '')
  mkdirSync(join(cursorDir, slug, 'agent-transcripts', 'sid'), { recursive: true })
  writeFileSync(join(cursorDir, slug, 'agent-transcripts', 'sid', 'sid.jsonl'), '{}\n')

  const merged = await discoverProjects({ claudeDir, cursorDir, codexDir: join(root, 'codex') })
  assert.equal(merged.length, 1)
  assert.equal(merged[0]!.path, project)
  assert.equal(merged[0]!.path_inferred, false)
  assert.deepEqual(merged[0]!.sources?.slice().sort(), ['claude-code', 'cursor'])
  assert.equal(merged[0]!.sessions.length, 2)
})

test('a measured cwd outranks an inferred Cursor path on merge', () => {
  const claude: Project = {
    key: 'encoded',
    path: '/Users/me/Dev/my-repo',
    dir: '/tmp/claude',
    sessions: [
      { id: 'c', file: '/tmp/c.jsonl', size: 1, mtimeMs: 2, source: 'claude-code' },
    ],
    lastActivity: 2,
    sources: ['claude-code'],
  }
  const cursor: Project = {
    key: 'Users-me-Dev-my-repo',
    path: '/Users/me/Dev/my/repo',
    path_inferred: true,
    dir: '/tmp/cursor',
    sessions: [{ id: 'k', file: '/tmp/k.jsonl', size: 1, mtimeMs: 3, source: 'cursor' }],
    lastActivity: 3,
    sources: ['cursor'],
  }
  // Same resolved path only when slug decode happens to match. This case checks the
  // measured-cwd preference when the two already share a path.
  cursor.path = '/Users/me/Dev/my-repo'
  const merged = mergeProjects([cursor, claude])
  assert.equal(merged.length, 1)
  assert.equal(merged[0]!.path_inferred, false)
  assert.equal(merged[0]!.key, 'encoded')
})

test('--source cursor skips Claude projects', async () => {
  const root = workspace()
  const claudeDir = join(root, 'claude')
  mkdirSync(join(claudeDir, 'encoded'), { recursive: true })
  writeFileSync(join(claudeDir, 'encoded', 'sess.jsonl'), '{}\n')
  const cursorDir = join(root, 'none')
  const found = await discoverProjects({ claudeDir, cursorDir, codexDir: join(root, 'codex'), source: 'cursor' })
  assert.equal(found.length, 0)
})

test('discoverClaudeProjects still finds a flat session directory', async () => {
  const root = workspace()
  const claudeDir = join(root, 'claude')
  mkdirSync(join(claudeDir, 'encoded'), { recursive: true })
  writeFileSync(join(claudeDir, 'encoded', 'sess.jsonl'), '{}\n')
  const found = await discoverClaudeProjects(claudeDir)
  assert.equal(found.length, 1)
  assert.equal(found[0]!.sessions[0]!.source, 'claude-code')
})

test('a Cursor checkout whose directory name contains dashes is still that directory', async () => {
  const project = join(realpathSync(mkdtempSync(join('/tmp', 'probezwork'))), 'flowz-agentic-sdlc')
  mkdirSync(project)
  const slug = project.replaceAll('/', '-').replace(/^-/, '')
  const cursorDir = join(workspace(), 'cursor')
  mkdirSync(join(cursorDir, slug, 'agent-transcripts', 'sid'), { recursive: true })
  writeFileSync(join(cursorDir, slug, 'agent-transcripts', 'sid', 'sid.jsonl'), '{}\n')

  const found = await discoverCursorProjects(cursorDir)
  assert.equal(found.length, 1)
  assert.equal(found[0]!.path, project)
  assert.equal(matchProjects(found, project).length, 1)
})

test('Codex discovery walks the dated tree and groups rollouts by cwd', async () => {
  const root = workspace()
  const project = join(root, 'work')
  mkdirSync(project, { recursive: true })
  const day = join(root, 'codex', '2026', '01', '06')
  mkdirSync(day, { recursive: true })
  const meta = (cwd: string, id: string): string =>
    JSON.stringify({
      timestamp: '2026-01-06T00:00:00.000Z',
      type: 'session_meta',
      payload: { id, cwd, originator: 'codex_cli_rs', cli_version: '0.50.0', source: 'cli' },
    }) + '\n'
  writeFileSync(
    join(day, 'rollout-2026-01-06T00-00-00-cccc3333-0000-0000-0000-000000000000.jsonl'),
    meta(project, 'cccc3333-0000-0000-0000-000000000000'),
  )
  writeFileSync(
    join(day, 'rollout-2026-01-06T01-00-00-eeee5555-0000-0000-0000-000000000000.jsonl'),
    meta(project, 'eeee5555-0000-0000-0000-000000000000'),
  )
  writeFileSync(join(day, 'notes.jsonl'), meta(project, 'not-a-rollout'))

  const projects = await discoverCodexProjects(join(root, 'codex'))
  assert.equal(projects.length, 1)
  assert.equal(projects[0]!.path, project)
  assert.deepEqual(projects[0]!.sources, ['codex'])
  assert.equal(projects[0]!.sessions.length, 2)
  assert.ok(projects[0]!.sessions.every((s) => s.source === 'codex'))
  assert.ok(
    projects[0]!.sessions.every((s) => s.id.startsWith('2026/01/06/rollout-')),
  )
})

test('Claude and Codex checkouts of the same path merge into one project', async () => {
  const root = workspace()
  const project = join(root, 'work')
  mkdirSync(project, { recursive: true })

  const claudeDir = join(root, 'claude')
  mkdirSync(join(claudeDir, 'encoded'), { recursive: true })
  writeFileSync(
    join(claudeDir, 'encoded', 'sess.jsonl'),
    `{"type":"user","cwd":${JSON.stringify(project)},"message":{"role":"user","content":"hi"}}\n`,
  )

  const day = join(root, 'codex', '2026', '01', '06')
  mkdirSync(day, { recursive: true })
  writeFileSync(
    join(day, 'rollout-2026-01-06T00-00-00-cccc3333-0000-0000-0000-000000000000.jsonl'),
    JSON.stringify({
      timestamp: '2026-01-06T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'cccc3333', cwd: project, originator: 'codex_cli_rs', cli_version: '0.1.0', source: 'cli' },
    }) + '\n',
  )

  const merged = await discoverProjects({
    claudeDir,
    cursorDir: join(root, 'none-cursor'),
    codexDir: join(root, 'codex'),
  })
  assert.equal(merged.length, 1)
  assert.equal(merged[0]!.path, project)
  assert.deepEqual(merged[0]!.sources?.slice().sort(), ['claude-code', 'codex'])
  assert.equal(merged[0]!.sessions.length, 2)
})

test('--source codex skips Claude projects', async () => {
  const root = workspace()
  const claudeDir = join(root, 'claude')
  mkdirSync(join(claudeDir, 'encoded'), { recursive: true })
  writeFileSync(join(claudeDir, 'encoded', 'sess.jsonl'), '{}\n')
  const found = await discoverProjects({
    claudeDir,
    cursorDir: join(root, 'none'),
    codexDir: join(root, 'none-codex'),
    source: 'codex',
  })
  assert.equal(found.length, 0)
})

