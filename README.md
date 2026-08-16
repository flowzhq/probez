<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.png">
    <img src="docs/logo.png" alt="probez" width="320">
  </picture>
</p>

[![npm](https://img.shields.io/npm/v/probez-cli.svg)](https://www.npmjs.com/package/probez-cli)
[![CI](https://github.com/flowzhq/probez/actions/workflows/ci.yml/badge.svg)](https://github.com/flowzhq/probez/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/probez-cli.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/probez-cli.svg)](LICENSE)

**probez shows you what your coding agents actually did. Every session, measured locally.**

Coding agents already write a detailed log of every session: each LLM call, every tool invocation,
the timing in between. probez turns that into a shape you can measure, one normalized record per
LLM round, and keeps all of it on your machine.

The history is already there. The first run reads months of sessions you have already had, so
there is nothing to wait for.

```
$ probez

probez  flowz-mcp  ~/Dev/workspace/flowz-mcp

  sessions   5         rounds   442      tasks  17
  tokens     67.5M in · 504.8K out
             825 new · 1.4M cached · 66.1M reused  (98% reused)
  span       Aug 11 – Aug 12, 2026
  top tools  Bash 171 · Edit 101 · Write 78 · Read 58 · ToolSearch 4

  +442 rounds, 5 sessions read
  → ~/.probez/projects/flowz-mcp-75ad21ac/rounds.jsonl
```

## Install

```bash
cd ~/any/project-you-work-in
npx probez-cli
```

That is the whole thing. No install step, no config file, no account, no API key.

**Reads [Claude Code](https://claude.com/claude-code) sessions**, from `~/.claude/projects`. Other
agents are not supported yet, since the round schema gets proven against one format first. If probez
reports `no agent sessions found`, that directory is empty or does not exist.

Needs **Node 20 or newer** and nothing else: probez has zero runtime dependencies.

Running it often? `npm install -g probez-cli` puts it on your PATH. The package is `probez-cli`;
the command it installs is `probez`. Update with `npm install -g probez-cli@latest`, or use
`npx probez-cli` and always get the latest. `npm uninstall -g probez-cli` removes it and leaves
`~/.probez` alone.

To run an unreleased commit or contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Use

What probez records nests, and every level has a name you can type back:

```
project              a directory an agent was started in    its name, or its path
└─ session           one agent run                          504799b8
    └─ task          a user turn, and everything it led to  504799b8#3
        └─ round     one LLM call                           504799b8#3.12
            └─ tool call                                    shown in full by its round
```

Each level has a list and a detail view: `probez sessions` then `probez session <id>`, and the same
for tasks and rounds.

| Command | What it does | Flags it takes |
| --- | --- | --- |
| `probez [project]` | Summary for a project, collecting anything new first | `--full` |
| `probez projects` | Every project on this machine, with path, sessions and last activity | |
| `probez sessions [project]` | One row per session: rounds, tasks, tool calls, tokens | `--limit` |
| `probez session [project] <id>` | One session as its tasks: what each asked, and what it cost | `--limit` |
| `probez tasks [project]` | One row per task, across every session | `--session` `--limit` |
| `probez task [project] <id>` | One task: what it asked, what it cost, and every round it took | `--session` `--limit` |
| `probez rounds [project]` | One row per round | `--session` `--task` `--tool` `--command` `--kind` `--category` `--target` `--agent` `--errors` `--limit` |
| `probez round [project] <id>` | One round in full, including every tool call | `--session` |
| `probez tools [project]` | Every tool the project called, with errors, time spent, and what `Bash` actually ran | `--kinds` `--limit` |
| `probez analyze [project]` | Where the work went: one row per kind of work, per project, session or task | `--by` `--split` `--unclassified` `--session` `--task` `--limit` |
| `probez view [project]` | Open the local profiler in your browser | `--port` `--no-open` |
| `probez collect [project]` | Collect one project, or **every project under a parent folder** | `--full` |

**These work on every command:** `--json` for machine-readable output, `--all` for every project on
the machine, `--include-temp` to include scratch directories, `--data-dir` and `--claude-dir` to
point at a different store or source, `--version`, and `--help`.

Every other flag belongs to the command it is listed against, and giving one to a command that does
not take it is an error rather than a silent no-op: `probez sessions --kinds` tells you `--kinds`
belongs to `tools`.

**Lists paginate, detail views do not.** `sessions`, `tasks` and `rounds` show 50 rows at a time and
always say how many they withheld. A detail view names one thing, so `session <id>`, `task <id>` and
`round <id>` show all of it unless you pass `--limit` yourself. `--limit 0` means everything.

**Naming a project.** Leave it out and probez uses the current directory. Otherwise give the
project's name as `probez projects` lists it, or the path it was worked in. `probez sessions
flowz-mcp` and `probez sessions ~/Dev/workspace/flowz-mcp` are the same thing. A path holding
several projects covers all of them, which is how `probez collect ~/Dev` collects a whole folder.

**Naming a session, a task or a round.** An id is the path down to the thing it names, so each one
extends the one above it: `0b2cc149`, `0b2cc149#3`, `0b2cc149#3.12`. Any unique prefix of the
session will do, since the tables print only its first eight characters, and the session comes off
entirely when the project has one: `probez task 3`, `probez round 3.12`. A round's id carries its
task so that the two kinds of id can never be mistaken for one another.

`probez <project>` is shorthand for `collect`, so naming a project collects it and prints its
summary. `probez --help` lists every option under the command it belongs to.

**What counts as a project.** The agent files each session under the directory it was *started* in,
and probez reads that. So a session launched in one repo but editing another is recorded entirely
against the first. A directory you have only ever `cd`'d into, without launching an agent there,
never appears at all.

`probez projects` and `--all` leave out projects in scratch directories (`$TMPDIR`, `/tmp`), because
a harness that runs an agent per test case turns one benchmark into dozens of throwaway
one-question "projects". They are real sessions, but not real work. Both say how many they left
out; `--include-temp` brings them back, and naming one directly always works.

Re-running `collect` updates in place and never creates a second copy. Unchanged sessions are
skipped, only new rounds are appended, and running it twice in a row writes nothing the second time.
That makes it safe to run on a schedule.

## Digging in

The summary gives one number per project. The read commands walk down the levels from there, all
reading the same `rounds.jsonl`, with no further collection and nothing leaving the machine.

Start with the sessions of a project:

```console
$ probez sessions flowz-mcp

  flowz-mcp  ~/Dev/workspace/flowz-mcp

  SESSION    ROUNDS  TASKS  TOOLS           IN      OUT  WORK       LAST
  0bfa7fe3      127      5  122 ✗1       21.6M   186.4K  Impl 40%   4 days ago
  0b2cc149       87      4  84 ✗2        10.1M    97.6K  Impl 38%   4 days ago
  51cced08      134      4  131          24.3M   138.1K  Impl 41%   4 days ago
  be254122       21      2  19 ✗1         1.0M     8.2K  Recon 68%  4 days ago
  bfd594d9       73      2  72 ✗1        10.4M    74.6K  Recon 41%  4 days ago

  5 sessions · 442 rounds
  `probez session <id>` shows one of them, task by task.
```

Open one, and it breaks into the turns you actually remember asking for:

```console
$ probez session flowz-mcp 0b2cc149

  flowz-mcp  ~/Dev/workspace/flowz-mcp

  session 0b2cc149  ·  4 tasks · 87 rounds · 10.1M in · 97.6K out · 2 tool errors · Aug 11, 2026

  TASK         ROUNDS       IN     OUT     TIME  WORK       ASKED
  0b2cc149#1        6   227.8K    1.2K    27.7s  Recon 100% did we implemented T001?
  0b2cc149#2        2    81.4K     233     5.0s  Recon 50%  start with T-003 first
  0b2cc149#3       46     4.4M   73.2K    16.3m  Impl 35%   Execute task spec `$1`. 1. Read `…
  0b2cc149#4       33     5.4M   23.0K     5.2m  Impl 49%   continue

  4 tasks · 87 rounds. `probez task 0b2cc149#1` shows one in full
```

A task is one user turn and everything the agent did about it, subagents included. Opening one shows
every round it took:

```console
$ probez task flowz-mcp 0b2cc149#2

  flowz-mcp  ~/Dev/workspace/flowz-mcp

  task 2 of session 0b2cc149  ·  2 rounds · 81.4K in · 233 out · 5.0s working

  asked
    start with T-003 first

  tools  Read 1 · Skill 1

  ROUND           AGENT MODEL                 IN     OUT     TIME  WORK       TOOLS
  0b2cc149#2.6    main  opus-5             39.9K     139    840ms  Recon 100% Read 1
  0b2cc149#2.7    main  opus-5             41.5K      94     23ms  Uncl 100%  Skill 1

  2 rounds · task 2 of 4
```

And a single round opens in full, down to what each tool was actually given:

```console
$ probez round flowz-mcp 0bfa7fe3#1.36

  round 0bfa7fe3#1.36 · main · opus-5
  124.0K in · 121 out · 825ms · 0 thinking chars
  2 new · 10.3K cached · 113.8K reused
  generated in 3.4s
  session 0bfa7fe3-f9c1-448f-bbac-a4c58b85e5bf · 2026-08-11T18:08:24.141Z

  assistant
    Build and vet are clean. Running the tests:

  tools (1)
     1    Bash             9.4s  848 chars
       verification/test
       command: go test ./... 2>&1 | tail -40
       description: Run the full test suite
```

`rounds` lists them across a whole project and filters with `--session`, `--task`, `--tool`,
`--command`, `--kind`, `--agent main|sub` and `--errors`. Use `probez rounds --errors` for the
rounds where a tool failed, `--command git` for the ones that ran any `git` subcommand, and
`--kind test` for the ones that ran tests. It lists 50 at a time (`--limit 0` for all) and always
says how many it withheld. `--json` on `round` prints the stored record verbatim, tool inputs
included.

### What Bash actually ran

The summary line shows the top five tools; this project called eleven:

```console
$ probez tools flowz-mcp

  flowz-mcp  ~/Dev/workspace/flowz-mcp

  TOOL                 CALLS  ERRORS    RESULT      TIME
  Bash                   171       4    180.9K      1.3h
    echo                  73       1    116.7K     13.3m
    cd                    54       2     39.0K      1.2h
    head                  51       1     58.4K      7.4m
    tail                  51       1     31.7K      9.7m
    grep                  41       1     40.7K      5.0m
    go test               37       ·     26.4K      4.3m
    python3               29       ·     17.7K      7.2m
    cat                   27       1     68.1K     58.7m
      … 52 more, --limit 0 for all
  Edit                   101       1     18.3K      9.0s
  Write                   78       ·     13.1K      3.7m
  Read                    58       ·    401.3K      1.6s
  EnterPlanMode            4       ·      2.3K      21ms
  ExitPlanMode             4       ·     30.3K      2.0m
  ToolSearch               4       ·       412      35ms
  Skill                    3       ·        63      32ms
  AskUserQuestion          2       ·       537      7.2m
  WebFetch                 2       ·      8.4K     42.3s
  WebSearch                1       ·      3.0K     23.9s

  11 tools · 428 calls · 5 errors
  60 commands under Bash. A call that ran several is counted for each
```

`Bash` gets a second level because its name is not its operation. Every other tool does one thing, a
`Read` reads, while one `Bash` row covers `grep`, `git commit` and `go test` alike. That is why it
is always at the top and always says nothing. The commands are read out of what is already stored,
so existing stores show this immediately, with no re-collection.

`probez tools <project> --kinds` groups those commands by the kind of work instead:

```console
  TOOL                 CALLS  ERRORS    RESULT      TIME
  Bash                   171       4    180.9K      1.3h
    read                 127       4    161.5K      1.2h
    shell                 73       1    116.7K     13.3m
    search                61       1     71.9K      6.0m
    nav                   55       2     40.1K      1.2h
    build                 38       1     22.6K      8.0m
```

Two things those numbers do not mean. A command is counted once per call it appears in, so
`cd repo && npm test` counts for both and the sub-rows add up to more than the 171 above. And
errors, result size and time belong to the *call*, which has one result and one duration, so every
command in a multi-command call is charged the whole of it. That is why `cd` appears to have taken
an hour.

Reading the command is deliberately shallow: quoting is respected, heredoc bodies and command
substitutions are skipped, and a line that cannot be read confidently produces `(unparsed)` rather
than a guess. An unrecognized program is `other`, which means "not in the table", not
"unclassifiable".

### Where the work went

`probez analyze` turns those calls into the kind of work they were:

```console
$ probez analyze flowz-mcp

  flowz-mcp  ~/Dev/workspace/flowz-mcp

  WORK                  ROUNDS    SHARE  ERRORS      TIME      OUT
  Planning                10.0     2.3%       ·     21.3s     5.7K
    design                 8.0     1.9%       ·       0ms      248
    clarify                2.0     0.5%       ·     21.3s     5.4K
  Reconstruction           115    26.8%     3.0      1.3m    60.0K
    read                  73.3    17.1%     1.0     37.5s    30.7K
    locate                41.2     9.6%     2.0     39.9s    29.2K
    inspect                0.1     0.0%       ·     659ms      101
  Implementation           161    37.5%     4.0     24.7m   292.3K
    modify                 102    23.9%     2.0      6.2m   102.5K
    create                44.0    10.3%       ·     17.5m   175.0K
    refactor              14.4     3.4%     2.0     55.9s    14.9K
  Verification            62.3    14.5%     1.0      2.2m    25.5K
    build                 28.2     6.6%     1.0     16.1s     7.6K
    test                  26.4     6.2%       ·     10.4s     4.8K
    run                    7.6     1.8%       ·      1.7m    13.1K
  Review                   4.1     1.0%       ·      1.1s      685
    read-back              4.0     0.9%       ·     355ms      593
    diff                   0.1     0.0%       ·     709ms       92
  Documentation           55.0    12.9%       ·      8.7m    81.7K
    system                44.0    10.3%       ·      5.1m    57.3K
    agent                 11.0     2.6%       ·      3.6m    24.3K
  Delivery                 4.9     1.2%       ·     18.7s     6.9K
    branch                 4.5     1.0%       ·     16.0s     6.5K
    commit                 0.5     0.1%       ·      2.7s      385
  Environment              4.7     1.1%       ·     11.1s     3.2K
    env                    2.7     0.6%       ·      7.4s     1.8K
    deps                   2.0     0.5%       ·      3.7s     1.4K
  Unclassified            12.0     2.8%       ·     26.3s    11.8K
    unknown               11.0     2.6%       ·     25.2s    11.5K
    incidental             1.0     0.2%       ·      1.1s      378

  428 rounds did something a tool can see, out of 442. Shares are of those
  14 rounds of prose only (3.2%) · 2.8% unclassified · 76.9% of work has a known target
  Unclassified is mostly ToolSearch, codebase-memory-mcp, Skill. --unclassified lists it
```

`ROUNDS` is fractional because a round splits across the work it did: a round that reads three files
and edits one is three quarters reconstruction. A `Bash` call splits the same way across the
commands it ran, except that `cd`, `echo` and anything downstream of a pipe are dropped rather than
counted, so `cd repo && npm test` is one test run and not half a change of directory.

**The last three lines are the point of the table, not a footnote.** A share is a share of rounds
that called at least one tool. Rounds of pure prose are outside it: that is where planning and
explaining live, and the store keeps no reasoning to tell them apart, so they are reported rather
than guessed at. So is every tool with no entry in the table, which on this machine is mostly MCP
servers. An honest hole that names itself is worth more than a confident guess.

Categories describe the *act*; a second axis describes what it was done to. Reading the README and
reading the router are the same act on different things, and `--split target` shows that half. Here
it separates a task that wrote as much test code as product code:

```console
$ probez analyze flowz-mcp --split target --session 51cced08 --task 2

  flowz-mcp  ~/Dev/workspace/flowz-mcp

  WORK                  ROUNDS    SHARE  ERRORS      TIME      OUT
  Planning                 2.0     2.4%       ·       0ms       62
    unknown                2.0     2.4%       ·       0ms       62
  Reconstruction          26.3    31.7%       ·     13.6s    13.0K
    code                  12.0    14.5%       ·      4.7s     9.9K
    docs                   7.0     8.4%       ·      5.9s     1.6K
    tests                  4.0     4.8%       ·      1.6s      699
    unknown                3.3     4.0%       ·      1.4s      791
  Implementation          36.0    43.4%       ·      4.6m    54.0K
    code                  17.0    20.5%       ·      2.1m    27.1K
    tests                 17.0    20.5%       ·      2.4m    25.8K
    docs                   2.0     2.4%       ·      5.6s     1.1K
  Verification            10.7    12.9%       ·      2.3s     1.9K
    unknown                9.7    11.6%       ·      2.3s     1.7K
    code                   1.0     1.2%       ·       0ms      109
  Review                   2.0     2.4%       ·     355ms      339
    code                   2.0     2.4%       ·     355ms      339
  Documentation            5.0     6.0%       ·      1.1m     8.8K
    docs                   4.0     4.8%       ·     34.7s     5.3K
    agent                  1.0     1.2%       ·     33.4s     3.5K
  Unclassified             1.0     1.2%       ·     201ms      572
    unknown                1.0     1.2%       ·     201ms      572

  83 rounds did something a tool can see, out of 84. Shares are of those
  1 round of prose only (1.2%) · 1.2% unclassified · 80.7% of work has a known target
```

Any share reads back down to the rounds behind it, the way `--kind` already did for commands:

```console
$ probez rounds flowz-mcp --category documentation --limit 5

  flowz-mcp  ~/Dev/workspace/flowz-mcp

  ROUND           AGENT MODEL                 IN     OUT     TIME  WORK       TOOLS
  0bfa7fe3#1.42   main  opus-5            142.8K    2.7K    31.1s  Docs 100%  Write 1
  0bfa7fe3#1.43   main  opus-5            145.6K    1.2K    14.8s  Docs 100%  Write 1
  0bfa7fe3#1.44   main  opus-5            147.0K    1.2K      0ms  Docs 100%  Write 1
  0bfa7fe3#1.45   main  opus-5            148.2K    1.0K      0ms  Docs 100%  Write 1
  0bfa7fe3#1.46   main  opus-5            149.3K    1.2K     9.5s  Docs 100%  Write 1

  showing 5 of 55 rounds, --limit 0 for all
```

`--by session` and `--by task` give one table each instead of one for the whole project.

**What these categories do not yet say.** An operation is classified by what it is, not by what it
was for. A `grep` counts as `locate` whether it opened an hour of working out how an unfamiliar
subsystem fits together or checked in one second where a constant lives. Reading an operation in
the light of the ones around it is a second pass over a sequence rather than a lookup on a call,
and it is the next version's job. Read the categories as what the agent did, not as what it was
achieving.

## The view

Everything above is one table at a time. `probez view` is all of it at once, in a browser, arranged
the way a profiler is arranged:

```console
$ probez view flowz-mcp

  probez view  http://127.0.0.1:7373/p/flowz-mcp-75ad21ac?t=19e2a961-0965-49f5-a11b-fd909f1d8663
  serving 45 projects from ~/.probez
  ctrl-c to stop
```

It opens your browser at that URL. Naming a project goes straight to it; leaving it out opens the
list of every project in the store.

**Projects → project → session → task**, and on the task page, a trace. The trace is two rows over
one axis. The top row is the phases the agent moved through; the bottom row is the rounds
themselves, one cell each, stacked by the work each round did. Click a round and it opens in full
underneath — what was asked, what was said, and every tool call with the arguments it was given.
The arrow keys walk from one round to the next.

```
by round                                            89 rounds · 1.8m working · 18.8m elapsed

 RECON │ IMPLEMENT ██████████████ │▌│▐│ IMPL │ RECON │ VERIF │ IMPL ████ │ DOCS │▌│ VERIF
 ▊▐▙▟▊▌▐▙▟▐▊▌▟▙▐▊▌▐▙▊▟▌▐▊▙▐▌▟▊▐▙▌▐▊▟▙▐▌▊▐▟▙▊▌▐▊▙▟▐▌▊▐▙▟▊▌▐▟▙▊▐▌▙▟▐▊▌▐▙▊▟▐▌▊▐▙▟▊▌▐▙▟▊▐▌▙▟
 170        180        190        200        210        220        230        240      250
 ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁
```

*(A sketch of the layout, not terminal output — the trace is drawn in the browser.)*

Three things about it are worth knowing before you read one.

**The axis is round index by default, and time is a toggle.** Time is the honest axis for cost and a
poor one for reading: the slowest round in a session can be four minutes and the fastest four
milliseconds, so on a time axis most of the rounds collapse into slivers you cannot click. Switch to
it when you want to see where the wait actually was — including the gaps where it was your turn.
The header carries both totals either way, and they are different numbers: `working` is the time the
model spent generating, `elapsed` is how long you sat there. The gap between them is the tools it
waited on and the turns where it was waiting on you.

**Phases are smoothed, and the page says so.** Real work alternates round to round — read a file,
edit it, read the next — so collapsing the raw per-round category gives a band every round or two.
A 122-round task produced 80 of them, which is a barcode, not a story. Phases are the dominant
category over five rounds instead. That is a choice rather than a measurement, so the page states
the window, and every round cell still shows what its own round actually was.

**It shows the rounds no tool saw.** Rounds of pure prose carry no label and sit outside every
share; the strip draws them hatched rather than dropping them, because a timeline missing 5% of its
rounds would be lying about how long the task was.

### Sync and export

Every project carries two buttons, on its own page and on its row in the list.

**Sync** is `collect` then `analyze` for that one project, without leaving the page. It reports what
it did in the words the CLI would use — `+8 rounds from 1 session · 1,201 total`, or `already up to
date` — because finding nothing new is the common outcome and deserves saying. A project whose agent
sessions have since been deleted still re-analyses what was collected, and says that is what
happened.

**Export** hands a project's data to your browser to save. Two formats, because they answer
different questions:

| | |
| --- | --- |
| **Rounds** `.jsonl` | The store's own file, byte for byte: one round per line, the contract every stage reads. What a script wants. |
| **Bundle** `.json` | The manifest, the analysis and the rounds in one document, so a share never travels without the coverage it is a share of. What a person wants to open. |

Where your browser supports a folder picker you get one; otherwise it lands where downloads land.
probez never writes it: it hands over the bytes and the browser does the writing, which is what
keeps "writes only under its own data directory" true.

**Reading writes nothing.** Browsing leaves the store byte-identical — unlike `analyze`, which caches
its result on the way through — and only Sync writes. It listens on `127.0.0.1` only, the URL carries
a token that is new on every run, the page loads nothing from anywhere but itself, and syncing needs
that token too: before it existed the token stood between a stray page and *reading* your prompts,
and now it also stands between one and starting a collection.

Nothing leaves the machine. What the page *does* put on screen — and what an export puts in a file —
is your prompts and your shell commands, unredacted, so read [SECURITY.md](SECURITY.md) before
opening it next to anyone or sending an export anywhere.

Needs the store to have something in it: run `probez collect` first, or `probez <project>`.

## What you get

One JSON object per LLM round, appended to `~/.probez/projects/<project>/rounds.jsonl`:

```json
{
  "session": "0bfa7fe3-f9c1-448f-bbac-a4c58b85e5bf",
  "round": 87, "task": 3, "agent": "main",
  "id": "msg_011CdwSqg3tdZwYQ7vw69XdB",
  "ts": "2026-08-11T18:37:28.976Z", "ms": 12571, "gen_ms": 16407, "wait_ms": null,
  "first_input": "tool_result",
  "model": "claude-opus-5",
  "in_tokens": 208130, "in_uncached": 1, "in_cache_write": 1109, "in_cache_read": 207020,
  "out_tokens": 1307,
  "mcp_server": null, "mcp_tool": null, "skill": null,
  "user_text": "",
  "text": "Now the composer becomes a merger rather than the sole producer:",
  "thinking_chars": 0,
  "tools": [
    {"name": "Edit", "id": "toolu_01JSLS17DXQPPbbA1Qj1W5vS",
     "input": {"file_path": "internal/compose/composer.go", "old_string": "func hasUnresolved…"},
     "input_chars": 3045, "result_chars": 175,
     "is_error": false, "stderr_chars": null, "interrupted": null,
     "patch": {"files": 1, "added": 76, "removed": 0},
     "emitted_at": "2026-08-11T18:37:41.547Z", "result_at": "2026-08-11T18:37:41.647Z", "ms": 100}
  ],
  "events": [
    {"type": "tool_result", "ts": "2026-08-11T18:37:25.140Z", "chars": 315,
     "tool_call_id": "toolu_01RvZYdDLoxC9ybqoKZ4RSjD"},
    {"type": "text", "ts": "2026-08-11T18:37:28.976Z", "chars": 64},
    {"type": "tool_call", "ts": "2026-08-11T18:37:41.547Z",
     "tool_call_id": "toolu_01JSLS17DXQPPbbA1Qj1W5vS"}
  ]
}
```

Two of those repay a second look. **`in_tokens` is the sum of the three fields after it**, and the
last of them is usually almost all of it — cache reads are billed at a fraction of the rate, so the
total on its own is a poor guide to what a round cost. And **`ms` is not how long the round took**:
it spans the records the round wrote, while `gen_ms` starts from the input that prompted it and so
includes the wait before the model said anything. Across this project the two are 0.66h and 1.82h.

`is_error` is the harness's flag, meaning the call was accepted — a `Bash` call whose test suite
fails still comes back `false`. `stderr_chars` and `interrupted` are what actually happened.

A verbatim copy of each original session file is kept alongside it, so nothing is lost if you later
want a field probez does not normalize. Those copies are most of the disk footprint. Collecting
every project on a machine with a year of history took about 305 MB, of which the session copies
were 284 MB and the normalized rounds 30 MB. They are also what a schema change rebuilds from: when
`collect` meets a store from an older probez it rewrites it from those copies, including sessions
the agent has since pruned.

## Privacy

**probez sends nothing anywhere.** There are no network calls in this codebase, no telemetry, no
account, and no upload path. Everything it reads and everything it writes stays under `~/.probez` on
your machine, or wherever `--data-dir` or `$PROBEZ_DATA_DIR` points if you set either.

It does read your real work. In `rounds.jsonl`: prompts and assistant messages in full, and tool
inputs including file paths and shell commands. Tool *outputs* and reasoning text become character
counts. **The verbatim session copies are a different matter.** They are the larger part of the
store, and they contain the full reasoning text and full tool output that the round record leaves
out. "Character counts only" describes `rounds.jsonl`, not `~/.probez`.

There is no redaction of any kind. A credential typed into a shell command or pasted into a prompt
is stored exactly as typed. The store is written owner-only, matching the agent's own session files,
and `collect` tightens anything it finds looser. Treat `~/.probez` with the same care as the
repositories it describes, and read [SECURITY.md](SECURITY.md) before sharing any of it.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
[docs/PRD.md](docs/PRD.md) has the goals and the operation taxonomy behind these numbers, and
[CHANGELOG.md](CHANGELOG.md) has what has shipped.

## License

MIT
