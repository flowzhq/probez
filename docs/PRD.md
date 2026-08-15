# probez: product requirements

## Problem

Coding agents produce a detailed local log of every session: each LLM call, every tool invocation,
the timing in between. It is rich data in an inconvenient shape: one append-only JSONL file per
project directory, structured for replaying a conversation rather than for measuring work.

So questions a team actually has go unanswered. How much of a session is spent reconstructing
context that already exists somewhere in the repo, versus writing code? Which tasks are the
expensive ones, and expensive in what way?

## Goal

Turn that log into a stable, analyzable stream of one record per LLM round, with zero configuration
and zero dependencies, entirely on the developer's machine.

v0.1 delivers collection and normalization, plus the commands to read the result back, down to a
single tool call, without a second tool. Analysis is a separate stage that reads the same file, and
v0.2 delivers it: the distribution of work, per project, session and task.

## Non-goals

These are choices, not omissions:

- **No analysis in v0.1.** Classification is a distinct problem with distinct failure modes. It
  shipped in v0.2 against a schema that was already stable, and needed no new collection.
- **Nothing leaves the machine.** No network calls, no telemetry, no account, no upload. This is a
  property of the codebase, not a setting.
- **Claude Code only, for now.** Other agents follow once the round schema has proven itself against
  one format.

## Users

The developer running the agent, first. Everything is single-machine, single-user, no server. Team
rollups are only interesting once individual profiles are trusted.

## Success criteria

- `npx probez-cli` inside a project produces a summary on the first try, with no configuration,
  in under 5 seconds for a typical project.
- Zero runtime dependencies. `npm ls --omit=dev` is empty.
- Re-running `collect` is idempotent: the second run appends nothing and leaves the file
  byte-identical.
- The store is no more readable than the logs it derives from: directories `0700`, files `0600`.
- The round stream is sufficient input for the taxonomy below, with no further collection.

## Time to value

Three commitments that keep the first run worthwhile:

1. **The history is already there.** The first run reads months of past sessions. Value is
   immediate, not accrued over weeks of recording.
2. **Every stage pays off alone.** v0.1 ends with a summary (sessions, tasks, rounds, tokens, date
   span, top tools) and commands that read the store back down to a single tool call. Counts, not
   analysis, but enough to be worth installing before the analyzer exists, and enough that nothing
   collected needs a second tool to see.
3. **Bare `probez` does the right thing.** Run inside a project with no arguments: collect it, print
   the summary. Subcommands are what you reach for second.

## The round schema

One JSON object per LLM round, appended to `~/.probez/projects/<project>/rounds.jsonl`.

```json
{
  "session": "0b2cc149-f9c1-448f-bbac-a4c58b85e5bf",
  "round": 12, "task": 5, "agent": "main",
  "id": "msg_011CdwVKHe1jaMmvqeWS3tZp",
  "ts": "2026-08-11T19:09:53.830Z", "ms": 8420,
  "model": "claude-opus-5", "in_tokens": 36028, "out_tokens": 132,
  "user_text": "why does the sync loop drop events?",
  "text": "Let me trace how EventLoop.flush calls into...",
  "thinking_chars": 1841,
  "tools": [
    {"name": "Read", "input": {"file_path": "src/loop.ts"}, "result_chars": 8123, "is_error": false, "ms": 42}
  ]
}
```

| Field | Why it exists |
| --- | --- |
| `session`, `task`, `round` | Group rounds into tasks and order them |
| `agent` | Separate the main agent from subagent work |
| `in_tokens`, `out_tokens`, `ms` | Weight each category, giving the percentages |
| `user_text`, `text` | Classify the round's intent |
| `tools[].name`, `tools[].input` | Classify the operation and its target (code / tests / docs / config) |
| `tools[].result_chars` | Depth of a reconstruction step |
| `tools[].is_error` | Debugging signal |

**Not recorded:** reasoning text and tool result bodies, which become character counts only. Both
are large and add little next to `text` and tool inputs. In `tools[].input`, strings over 2000
characters are truncated to the first 200 plus a length marker; object structure and every file
path survives, so the target axis is unaffected while `Edit` and `Write` payloads stop dominating
the file.

A verbatim copy of each session file is kept next to `rounds.jsonl`. Agents prune old sessions, so
this is what keeps every dropped field re-derivable locally, and what makes a lean schema safe.

## Taxonomy

Two rules keep it honest. **Every category gets sub-kinds.** A flat bucket next to a decomposed one
signals that only one of them was taken seriously. And **reading is never the same operation as
writing**: reading docs is Reconstruction with a docs target, writing docs is Documentation.

A third rule earns its place once the categories meet real data. **A category is the shape of the
act; the target is what the act was done to.** "Read the README" and "read the router" are the same
cell, differing only in target, which is why there is no separate category for working on tests or
on configuration: those are targets, and the target axis already carries them.

| Category | Sub-kinds |
| --- | --- |
| Planning | clarify · decompose · design |
| Reconstruction | locate · read · inspect |
| Implementation | create · modify · refactor |
| Verification | test · build · run |
| Review | diff · read-back |
| Documentation | system · change · agent |
| Delivery | commit · publish · branch |
| Environment | deps · env |
| Unclassified | incidental · unknown |

The **target** axis (`code · tests · docs · config · infra · agent · external · unknown`) is derived
from file paths and commands. `agent` is for paths under the agent's own directory, plans and memory
notes, which are neither the project's code nor its documentation.

The command half of that axis landed early, in 0.1.0 itself: `probez tools` reads each `Bash` call
down to the commands it ran and the kind of work each one is (`search`, `vcs`, `test`, …), and
`rounds` filters on both. v0.2 adds the path half and the round-level categories, and it needed no
additional collection, which is the claim being demonstrated rather than asserted.

**Documentation is a deliberate exception to the third rule.** It is, strictly, Implementation with
a docs target. It is kept as a category because "wrote code" versus "wrote prose" is the single
distinction this product exists to make, and because it is not marginal: 39% of all write calls in a
real store target a markdown file. Folding it into Implementation would mean the headline number
silently counted ADRs as code.

### What the data refused

Three things in the original v0.2 sketch did not survive contact with a real store, and are recorded
here because the reasons generalise:

- **Repair is not detectable.** Only 2% of tool calls carry `is_error`, because it is a harness-level
  flag rather than an exit status: a `Bash` call running a suite with 47 failures returns
  `is_error: false`. The store keeps no exit code and no result body, so the great majority of real
  repair work is invisible. The error signal survives as a column on the category table instead.
  Detecting repair properly needs `exit_code` captured at extract time, which is a schema change.
- **`trace` is not detectable.** Following calls across files would mean knowing that one file was
  opened *because* of a symbol found in another, which needs result bodies the store does not keep.
  The nearest proxy, runs of consecutive reads, decays smoothly with no natural threshold: 25% of
  reads at a run of three, 17% at four, and nothing in the data prefers either. A sub-kind whose
  size is set by an unjustifiable constant is a knob, not a measurement.
- **Rounds that call no tool carry no label.** Nine percent of rounds are pure prose, and
  `thinking_chars` is zero throughout, so planning, explaining and summarising are indistinguishable
  there. They are excluded from the denominator and reported on the coverage line. This is why
  Planning reads near 1%: not because agents rarely plan, but because a tool log cannot see it.

### How deep the categories go, and how deep they will go

v0.2 classifies an operation by what it *is*, not by what it was *for*. That is a real ceiling, and
it shows up first in Reconstruction. A `grep` is booked as `locate` whether it was the opening move
of understanding an unfamiliar subsystem or a one-second check for where a constant is defined.
Those are not the same work, and calling both of them reconstruction overstates the number this
product exists to report.

Going deeper means reading an operation in the context of the ones around it: how many calls the
agent spent before it wrote anything, whether a search was followed by reads that followed its
hits, whether the same area was returned to. The round stream already carries what that needs, and
none of it requires new collection. What it requires is a second pass over a sequence rather than a
table lookup on a call, which is a different kind of analysis and belongs in its own version. The
one ordering rule in v0.2, review versus orientation, is the shape the rest of it takes.

Until then the categories should be read as what the agent *did*, not as what it was *achieving*.

**Attribution caveat.** A project is the directory the agent session was *started* in, because that
is how the agent files its own logs. Work done in one repo from a session launched in another is
therefore booked against the launch directory, which will skew per-project percentages for anyone
who works across repos from one session. `tools[].input` carries the paths each tool touched, so a
later version can attribute by files actually edited rather than by launch directory, again with no
additional collection.

Every sub-kind above is derived from v0.1 fields: `tools[].name` separates Write from Edit,
`tools[].input` carries paths and shell commands, and a `git diff` that follows an edit within the
same task is the review signal. **v0.2 required no additional collection.**

One assumption in that list was wrong, and the correction is worth keeping: an earlier draft claimed
`tools[].name` also separates Grep from Read. It does not, in practice. A real store contains six
`Grep` calls and four `Glob` calls in total; effectively all searching goes through `Bash` as
`grep -rn`. The `locate` sub-kind comes from the command table, not from a tool name.

## Roadmap

| | |
| --- | --- |
| **v0.1 · `collect`** | Record and normalize, locally, then read it back at every level: `sessions`, `session`, `tasks`, `task`, `rounds`, `round`, `tools`, including what `Bash` ran |
| **v0.2 · `analyze`** | The distribution above, per project, session and task, with the coverage it is a share of |
| **v0.3 · `view`** | `probez view <project>` writes a self-contained HTML profile and opens it: inline CSS and JS, no server, no CDN, no network |
| **v0.4 · `sync`** | collect → analyze → refresh the view, one command. The day-to-day entry point |
| **v0.5 · trend** | A snapshot is an observation; the decision comes from watching reconstruction move. Rounds are timestamped and the store is append-only, so this needs no new collection |

Each stage reads the previous stage's output file, so `rounds.jsonl` is the contract between them.
`sync` is a thin composition rather than a fourth pipeline, which works because `collect` is
idempotent and incremental.
