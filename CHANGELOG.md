# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). It is published to npm as
[`probez-cli`](https://www.npmjs.com/package/probez-cli); the installed command is `probez`.

## [0.3.0] - 2026-08-16

The record. 0.2 said what the work was; this says what it cost, how long it really took, and when it
failed without saying so.

### Added

- **Input tokens are kept as three numbers, not one.** `in_uncached`, `in_cache_write` and
  `in_cache_read` sit beside `in_tokens`, which still holds their sum. They are priced roughly 1×,
  1.25× and 0.1×, and on a store of 25,136 rounds 98.2% of what probez called "input" was cache
  reads — the figure weighting every percentage `analyze` prints was dominated by its cheapest
  component. `collect` and the round inspector now show the split.
- **`gen_ms` and `wait_ms` separate the model's time from the person's.** `ms` spans the records a
  round wrote, which misses the wait before the model said anything; `gen_ms` runs from the input
  that prompted the round. On one 442-round project the two are 0.66h and 1.82h. `wait_ms` is the
  time a round spent waiting on a person, and is null unless one was waited on.
- **`events[]`, the round's moments in file order** — `user_message`, `tool_result`, `reasoning`,
  `text`, `tool_call`, each with a timestamp, and the tool ones carrying the call id. This is what
  makes `gen_ms` re-derivable and a new timing question answerable without re-collecting.
- **What a tool actually did, beside what the harness said.** `is_error` reports that a call was
  accepted, not that it worked — a Bash call whose suite fails comes back `false`. `stderr_chars`
  and `interrupted` come from the raw result, and surface 471 failed calls across this machine's
  store that were recorded as successes. There is no exit code in the source records at all; these
  two are the whole of the real signal, which corrects an assumption in the v0.2 write-up.
- **`tools[].patch`** — the files, lines added and lines removed of an edit, folded from the result's
  structured patch. This is what a later version needs to attribute work to the files it changed
  rather than to the directory the agent was launched in.
- **`tools[].id`, `emitted_at`, `result_at` and `input_chars`.** A call now carries the id its result
  is matched on, both ends of its wall time, and the size it was before truncation, so a cut input
  still says how large it really was.
- **`mcp_server`, `mcp_tool` and `skill`**, read from the harness's own attribution. These name work
  a built-in tool table cannot place: on this machine they cover 17% of rounds, which is most of the
  16% of weight 0.2 reported as unclassified. The taxonomy does not spend them yet.

- **The view spends all of it.** Every level now carries the token split: a project, session and
  task each say how much of their input was reused from cache, with the exact three-way breakdown on
  hover, and the round inspector says it per round. "Where agent work goes" gains an **In** column,
  so a category that reads as a small share of rounds but a large share of context is visible as
  one; input is charged to work the same way rounds are, splitting across what a round did. Sessions
  and tasks gain **In** and **Lines**, and a task says how long it spent waiting on a person when it
  waited at all. The tools table gains a **Quiet** column — calls that wrote to stderr or were cut
  short while the harness reported no error. On one project Bash shows 4 errors against 15 quiet.
- **Every table breaks tokens out five ways** — Input, Write 5m, Write 1h, Read, Output — under the
  same names the Settings screen prices them by, so a column and a rate are visibly the same thing.
  It replaces the single `In` column, and it makes the shape of agent traffic hard to miss: on one
  project the work table reads 800 input against 63.4M read.
- **Sync and Export fold into one `⋮`**, on the project page and in the projects list alike — nobody
  opens either to sync, they open them to read what the agent did. The menu keeps the sentence that
  says what happened: an icon can say "sync", but only words can say *already up to date · 442
  rounds*. In a table row that sentence floats under the button rather than wrapping inside the
  cell, which used to re-flow every column while you were reading it.
- **Settings is a gear** in the header, beside the theme controls and sized like them — eight square
  teeth on a ring, deliberately not the rays-from-a-dot shape the light theme uses two controls
  along.
- **Cost in the header, and a mark on the words that need one.** A project, session and task each
  say what they cost — the whole span, not just the rounds that called a tool, so it is larger than
  the figure the shares divide and the coverage line still says which is which. `reused` and `cost`
  carry an ⓘ, because "reused" is a share of prompt-cache reads and nobody should be expected to
  infer that from six letters; a tooltip nothing points at is a tooltip nobody finds. It uses the
  same tooltip the charts do rather than the browser's `title`, which waits about a second, shows a
  bare `?` cursor in the meantime, and never appears at all for a keyboard user.

- **Token pricing, and a Settings screen to set it.** `probez view` gains **Settings**: one row per
  model, five rates each, in dollars per million tokens. They ship at the published list prices and
  are editable, because list prices move, negotiated rates exist, and a model probez has never heard
  of should not be silently free. Saved to `~/.probez/pricing.json`, owner-only, never sent
  anywhere; `POST /api/pricing` is the second and last route the view can write with, and every
  field is checked as a non-negative number before anything is stored.
- **Five rates, not four, because a cache write has two prices.** A 5-minute cache entry is billed
  at 1.25× the input rate and a 1-hour entry at 2×. That is not a rounding difference: on this
  machine's store 99.9% of cache writes are the 1-hour kind, so pricing them all at 1.25× would
  understate the cache-write bill by more than a third. `in_cache_write` now splits into
  `in_cache_write_5m` and `in_cache_write_1h`, read from `usage.cache_creation`.

- **Send a project to someone, and read one they sent you.** `probez export <project>` writes the
  store's rounds — `--bundle` for the one-document `.json` with the manifest and analysis, plain
  `.jsonl` otherwise — to stdout or to `--out`. `probez import <file>` reads either back, and so
  does **Import** on the projects page, which is also why `probez view` no longer refuses to open on
  an empty store: importing is how a store with nothing in it gets its first project. An import is
  someone else's work and is treated as such — nothing in it is executed, every field is checked and
  bounded, control characters are stripped from anything that reaches a terminal, the token totals
  are recomputed from their parts rather than believed, and where it lands is a hash of the sender's
  project identity rather than anything the file says. Re-importing replaces; the same project name
  from a different sender sits beside yours instead of over it. An export written before the token
  split is refused rather than priced at zero. See SECURITY.md.

### Changed

- **A share is now a share of money, not of rounds**, under "where agent work goes" in the view and
  in `probez analyze` alike. `ROUNDS` still says how much of the work a category was; `SHARE` says
  how much of the bill, and a new `COST` column says the amount. The two disagree, which is the
  point — a round of reconstruction reading a large file and a round of implementation writing one
  line are one round each and nothing like one dollar each. Cost is computed per round from its own
  model's rates and split across that round's work on the same weights as the rounds themselves.
  The coverage line names the denominator (`Shares are of the $57.90 they cost`) and names what
  sits outside it, now including any round whose model has no rate — reported rather than counted
  as free.
- **"Working" now means the time the model spent generating**, in the view and the CLI alike. It
  was the span of the records a round wrote, which misses the wait before the model said anything —
  most of a round. The trace's by-time lane lays each round out from the input that prompted it for
  the same reason, so the bars finally add up to the total printed above them. Tool execution is
  outside both, since a tool's result arrives as the next round's input. Task times move a long way:
  one task in the README goes from 863ms to 5.0s, another from 4.9m to 16.3m.
- **A store from an older schema is rebuilt on the next `collect`.** It could not be repaired by
  appending: the rounds already in the file are the old shape and the `session+id` filter dropped
  every replacement as a duplicate, so `--full` left a store exactly as it found it. The rebuild
  reads the session copies the store already keeps, including sessions the agent has since pruned,
  writes through a temporary file so an interrupted run leaves the old store intact, and drops the
  `analysis.jsonl` computed from the rounds it replaced. Nothing leaves the machine and no round is
  lost, but on a large store it is not instant.
- **A project name can be a directory anywhere it is a name.** `probez export ~/Dev/app` and
  `probez analyze ~/Dev/app` resolve the same way `probez collect` always has, matching the path the
  store recorded. And a machine with no agent directory at all is no longer a dead end: if the store
  has projects in it, the read commands work — which is the machine of somebody who was sent a file
  and has never run an agent.
- **The README is half its old length**, view first and CLI second, with real screenshots of a
  project and a session in place of the ASCII sketch of the trace. Badges are centred under the
  logo. Every `$ probez` block in it is still verbatim output.
- `rounds.jsonl` is about 60% larger for the fields above, measured by rebuilding a 22-project,
  14,000-round store: 20.3 MB to 32.4 MB. It remains roughly a tenth of the session copies beside
  it, which are unchanged.

## [0.2.0] - 2026-08-15

The analyzer, and the view. `collect` said how much; this says what of, and shows it.

### Added

- **`probez analyze` says what the work was.** Eight categories, each decomposed: Planning,
  Reconstruction, Implementation, Verification, Review, Documentation, Delivery and Environment,
  plus an Unclassified bucket that names what it could not place. A second axis, the target
  (`code`, `tests`, `docs`, `config`, `infra`, `agent`, `external`), separates reading the README
  from reading the router. `--by session` and `--by task` break the project down, `--split target`
  swaps the second level onto the target axis, and `--unclassified` lists what did not classify.
  Everything is derived from what 0.1 already collected, so an existing store analyses immediately
  with no re-collection.
- **Every share says what it is a share of.** A round splits across the work it did, so `ROUNDS` is
  fractional, and the denominator is rounds that called at least one tool. The coverage line under
  every table names what sits outside that: rounds of pure prose, work no table could classify, and
  how much of the work has a known target. Measured against a store of 13,098 rounds, that is 9.0%
  of rounds with no tool call and 16.0% of weight unclassified, nearly all of it MCP servers whose
  inputs are per-server and unknowable to a built-in table.
- **`probez rounds --category` and `--target`** read any share back down to the rounds behind it,
  beside the existing `--kind`.
- **`probez view` — a local profiler for agent work.** Starts a server on `127.0.0.1` and opens a
  browser at projects → project → session → task, with a round inspector under the task trace.
  `--port` picks the port, `--no-open` prints the URL instead. Naming a project opens it directly.
- **The trace.** A task's rounds laid out left to right in two registered rows: a ribbon of the
  phases the agent moved through, and a strip of the rounds themselves. Each round cell is a stack
  rather than a block, because a round's weight splits across the work it did. Click a round to open
  it in full; the arrow keys walk from one to the next. Past sixty rounds an overview lane appears
  with a brush on it, and the main rows draw the brushed range.
- **Two axes.** Round index by default, so every round stays clickable; wall-clock time behind a
  toggle, where the gaps are visible and a four-minute round is four minutes wide. `working` and
  `elapsed` are reported separately everywhere, because they are different numbers.
- **Sync and Export, per project**, on the project page and on each row of the list. Sync is
  `collect` then `analyze` on that one project, reporting what it did in the words the CLI would
  use, because "found nothing new" is the common outcome and worth saying. Export hands the data to
  the browser to save: `.jsonl` is the store's own file byte for byte, `.json` is a bundle carrying
  the manifest and the analysis around the same rounds. Where the browser has a folder picker you
  get one.
- `inspect.ts` gains `traceOf` and a pure `workIndex`; `store.ts` gains `listStored` and
  `findStored`, the first way to read a project back out of the store rather than discovering it
  from the agent's directory. A store stays browsable after the sessions it came from are gone.

### Changed

- **`sessions`, `tasks` and `rounds` gained a `WORK` column**, and `round <id>` labels each tool
  call it prints. This changes the output of commands that existed in 0.1, so anything parsing
  those tables needs updating. The column carries the share as well as the name, because a
  category that won at 34% describes its rounds very differently from one that won at 80%.
- **Constraint 2 is now "no outbound network" rather than "no network access".** probez still never
  opens a connection to anything. `view` listens, on loopback only, and CI checks five things
  separately: no outbound client, every listener binds `127.0.0.1`, `child_process` appears only in
  `src/open.ts` and only as an argv spawn, and the served page loads nothing off-origin.
- `dominant()` also returns the category id, which is what the view colours by.
- The published package now ships `dist/view` alongside `dist/src`.

### Fixed

- The CI constraints job could not pass. Its network grep matched `\bfetch\b`, and `git fetch` is in
  the command table in `classify.ts` — so the check failed on a string that is nothing but the name
  of a git subcommand. It now matches `fetch(` as a call.

### Security

- The view is access-controlled: every `/api` request must carry a token generated fresh on each
  run, and every request's `Host` header must be the address the server bound, which is the defence
  against DNS rebinding. Reading leaves the store byte-identical — unlike `analyze`, no `GET` here
  writes, and a test asserts it.
- `POST .../sync` is the only route that writes, and it refuses `GET`: a URL that collects when it
  is merely visited is a URL that can be put in an `<img>` tag. That one button changes what the
  token protects, and the docs say so — before it, the token stood between a page you did not open
  and reading your prompts; now it also stands between one and starting a collection.
- An export is a copy of the store outside the store's owner-only directory. probez does no
  redaction, so an export carries prompts, file paths and shell commands exactly as typed. The
  browser writes it, never probez, which is what keeps constraint 3 intact.

### Known limits

- **An operation is classified by what it is, not by what it was for.** A `grep` is `locate`
  whether it opened an hour of reconstructing an unfamiliar subsystem or checked in one second
  where a constant lives, which overstates Reconstruction. Telling those apart means reading a call
  in the light of the ones around it, a pass over a sequence rather than a lookup on a call. The
  round stream already carries what that needs; it is the next version's work, not new collection.
- **Repair, `trace`, `lint` and `ci` were designed and then cut**, each for a reason recorded in
  `docs/PRD.md`. Three of them were not detectable from what the store keeps, and two were under
  0.6% of a real store.

## [0.1.1] - 2026-08-15

Correctness and privacy fixes on top of the first release. No new commands.

### Security

- **The store is now owner-only.** Directories are created `0700` and files `0600`, matching the
  mode the agent already uses for the session files probez reads. 0.1.0 used the system default, so
  `rounds.jsonl` was world-readable at `0644` inside `0755` directories, publishing to every local
  account the prompts, assistant text and shell commands distilled from logs the agent had
  deliberately kept private. `collect` also tightens anything under the data directory it finds
  looser, so an existing store is repaired the next time you collect it. probez only ever removes
  access here, never grants it.

### Changed

- **A flag a command does not use is now refused rather than ignored.** `probez sessions --kinds`
  used to be accepted and silently dropped; it now exits 2 and says `--kinds` belongs to `tools`.
  This is the one breaking change: an invocation that passed a flag with no effect will start
  failing, which is the point. `--help` lists each flag under the command that takes it.
- **Lists paginate, detail views do not.** `sessions` and `tasks` now honour `--limit` and default
  to 50 rows like `rounds`, always saying how many they withheld. `session <id>` and `task <id>`
  name one thing, so they show all of it unless `--limit` is given. `--limit 0` still means
  everything.
- Wording throughout the docs, the `--help` text and the CLI's own messages no longer leans on the
  em-dash. Footers and errors read as plain sentences instead: `+442 rounds, 5 sessions read`,
  `… 52 more, --limit 0 for all`, `"x" is not a round selector. Try 3.12 or fe64e716#3.12`. The
  em-dash survives only as the placeholder glyph for a missing value in a table cell. Anything
  grepping probez's output for those strings needs updating.
- The package description and the README headline now match the CLI's own one-liner: "See what your
  coding agents actually did."

### Fixed

- **`--session` on `tasks` was validated and then discarded**, so a bad id errored while a good one
  silently listed every session's tasks. It now narrows the listing, the way it does on `rounds`.
- `src/store.ts` used a raw NUL byte as an in-memory key separator, which made git record the file
  as binary, leaving no diff, no blame and no line-level review on the one file that performs
  every write, and made plain `grep` skip it. The separator is now written as a `\u0000` escape,
  which is byte-identical at runtime.

### Added

- `test/cli.test.ts` covers the above end to end, building its own source tree and store so it
  depends on neither `~/.claude` nor `~/.probez`.

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

[Unreleased]: https://github.com/flowzhq/probez/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/flowzhq/probez/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/flowzhq/probez/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/flowzhq/probez/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/flowzhq/probez/commits/v0.1.0
