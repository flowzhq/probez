<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.png">
    <img src="docs/logo.png" alt="probez" width="320">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/probez-cli"><img src="https://img.shields.io/npm/v/probez-cli.svg" alt="npm"></a>
  <a href="https://github.com/flowzhq/probez/actions/workflows/ci.yml"><img src="https://github.com/flowzhq/probez/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/probez-cli.svg" alt="node"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/probez-cli.svg" alt="license"></a>
</p>

<p align="center">
  <strong>See what your coding agents actually did. Every session, measured locally.</strong>
</p>

Coding agents already log every session: each LLM call, every tool invocation, the timing between.
probez normalizes that into one record per LLM round and shows you where the work — and the money —
actually went. Nothing leaves your machine.

## Quick start

**1. Install.** Needs **Node 20+** and nothing else — zero runtime dependencies.

```bash
npm install -g probez-cli
```

Or skip the install and put `npx probez-cli` wherever `probez` appears below.

**2. Collect a project you work in.** Nothing to set up first: the history is already on disk, so
the first run reads months of sessions you have already had.

```bash
cd ~/any/project-you-work-in
probez collect
```

It reads [Claude Code](https://claude.com/claude-code) sessions from `~/.claude/projects` and [Cursor](https://cursor.com) transcripts from `~/.cursor/projects`, then writes
one record per LLM round under `~/.probez`. Run it again whenever you want to catch up — it reads
only what changed. `probez collect --all` does every project on the machine at once. A repository
used in both agents is one project. Cursor transcripts do not include token usage, so those rounds
have no cost.

**3. Look at what came back**, in the browser or in the terminal:

```bash
probez view   # the profiler: projects, sessions, tasks, rounds
probez        # the project as one summary — it collects first, so it stands in for step 2
```

Both are below: [the view](#the-view) first, [the CLI](#the-cli) after.

## The view

`probez view` opens a local profiler in your browser: every project, then a session, then a task,
down to a single tool call. It listens on `127.0.0.1` with a token that is new on every run.

**A project** — where its work went, what each kind of work cost, and the sessions it happened in.
The list under it is two tabs: *sessions*, each row carrying the whole spread of its work as a bar
rather than the name of its largest slice, and *trails*, every walk the project made through itself.
A trail row opens the task it happened in, on the round it started at.

<p align="center">
  <img src="docs/view-project.png" alt="probez view: a project, its work profile and its sessions" width="900">
</p>

**A session** — the trace. Two rows over one axis: the phases the agent moved through, and the
rounds themselves, each stacked by the work it did. Click a round to open it in full — what it was
asked, what it said, and every tool call marked with the work it was counted as; the arrow keys walk
to the next. Opening a call shows the arguments it was given, and **Show result** reads what came
back out of the archived session — fetched when you ask for it, not when the page loads.

<p align="center">
  <img src="docs/view-session.png" alt="probez view: a session trace and its work profile" width="900">
</p>

A task's trace has a third row between the two, when the task made any: **walks**, drawn as brackets
over the rounds they touched. A walk is not a stretch of rounds — it is what the evidence connects,
so a search interrupted by an edit and resumed four rounds later is still one search, and the phase
ribbon cannot show that. Hover one for how far it went, what it started from, and whether it ended
in a change; click it to open the round it started at. See `probez trails` below.

Three things worth knowing:

- **The axis is round index, with time as a toggle.** On a time axis the slowest round dwarfs the
  rest, so most collapse into slivers you cannot click. `working` is the time the model spent
  generating; `elapsed` adds the tools it waited on and the turns it waited on you.
- **Phases are smoothed over five rounds**, and the page says so. The raw per-round category gives
  a band every round or two, which is a barcode rather than a story. Every cell still shows what
  its own round actually was.
- **Rounds no tool saw are drawn hatched**, not dropped. They carry no label and sit outside every
  share, but a timeline missing 5% of its rounds would lie about how long the task took.

**Settings** holds the token rates every cost is computed from — one row per model, five rates
each, at published list prices and yours to change. Stored in `~/.probez/pricing.json`, owner-only.

Each project carries a **⋮** menu, on its own page and on every row of the projects list. *Sync*
runs `collect` then `analyze` for that project. *Rename* gives it a name of your own — a label, on
this machine, that the CLI answers to as well; nothing moves, since a project's directory in the
store is a hash of the path an agent ran in, and clearing the field puts the derived name back.
*Export* hands its rounds or a full bundle to your browser to save. *Delete* removes the project and
everything probez recorded for it, after asking; the agent's own session files are not touched, so a
collected project comes back with `probez collect` minus whatever the agent has since pruned, and an
imported one does not come back at all. **Import** on the projects page reads a file someone sent
you — which is also why the view opens on an empty store, and why a project that arrived that way is
marked `imported` in the list.

## The CLI

Everything the view shows, one table at a time. The levels nest, and every level has a name you can
type back:

```
project                a directory an agent was started in    its name, or its path
└─ session             one agent run                          504799b8
   └─ task             a user turn, and everything it led to  504799b8#3
      └─ round         one LLM call                           504799b8#3.12
         └─ tool call                                         shown in full by its round
```

| Command | What it does |
| --- | --- |
| `probez [project]` | Collect, then summarize |
| `probez projects` | Every project on this machine |
| `probez sessions` · `session <id>` | One row per session, or one session as its tasks |
| `probez tasks` · `task <id>` | One row per task, or one task and every round it took |
| `probez rounds` · `round <id>` | One row per round, or one round with every tool call |
| `probez tools` | Every tool called, and what `Bash` actually ran |
| `probez trails` · `trail <id>` | Runs of calls that followed one another into the repository |
| `probez analyze` | Where the work went |
| `probez view` | Open the profiler |
| `probez collect` | Collect one project, or every project under a folder |
| `probez export <project>` | Write a project out as a file to send someone |
| `probez import <file>` | Read a project someone sent you |

Lists take `--limit` and always say how many rows they withheld. `rounds` filters by `--session`,
`--task`, `--tool`, `--command`, `--kind`, `--category`, `--target`, `--agent` and `--errors`.
`analyze` takes `--by`, `--split` and `--unclassified`. `trails` takes `--deep`, `--min-depth` and
`--outcome`. `--source` selects Claude Code, Cursor, or
both. `--json` works everywhere. `probez --help` lists every flag under the command it belongs to.

```console
$ probez

probez  flowz-mcp  ~/Dev/workspace/flowz-mcp

  sessions   8         rounds   652      tasks  24
  tokens     94.4M in · 646.3K out
             1.2K new · 2.0M cached · 92.4M reused  (98% reused)
  span       Aug 11 – Aug 18, 2026
  top tools  Bash 292 · Edit 125 · Write 91 · Read 84 · mcp__codebase-memory-mcp__query_graph 12

  +652 rounds, 9 sessions read
  → ~/.probez/projects/flowz-mcp-75ad21ac/rounds.jsonl
```

Sessions of a project, newest last:

```console
$ probez sessions flowz-mcp

  flowz-mcp  ~/Dev/workspace/flowz-mcp

  SESSION    ROUNDS  TASKS  TOOLS           IN      OUT  WORK       LAST
  0bfa7fe3      127      5  122 ✗1       21.6M   186.4K  Impl 37%   8 days ago
  0b2cc149       87      4  84 ✗2        10.1M    97.6K  Impl 38%   8 days ago
  51cced08      134      4  131          24.3M   138.1K  Impl 39%   7 days ago
  be254122       21      2  19 ✗1         1.0M     8.2K  Recon 55%  7 days ago
  bfd594d9       73      2  72 ✗1        10.4M    74.6K  Recon 34%  7 days ago
  6ffef9bc       33      4  30            2.2M    17.5K  Recon 52%  3 days ago
  c21c7448      146      2  145 ✗5       22.8M   112.6K  Recon 43%  3 days ago
  069d8593       31      1  30 ✗3         1.9M    11.3K  Recon 72%  1 day ago

  8 sessions · 652 rounds
  `probez session <id>` shows one of them, task by task.
```

A session as its tasks, each with the commit the tree was on when it was asked:

```console
$ probez tasks flowz-agentic-sdlc --session 15ac167d --limit 8

  flowz-agentic-sdlc  ~/Dev/workspace/flowz-agentic-sdlc

  TASK         ROUNDS       IN     OUT     TIME  WORK       FROM     ASKED
  15ac167d#1       12   517.7K   10.8K     2.6m  Docs 55%   a938f1f  start tracking the proje…
  15ac167d#2        5   275.1K    5.9K     1.4m  Docs 75%   6e9716d  once i a while i'll post…
  15ac167d#3        1    58.4K    1.5K    23.8s  —          9e4e660  we are implementing task…
  15ac167d#4        3   186.2K    3.4K    51.7s  Plan 100%  9e4e660  what next? M2?
  15ac167d#5        3   215.4K    6.9K     1.3m  Docs 50%   9e4e660  do we have this in the d…
  15ac167d#6        4   307.5K    3.0K    41.9s  Docs 67%   2a0c9e7  this should be in the co…
  15ac167d#7       20     2.1M   36.2K     7.3m  Docs 46%   be347e3  i see the task, yet no m…
  15ac167d#8        4   569.1K    6.4K     1.5m  Recon 42%  52900e4  add to the metrics ledge…

  showing 8 of 16 tasks, --limit 0 for all. `probez task <id>` shows one in full
```

**`FROM` is where the task began, not what it produced.** Tasks 3, 4 and 5 all start from
`9e4e660`, so those three asks were made against the same tree; the hash then moves, which is the
work of the task before it landing. It is read from git's HEAD reflog when the project is
collected — no `git` runs — and it is blank for a project that is not a checkout.

And what the work actually was:

```console
$ probez analyze flowz-mcp

  flowz-mcp  ~/Dev/workspace/flowz-mcp

  WORK                  ROUNDS    SHARE      COST  ERRORS      TIME      OUT
  Planning                49.2    10.4%     $8.38     1.0     58.4s    19.2K
    read                  37.2     8.7%     $6.96     1.0     16.9s    10.0K
    design                 8.0     1.1%     $0.86       ·       0ms      248
    clarify                4.0     0.7%     $0.55       ·     41.5s     9.0K
  Reconstruction           202    24.3%    $19.52    13.0      4.3m   107.2K
    read                  93.8    10.2%     $8.17     2.0     43.8s    37.4K
    locate                83.5    10.1%     $8.07     7.0      1.4m    43.0K
    mcp                   16.0     1.9%     $1.53     4.0     21.0s    13.2K
    inspect                9.1     2.2%     $1.75       ·      1.8m    13.5K
  Implementation           188    33.8%    $27.10     8.0     30.6m   341.8K
    modify                 132    20.9%    $16.77     8.0      8.2m   128.1K
    create                56.0    12.9%    $10.33       ·     22.4m   213.7K
  Testing                 34.3     5.2%     $4.14       ·     13.7s     7.2K
    test                  34.3     5.2%     $4.14       ·     13.7s     7.2K
  Documentation           73.0    13.2%    $10.56       ·     10.5m   105.5K
    system                59.0    10.4%     $8.36       ·      6.3m    75.2K
    agent                 14.0     2.7%     $2.20       ·      4.2m    30.3K
  Delivery                42.0     5.3%     $4.25     1.0     36.8s    16.0K
    build                 37.1     4.7%     $3.73     1.0     18.1s     9.1K
    branch                 4.5     0.6%     $0.47       ·     16.0s     6.5K
    commit                 0.5     0.0%     $0.04       ·      2.7s      385
  Environment             12.4     3.4%     $2.73     3.0     18.8s     6.7K
    env                   10.4     3.2%     $2.56     3.0     15.1s     5.3K
    deps                   2.0     0.2%     $0.16       ·      3.7s     1.4K
  Unclassified            31.5     4.4%     $3.53     1.0     45.4s    18.5K
    unknown               30.5     4.3%     $3.44     1.0     44.2s    18.1K
    incidental             1.0     0.1%     $0.09       ·      1.1s      378

  633 rounds did something a tool can see, out of 652. Shares are of the $80.21 they cost
  19 rounds of prose only (2.9%) · 5.0% unclassified · 69.4% of work has a known target
  Unclassified is mostly codebase-memory-mcp, ToolSearch, Skill. --unclassified lists it
  22.7% of the finding was inside 10 trails, 1 of which ended in a change
  The deepest went 5 hops from a listing: `probez trail 069d8593#1.0`
```

**A share is a share of money.** `ROUNDS` says how much of the work a category was; `SHARE` says how
much of the bill. Cost is worked out per round from its own model's rates, then split across that
round's work. The last lines are part of the answer: rounds of pure prose and tools with no entry in
the table sit outside the shares, and are reported rather than guessed at.

### Trails: how the agent found its way around

An agent that does not know a repository finds its way around it. It lists the tree, opens what the
listing named, greps for a word, reads the lines the grep hit. Every one of those calls is
Reconstruction, and a tally of Reconstruction cannot tell five hops of one search from five unrelated
file opens. A **trail** is that search:

```console
$ probez trails flowz-mcp --deep --limit 8

  flowz-mcp  ~/Dev/workspace/flowz-mcp

  TRAIL          STEPS  DEPTH  WIDE  PATHS  ROOT     OUTCOME        IN    TIME
  069d8593#1.0       6      5     2      7  listing  abandoned  268.5K    6.0s
  0b2cc149#1.0       5      4     2      3  listing  abandoned  188.4K    3.0s
  51cced08#2.1       4      4     1      9  listing  test       152.8K    4.4s
  6ffef9bc#1.0       5      4     2      9  listing  abandoned  204.2K    6.7s
  6ffef9bc#4.16      9      4     3      9  doc      test       695.0K    4.8s
  be254122#1.0       8      3     5     10  listing  abandoned  356.0K    8.4s
  be254122#2.15      4      3     2      7  listing  abandoned  231.9K    2.4s
  bfd594d9#2.3       3      2     2      3  listing  test       263.0K    3.4s

  showing 8 of 10 trails, --limit 0 for all · 10 proven from result bodies
  `probez trail <id>` draws one of them, hop by hop.
```

`DEPTH` is how far the search went and `WIDE` how far it fanned from a single call — a listing whose
output feeds five reads is wide and shallow, a chain of follows is deep and narrow. `ROOT` is what it
started from and `OUTCOME` whether it ended in a change to somewhere it had been. A trail is named by
the round it starts at, and asking for any round it passed through finds it:

```console
$ probez trail flowz-mcp 069d8593#1.0 --deep

  trail 069d8593#1.0 → 1.10 · 6 steps · proven
  depth 5 · breadth 2 · 7 paths · 1 revisited
  from a listing · abandoned · 268.5K in · 1.5K out · 6.0s

  ROUND   STEP                REACHED FOLLOWED                WHERE
  1.0     ls                  dir     started here            —
  1.1       find              dir     listed docs             docs cmd
  1.2         cat             dir     listed docs/tasks/RE…   docs/tasks/README.md cmd
  1.4           cat           file    listed cmd/livemodel…   internal/graph/codebasememory/engine.…
  1.5             which       dir     listed .flowz           .flowz
  1.10        find            tree    listed docs/tasks/T-…   docs/tasks/T-011-codebase-memory-adap…

  `probez round 1.0` shows any one of these calls in full.
```

`FOLLOWED` is the evidence for each hop, and there are three kinds. `listed` means the path was in
the earlier call's own output, which is proof — and reading it needs the archived session, which is
what `--deep` is for. Without the flag a hop is inferred from what the calls asked for: `probe`, a
search for a word and then a file carrying it, and `narrow`, a file under a directory already
reached. Each trail says which kind it had, on the `proven`/`inferred` line.

The two readings are not two views of one answer. Against probez's own store the deep read finds
about half again as many steps, and it roots a walk further back — the same search the shallow read
names `1.5` is named `1.0` once the listing that started it becomes visible. It is not strictly a
superset either: a better-sourced hop can regroup a walk, and a fragment left under the three-call
floor stops being one.

Any single round opens in full, down to what each tool was given:

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
       testing/test
       command: go test ./... 2>&1 | tail -40
       description: Run the full test suite
```

## Sharing a project

A project can be written to a file and read back on another machine, so a trace can go in a bug
report or a review the way a log does.

```console
$ probez export flowz-mcp --bundle --out flowz-mcp.json

  exported  flowz-mcp  →  ~/probez-demo/flowz-mcp.json
  1432 KB · they read it with `probez import flowz-mcp.json`
```

```console
$ probez import flowz-mcp.json

  imported  flowz-mcp

  sessions   8         rounds   652      tasks  24

  this is somebody else's work, kept apart from anything collected here
  → ~/.probez/projects/flowz-mcp-34f11966/rounds.jsonl
  probez view flowz-mcp-34f11966
```

`--bundle` writes one `.json` carrying the manifest and the analysis around the rounds; without it
you get the store's own `.jsonl`, one round per line, on stdout unless you pass `--out`. Either
imports. The same pair is in the view: **Export** under a project's **⋮**, **Import** on the
projects page.

An import is kept apart from anything collected here — a hash of the sender's project decides where
it lands, so the same name from two people does not collide, and re-importing replaces rather than
appends. Nothing in a file is executed. But nothing in it is checked either: it says whatever the
sender's agent said, and probez shows it to you as faithfully as it shows your own work. **An export
is unredacted** — prompts, shell commands and file paths exactly as typed. Read one before you send
it, and read [SECURITY.md](SECURITY.md) first.

## What you get

One JSON object per LLM round, appended to `~/.probez/projects/<project>/rounds.jsonl`:

```json
{
  "session": "0bfa7fe3-f9c1-448f-bbac-a4c58b85e5bf",
  "round": 87, "task": 3, "commit": null, "agent": "main",
  "id": "msg_011CdwSqg3tdZwYQ7vw69XdB",
  "ts": "2026-08-11T18:37:28.976Z", "ms": 12571, "gen_ms": 16407, "wait_ms": null,
  "first_input": "tool_result",
  "model": "claude-opus-5",
  "in_tokens": 208130, "in_uncached": 1, "in_cache_read": 207020,
  "in_cache_write": 1109, "in_cache_write_5m": 0, "in_cache_write_1h": 1109,
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

Four of those repay a second look:

- **`in_tokens` is the sum of the fields after it**, and the last is usually almost all of it. Cache
  reads bill at a fraction of the rate, so the total alone is a poor guide to what a round cost.
- **`ms` is not how long the round took.** It spans the records the round wrote; `gen_ms` starts
  from the input that prompted it, so it includes the wait before the model said anything.
- **`is_error` is the harness's flag**, meaning the call was accepted — a `Bash` call whose test
  suite fails still comes back `false`. `stderr_chars` and `interrupted` are what actually happened.
- **`commit` is the task's starting point, at full length**, and it is the same on every round of
  the task. It is `null` here because the project this round came from is not a git checkout, which
  is also what a repository with no reflog and a task older than the reflog reaches both look like.

**Not recorded:** reasoning text and tool result bodies, kept as character counts. Tool input
strings over 2,000 characters are cut to the first 200 plus a length marker; object structure and
every file path survives, and `input_chars` carries the size the cut removed.

A verbatim copy of each session file is kept alongside, so nothing is lost if you later want a field
probez does not normalize — and it is what a schema change rebuilds from. It is also where `view`
reads a result body from when you press **Show result**, which is why that works on a project
collected here and not on one that arrived as an export. Collecting every project
on a machine with a year of history took about 305 MB, of which the session copies were 284 MB and
the normalized rounds 30 MB.

## Privacy

**probez sends nothing anywhere.** No network calls, no telemetry, no account, no upload path.
Everything stays under `~/.probez` on your machine.

It does read your real work. `rounds.jsonl` holds prompts and assistant messages in full, and tool
inputs including file paths and shell commands. One file outside the agent's session directory is
read too: `.git/logs/HEAD` in the project, for the commit each task started from — read-only, with
no `git` subprocess, and nothing kept from it but the hash. The verbatim session copies beside it hold more
still: the full reasoning text and full tool output the round record leaves out.

There is no redaction of any kind. A credential typed into a shell command is stored exactly as
typed. The store is written owner-only, and `collect` tightens anything it finds looser. Treat
`~/.probez` with the same care as the repositories it describes, and read
[SECURITY.md](SECURITY.md) before sharing any of it.

## Contributing

Bug reports, ideas and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for how
to run it from source, the release checklist, and the three constraints that shape the codebase.

## License

MIT — see [LICENSE](LICENSE).
