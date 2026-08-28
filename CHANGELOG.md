# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). It is published to npm as
[`probez-cli`](https://www.npmjs.com/package/probez-cli); the installed command is `probez`.

## [0.4.0] - 2026-08-28

### Added

- **`probez clear`, and a danger zone in the view: a way to give the disk back.** A store grows, and
  almost all of what it weighs is the verbatim copies of the agent's own transcripts kept beside the
  rounds — on the machine this was written on, 830 MB of 977. Until now the only way to reclaim any
  of it was to delete a whole project, one at a time, from the browser.

  Three shapes, one command: `probez clear <project>` takes one, `probez clear --all` takes every
  project, and `probez clear --before 30d` takes everything older than a window. The CLI had no
  delete at all before this.

  **A session is the unit of the window.** One whose last round is older than the cutoff goes
  entirely — its rounds and the archived transcript beside them — and one with any newer round stays
  whole. So a project you still work in keeps its recent work and gives up the rest, and a project
  left with nothing is removed. The alternative, trimming individual rounds, would have left the
  archived copies behind — which is to say almost all of the disk — or forced rewriting someone's
  transcript and left `trails --deep` reading a session that is half there.

  ```
  $ probez clear --before 14d

    would remove everything last active before 2026-08-13:

    flowz-agentic-sdlc       all of it   3744 rounds     55 MB
    flowz-mcp               5 sessions    442 rounds      6 MB

    2 projects touched · 1 removed entirely · 29 sessions · 4186 rounds · 61 MB freed

    Remove 4186 rounds from 2 projects? There is no undo. [y/N]
  ```

  **Nothing acts on the first press.** The plan is worked out, printed, and only then asked about —
  and it is the same plan the view shows in the panel that asks, so what you are shown and what
  happens cannot come apart. With no terminal to ask on, the command refuses rather than assuming,
  which is what makes `probez clear --all | tee log` safe; `--yes` is how a script says it means it.
  This is the first and only place probez waits for a person.

  A trim rewrites `rounds.jsonl` beside itself and moves the new file over the old one, so an
  interrupted clear leaves the store as it was rather than half of it. The manifest is recounted
  from what is left, the state stops claiming a cleared session was read, and the analysis and
  search index are removed rather than repaired — both are derived, and a stale index is the one
  thing worse than none. Rates and the reader are settings rather than projects and are never
  cleared.

- **`probez collect --since 30d`**, the companion: read only the sessions the agent has written to
  inside a window, so a first collect on a machine with years of history does not have to read all
  of it. A window on one run and nothing else — a session outside it is not recorded as read, so a
  later collect with no window reads it then. Never applied to a schema rebuild, which writes a new
  store from what it reads and would silently drop everything outside the window.

  The summary line counts sessions skipped by the window apart from sessions already up to date,
  because saying "unchanged" about one probez has never opened would be untrue about what is in the
  store.

- **Codex CLI rollouts.** `probez collect` reads OpenAI Codex sessions under `~/.codex/sessions`
  (or `$CODEX_HOME/sessions`) as well as Claude Code and Cursor. Codex writes one dated tree of
  `rollout-*.jsonl` files rather than a folder per project; discovery groups them by the `cwd` each
  rollout recorded, and a repository used by more than one agent is still one project.
  `--source claude|cursor|codex|all` (default `all`; `both` still means all three) and `--codex-dir`
  select which trees to walk. Token counts, when the rollout recorded them, are kept; cost stays
  blank until a rate exists for that model, the same as any other unpriced round.

- **Agent source is a filterable round dimension.** Every stored round records which product
  produced its session (`claude-code`, `cursor`, `codex`, or `unknown`). The field is stamped in the
  store after extraction, not inside each extractor. `--source` on `collect` and `projects` still
  selects which directories to scan. On read commands (`sessions`, `tasks`, `rounds`, `analyze`,
  `tools`, `find`, `trails`, `questions`, `view`) the same flag filters already-collected rounds and
  does not restrict discovery. `source:claude` in a query matches persisted `claude-code`. Schema 7
  rebuilds existing stores on the next collect; a missing or unrecognised source is `unknown`, never
  assumed Claude. In the view, the Source control is a page filter (same project layout, that
  agent's sessions); typing `source:` in the query bar is still a search. Neither changes what Sync
  collects. Mixed-source cost coverage stays explicit: rounds with no rate or no usage recorded are
  marked `+` / unpriced rather than invented. The query bar's magnifying glass runs the search, a
  completion already typed in full is not repeated under the box, and a clear control drops the
  current query and source filter.

### Changed

- **`delete` is no longer the only thing in probez that destroys data**, so SECURITY.md and
  CONTRIBUTING § rule 3 now describe three shapes of it rather than one. All of them go through the
  same fence — `ownDir`, which checks the slug against the shape `slugFor` produces *and* checks the
  resolved path to be under `<data-dir>/projects/` — and `test/clear.test.ts` asserts that by handing
  the applier a plan naming a path outside the store and checking the file there survives.

### Fixed

- **A model probez has not seen cannot be priced, which made Codex support unusable for cost.** The
  rate table under Settings is built from three things that have all already happened: models with
  rounds in the store, models the rate file names, and models with a published price. None of them
  can hold a model you have not run yet, and probez ships no OpenAI rates — so on a machine with no
  Codex sessions collected there was no Codex row, and no way to make one. The rate *file* has
  always accepted any name; there was simply nothing on screen that could type one.

  Settings now has an **Add a model** field. What it adds is an ordinary row, priced and saved by
  the same controls as the rest of the table, so it also covers a Claude model probez does not ship
  a rate for yet and a name an agent records differently than expected.

  This does not price Codex for you. `defaultPricing()` still ships no OpenAI models, so a Codex
  round stays unpriced — reported as `—` and counted outside COST — until somebody enters a rate.
  That is the same contract every unpriced model has had: a missing number rather than an invented
  one.

## [0.3.9] - 2026-08-26

### Added

- **`probez find`: one query over everything that has been collected.** Every read command until
  now addressed the round stream through a fixed hole — one flag per field, no way to combine two
  of them with an `or`, and nothing at all for the things no flag names: what a prompt said, what a
  command ran, what a round cost, when it happened. `probez find` is one grammar over the whole
  record instead. Bare words are free text over the prompts, the prose, the commands and the paths;
  `key:value` filters; `-` negates; one atom after another means and, `OR` is the other one, and
  brackets regroup.

  ```
  probez find 'category:reconstruction cost:>0.50 -tool:Read since:7d'
  probez find '(tool:Edit OR tool:Write) added:>200 in:tasks sort:cost'
  ```

  Thirty-one fields, listed under `probez help` with what each one reads: where a round sits
  (`project` `session` `task` `round` `commit` `model` `agent` `skill` `mcp`), what it did (`tool`
  `command` `kind` `category` `target`), what it came to (`cost` `ms` `gen` `wait` `input` `output`
  `cached` `thinking` `calls` `errors` `files` `added` `removed`), when it happened (`since`
  `before`), and the plain properties (`is:error` `is:quiet` `is:compacted` `is:sub` `has:patch` …).
  Magnitudes are read against the field they were written for, so `input:>2m` is two million tokens
  and `gen:>2m` is two minutes.

- **A result is a re-scoped profile, not a list of rows.** What comes back first is the share:
  *4 rounds · $2.32 · 2.8% of cost · 3 sessions · 81% reconstruction*. Four rounds is a count; 2.8%
  of what a project cost is a finding. The idea is pprof's `-focus`, which does not filter a listing
  but recomputes the profile over what survived, and it costs nothing here because the same
  `categoryTally`, `sessionRows` and `taskRows` every other page is built from are what run over the
  matches. `--json` carries all of it — totals, scope, share, distribution and rows.

  `--in` says what the matched rounds are then counted as: `rounds` (the default), `tasks`,
  `sessions`, `projects`, `questions` or `trails`. A session matches when a round inside it does,
  and the row reports the rounds that matched with the size of the whole session beside them, so a
  task that spent six of its seventy-one rounds on what was asked for reads as six rather than
  seventy-one. A task is still named by the prompt that opened it even when that round is not one of
  the ones that matched.

  `--all` searches every project in the store. `--sort` puts the big end of a magnitude first;
  `sort:`, `limit:` and `in:` can be written into the query instead.

- **A half-typed query is read the same way a finished one is.** A search box is typed into one
  character at a time, so the parser spends most of its life looking at `cost:>`, `"unclosed` and
  `categor`. None of those is an error: each yields a tree plus a diagnostic carrying the span it is
  about, printed under the part of the query it refers to, and everything else still runs. A value
  that is merely missing is neutral rather than empty, so a list narrows as a query is completed
  instead of blanking out halfway through a word. A key that is nearly a field says which one it was
  nearly (`did you mean category:?`); a value a field cannot take names the near miss and matches
  nothing, because a finished wrong thought is not the same as an unfinished one. `--plan` prints
  that reading on its own and touches no store at all.

- **A search index, so a query does not have to read the rounds.** `collect` and `analyze` now
  write `search.jsonl` beside `analysis.jsonl` in each project's store: one column per field a
  query can name, one slot per round, plus an inverted index over the words of every prompt, every
  command and every path. A query is answered from those columns, and `rounds.jsonl` is opened only
  for the rounds that actually matched — by byte offset, so a search that matched four hundred of
  fifty thousand rounds reads four hundred rounds' worth of bytes rather than the whole file.

  It is about a fifth the size of the rounds it describes and takes a few hundred milliseconds to
  build. On a 93 MB store of 48,000 rounds across 307 projects, `find --all` went from 1.4 s to
  300 ms, and a single project from 260 ms to 60 ms.

  Two things are deliberately not in it. **Cost** is not, because rates are a setting: what is
  stored is the five token counts and a model, and a price is worked out at query time, so a
  corrected rate cannot leave a stale figure behind. **Questions and trails** are not, because both
  read a run of calls across a whole project and neither can be answered from the part of it that
  matched — `in:questions` and `in:trails` read the rounds and the result says so.

  The index is derived data in the strict sense: deleting it costs speed and nothing else. A
  missing one, a stale one, one from a version this probez does not know, and a half-written one all
  mean the same thing — read the rounds — and `find` says in its footer how many projects had to be.
  `find` itself never writes one.

- **A query bar in `probez view`, on every page.** `/` or ⌘K focuses it. Fields complete from the
  same table the parser validates against, and their values from what the store actually holds —
  `tool:` offers the eleven tools this project has really called, each with the rounds it is in,
  because a list of tools in general is a list you still have to know the answer to use. The counts
  are a pass over an index column, so offering them costs nothing.

  The results page leads with the share, not the rows: the totals, what fraction of the searched
  projects they are, where they are concentrated, and the distribution of the matched work drawn by
  the same bar every other page uses. Tabs say what the matched rounds are counted as — rounds,
  tasks, sessions, projects, questions or trails — and a grouped row shows what matched with the
  size of the whole group beside it.

  The query is the URL, so a result is a link. Clicking a round opens its task with the query still
  attached, and **the trace arrives with the matching rounds lit and the rest of the task drawn
  around them**: what is worth seeing is where in the task the matches fall, which a filtered list
  cannot show. A note above the trace says how many matched and offers the way back out.

  A half-typed query is shown the same way at the command line and in the browser: what could not be
  read is quoted with what it was nearly, and the rest of the query still runs.

  Two new endpoints, both `GET` and both refusing `POST`, because answering a query writes nothing —
  not even the index, which `Sync` builds beside the analysis cache: `/api/search` and `/api/facets`.

- **`probez find --ask`, and an *ask* mode in the view: a question instead of a query.** Hands
  what you typed to the command in `<data-dir>/reader.json` — the same one `explain` uses, your own
  LLM, hosted or local — and gets back **a query**, not an answer. probez parses it, refuses it
  outright if it does not read cleanly, shows it, and only then answers it by exactly the path a
  typed query takes.

  ```
  $ probez find --ask "which sessions had the most failing shell commands"

    probez read "which sessions had the most failing shell commands" as

      tool:Bash is:error in:sessions sort:errors
  ```

  That distinction is the whole of why this is allowed under the no-outbound-network rule: **a model
  chooses which rounds to look at and never what any of them came to.** Every total, share and row
  stays derived from the rounds, so a result compiled from a sentence is re-runnable by someone with
  no reader configured and comes out identical — and the query is one you can correct by hand.

  What is sent is the field table, the values each field can take, and a sample of the names this
  store holds (tool names, command names, model names), with your question. About five kilobytes,
  and it does not grow with the store. **Nothing you typed to the agent and nothing any tool
  returned, ever.** `--prompt` prints exactly what would go and runs nothing, which is also how to
  use this with a chat already open. With no `reader.json` there is nothing probez can run and every
  caller says so. Answers are held in `<data-dir>/asked.json` and keyed by the store they were asked
  of, so the same question is not paid for twice; `--again` asks afresh.

  In the view the box has two modes, shown as two controls at its head, so what Enter is about to do
  is readable without pressing it — one of the two spends tokens on somebody else's program. What
  comes back lands in the bar to be checked and edited, and the URL is an ordinary search URL with
  the question carried alongside as a caption. Landing on a result puts the box back in query mode,
  because a result is a query.

  This is the second thing in probez that starts a program, and CONTRIBUTING § rule 2 now names both
  callers of `src/reader.ts` and what would have to be argued to add a third.

### Changed

- **Free text matches a word or the start of one, rather than any substring anywhere.** `tok` finds
  `tokens`; `oken` no longer does, and `"npm test"` no longer finds `pnpm test`. This is the rule
  every search box uses, and it is also the only rule an index can answer — matching arbitrary
  substrings would mean every query read every round, which is the thing the index exists to stop.
  Both paths apply it, and `test/searchindex.test.ts` asserts they agree query for query.

- **The filters on `rounds` are the query language underneath.** `--tool Bash` compiles to
  `tool:Bash` and reaches the same comparison, so there is one filter engine rather than two that
  can come to disagree about what a tool name is or how `git` comes to name `git commit`. Nothing
  about the flags changed: the same three matching rules they always had — a tool by its whole name,
  a command by its name or its name and a subcommand, a session by a prefix that does not cross a
  `/` — are now written down in the field table and tested from both directions.

  `subCommands` moved to `bash.ts`, beside the parser it calls, and is re-exported from `inspect.ts`.
  `RoundFilter` moved to `query.ts`, beside the compiler that reads it, and is re-exported the same
  way.

### Fixed

- **A search URL with no `in=` no longer overrode a query's own `in:`.** The view defaulted the
  entity to `rounds` when the URL did not name one, which silently discarded the grouping of any
  query carrying its own — including every query `--ask` compiles. Absent now means "whatever the
  query says", and the tabs write it explicitly.

- **`/api/compile` refuses `GET`**, like every other route that writes or starts a program. It was
  reachable as a GET and answered with a 400 rather than a 405.

## [0.3.8] - 2026-08-25

### Added

- **A subagent's run is now a session of its own, and its rounds are counted.** Claude Code writes
  a subagent's transcript to `<session>/subagents/agent-<id>.jsonl`, a directory beside the session
  that spawned it. Discovery only ever read the files sitting directly in the project directory, so
  none of those transcripts were opened: everything a subagent did was missing from the store, and
  all that survived of it was the one `Agent` tool call in the parent, which reads as twenty
  seconds and a few thousand characters however much work went on behind it. On the machine this
  was found on that was 44 transcripts, two thirds of them running a model other than their
  parent's — so per-model token and cost totals were low by whatever the delegated work came to.

  A session id is now the transcript's path relative to the project's transcript root for both
  agents alike, which is the shape Cursor's ids already had, so a subagent is named
  `504799b8/a8261ff4` and `agent` is read from that name rather than from a per-vendor flag. The
  sessions table marks them and takes `--agent main|sub`; `probez session <id>` lists what a
  session handed off, under its own tasks and separate from its own totals; `probez rounds --agent
  sub` finds the rounds. Sessions someone opened keep exactly the id they had, so existing stores
  stay valid and the subagents arrive as new sessions on the next collect.

  Project session counts go up accordingly, and so do token totals — the work was always there.

- **The sessions table says what each session cost.** A `COST` column in `probez sessions` and in
  the view's sessions table, worked out per round from its own model's rates and summed — the same
  figure the session page already showed one level down, now visible across the whole list, and
  totalled under it. Rates are the ones under Settings in `probez view`.

  A session with rounds whose model has no rate is marked `+`, since the figure is real but short;
  one where none of them has a rate shows `—` rather than a total that would read as free. The
  listing says how many rounds are outside, the way `analyze` names its unpriced models. `--json`
  carries `cost` as it always did, and now `unpriced` beside it.

### Changed

- **A session id is printed and typed as what identifies it, not as its first eight characters.**
  A subagent's id begins with the id of the session that spawned it, so eight characters named
  every subagent of a session the same thing, and named it the same as its parent. Tables now print
  `504799b8/a8261ff4`, `--session` matches part by part, and the id columns widen only where a
  project actually has subagents in it. Naming a session on its own still means that session and
  not the subagents beneath it, so nothing that worked before resolves differently now.

### Fixed

- **An archived session with no state entry was assigned to an agent by guessing from its id.**
  The rule was that an id containing `/` came from Cursor, which is wrong now that Claude names a
  subagent's transcript the same way. It reads a record out of the archived copy instead.

- **The view looked for a subagent's archived session at a path, not at the name it was stored
  under.** `sessions/` holds one flat file per session, its id flattened; two lookups in the view
  built the name by appending `.jsonl` to the id instead. For a session id that is a path that
  named a directory the store never wrote, so a subagent's tool-result bodies read as absent and
  its trails fell back to what the inputs alone could show. This was already true of Cursor's
  subagents and is now reachable for Claude's.

- **A subagent's own id could not be typed into `probez task` or `probez round`.** The shape those
  selectors accept before the `#` admitted hex and dashes only, so `504799b8/a8261ff4#1.0` — what
  the tables print — was rejected as malformed.

- **`npm run build` now typechecks `web/` as well as `src/`.** `vite build` does not, and nothing
  else did either, so a payload field the server had grown and the page was already reading could
  go untyped indefinitely. It caught two on the way in.

- **A raw NUL byte in `QuestionPanel.tsx` made the file invisible to every grep over `web/src`.**
  The key separator in `signature` was written as the byte itself rather than as `\0`, which is the
  same value at runtime and a binary file to `grep`, `git diff` and the constraints job. It is the
  third time this byte has been pasted in rather than escaped, and the first time the check added
  for it caught one — the CI gate failed on it, which is what it is for. The rule is in the job's
  own comment: `\0` in a template, `'\x00'` where a digit follows, never the byte.

  Nothing shipped in 0.3.7 was unsafe because of it. The greps it switched off for that file are
  the `src/` ones, which never read `web/`, and the one that does — *the view loads nothing from
  off-origin* — passes on the file now that it can be read.

## [0.3.7] - 2026-08-24

### Added

- **`probez explain <id>`: what one question was, read back by your own LLM.** `KIND` is a rule, so
  it holds for six shapes and says `other` for everything else. This is the sentence instead — and
  it comes from a model you already have. Write the command in `<data-dir>/reader.json`, as
  `{"command": ["claude", "-p"]}` or `["ollama", "run", "llama3"]`, or set it under Settings in the
  view; probez writes the question's calls to that command's stdin and keeps the sentence it answers
  with. In the view it is a button on any question, and the sentence then fills the *asked about*
  column so a table of them reads at a glance. Beside it is **copy prompt**, which puts exactly what
  the reader would be sent on the clipboard so you can paste it into a chat you already have open —
  the view's half of `probez explain <id> --prompt`. It runs nothing, needs no reader, and is
  offered whether or not one is configured.

  The reading sits beside the measurement and never replaces it. Where the model's kind differs from
  the rule's, both are shown — the disagreement is the interesting part — and nothing that comes
  back enters a share, a tally or a filter, so every number probez prints stays derivable from the
  rounds alone. Answers are cached in `readings.json` beside that project's rounds, so asking twice
  runs nothing and `--again` is what spends.

  probez has never opened a connection to anything and still does not: this runs a command *you*
  named, as you, and whatever that command talks to it talks to with your credentials. It is argv
  and never a shell line, it runs only from `probez explain` or the `explain` POST — never from
  collect, analyze or browsing — and what is sent is that question's calls and nothing else: no
  prompts you typed, no assistant text, no tool output. `--prompt` prints exactly what would go and
  runs nothing. With no `reader.json` there is nothing probez can run at all. CI now greps for
  `child_process` outside `src/open.ts` and `src/reader.ts`, and for a shell inside either.

- **`probez questions` and `probez question <id>`: what the agent needed to know, and what finding
  out cost it.** A trail is a walk that went somewhere, and its edges exist only where a call
  *narrowed* — a smaller scope, a file under a directory already reached. A call that asks the same
  thing over again narrows nothing, so it forms no edge, joins no trail, and leaves no trace in
  `probez trails`. Against probez's own store that is 34% of every finding call, and a tenth of it
  reaches a trail: the trail keeps the productive hops and drops the thrash, which is backwards for
  anyone measuring what navigation costs.

  A question is the other reading of the same calls. One thing the agent needed to know, and every
  call it spent finding out, whether or not any of them got anywhere. Eleven greps for one field
  name in one file are one question that cost eleven calls, not eleven calls that formed no trail.

  Each one carries what it cost and how much of that was waste: `AGAIN`, the same words asked of the
  same places over again; `FETCH`, calls that only turned a line number into a body; and `GUESS`,
  calls that named three or more different words at once, which is an agent reaching for vocabulary
  it has not learned yet. `KIND` is which of six questions it was — `define`, `refs`, `outline`,
  `flow`, `touches`, `covers` — by one readable table in `question.ts`, which is also where each
  one's meaning is written: a kind is one word, and one word never says what it means, so the
  listing glosses the kinds it used, a detail view glosses the one it shows, `--help` carries all
  seven, and in the view every kind hangs its meaning off a hover. A seventh, *how does A reach
  B*, is deliberately absent: no grep expresses it, so no reading of a grep can recover it, and a
  kind the evidence can never produce would be a claim about intent the inputs do not carry.

  `--kind` and `--min-calls` filter the listing; the cost-per-question line under it is always over
  the whole scope, so a filter cannot make a project look like it asks harder questions than it
  does.

- **The trace lane draws questions as well as trails.** A toggle beside the axis switches which
  reading the brackets are of, and arriving with either one chosen — from a link, or from a table
  under the trace — opens the lane it belongs to. One lane and not two: the two readings cover much
  the same rounds, so stacking them would put two near-identical bars over one strip and the
  difference between them would be a puzzle rather than a fact. Selecting one already closed the
  other; the toggle makes that a choice instead of a surprise.

  Hatching keeps its meaning across both — part of this went nowhere: a trail that changed nothing,
  a question part of which was re-asking. A question answered in a single call is a point rather
  than a span and gets no bracket, so the note under the trace says how many are not drawn. Three
  quarters of them are, and a lane that dropped them silently would read as a smaller task than it
  was.

- **The view shows questions too.** A project's list gains a third tab beside *sessions* and
  *trails*, and a task page gains a *what it needed to know* section under its trace. Clicking a
  question lights the rounds it touched and lists every call it took, marking the ones that asked
  what had already been asked. Rows link the same way trail rows do: to the task it happened in,
  with the question already open.

  A question is addressed by the position of its first call rather than by the `<task>.<round>` it
  is named after. A round can make several tool calls at once and two of them can start two
  different questions — 5.5% of the questions across the corpora this was built against — and a
  name that reaches only the first of them leaves the rest unopenable.

- **Trails and questions show what was actually run.** Both detail views printed the *reading* of a
  call — how wide it reached, which words it asked about, which paths it named — and never the call.
  A run of eleven greps for one field name is obvious the moment the eleven commands sit under each
  other, and merely plausible as eleven rows saying `file · out_tokens`.

  So a call now carries its own text: the command for a `Bash` call, and for a tool the thing and
  what it was pointed at — `Read src/store.ts:40-59`, written the way `sed -n a,bp` writes a span so
  that a read and a slice of the same lines do not read as two different operations. It takes the
  column the program name used to have, since the command contains the name, and the width the
  `WHERE` column used to have, since a command names its own paths. In the view it is one cell with
  the whole of it on hover.

  Rendered once in `trail.ts` rather than in each caller: a command the browser abbreviated
  differently from the terminal is two answers to "what ran". Paths in it are written relative to
  the checkout, by the same rule the rest of the view uses — `Read` is handed an absolute path by
  the harness and a shell command is typed relative, and a table showing one of each spends its
  width on a directory the page header already names. Long commands are cut at 400 characters,
  because this rides on every finding call in a project payload.

### Fixed

- **A guess could say what a question was about.** A call naming three or more of the project's own
  words at once is the agent reaching for vocabulary it has not learned yet — which makes it the
  call whose words are least trustworthy as identity, and the one that contributed the most of them.

  On a real task it inverted the clustering. The prompt was *update the classifier to support
  kubectl, aws and other like under Environment*, and one call —
  `grep -n "docker\|kubectl\|terraform\|aws\|gcloud\|other\|proc" test/bash.test.ts` — was a
  single guess at what the classifier's table might be called. All seven guesses went into the
  question's identity. Twenty-six calls later a search of probez's own collected store, a different
  corpus and not even the repository, matched three of them and was folded in: an eleven-call
  question reported as thirteen, and two activities reported as one.

  A sweep may now join a question but may not extend its vocabulary. The call that *starts* a
  question is exempt, or one opened by a guess would have no identity at all and nothing could ever
  join it — so this narrows the failure rather than closing it, which is worth saying plainly.

  Across a 4,341-round store: 1,177 questions become 1,187, questions costing more than six calls
  fall from 24 to 20, and the count of calls does not move, because nothing is dropped — only
  separated. The `GUESS` column now counts by the same rule, so a pattern made of the language's
  own words — `grep "^export \|^interface \|^function "` — is no longer counted as a guess at
  vocabulary when it is a request for a file's table of contents.

- **A shell line continuation survived being folded into one line.** `grep x \` + newline + `src/a.ts`
  came back as `grep x \ src/a.ts`, which is a command with an escaped space in it rather than the
  one that ran. The backslash is the newline's own escape, so folding the line takes it too.


- **Clicking a trail in the trace opened its round but dropped the trail.** The lane's click handler
  selected the trail and then selected the round again through a second callback, which had not seen
  the trail yet and wrote the URL from a stale value. The trail was chosen and immediately discarded,
  so the panel never opened — while the identical click from the trails table, which writes both
  halves at once, always did. Picking the trail is now the whole click; whoever owns the selection
  opens the round, because both halves of it live in one place.

- **`--kind` was validated against one vocabulary for every command that takes it.** `rounds --kind`
  names a command kind and `questions --kind` names a question kind, and a single check against the
  command-kind list refused every legal value of the other. The check is now per command, which is
  what `COMMAND_FLAGS` already implied by scoping the flag itself.

- **A read and a search never named the same file, so half of every locate-then-fetch pair went
  unexplained.** `Read` records an absolute path and a shell command records whatever was typed,
  which is nearly always relative. Nothing normalized the two, so `Read /repo/src/store.ts` and
  `grep flush src/store.ts` were different places to `trailsOf`: no `narrow` edge, no revisit, and
  two entries in a trail's path count for one file. In probez's own store that is 206 of 290
  absolute paths, every one of them the fetch half of a pair.

  Paths are now read relative to the checkout the calls ran in, and only that prefix comes off — a
  path elsewhere on the machine is elsewhere, and rewriting it would fold the agent's own notes into
  the project's source. Trail coverage of finding calls goes from 21.8% to 27.1% and the edge count
  from 280 to 354; the deepest trail in the session that prompted the module goes from 13 steps to
  19.

### Fixed

- **A stream filter at the head of a pipeline was read as scaffolding, and the call as a round that
  did nothing.** `head`, `tail`, `wc`, `sort`, `jq` and the rest are scaffolding *downstream* of a
  pipe — `pnpm test 2>&1 | tail -25` ran the tests, and the `tail` is how the output was looked at.
  That rule was applied from the line as a whole, `text.includes('|')`, rather than from where each
  command actually sat. So `wc -l src/*.ts | tail -5` had both of its commands struck out and came
  back `unclassified/incidental`: a call that read every file in a directory, counted as idle.

  The same line made a `|` inside a quoted argument into a pipe. `jq -r '.scripts | to_entries[]'
  package.json` opens one file and runs one command, and was reported as doing neither.

  `parsePlaced` had already decided both questions correctly — it is quote-aware and marks each
  command with whether it followed a pipe — and `bashActs` was throwing that away and recomputing a
  worse answer. It now reads the per-command flag, and treats a command as scaffolding only when
  every occurrence of it was downstream, so a name that leads one pipeline and trails another still
  counts for the work it did.

  Across a 57,197-call store this changes 643 calls: 481 led a pipeline, 162 had a pipe only inside
  a quoted argument. `analyzer_version` is at 3, so the next `analyze` recomputes.

## [0.3.6] - 2026-08-20

### Added

- **Compactions are recorded, and every round says how full the window was.** A session has two
  kinds of discontinuity and only one of them announces itself. `/clear` ends the session file and
  opens a new one under a new id, so nothing is needed to see it. An auto-compaction keeps the same
  id and the same file, drops most of the context, and carries on — and the round after it read a
  conversation the round before it never saw.

  The extractor now reads the `compact_boundary` record the harness writes, which arrives carrying
  no message at all and was being dropped unparsed by the guard that skips such records. It lands on
  the round that followed it, as `compaction`: the trigger, the size before and after, the running
  total dropped, and how long the person waited for it. A subagent answering next does not take it,
  because a subagent was never part of the context that was compacted.

  Rounds also report the share of the model's context window they used, from `in_tokens` over a
  window table keyed by model id the way rates are. A model with no published window has no share
  rather than a guessed one. Read together the pair is the whole story in two lines: `100% of
  context`, then `compacted (auto) · 1.0M → 21.0K · took 2.6m`, then `7% of context`.

  Both are in `probez view` as well as the CLI. The round inspector draws the compaction as a rule
  across the top of the round that followed it, and marks the window share beside the token figures
  in three bands: green to 20%, amber to 80%, red above it. The bands are decided on the figure as
  shown rather than the raw share, so a round printing `20%` is never the amber one. The share is
  computed on the server and sent
  with the payload rather than worked out in the browser: the view mirrors the stored schema by
  hand, and a second copy of the model table is a second thing to keep current.

  The store schema is at 6, so the first run against an existing store rebuilds it — compactions
  cannot be backfilled by appending, since the rounds already written are the old shape.

- **Trails: the runs of calls that followed one another into the repository.** An agent that does
  not know a repository finds its way around it — it lists the tree, opens what the listing named,
  greps for a word, reads the lines the grep hit. `analyze` counts all of that as Reconstruction and
  cannot tell five hops of one search from five unrelated file opens. `probez trails` finds the
  search, and `probez trail <id>` draws it hop by hop.

  A trail is a graph over calls rather than a ninth category, and deliberately so: a category would
  make a round's label depend on its neighbours, which is the coupling that removing `review` in
  0.3.2 bought back. It carries DEPTH (how far the search went), WIDE (how far it fanned from a
  single call — a listing feeding five reads is wide and shallow, a chain of follows is deep and
  narrow), the paths it visited, how many it went back to, what it started from, and whether it
  ended in a change to somewhere it had been.

  Every hop names its evidence. `probe` is a search for a word and then a file carrying it; `narrow`
  is a file under a directory already reached, or the same file reached less of. Both are inferred
  from what the calls asked for, which is all `rounds.jsonl` can support. `--deep` adds the third:
  `listed`, a path read out of an earlier call's own result body, which is the only way to see that
  `find .` is why the next five files were opened. It reads the verbatim session copies `collect`
  already keeps, in one pass, and every trail says which kind of evidence it had rather than
  presenting the two as one answer. An imported project carries its rounds and not the logs behind
  them, so `--deep` finds nothing there and says so.

  A trail has no id of its own. It is named by the round it starts at, and asking for any round it
  passed through finds it, so no fifth kind of id sits beside session, task and round to be mistaken
  for them. `--min-depth` and `--outcome` filter the list.

  Nothing here is scored. Membership is three rules — at least three calls, at least one hop, at
  least two places — and the facts are reported beside them. The last of those rules is not
  decoration: without it, five `Read` calls paging down one file chained into a depth-five walk that
  visited nowhere, which was the largest false positive against a real store.

- **`analyze` says how much of the finding was directed.** Reconstruction says how much of the work
  was finding things out; the new line says how much of that finding happened inside a trail as
  against calls that stand alone, how many of those trails ended in a change, and which was the
  deepest — with the id to open it. `--deep` there too. A low share is not a fault: it is what an
  agent working in a repository it already knows looks like.

- **Trails in the view, as a tab beside Sessions.** The heading carries an ⓘ explaining what a walk
  is and what each of its columns measures, since `wide` and `back` are one-word names for things
  nobody should be expected to infer. Every walk in the project, with the same columns
  the CLI prints, and a row opens the task it happened in with the round it started at selected —
  which is where the bracket over those rounds is drawn. There is no trail page: a trail is a shape
  over rounds, and the trace is where rounds are shown.

  It reads deep, and it is fetched when the tab is opened rather than on the way to the page — the
  same bargain the tools tab makes, for a bigger reason, since this reads every archived session in
  the project. Shallow was never the right default here: it finds about a third of the steps and
  roots the walks it does find further forward, and unlike the CLI there is no flag to have got
  wrong. The one path a trail carries is written `~/…` before it leaves the server, for the reason
  a project's path already was.

- **Picking a walk lights up the rounds it touched, and opens it hop by hop.** Clicking a bracket
  on the task trace turns down every round the walk did not touch and prints the walk under the
  trace — the same table `probez trail <id>` gives, with each hop's evidence beside it. Rounds are
  turned down rather than outlined because a walk can touch six rounds out of a hundred and twenty,
  and six outlines in a barcode are not findable. Clicking a step opens that round in the inspector
  exactly as clicking its cell does, and the panel marks where you are: the trace and the panel are
  two views of one selection, never two selections. Clicking the same bracket again puts the strip
  back.

  The chosen walk is in the URL beside the chosen round, which is what makes one linkable: a row
  of the project's trails table opens the task with the walk already picked, exactly as clicking
  its bracket on that trace would, rather than merely landing on the round it starts at. A link
  you send someone opens on the walk you were reading.

- **A walks lane on the task trace.** Between the phase ribbon and the round strip, when a task made
  any: one bracket per trail, over the rounds it touched, labelled with how far it went. The ribbon
  cannot show this — a walk is not a stretch of rounds but what the evidence connects, so a search
  interrupted by an edit and resumed four rounds later is still one search. Overlapping walks stack
  into rows rather than piling on one line. Hover for where it went and how it ended; click to open
  the round it started at. The task payload reads its trails deep, since a task is one session the
  page is already reading.

### Fixed

- **A raw NUL byte in two source files made `grep` skip them whole.** `src/import.ts` and
  `test/classify.test.ts` wrote the round-key separator as an actual NUL rather than as the `\0`
  escape every other file uses. One such byte is enough for `file` to call a file `data` and for
  plain `grep` to report no matches and exit 1 — which means "not found", not "could not look" —
  so 762 lines of TypeScript were invisible to every search. `labelOf` read as dead code when it
  has two live uses. Worse, the `constraints` job in CI is itself a set of greps over `src/`, and
  three of them do not pass `-a`: a file carrying a NUL could have imported `child_process` and
  called `execSync` and passed every check in the job. Both separators are now escapes, identical
  at runtime, and a new first constraint fails the build on any NUL in a tracked source file.
  0.1.1 fixed this same byte in `src/store.ts`; it came back the next day in two new files, which
  is why the guard is a check now and not a note.

- **A tooltip no longer inherits the styling of whatever it explains.** The ⓘ sits inside the
  heading it belongs to, and a section heading here is uppercase with its letters spread out, so a
  paragraph of prose hung off one arrived shouted. Nothing about where a tip is anchored should
  decide how it reads.

- **The sessions table draws its work, instead of naming the largest slice.** `Recon 57%` named one
  category out of eight and discarded the rest. It is now the bar the tasks and projects tables
  already used: one band per category, widest first, no number, percentages on each band's tooltip.
  The widest band is the same answer the text gave, since `spread` weighs categories the way
  `dominant` does, so the bar and the name it replaced can never disagree about which is largest.
  0.3.5 did this one level down, for tasks, and left the level above it saying the old thing.

- **A command now knows which side of a pipe it ran on.** `bash.ts` cut a command line into pieces
  and threw away what the shell put between them, so nothing downstream could tell
  `grep -rn flush src`, which asks the repository a question, from the `grep` in
  `npm test | grep "^not ok"`, which reads output that already exists. Trails need that difference —
  counted as a search, the second would root a walk at every test run — so the parser keeps it.
  Nothing about the tools table changed: it still folds repeats, and `grep a | grep b` is still one
  use of `grep`.

## [0.3.5] - 2026-08-19

A second agent, and two things the view could measure but not show. probez reads Cursor transcripts
as well as Claude Code sessions, so a repository worked in both is one project rather than two. In
the view, a tool call now shows the result it actually came back with, read out of the session copy
when you ask for it, and the tasks table draws the whole spread of work instead of naming its
largest slice.

### Added

- **Cursor transcripts.** `probez collect` reads Cursor agent transcripts under
  `~/.cursor/projects/<slug>/agent-transcripts` as well as Claude Code sessions, and a repository
  used in both is one project. `--source claude|cursor|both` (default `both`) and `--cursor-dir`
  select which. Cursor rows have no usage, model, or tool results; those fields stay blank rather
  than being guessed at. Nested subagent files are `agent: sub`, archived under a flat name. A
  project slug is resolved against the directories that still exist, so a name with dashes
  (`flowz-agentic-sdlc`) is not split into extra path segments.

- **The tasks table shows the whole distribution, not the name of its largest slice.** The `Work`
  column said `Recon 46%`, which named one category and discarded the other seven. It is now the
  bar the projects table already used: one band per category, widest first by weight, no number.
  The widest band is the same answer the old text gave — `spread` weighs categories the way
  `dominant` does, so the bar and the name it replaced can never disagree about which is largest.
  Percentages are still on each band's tooltip.

- **Tool result bodies, in the view, on request.** `rounds.jsonl` records a result's size and not
  its text, so the inspector could say a `Grep` returned 4.2K characters and never what they were.
  Opening a tool call now offers **Show result**, which reads the body out of the verbatim session
  copy `collect` already keeps beside the rounds and prints it under the call.

  It is fetched per call, when you press the button, and never on the way to the page: a round of
  twenty calls costs no reads until you ask for one, and a body already read is kept rather than
  fetched twice. Results over 200,000 characters are cut, and say so with the path to the whole of
  it. A result that was a screenshot says it was an image rather than showing an empty panel.

  Behind it, `GET /api/projects/<slug>/sessions/<session>/results/<tool_use_id>`. The call is
  resolved against the store before any file is opened, so the session named is one the project
  recorded rather than a path arriving from the browser, and the id searched for is one the store
  already holds. The route reads and never writes, and needs the token like everything else under
  `/api`. Nothing about `collect`, the store's layout, or the extract changed — this reads what was
  already on disk. An imported project has rounds and no session copies, and says so.

## [0.3.4] - 2026-08-18

Work that was falling through the table now has a name, and every task says which commit it started
from. Deploying a cluster reads as time on the machines the code runs on, a call to an MCP server
reads as finding out what the repo does not hold, and a task carries the state of the tree it was
asked against.

### Added

- **Every task records the commit it started from.** A task is a piece of work asked against a
  particular state of the tree, and until now nothing said which one. `probez tasks` grows a `FROM`
  column, `probez task <id>` and `probez round <id>` end their header with `from 0e864ea`, the view
  puts it beside the round count, and `commit` is on every round in `rounds.jsonl` and in `--json`
  at full length. It is the starting point, not the result: a task that opened before the agent
  committed still reports where it began, and the commit it made belongs to the task after it.

  It is read from git's own HEAD reflog — `.git/logs/HEAD`, a plain text file listing every commit,
  checkout, merge and reset with the second it happened — and matched against the moment the user
  turn arrived. No `git` subprocess runs, probez works the same on a machine with no git installed,
  and a worktree reports its own HEAD rather than the checkout it points at. The answer is resolved
  when a session is collected and stored with the round, so it does not decay as git prunes the
  reflog behind it. Blank means blank: a project outside a checkout, a repository keeping no
  reflog, or a task older than the reflog still reaches are all reported as nothing rather than as
  a nearby hash, and a project where nothing resolved keeps the table it always had rather than
  gaining a column of dashes.

- **Container, cluster and cloud tooling is named work.** `kubectl`, `docker`, `terraform`, `aws`,
  `gcloud`, `helm`, `systemctl` and the rest of that family used to fall through to `other`, which
  is where a program nothing recognized lands, and from there into `Unclassified · unknown`. They
  are now a command kind of their own, `infra`, and a third Environment sub-kind, so a session
  spent deploying reads as time spent on the machines the code runs on rather than as a hole in the
  tally. `probez rounds --kind infra` and `--category environment` both find them.
  Whatever the subcommand does, the kind is the same: `kubectl get` reports on a cluster and
  `kubectl apply` changes one, and keeping them apart would mean a sub-table of read-versus-write
  verbs for thirty different CLIs to buy a distinction nothing downstream asks for.

- **A call to an MCP server is named work.** Anything the harness namespaces as
  `mcp__<server>__<tool>` used to fall through to `Unclassified · unknown`, alongside genuinely
  unreadable calls. It is now the `mcp` verb and a fourth Reconstruction sub-kind, so a session that
  leaned on Figma, a browser or a ticket tracker reads as time spent finding out what the repo does
  not hold. `probez rounds --category reconstruction` finds them, and the full tool name is still
  what `--unclassified` would have shown.

  The namespace is the whole signal, and the placement is honest about that: the tool after
  `mcp__<server>__` is whatever someone configured, so nothing built in can tell a Figma read from a
  Jira write. Reconstruction is where the bulk of them sit, and the sub-kind is kept apart from
  `inspect` so the share stays visible and can be moved wholesale if a store says otherwise. No
  target is read off the input either — the shape is per-server, and an unset target beats a guessed
  one.

### Changed

- **`docker run` is Environment, not a run of the project.** It was the one entry from that family
  the command table already knew, and it named a container as though it were the project starting
  up. The rest of `docker` was unclassified around it, so the two halves of the same call disagreed.
- **What follows `docker exec` or `kubectl exec` no longer names a row.** The rule that makes
  `npm run build` worth naming after its script was reaching the token after `exec` as well, which
  gave every pod and every container a row of its own in `probez tools`. They come back as
  `docker exec` and `kubectl exec`. A container named `test-db` is also no longer read as a test
  run, since the program is now recognized before the token after it is.

## [0.3.3] - 2026-08-16

The view says more and gives away less. Every tool call now carries the work it was counted as,
which is what `probez round <id>` has always printed; and no path the view puts on screen names the
person who ran it.

### Added

- **Every tool call in the view says what it was counted as.** The round inspector showed the
  round's labels added up — "Reconstruction · read 20% · Implementation · modify 60%" — and then a
  list of calls with no way to tell which call was which. Each call now carries its own chips, in
  the category's colour, with the full category, the target and the tool or command in the title;
  a call that did the same thing several times says `×3` rather than repeating itself. That is what
  `probez round <id>` has always printed under each call, so the two front ends now show the same
  thing. Labels served by the view carry the index of the call that produced them, since `source`
  names a tool but cannot tell two `Bash` calls apart.

### Changed

- **The view writes a path under home as `~/…`, the way the CLI always has.** It printed the
  absolute path, so a project header read `/Users/<someone>/Dev/…` and every screenshot of the view
  carried a username that was nobody else's business. The store still keeps the real path — only the
  copy handed to the browser is shortened, and nothing sends it back. The same goes for the store
  directory on the projects page, the pricing file on Settings, and the source directory a failed
  sync reports. An export is untouched: it is a copy of the record, and the record has always been
  unredacted.
- **The README's two screenshots are regenerated.** They still showed the pre-0.3.2 categories —
  Verification and Review, neither of which exists — beside a work profile that no longer matches
  what the code produces.

### Fixed

- **A `>` inside a heredoc is a comparison, not a redirect.** The write-sniff that decides whether
  `python3 - <<'EOF'` changed a file or reported on one read Python's greater-than as a shell
  redirect: a body containing `if len(o)>120:` or `if len(str(val))>200:` was filed as
  `implementation/modify` with no target, when the script only read a store and printed what it
  found. The redirect now has to name a file — a `.` or a `/` in the destination — which is the
  question the non-heredoc redirect scan already asked. Scripts that filter on a length or a count
  land in `reconstruction/inspect` where they belong.

## [0.3.2] - 2026-08-16

The classifier, taken apart. It did two jobs in one pass — working out what a call mechanically did,
and deciding what kind of work that was — and because the two were interleaved, the same act could be
filed two ways depending on which tool performed it. They are now two passes, and the second one is a
table.

### Changed

- **A call is parsed before it is classified.** `src/act.ts` reads a tool call down to the *verbs* it
  performed — read, write, search, test, commit, and thirteen others — each a fact you could confirm
  by looking at the call. `src/classify.ts` maps each verb onto a category through one flat table.
  A label you disagree with is now a row to change rather than a rule to trace through thirty-odd
  return sites.
- **Verification is dissolved and Review is gone; Testing is new.** Running a suite is `testing/test`
  and running the project is `testing/run`. Compiling, typechecking and linting move to
  `delivery/build`, on the grounds that building is part of shipping. Running a scripting language at
  the project — `python3 p.py`, `python3 -c` — is `reconstruction/inspect`, because it computes an
  answer rather than exercising the product. That last one encodes "the project is not written in a
  scripting language", which holds for most repos and inverts in a Python one; it is one table in
  `act.ts`.
- **Reading prose is Planning.** Reading `docs/PRD.md`, a README or `CLAUDE.md` is `planning/read`
  rather than `reconstruction/read`. **A planning share from 0.3.1 or earlier is not comparable to
  one from 0.3.2**: the old number counted only the harness transitions around a plan, which are near
  1% of any store, and the new one is time spent on what the work should be, whether that was spent
  deciding or reading someone else's decision. The transitions are still there as `clarify`,
  `decompose` and `design`.
- **`implementation/refactor` folds into `implementation/modify`.** It was carrying two unrelated
  things — moving files about, and an `Edit` with `replace_all` set — and neither was a change of
  behaviour distinguishable from the other kind.
- **`ANALYZER_VERSION` is 2.** Every stamp in an `analysis.jsonl` written by an older version refers
  to a taxonomy that no longer exists.

### Fixed

- **A shell command that wrote prose was filed as implementation.** The prose check lived only on the
  tool path, so `Write` on a README was `documentation/system` while `cat > README.md` and a
  `python3` heredoc writing the same file were `implementation/modify`. The question is now asked once,
  against the path, so the two cannot disagree.
- **A `>` inside a quoted string or a heredoc body was read as a redirect.** `python3 - <<EOF` with
  `print("wrote > notes.md")` in its body reported a write to `notes.md`, so a line that reported on a
  file was counted as one that changed it. Both the redirect scan and the heredoc write-sniff now run
  against the argument list only.

### Removed

- **The Review category, and with it the last rule that looked outside a call.** It existed to hold
  one distinction — a `git diff` after an edit is checking your work, the same command before one is
  orienting — and it cost every round the history of its task, so no round could be labelled without
  replaying the project around it. Read-only git is now unconditionally `reconstruction/inspect`.
  Classification is a function of the call, which is what `probez round` wanted all along.

### Known limits

- `npm run <script>` arrives from the command parser as kind `build` whatever the script is named, so
  `npm run lint` and `npm run dev` both land in `delivery/build`. The script name is already on the
  parsed command, so narrowing this is a table lookup rather than a parser change.
- Writing a test file is `implementation`, with a `tests` target. Testing is what was *run*, not what
  was authored.

## [0.3.1] - 2026-08-16

Managing the store, from the page that lists it. 0.3 could collect a project, read it and send it
somewhere; it could not rename one or get rid of one.

### Added

- **Rename a project, from the ⋮ menu.** A label and only a label: the store directory is a hash of
  the path an agent ran in, so renaming moves nothing and cannot land one project on top of another.
  The chosen name lives in the manifest beside the derived one — `collect` recomputes the derived
  name from the path every time it runs and carries the chosen one across, so a rename survives every
  later sync — and clearing the field is a revert rather than a project with no name. The CLI reads
  the same field, so a project renamed in the browser is what `probez projects` prints and what
  `probez analyze <name>` answers to.
- **Delete a project, after being asked.** It removes one project's directory — rounds, the session
  copies beside them, the analysis cache, the manifest — and there is no undo. It is the only thing
  in probez that destroys data, and it is fenced twice: the slug must have the shape `slugFor`
  produces, and the path it resolves to must be under `<data-dir>/projects/`. The agent's own session
  files are not touched, so a collected project comes back with `probez collect` minus whatever the
  agent has pruned since; an imported one does not come back at all. The panel that asks says both.
- **`POST .../rename` and `POST .../delete`**, alongside `sync`. Like it, both refuse `GET`, because
  a URL that renames or deletes when it is merely visited is a URL that can be put in an `<img>` tag.
- **Projects that arrived as a file are marked `imported`** in the list and on their own page. Every
  number on such a row was measured on somebody else's machine, and nothing else in the table said so.
- **`probez projects --json` gained `name`**, the name the tables print. `key` is unchanged and is
  still the agent's own directory name.

### Fixed

- **The projects list and a project's page disagreed about "Last".** The column showed when the most
  recent round ran; the page showed when probez last read the sessions, under a name close enough to
  read as the same fact. The column is now `Last activity`, the page leads with the same figure under
  the same name, and when it was collected — or imported — follows as the separate thing it is.
- **A project's path was invisible in the page header.** It has been in the markup since 0.2 and zero
  pixels wide: `.clip` sizes itself with a table trick that resolves to a literal zero in a flex row.
- **`probez analyze <name>` printed `(imported)` for a project that was not imported.** A project
  matched through the store rather than through the agent's directory carries a slug, and the header
  read that as "this is an import". It reads the path first now, which an import does not have.
- **The CLI listed an imported project's `LAST` as when it was imported**, while every other row —
  and the view — meant the last round in it.

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

[Unreleased]: https://github.com/flowzhq/probez/compare/v0.3.9...HEAD
[0.4.0]: https://github.com/flowzhq/probez/compare/v0.3.9...v0.4.0
[0.3.9]: https://github.com/flowzhq/probez/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/flowzhq/probez/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/flowzhq/probez/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/flowzhq/probez/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/flowzhq/probez/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/flowzhq/probez/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/flowzhq/probez/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/flowzhq/probez/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/flowzhq/probez/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/flowzhq/probez/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/flowzhq/probez/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/flowzhq/probez/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/flowzhq/probez/commits/v0.1.0
