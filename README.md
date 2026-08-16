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

It reads [Claude Code](https://claude.com/claude-code) sessions from `~/.claude/projects` and writes
one record per LLM round under `~/.probez`. Run it again whenever you want to catch up — it reads
only what changed. `probez collect --all` does every project on the machine at once.

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

<p align="center">
  <img src="docs/view-project.png" alt="probez view: a project, its work profile and its sessions" width="900">
</p>

**A session** — the trace. Two rows over one axis: the phases the agent moved through, and the
rounds themselves, each stacked by the work it did. Click a round to open it in full; the arrow
keys walk to the next.

<p align="center">
  <img src="docs/view-session.png" alt="probez view: a session trace and its work profile" width="900">
</p>

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

Each project carries a **⋮** menu: *Sync* runs `collect` then `analyze` for that project, and
*Export* hands its rounds or a full bundle to your browser to save. **Import** on the projects page
reads a file someone sent you — which is also why the view opens on an empty store.

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
| `probez analyze` | Where the work went |
| `probez view` | Open the profiler |
| `probez collect` | Collect one project, or every project under a folder |
| `probez export <project>` | Write a project out as a file to send someone |
| `probez import <file>` | Read a project someone sent you |

Lists take `--limit` and always say how many rows they withheld. `rounds` filters by `--session`,
`--task`, `--tool`, `--command`, `--kind`, `--category`, `--target`, `--agent` and `--errors`.
`analyze` takes `--by`, `--split` and `--unclassified`. `--json` works everywhere.
`probez --help` lists every flag under the command it belongs to.

```console
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

Sessions of a project, newest last:

```console
$ probez sessions flowz-mcp

  flowz-mcp  ~/Dev/workspace/flowz-mcp

  SESSION    ROUNDS  TASKS  TOOLS           IN      OUT  WORK       LAST
  0bfa7fe3      127      5  122 ✗1       21.6M   186.4K  Impl 40%   5 days ago
  0b2cc149       87      4  84 ✗2        10.1M    97.6K  Impl 38%   5 days ago
  51cced08      134      4  131          24.3M   138.1K  Impl 41%   4 days ago
  be254122       21      2  19 ✗1         1.0M     8.2K  Recon 68%  4 days ago
  bfd594d9       73      2  72 ✗1        10.4M    74.6K  Recon 41%  4 days ago

  5 sessions · 442 rounds
  `probez session <id>` shows one of them, task by task.
```

And what the work actually was:

```console
$ probez analyze flowz-mcp

  flowz-mcp  ~/Dev/workspace/flowz-mcp

  WORK                  ROUNDS    SHARE      COST  ERRORS      TIME      OUT
  Planning                10.0     2.0%     $1.18       ·     21.3s     5.7K
    design                 8.0     1.5%     $0.86       ·       0ms      248
    clarify                2.0     0.6%     $0.32       ·     21.3s     5.4K
  Reconstruction           115    26.4%    $15.29     3.0      1.3m    60.0K
    read                  73.3    18.7%    $10.85     1.0     37.5s    30.7K
    locate                41.2     7.6%     $4.43     2.0     39.9s    29.2K
    inspect                0.1     0.0%     $0.01       ·     659ms      101
  Implementation           161    39.1%    $22.66     4.0     24.7m   292.3K
    modify                 102    22.4%    $12.98     2.0      6.2m   102.5K
    create                44.0    13.6%     $7.90       ·     17.5m   175.0K
    refactor              14.4     3.1%     $1.78     2.0     55.9s    14.9K
  Verification            62.3    12.9%     $7.47     1.0      2.2m    25.5K
    build                 28.2     4.9%     $2.83     1.0     16.1s     7.6K
    test                  26.4     5.4%     $3.12       ·     10.4s     4.8K
    run                    7.6     2.6%     $1.51       ·      1.7m    13.1K
  Review                   4.1     0.8%     $0.47       ·      1.1s      685
    read-back              4.0     0.8%     $0.46       ·     355ms      593
    diff                   0.1     0.0%   $0.0089       ·     709ms       92
  Documentation           55.0    14.0%     $8.13       ·      8.7m    81.7K
    system                44.0    11.1%     $6.44       ·      5.1m    57.3K
    agent                 11.0     2.9%     $1.69       ·      3.6m    24.3K
  Delivery                 4.9     0.9%     $0.51       ·     18.7s     6.9K
    branch                 4.5     0.8%     $0.47       ·     16.0s     6.5K
    commit                 0.5     0.1%     $0.04       ·      2.7s      385
  Environment              4.7     0.8%     $0.44       ·     11.1s     3.2K
    env                    2.7     0.5%     $0.28       ·      7.4s     1.8K
    deps                   2.0     0.3%     $0.16       ·      3.7s     1.4K
  Unclassified            12.0     3.0%     $1.75       ·     26.3s    11.8K
    unknown               11.0     2.9%     $1.66       ·     25.2s    11.5K
    incidental             1.0     0.2%     $0.09       ·      1.1s      378

  428 rounds did something a tool can see, out of 442. Shares are of the $57.90 they cost
  14 rounds of prose only (3.2%) · 2.8% unclassified · 76.9% of work has a known target
  Unclassified is mostly ToolSearch, codebase-memory-mcp, Skill. --unclassified lists it
```

**A share is a share of money.** `ROUNDS` says how much of the work a category was; `SHARE` says how
much of the bill. Cost is worked out per round from its own model's rates, then split across that
round's work. The last lines are part of the answer: rounds of pure prose and tools with no entry in
the table sit outside the shares, and are reported rather than guessed at.

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
       verification/test
       command: go test ./... 2>&1 | tail -40
       description: Run the full test suite
```

## Sharing a project

A project can be written to a file and read back on another machine, so a trace can go in a bug
report or a review the way a log does.

```console
$ probez export flowz-mcp --bundle --out flowz-mcp.json

  exported  flowz-mcp  →  ~/probez-demo/flowz-mcp.json
  991 KB · they read it with `probez import flowz-mcp.json`
```

```console
$ probez import flowz-mcp.json

  imported  flowz-mcp

  sessions   5         rounds   442      tasks  17

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
  "round": 87, "task": 3, "agent": "main",
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

Three of those repay a second look:

- **`in_tokens` is the sum of the fields after it**, and the last is usually almost all of it. Cache
  reads bill at a fraction of the rate, so the total alone is a poor guide to what a round cost.
- **`ms` is not how long the round took.** It spans the records the round wrote; `gen_ms` starts
  from the input that prompted it, so it includes the wait before the model said anything.
- **`is_error` is the harness's flag**, meaning the call was accepted — a `Bash` call whose test
  suite fails still comes back `false`. `stderr_chars` and `interrupted` are what actually happened.

**Not recorded:** reasoning text and tool result bodies, kept as character counts. Tool input
strings over 2,000 characters are cut to the first 200 plus a length marker; object structure and
every file path survives, and `input_chars` carries the size the cut removed.

A verbatim copy of each session file is kept alongside, so nothing is lost if you later want a field
probez does not normalize — and it is what a schema change rebuilds from. Collecting every project
on a machine with a year of history took about 305 MB, of which the session copies were 284 MB and
the normalized rounds 30 MB.

## Privacy

**probez sends nothing anywhere.** No network calls, no telemetry, no account, no upload path.
Everything stays under `~/.probez` on your machine.

It does read your real work. `rounds.jsonl` holds prompts and assistant messages in full, and tool
inputs including file paths and shell commands. The verbatim session copies beside it hold more
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
