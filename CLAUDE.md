# probez — working notes for Claude

A local CLI that normalizes coding-agent session logs into one record per LLM round. Zero runtime
dependencies, no network calls, writes only under its own data directory. Those three are product
constraints, not preferences — see CONTRIBUTING.md.

## Releasing — run the checklist, every time

**Trigger:** any change to the `version` field in `package.json`, or an instruction that names a
version ("cut 0.2.0", "make this v0.1.2", "ship it", "release this"). Treat a version bump as the
start of the checklist, never as the whole job.

**Do:** every step of **CONTRIBUTING.md § Releasing**, in order — sync the docs (README examples
regenerated from real output, the `HELP` string in `src/cli.ts`, `docs/PRD.md` roadmap), move the
changelog entries into a dated section, bump `package.json` *and* the lockfile, verify,
`git tag -a vX.Y.Z`, then `npm publish` and push the commit and the tag.

**The two that get missed:** the git tag, and `npm install --package-lock-only` after the bump.
A release is not done until the tag exists and the version is on npm.

**Publishing is one-way.** A published version cannot be replaced, only deprecated and superseded.
Run `npm publish --dry-run` and read the file list before the real thing.

Do not report a version as complete while any step is outstanding. If a step is deliberately being
skipped, say which one and why.

## Where the command list lives

Adding or changing a command means editing four places. Nothing enforces this — no test compiles
against prose:

- `src/cli.ts` — the command itself and the `HELP` string
- `README.md` — the "Use" table, and the worked examples under "Digging in"
- `CHANGELOG.md` — under `[Unreleased]`
- `docs/PRD.md` — only if it changes what a milestone delivers

## Examples in docs are output, not prose

Every `$ probez …` block in the README is real terminal output. When behavior changes, re-run the
command and paste the result rather than editing the block by hand — including blank lines and the
project-header line the read commands print. Use a project other than this repo, whose store changes
every time probez runs on it.
