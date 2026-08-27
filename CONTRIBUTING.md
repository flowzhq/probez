# Contributing to probez

Thanks for taking the time. Issues, bug reports, and pull requests are all welcome.

## Development setup

Requires Node 20 or newer. There is nothing else to install beyond the dev dependencies.

```bash
git clone https://github.com/flowzhq/probez.git
cd probez
npm install
npm run build         # tsc, then a web typecheck and vite build
npm test              # build, then node --test
```

`npm run logos` regenerates the view's logos and favicon from the source art in `web/assets` into
`web/public`. It is not part of the build — the outputs are committed — so run it only when the
source art changes. It has a note at the top about why the dark logo is derived rather than used.

The build has two halves and either can be run alone. `npm run build:cli` is `tsc`, emitting the
CLI to `dist/src`. `npm run build:web` typechecks `web/` against its own tsconfig and then runs
`vite build`, emitting the frontend `probez view` serves to `dist/view`. The typecheck is there
because `vite build` does not do one: without it a payload field the server had grown and the page
was already reading would go untyped indefinitely. `npm test` needs both halves, because one test
asserts the served page loads nothing from off-origin.

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
   than a precedent: `src/reader.ts`. **Two** things call it, and both are named below, because the
   number is the point — a list of callers that grows without anyone noticing is how a fence becomes
   a suggestion. Adding a third means editing this paragraph and arguing for it.

   - `src/reading.ts`, which is how `probez explain` hands one question's calls to a model the
     person already has, and gets a sentence back. The request this rule would otherwise refuse:
     read these eleven greps back to me in English.
   - `src/asking.ts`, which is how `probez find --ask` hands one *sentence* to the same model and
     gets a **query** back. The request: I do not want to learn a query language to ask what last
     week cost.

   Both are arranged so that the refusal still holds everywhere it matters:

   - probez opens no socket. It writes to the stdin of a command *the person wrote into
     `<data-dir>/reader.json`* and reads its stdout. Whatever that command talks to, it talks to
     under their account with their credentials, exactly as if they had typed it. probez holds no
     key and has nowhere to put one.
   - The command is argv and is spawned with `shell: false`. A `;`, a `|` or a `$(…)` in it is an
     argument. Nothing read out of a session, a path or a project name can reach the argv.
   - It runs only from `probez explain`, `probez find --ask`, and the `explain` and `compile` POSTs
     — one question, when a person asks for that question. Collecting, analyzing, browsing, and
     every `GET` in the view run nothing. Both POSTs refuse `GET` for the same reason `delete` does.
   - What is written to it is bounded and named. For `explain`, the question's own calls: the verb,
     the scope, the words searched for, the paths named, and the command as it ran. For `--ask`,
     the field table, the values each field can take, and a sample of the names this store holds —
     tool names, command names, model names — with the person's sentence. **No prompts, no tool
     output, no file contents, either way.** `--prompt` on both prints exactly what would go and
     spawns nothing, which is also the supported way to use either without probez running anything.
   - There is no default command. With no `reader.json` there is nothing to run, and every caller
     says so rather than falling back to something.
   - **Nothing that comes back is a number, and nothing that comes back is believed.** A reading
     sits beside the measured `kind` and never replaces it. A compiled query is parsed by probez,
     refused outright if it does not read cleanly, shown before it runs, and editable — and it
     selects *which rounds* rather than producing a figure about them. Every total, share and row
     stays derived from the rounds, so a result compiled from a sentence is re-runnable by someone
     with no reader configured at all and comes out identical.

   One thing `--ask` does that `explain` does not, named because it is the weakest part: the sample
   of names in its prompt is text read out of session logs, and an imported project's logs were
   written on a machine that is not yours. They are stripped of control characters, bounded in
   length and in count, and labelled in the prompt as values to choose between. That is a mitigation
   and not a proof. What makes it acceptable is the bullet above — the only thing the answer can be
   is a query probez parses, which can filter rows and do nothing else. There is no path from what
   comes back to a command, a file, or a byte leaving this machine.

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

   The view's routes that write are all `POST`, and there are eight: `.../sync` writes what `collect`
   and `analyze` write, `.../rename` sets one field of a manifest, `.../delete` removes one project's
   directory, `.../explain` keeps what a reader said about one question, `/compile` keeps what one
   said about one sentence, `/import` writes a project
   that arrived as a file, `/pricing` stores rates, and `/reader` stores the command they run.
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
  `test/fixtures/`, including a subagent's own transcript beside the older layout that interleaved
  one into its parent's file. If you change how a round is assembled, add a fixture case that fails
  without your change.
- `test/extract-cursor.test.ts` covers Cursor transcripts: one round per assistant row, tasks from
  `<user_query>`, synthetic tool ids, null usage, and subagent paths.
- `test/extract-codex.test.ts` covers Codex rollouts: one round per model burst, tasks from
  `user_message`, usage from `token_count`, `shell` argv, `apply_patch`, and subagent metadata.
- `test/discover.test.ts` covers Cursor nested transcripts, Claude's subagent transcripts under the
  session that spawned them, Codex's dated tree grouped by cwd, and merging checkouts of the same
  path into one project.
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
  `~/.claude`, `~/.cursor`, `~/.codex` nor `~/.probez`.
- `test/reading.test.ts` covers the reader and what it is asked: that the prompt carries the calls
  and neither the person's prompt nor any tool's output, that the command is argv and never reaches
  a shell, that a reader which fails, hangs, vanishes or answers in prose comes back as a message,
  that a `kind` outside the table becomes a named hole rather than a guess, and that a reading is
  kept, reused without running anything, and re-asked only when asked for.
- `test/query.test.ts` covers the query language: precedence and negation, that printing a query
  and parsing it back gives the same tree, that every prefix of a real query parses without
  throwing, that an unfinished atom is neutral while a finished wrong one matches nothing, and that
  the flags on `rounds` compile to the tree a typed query produces — which is what keeps there from
  being two filter engines.
- `test/search.test.ts` covers what a query comes to: the share against the scope it was matched
  in, the grouped rows carrying the size of the whole group beside what matched, and that a task
  keeps its name when the round that named it is not among the matches.
- `test/searchindex.test.ts` is mostly one property, asserted query by query over every kind of
  field: the index and the rounds answer identically. Beside it, the cases that all mean "read the
  rounds instead" — no index, a stale one, one from a version this probez does not know, and a
  half-written one — and that a torn line keeps its place and matches nothing.
- `test/asking.test.ts` covers reading a sentence as a query. The refusals are the point: a query
  probez cannot read is quoted and thrown rather than run, an answer with no query in it says what
  the reader actually said, and a refused answer leaves nothing behind. Beside them, that the prompt
  carries the schema and the question and nothing else, that it is bounded, and that a query with no
  *filter* in it is kept — `in:sessions sort:cost limit:1` is the right answer to "what is the most
  expensive session", and refusing it was a real bug.
- `test/view.test.ts` runs the local server in-process against a temporary store. The refusals are
  the reason it exists: no token, wrong `Host`, and the method rules — every write path refuses
  `GET` and every read path refuses everything but it. Beside them sit the assertion that the store
  is byte-identical after a session of browsing, and the ones saying that a sync, a rename or a
  delete without the token writes nothing at all. A new route that writes belongs in all of those
  lists, and a delete additionally has to be shown unable to point outside `<data-dir>/projects/`.
  `explain` is in them too, plus its own: that it refuses without the token, that it says so rather
  than falling back when no reader is configured, and that every refusal leaves the store untouched.
  So is `compile`, which is the other route that starts a program, on the same terms. Searching and
  its facets are on the read side of all of it, including the byte-identical assertion — answering a
  query writes nothing, not even the index it is answered from.

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
