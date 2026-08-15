# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). It is published to npm as
[`probez-cli`](https://www.npmjs.com/package/probez-cli); the installed command is `probez`.

## [Unreleased]

### Changed

- Wording throughout the docs, the `--help` text and the CLI's own messages no longer leans on the
  em-dash. Footers and errors read as plain sentences instead: `+442 rounds, 5 sessions read`,
  `… 52 more, --limit 0 for all`, `"x" is not a round selector. Try 3.12 or fe64e716#3.12`. The
  em-dash survives only as the placeholder glyph for a missing value in a table cell. No behaviour
  changed, but anything grepping probez's output for those strings needs updating.
- The package description and the README headline now match the CLI's own one-liner: "See what your
  coding agents actually did."

### Fixed

- `src/store.ts` used a raw NUL byte as an in-memory key separator, which made git record the file
  as binary, leaving no diff, no blame and no line-level review on the one file that performs
  every write, and made plain `grep` skip it. The separator is now written as a `\u0000` escape,
  which is byte-identical at runtime.

### Known issues

- `--limit` is accepted but ignored by `sessions`, `session`, `tasks` and `task`; only `rounds` and
  `tools` honour it.
- `--session` on `tasks` is validated and then discarded, so a bad id errors while a good one
  silently lists every session's tasks.
- Flags are parsed globally, so a flag a command does not use is accepted and ignored rather than
  refused, `--kinds` outside `tools` being one example. The documentation now states each flag's
  scope; enforcing it is a v0.2 change, since refusing a flag that used to be tolerated can break an
  existing invocation.

## [0.1.0] - 2026-08-15

First release.

### Added

- **`probez collect [project]`** normalizes a coding agent's session logs into one record per LLM
  round, appended to `~/.probez/projects/<project>/rounds.jsonl`. Takes a project path, a project
  name, or any parent folder holding several; `--all` sweeps the machine. Incremental by default,
  so re-running appends only what is new and writing twice in a row changes nothing; `--full`
  re-reads everything and repairs a store. A verbatim copy of each session file is kept alongside
  the rounds, since agents prune their own logs.
- **Bare `probez`** collects the project for the current directory and prints its summary: sessions,
  tasks, rounds, tokens, date span, top tools.
- **`probez projects`** lists every project on this machine, with its path, session count and last
  activity. Scratch directories, `$TMPDIR` and `/tmp`, are left out here and from `--all`,
  because a harness that runs an agent per test case turns one benchmark into dozens of throwaway
  projects.
  `--include-temp` brings them back, and naming one directly always works.
- **Reading the store back, at every level it records.** A list and a detail view for each:
  `probez sessions` and `probez session <id>`, `probez tasks` and `probez task <id>`,
  `probez rounds` and `probez round <id>`. A task is one user turn and everything the agent did
  about it, subagents included; a round is one LLM call.
- **Ids are the path down to the thing they name**, each level extending the one above it:
  `504799b8`, `504799b8#3`, `504799b8#3.12`. Any unique prefix of the session works, since the
  tables print its first eight characters, and the session comes off entirely when the project has
  only one. Tasks and rounds are both numbered inside their session, so neither number means
  anything without it, and a round id carries its task so the two kinds can never be confused.
- **`probez tools [project]`** lists every tool the project called, with errors, result size and
  time. `Bash` breaks down further into the commands it ran (`grep`, `git commit`, `go test`), since
  unlike every other tool its name is not its operation. `--kinds` groups those commands by the kind
  of work instead: `search`, `read`, `edit`, `vcs`, `test`, `build`, `deps`, `run`, `net`, `proc`,
  `nav`, `shell`, `other`.
- **Filters on `probez rounds`:** `--session`, `--task`, `--tool`, `--command`, `--kind`,
  `--agent main|sub`, `--errors`, `--limit`. `--command git` also matches `git commit`, the way the
  tools table names it.
- **`--json` on every command** that prints a result, for the analysis stages that read the same
  file.

### Notes

- Zero runtime dependencies, no network calls, and nothing written outside probez's own data
  directory. The first two are checked in CI rather than left to convention; the third is a property
  of the code, with every write rooted at the data directory. See `CONTRIBUTING.md`.
- Reading a shell command is deliberately shallow: quoting is respected, heredoc bodies and command
  substitutions are skipped, and a line that cannot be read confidently is reported as `(unparsed)`
  rather than guessed at. Measured against a store of 6,455 Bash calls, that leaves 0.3% unparsed
  and 6% landing in `other`, which means "not in the table" rather than "unclassifiable".
- Counting caveat, repeated wherever the numbers appear: a command is counted once per Bash call it
  appears in, so `cd repo && npm test` counts for both and the sub-rows total more than the calls
  above them. Errors, result size and time belong to the call, which has one result and one
  duration, so every command in a multi-command call is charged the whole of it.

[Unreleased]: https://github.com/flowzhq/probez/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/flowzhq/probez/commits/v0.1.0
