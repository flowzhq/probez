# Contributing to probez

Thanks for taking the time. Issues, bug reports, and pull requests are all welcome.

## Development setup

Requires Node 20 or newer. There is nothing else to install beyond the dev dependencies.

```bash
git clone https://github.com/flowzhq/probez.git
cd probez
npm install
npm run build         # tsc, then vite build
npm test              # build, then node --test
```

`npm run logos` regenerates the view's logos and favicon from the source art in `web/assets` into
`web/public`. It is not part of the build — the outputs are committed — so run it only when the
source art changes. It has a note at the top about why the dark logo is derived rather than used.

The build has two halves and either can be run alone. `npm run build:cli` is `tsc`, emitting the
CLI to `dist/src`. `npm run build:web` is `vite build`, emitting the frontend `probez view` serves
to `dist/view`. `npm test` needs both, because one test asserts the served page loads nothing from
off-origin.

Run the local build against your own sessions:

```bash
node dist/src/cli.js projects
node dist/src/cli.js collect ~/some/project --data-dir /tmp/probez-dev
node dist/src/cli.js view --data-dir /tmp/probez-dev
```

Use `--data-dir` while developing so you never touch your real `~/.probez` store.

For the frontend, `npm run dev` starts Vite with hot reload on its own port and proxies `/api` to a
`probez view` running alongside it on the default port. Start that first, then open the dev server
with the token it printed:

```bash
node dist/src/cli.js view --no-open       # prints http://127.0.0.1:7373/?t=<token>
npm run dev                               # then open http://localhost:5173/?t=<token>
```

## The rules that shape this codebase

Three constraints are not up for negotiation in a PR, because they are the product:

1. **Zero runtime dependencies.** `package.json` has no `dependencies` block and will not grow one.
   Node's standard library covers everything probez does. `typescript` and `@types/node` are
   development-only.
2. **No outbound network.** probez never opens a connection to anything. A PR that adds an HTTP
   client, telemetry, or an upload path will be declined regardless of how it is gated.

   `probez view` *listens*, which is the one thing on this side of the line, and it is fenced in:
   it binds `127.0.0.1` and nothing else, every request must carry a token that is new on every run
   and must arrive with a matching `Host` header, and the served page may load only from its own
   origin. CI checks each of those separately, so relaxing one is a visible change to this file
   rather than a quiet one to a grep.

   There is one place probez *starts a program*, and it is named here so it stays a decision rather
   than a precedent: `src/reader.ts`, which is how `probez explain` hands one question to a model
   the person already has. It is the answer to the request this rule would otherwise refuse — read
   these eleven greps back to me in a sentence — and it is arranged so that the refusal still holds
   everywhere it matters:

   - probez opens no socket. It writes to the stdin of a command *the person wrote into
     `<data-dir>/reader.json`* and reads its stdout. Whatever that command talks to, it talks to
     under their account with their credentials, exactly as if they had typed it. probez holds no
     key and has nowhere to put one.
   - The command is argv and is spawned with `shell: false`. A `;`, a `|` or a `$(…)` in it is an
     argument. Nothing read out of a session, a path or a project name can reach the argv.
   - It runs only from `probez explain` and from the `explain` POST — one question, when a person
     asks for that question. Collecting, analyzing, browsing and every `GET` run nothing.
   - What is written to it is the question's own calls: the verb, the scope, the words searched for,
     the paths named, and the command as it ran. No prompts, no tool output. `probez explain <id>
     --prompt` prints exactly what would go and spawns nothing, which is also the supported way to
     use this without probez running anything at all.
   - There is no default command. With no `reader.json` there is nothing to run, and every caller
     says so rather than falling back to something.
   - Nothing that comes back enters a share, a tally or a filter. A reading sits beside the measured
     `kind` and never replaces it, so every number probez prints stays re-derivable from the rounds.

   CI greps for `child_process` outside `src/open.ts` and `src/reader.ts`, and for `shell: true` and
   `exec` inside them, so a second spawn anywhere fails the build the way a second reflog reader
   does. A PR that wants one needs to argue for it the way this list does.
3. **Only ever read the agent's session files.** probez writes exclusively under its own data
   directory.

   There is one read outside them, and it is named here so it stays a decision rather than a
   precedent: `src/git.ts` opens `.git/logs/HEAD` in the directory the agent ran in, to say which
   commit a task started from. It is one plain text file, opened read-only, and nothing is
   executed — there is no `git` subprocess, and probez behaves the same on a machine with no git
   installed. CI greps for it, so a second reader anywhere else fails the build rather than
   arriving quietly, and a PR that wants one needs to argue for it the way this paragraph does.

   The view's routes that write are all `POST`, and there are seven: `.../sync` writes what `collect`
   and `analyze` write, `.../rename` sets one field of a manifest, `.../delete` removes one project's
   directory, `.../explain` keeps what a reader said about one question, `/import` writes a project
   that arrived as a file, `/pricing` stores rates, and `/reader` stores the command `explain` runs.
   Every
   other route is `GET`, and each of these refuses `GET` so that visiting a URL can never collect,
   rename, delete, or start a program. Export is not an exception to the rule: the server hands bytes to the browser
   and the browser writes them where the person said, which is the only way a page can put a file on
   disk.

   `delete` is the only thing anywhere in probez that destroys data, and it stays inside the same
   fence: the slug is checked against the shape `slugFor` produces *and* the resolved path is checked
   to be under `<data-dir>/projects/`, so nothing outside probez's own directory is reachable. The
   agent's session files are not among the things it removes.

## Code style

- TypeScript, `strict` mode, ES modules, `node:`-prefixed imports.
- Prefer streaming over reading whole files, since session logs get large. The read commands are
  the one exception: they hold a single project's rounds in memory, because filtering and sorting
  need the whole set and a store is a few megabytes even after months.
- No formatter or linter config yet; match the surrounding code.

## Tests

Tests use the built-in `node:test` runner, with no framework, and they run against the compiled
output in `dist/test/`, which is why `npm test` builds first.

- `test/extract.test.ts` covers the extractor with a golden test over a fixture session in
  `test/fixtures/`. If you change how a round is assembled, add a fixture case that fails without
  your change.
- `test/extract-cursor.test.ts` covers Cursor transcripts: one round per assistant row, tasks from
  `<user_query>`, synthetic tool ids, null usage, and subagent paths.
- `test/discover.test.ts` covers Cursor nested transcripts and merging Claude and Cursor checkouts
  of the same path into one project.
- `test/inspect.test.ts` covers the read side — session, task and tool aggregation, the work
  taxonomy's fractional split, the trace and its phase smoothing, round filters, and selector
  parsing — against rounds built in the test file itself, so it needs no fixture.
- `test/classify.test.ts` covers both halves of classification — `act.ts` reading a call down to its
  verbs, and `classify.ts` mapping a verb onto a category — including the invariants that every
  sub-kind the classifier emits is declared and every declared one is reachable, that the view's copy
  of the taxonomy matches this one, and that a round's labels always account for exactly one round.
- `test/bash.test.ts` covers reading a shell command into the commands it ran.
- `test/models.test.ts` covers the context-window table and the share derived from it, including
  that a model with no published window reports no share rather than a full one.
- `test/cli.test.ts` runs the built CLI end to end in a temporary store, so it touches neither
  `~/.claude`, `~/.cursor` nor `~/.probez`.
- `test/reading.test.ts` covers the reader and what it is asked: that the prompt carries the calls
  and neither the person's prompt nor any tool's output, that the command is argv and never reaches
  a shell, that a reader which fails, hangs, vanishes or answers in prose comes back as a message,
  that a `kind` outside the table becomes a named hole rather than a guess, and that a reading is
  kept, reused without running anything, and re-asked only when asked for.
- `test/view.test.ts` runs the local server in-process against a temporary store. The refusals are
  the reason it exists: no token, wrong `Host`, and the method rules — every write path refuses
  `GET` and every read path refuses everything but it. Beside them sit the assertion that the store
  is byte-identical after a session of browsing, and the ones saying that a sync, a rename or a
  delete without the token writes nothing at all. A new route that writes belongs in all of those
  lists, and a delete additionally has to be shown unable to point outside `<data-dir>/projects/`.
  `explain` is in them too, plus its own: that it refuses without the token, that it says so rather
  than falling back when no reader is configured, and that every refusal leaves the store untouched.

If you hit a real session that probez parses incorrectly, the most useful contribution is a minimal
fixture reproducing it. Please strip anything private before attaching it.

## Releasing

Every version bump goes through this list, in this order. Skipping a step is how the docs and the
code drift apart. Each item below has been wrong at least once.

1. **Sync the docs to what the code now does.**
   - `README.md`: the command table, and every `$ probez …` block. Regenerate those by *running*
     the command and pasting its output, including the project-header line; do not hand-edit them.
     Use a project you are not actively working in, or the numbers go stale the next time you run
     probez on this repo.
   - `src/cli.ts`: the `HELP` string is a third copy of the command list, after the README table
     and the changelog. It drifts silently because nothing compiles against it.
   - `docs/PRD.md`: anything describing what the current version delivers.
   - `CONTRIBUTING.md`: the dev commands and test layout, if either changed.
   - `SECURITY.md`: if what probez exposes changed.
2. **Move the changelog entries** out of `[Unreleased]` into a dated `## [x.y.z]` section, and add
   its compare link at the bottom.
3. **Bump the version** in `package.json`, then run `npm install --package-lock-only`.
   `probez --version` reads `package.json` and CI installs from the lockfile, so both have to move
   together.
4. **Verify**: `npm test` passes, `npm ls --omit=dev` is empty, and every README example still
   reproduces verbatim against a real store.
5. **Tag the release commit**: `git tag -a vX.Y.Z -m "probez vX.Y.Z"`. An untagged version cannot be
   checked out later, and the changelog's compare links have nothing to point at.
6. **Publish to npm**: `npm publish`, then `git push && git push --tags`. Check the tarball first
   with `npm publish --dry-run`. `files` ships `dist/src` and `dist/view`, and a build left stale by
   a failed `tsc` or a skipped `vite build` would go out unnoticed — a published CLI whose `view`
   has no frontend is the failure this check is for. npm releases cannot be replaced, only deprecated and superseded, so
   the version number is spent either way.

## Pull requests

- One concern per PR.
- Say what you observed and what changed. The PR template asks for both.
- `npm test` must pass. CI runs on Node 20 and 22.
