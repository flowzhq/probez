import { createHash, randomBytes } from 'node:crypto'

import { DIRECTORY_TARGETS, documentSub, isProse, pathsIn, targetOf, writesToFile } from './act.js'
import { parsePlaced } from './bash.js'
import { probesOfCommand, siteOf, termsOf } from './trail.js'
import type { Round, ToolCall } from './types.js'

/**
 * Turning an export into one that can be sent to someone.
 *
 * An export is otherwise verbatim — prompts, shell commands and file paths exactly as typed — which
 * makes the one thing it exists for, putting a trace in a bug report, the one thing it cannot
 * safely do. Darkening replaces everything readable and keeps everything countable.
 *
 * Two treatments, and which one a field gets is the whole design:
 *
 * - **Prose is replaced.** A prompt and an assistant's reply become `****`. Nothing downstream reads
 *   their text, and their sizes are already recorded elsewhere — every round carries a `chars` on
 *   the `user_message` and `text` events, so no size is lost by blanking the field it came from.
 * - **Structure is pseudonymized.** A path, a command and a search term are read by the analyzer,
 *   so blanking them would keep the byte counts and throw away the measurements: `targetOf` reads a
 *   path to say what kind of file was worked on, `pathsIn` reads them back out of shell commands,
 *   which is over half a real store, and a trail is built by noticing that two calls named the same
 *   thing. Each distinct value is replaced by a stable token instead, in a shape that answers those
 *   questions the same way the original did.
 *
 * The invariant the tests hold this to: for every path, `targetOf`, `isProse` and `documentSub`
 * give the same answer before and after; for every command, so do the command names and kinds.
 *
 * It is one-way. The tokens are salted with bytes generated for that export and thrown away, so
 * nothing here can be undone, and two exports of the same project share no tokens.
 */

/** What a blanked value reads as, anywhere a person will see one. */
export const DARK = '****'

/**
 * A token is hex with a letter in front, and deliberately has no `*` in it.
 *
 * `pathsIn` refuses any argument holding a shell metacharacter, `*` among them, so a darkened path
 * spelled with asterisks would be skipped when it appeared inside a command — and the target axis
 * for `Bash` calls would go dark along with it. The leading letter keeps a token from ever being
 * read as a number.
 */
const TOKEN = /^d[0-9a-f]{8}$/

/** The keys whose value is a path, which is exactly the list `pathOf` reads. */
const PATH_KEYS = new Set(['file_path', 'notebook_path', 'path', 'url'])

/** The keys whose value is a shell command, which is what `commandOf` reads. */
const COMMAND_KEYS = new Set(['command', 'cmd'])

/**
 * The keys a trail follows a call by.
 *
 * `trail.ts` decides that two calls are part of one search by seeing the same term twice, so these
 * have to stay distinct from one another even though none of them can stay readable. They become
 * tokens rather than `****`, which would collapse every search in a session into one.
 */
const TERM_KEYS = new Set(['pattern', 'query', 'description'])

/** One export's tokens: the salt that makes them unguessable, and what has been issued so far. */
export interface Tokens {
  salt: string
  /**
   * The directory the project was worked in, so a path can be reduced to one place before it is
   * darkened.
   *
   * A `Read` records an absolute path and a shell command records a relative one, and a trail only
   * works because `siteOf` folds those two into the same place — against probez's own store, 206 of
   * 290 absolute paths, every one of them the fetch half of a pair. Darkening the two spellings
   * separately would give one file two tokens and break every one of those pairs.
   */
  root: string
  issued: Map<string, string>
}

/**
 * Somewhere to keep an export's tokens.
 *
 * The salt is random per export unless one is passed, which the tests do to get a stable answer. A
 * fresh salt is what stops two exports of the same project from being lined up against each other:
 * without it the same path would darken to the same token every time, and a token that is stable
 * across exports is a name.
 */
export function newTokens(root = '', salt = randomBytes(16).toString('hex')): Tokens {
  return { salt, root, issued: new Map() }
}

/** The token for one value, the same every time within one export and never twice for two. */
function token(tokens: Tokens, kind: string, value: string): string {
  const key = `${kind}\0${value}`
  const had = tokens.issued.get(key)
  if (had !== undefined) return had
  const made = `d${createHash('sha256').update(`${tokens.salt}\0${key}`).digest('hex').slice(0, 8)}`
  tokens.issued.set(key, made)
  return made
}

/**
 * Directory names the target table itself knows, which are kept rather than replaced.
 *
 * Every one of them is a convention — `src`, `tests`, `docs`, `k8s` — so keeping them says nothing
 * about the sender, and it is what lets a darkened path still sit under a darkened directory. A
 * trail's commonest edge is exactly that containment: search a tree, then open a file inside it.
 */
const KNOWN_SEGMENTS = new Set([...Object.keys(DIRECTORY_TARGETS), '.claude', '.github', 'workflows'])

/** One segment of a path: kept when it is a convention, replaced when it is a name. */
function segment(tokens: Tokens, part: string): string {
  const lower = part.toLowerCase()
  return KNOWN_SEGMENTS.has(lower) ? lower : token(tokens, 'path', lower)
}

/** Whether a rebuilt path is read exactly the way the original was. */
function reads(as: string, like: string): boolean {
  return (
    targetOf(as) === targetOf(like) &&
    isProse(as) === isProse(like) &&
    (!isProse(like) || documentSub(as) === documentSub(like))
  )
}

/**
 * A path replaced by one that is read the same way and says nothing.
 *
 * Segment by segment rather than whole, because two of a trail's three edges are about how paths
 * relate to one another: one sits under another, or a search term appears in one's name. A single
 * token for a whole path loses both — `src` and `src/pay.go` become two unrelated words, and the
 * walk from searching a tree to opening a file in it stops existing.
 *
 * So the conventions stay (`src`, `tests`, `docs`), the names go, and the leaf is tried in
 * increasing order of what it has to keep: a bare token first, then a token still marked as a test,
 * then the name itself — which is only ever reached for a name the classifier knows by heart, like
 * `package.json` or `README.md`, and those are nobody's secret. The last resort is a path built
 * from the answer alone.
 */
export function darkenPath(tokens: Tokens, path: string): string {
  if (path === '') return ''
  // Reduced to one place first, so the same file spelled two ways darkens to one token — and so
  // the answers are read off the same spelling the tokens were made from.
  const place = siteOf(path, tokens.root)
  if (place === '') return ''

  const parts = place.split('/')
  const base = parts.pop() ?? ''
  const dirs = parts.filter((part) => part !== '').map((part) => segment(tokens, part))
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
  // Made from the stem rather than the whole file name, because that is what a probe is matched
  // against: `stem()` drops the extension before asking whether a search term is in the name. A
  // token over `pay.go` could never equal the token a search for `pay` gets.
  const id = segment(tokens, dot > 0 ? base.slice(0, dot) : base)

  const under = (leaf: string): string => [...dirs, leaf].join('/')
  for (const leaf of [
    ext === '' ? id : `${id}.${ext}`,
    `${id}.test.${ext}`,
    `${id}_test.${ext}`,
    base,
  ]) {
    const out = under(leaf)
    if (reads(out, place)) return out
  }

  // Nothing built out of the original's own shape reads the way it did. Fall back to a path made
  // only of the answers, which is always right and keeps nothing but them.
  return template(tokens, place, id)
}

/** A path built from the classifier's answers alone, for when nothing else reproduces them. */
function template(tokens: Tokens, place: string, id: string): string {
  const target = targetOf(place)
  const prose = isProse(place)
  if (target === 'external') return prose ? `https://${id}/docs/${id}.md` : `https://${id}/`
  const leaf = prose ? `${id}.md` : ''
  switch (target) {
    case 'agent':
      return `.claude/${prose ? leaf : id}`
    case 'tests':
      return `tests/${prose ? leaf : `${id}.ts`}`
    case 'docs':
      switch (documentSub(place)) {
        case 'agent':
          return `docs/${id}/claude.md`
        case 'change':
          return `docs/changelog-${id}.md`
        default:
          return `docs/${id}.md`
      }
    case 'infra':
      return prose ? `deploy/${leaf}` : `deploy/${id}.yml`
    case 'config':
      return prose ? `docs/${leaf}` : `${id}.config.json`
    case 'code':
      return prose ? `docs/${leaf}` : `${id}.ts`
    default:
      return prose ? `docs/${leaf}` : id
  }
}

/**
 * A shell command replaced by one that classifies the same way.
 *
 * What survives is the command's own name and the paths it named, because those are what is
 * measured: the name decides the kind of work, and `pathsIn` reads the arguments back out to give a
 * `Bash` call a target. Everything else — flags, messages, patterns, the credential somebody typed
 * on a command line — is replaced, and the arguments are where all of that lives.
 *
 * A command the table does not recognize is itself replaced by a token. It classifies as `other`
 * either way, so nothing is lost by it, and an unrecognized name is exactly the case where the name
 * is the sender's own: an internal deploy script rather than `git`.
 */
export function darkenCommand(tokens: Tokens, command: string): string {
  const placed = parsePlaced(command)
  if (placed.length === 0) return DARK

  // A program and its subcommand are not paths, however much `go test` looks like a directory
  // called `test`. `bashActs` excludes them the same way before reading a call's target, and
  // reading them back in here would invent a path the original never named.
  const words = new Set(placed.flatMap((one) => one.name.split(' ')))
  // Read from the whole line, once, exactly as `bashActs` reads it — and put back on the first
  // command, because a call gives every command in it the same path anyway. Doing it per command
  // would put a path where the original never had one, and change which path comes first.
  const paths = pathsIn(command, words).map((found) => darkenPath(tokens, found))

  let out = ''
  for (const [i, one] of placed.entries()) {
    // `kind` is `other` for everything the table has no entry for, which is the same thing as
    // "this name is the sender's, not a tool everyone has".
    const name = one.kind === 'other' ? token(tokens, 'command', one.name) : one.name
    const segment = [name, ...probeArgs(tokens, one), ...(i === 0 ? paths : []), DARK].join(' ')
    // Whether a command ran on its own or was reading another's output decides whether it counts
    // as work at all — `bashActs` calls a command scaffolding only when every use of it was
    // downstream — so the joins are put back as they were rather than flattened to one.
    out = i === 0 ? segment : `${out} ${one.piped ? '|' : '&&'} ${segment}`
  }

  // Whether a command wrote a file is the single largest correction the classifier makes, and the
  // evidence for it is a redirect or a heredoc rather than anything in the command's name. Without
  // this every write in a darkened export arrives as a read.
  const writes = writesToFile(command)
  if (writes === null) return out
  // A resolved destination goes back as a redirect to the darkened form of itself, so the write
  // still names a file and that file still classifies the way it did.
  if (writes !== '') return `${out} > ${darkenPath(tokens, writes)}`
  // A heredoc whose destination could not be read. The verb is the evidence, and it has to sit
  // after everything else: the path scan stops at the first `<<`.
  return `${out} << 'EOF'\nwrite_text\nEOF`
}

/**
 * What a command was looking for, put back where the reader will find it.
 *
 * A trail is half paths and half *probes* — the words a call asked the repository about — and a
 * probe is read out of the arguments: for a search it is the first bare one, for `find` it is the
 * value of a `-name`. Dropping the arguments wholesale takes every shell probe with them, and a
 * trail that was rooted at a search stops existing. Worse, the first path would then be sitting
 * where the pattern goes and would be read as one.
 *
 * The terms are the same tokens a `Grep` pattern gets, so a search run one way and the same search
 * run the other still meet.
 */
function probeArgs(tokens: Tokens, placed: Parameters<typeof probesOfCommand>[0]): string[] {
  const probes = probesOfCommand(placed).map((term) => token(tokens, 'path', term))
  if (probes.length === 0) return []
  const [head] = placed.name.split(' ')
  // Joined with a hyphen, never a pipe: `TERM` stops at any non-word character so either splits the
  // terms back out, but a pipe is a pipe — the command reader would cut the segment there and read
  // the second term as a command of its own.
  const joined = probes.join('-')
  return head === 'find' ? ['-name', joined] : [joined]
}

/**
 * A tool call's arguments, walked key by key.
 *
 * Keys are kept: they are the tool's own schema — `file_path`, `old_string` — and say nothing about
 * the person using it. Values are replaced, by the rule their key implies. Anything that is not a
 * string is already a number, a flag or a shape, and is left alone.
 */
export function darkenInput(tokens: Tokens, input: unknown, key = ''): unknown {
  if (typeof input === 'string') {
    if (PATH_KEYS.has(key)) return darkenPath(tokens, input)
    if (COMMAND_KEYS.has(key)) return darkenCommand(tokens, input)
    if (key === 'pattern') {
      // Term by term, and joined so the reader splits them back out the same way. A pattern with
      // nothing identifier-shaped in it still needs to stay distinct from the next one.
      // The same namespace a path segment uses: a search for `pay` and the file `pay.go` are the
      // pair an edge is built out of, and they only meet if the two darken to the same word.
      const terms = termsOf(input).map((term) => token(tokens, 'path', term))
      return terms.length === 0 ? token(tokens, 'term', input) : terms.join('-')
    }
    if (TERM_KEYS.has(key)) return token(tokens, 'term', input)
    return DARK
  }
  if (Array.isArray(input)) {
    // A command can arrive as argv rather than a line. Joining it back would change the shape the
    // sender sent, so each part is darkened where it stands and the command reader still finds it.
    if (COMMAND_KEYS.has(key)) return [darkenCommand(tokens, input.filter((p) => typeof p === 'string').join(' '))]
    return input.map((one) => darkenInput(tokens, one, key))
  }
  if (input !== null && typeof input === 'object') {
    const out: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
      out[name] = darkenInput(tokens, value, name)
    }
    return out
  }
  return input
}

/** One tool call: its name and every measurement kept, its arguments darkened. */
function darkenTool(tokens: Tokens, tool: ToolCall): ToolCall {
  return {
    ...tool,
    // An MCP tool's name is the server's, and a server can be an internal one. A built-in tool is
    // the same everywhere and is the thing being counted.
    name: tool.name === null ? null : darkenToolName(tokens, tool.name),
    input: darkenInput(tokens, tool.input),
  }
}

/** An MCP tool is named for its server; everything else is a name every probez knows. */
function darkenToolName(tokens: Tokens, name: string): string {
  return name.startsWith('mcp__') ? `mcp__${token(tokens, 'mcp', name)}` : name
}

/**
 * One round, darkened.
 *
 * Everything not named here is carried through untouched, which is every number, every timestamp,
 * every enum and every id. Ids are opaque strings the harness generated and hold no content, and
 * they have to keep pairing with one another for `probez task` and `probez round` to resolve on the
 * other side.
 */
export function darkenRound(tokens: Tokens, round: Round): Round {
  return {
    ...round,
    darkened: true,
    // A commit hash names a repository that can be looked up. Replaced by something of the same
    // shape, so anything reading it still sees a hash.
    commit: round.commit === null ? null : commitToken(tokens, round.commit),
    mcp_server: round.mcp_server === null ? null : token(tokens, 'mcp', round.mcp_server),
    mcp_tool: round.mcp_tool === null ? null : token(tokens, 'mcp', round.mcp_tool),
    skill: round.skill === null ? null : token(tokens, 'skill', round.skill),
    user_text: round.user_text === '' ? '' : DARK,
    text: round.text === '' ? '' : DARK,
    tools: round.tools.map((tool) => darkenTool(tokens, tool)),
    // A person's name. Tokened like the rest, so the people in one export can still be told apart
    // and filtered, and none of them can be named.
    ...(round.committer === undefined ? {} : { committer: darkenCommitter(tokens, round.committer) }),
  }
}

/** Who recorded a round, as a darkened export names them. */
export function darkenCommitter(tokens: Tokens, name: string): string {
  return token(tokens, 'committer', name)
}

/** A hash the same length as the one it replaces, so it still reads as a commit. */
function commitToken(tokens: Tokens, commit: string): string {
  const made = createHash('sha256')
    .update(`${tokens.salt}\0commit\0${commit}`)
    .digest('hex')
  return made.slice(0, commit.length)
}

/**
 * The manifest a bundle carries, darkened.
 *
 * The name, the directory the agent ran in, the store directory and the key are all paths on the
 * sender's machine, and the key is the path with its separators swapped. They are tokenized rather
 * than dropped: the importer reads `slug`, `path` and `key` as the sender's identity, and that is
 * what makes re-importing the same file replace the project instead of landing a second copy. A
 * token is stable within the file, so it keeps working.
 */
export function darkenManifest(tokens: Tokens, manifest: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...manifest }
  for (const key of ['project', 'name', 'path', 'key', 'dir', 'source_dir', 'slug']) {
    const value = manifest[key]
    if (typeof value === 'string' && value !== '') out[key] = token(tokens, 'project', value)
  }
  if (Array.isArray(manifest.committers)) {
    out.committers = manifest.committers.map((name) => (typeof name === 'string' ? darkenCommitter(tokens, name) : name))
  }
  out.darkened_at = new Date().toISOString()
  return out
}

/**
 * The unclassified rows of a bundle's analysis.
 *
 * Each row is named for the tool or command that could not be read, which is the one place an
 * unrecognized name — a private binary, an internal MCP server — reaches the analysis. The weights
 * are the figure and are kept.
 */
export function darkenUnclassified(
  tokens: Tokens,
  rows: { name: string; weight: number }[],
): { name: string; weight: number }[] {
  return rows.map((row) => ({ ...row, name: token(tokens, 'command', row.name) }))
}

/** Whether a string is one of this module's tokens, which is what the tests assert against. */
export function isToken(value: string): boolean {
  return TOKEN.test(value)
}
