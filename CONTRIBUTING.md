# Contributing to probez

Thanks for taking the time. Issues, bug reports, and pull requests are all welcome.

## Development setup

Requires Node 20 or newer. There is nothing else to install beyond the dev dependencies.

```bash
git clone https://github.com/flowzhq/probez.git
cd probez
npm install
npm run build     # tsc
npm test          # build, then node --test
```

Run the local build against your own sessions:

```bash
node dist/src/cli.js projects
node dist/src/cli.js collect ~/some/project --data-dir /tmp/probez-dev
```

Use `--data-dir` while developing so you never touch your real `~/.probez` store.

## The rules that shape this codebase

Three constraints are not up for negotiation in a PR, because they are the product:

1. **Zero runtime dependencies.** `package.json` has no `dependencies` block and will not grow one.
   Node's standard library covers everything probez does. `typescript` and `@types/node` are
   development-only.
2. **No network access.** probez makes no outbound calls of any kind. A PR that adds an HTTP client,
   telemetry, or an upload path will be declined regardless of how it is gated. CI checks for this.
3. **Only ever read the agent's session files.** probez writes exclusively under its own data
   directory.

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
- `test/inspect.test.ts` covers the read side (session and tool aggregation, round filters, and
  selector parsing) against rounds built in the test file itself, so it needs no fixture.

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
   - `docs/PRD.md`: the roadmap row and anything describing what the current version delivers.
   - `CONTRIBUTING.md`: the dev commands and test layout, if either changed.
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
   with `npm publish --dry-run`. `files` ships `dist/src` only, and a build left stale by a failed
   `tsc` would go out unnoticed. npm releases cannot be replaced, only deprecated and superseded, so
   the version number is spent either way.

## Pull requests

- One concern per PR.
- Say what you observed and what changed. The PR template asks for both.
- `npm test` must pass. CI runs on Node 20 and 22.
