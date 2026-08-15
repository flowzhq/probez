# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). It is published to npm as
[`probez-cli`](https://www.npmjs.com/package/probez-cli); the installed command is `probez`.

## [Unreleased]

## [0.1.0] - 2026-08-15

First release.

### Added

- **`probez collect [project]`** — normalize a coding agent's session logs into one record per LLM
  round, appended to `~/.probez/projects/<project>/rounds.jsonl`. Takes a project path, a project
  name, or any parent folder holding several; `--all` sweeps the machine. Incremental by default,
  so re-running appends only what is new and writing twice in a row changes nothing; `--full`
  re-reads everything and repairs a store. A verbatim copy of each session file is kept alongside
  the rounds, since agents prune their own logs.
- **Bare `probez`** — collect the project for the current directory and print its summary: sessions,
  tasks, rounds, tokens, date span, top tools.
- **`probez projects`** — every project on this machine, with its path, session count and last
  activity. Scratch directories under `$TMPDIR` are left out, here and from `--all`, because a
  harness that runs an agent per test case turns one benchmark into dozens of throwaway projects.
  `--include-temp` brings them back, and naming one directly always works.
- **Reading the store back, at every level it records.** A list and a detail view for each:
  `probez sessions` and `probez session <id>`, `probez tasks` and `probez task <id>`,
  `probez rounds` and `probez round <id>`. A task is one user turn and everything the agent did
  about it, subagents included; a round is one LLM call.
- **Ids are the path down to the thing they name**, each level extending the one above it:
  `504799b8`, `504799b8#3`, `504799b8#3.12`. Any unique prefix of the session works, since the
  tables print its first eight characters, and the session comes off entirely when the project has
  only one. Tasks and rounds are both numbered inside their session, so neither number means
  anything without it — and a round id carries its task so the two kinds can never be confused.
- **`probez tools [project]`** — every tool the project called, with errors, result size and time.
  `Bash` breaks down further into the commands it ran (`grep`, `git commit`, `go test`), since
  unlike every other tool its name is not its operation. `--kinds` groups those commands by the kind
  of work instead: `search`, `read`, `edit`, `vcs`, `test`, `build`, `deps`, `run`, `net`, `proc`,
  `nav`, `shell`, `other`.
- **Filters on `probez rounds`** — `--session`, `--task`, `--tool`, `--command`, `--kind`,
  `--agent main|sub`, `--errors`, `--limit`. `--command git` also matches `git commit`, the way the
  tools table names it.
- **`--json` on every command**, for the analysis stages that read the same file.

### Notes

- Zero runtime dependencies, no network calls, and nothing written outside probez's own data
  directory. These are enforced in CI, not conventions — see `CONTRIBUTING.md`.
- Reading a shell command is deliberately shallow: quoting is respected, heredoc bodies and command
  substitutions are skipped, and a line that cannot be read confidently is reported as `(unparsed)`
  rather than guessed at. Measured against a store of 6,455 Bash calls, that leaves 0.3% unparsed
  and 6% landing in `other`, which means "not in the table" rather than "unclassifiable".
- Counting caveat, repeated wherever the numbers appear: a command is counted once per Bash call it
  appears in, so `cd repo && npm test` counts for both and the sub-rows total more than the calls
  above them. Errors, result size and time belong to the call — it has one result and one duration —
  so every command in a multi-command call is charged the whole of it.

[Unreleased]: https://github.com/flowzhq/probez/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/flowzhq/probez/commits/v0.1.0
