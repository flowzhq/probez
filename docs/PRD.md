# probez — product requirements

## Problem

Coding agents produce a detailed local log of every session — each LLM call, every tool invocation,
the timing in between. It is rich data in an inconvenient shape: one append-only JSONL file per
project directory, structured for replaying a conversation rather than for measuring work.

So questions a team actually has go unanswered. How much of a session is spent reconstructing
context that already exists somewhere in the repo, versus writing code? Which tasks are the
expensive ones, and expensive in what way?

## Goal

Turn that log into a stable, analyzable stream — one record per LLM round — with zero configuration
and zero dependencies, entirely on the developer's machine.

v0.1 delivers collection and normalization, plus the commands to read the result back — down to a
single tool call, without a second tool. Analysis is a separate stage that reads the same file.

## Non-goals

These are choices, not omissions:

- **No analysis in v0.1.** Classification is a distinct problem with distinct failure modes. It
  ships in v0.2 against a schema that is already stable.
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
- The round stream is sufficient input for the v0.2 taxonomy below, with no further collection.

## Time to value

Three commitments that keep the first run worthwhile:

1. **The history is already there.** The first run reads months of past sessions. Value is
   immediate, not accrued over weeks of recording.
2. **Every stage pays off alone.** v0.1 ends with a summary — sessions, tasks, rounds, tokens, date
   span, top tools — and commands that read the store back down to a single tool call. Counts, not
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
| `in_tokens`, `out_tokens`, `ms` | Weight each category — the percentages |
| `user_text`, `text` | Classify the round's intent |
| `tools[].name`, `tools[].input` | Classify the operation and its target (code / tests / docs / config) |
| `tools[].result_chars` | Depth of a reconstruction step |
| `tools[].is_error` | Debugging signal |

**Not recorded:** reasoning text and tool result bodies — character counts only. Both are large and
add little next to `text` and tool inputs. In `tools[].input`, strings over 2000 characters are
truncated to the first 200 plus a length marker; object structure and every file path survive, so
the target axis is unaffected while `Edit` and `Write` payloads stop dominating the file.

A verbatim copy of each session file is kept next to `rounds.jsonl`. Agents prune old sessions, so
this is what keeps every dropped field re-derivable locally — and what makes a lean schema safe.

## Taxonomy (v0.2 target)

Two rules keep it honest. **Every category gets sub-kinds** — a flat bucket next to a decomposed one
signals that only one of them was taken seriously. And **reading is never the same operation as
writing**: reading docs is Reconstruction with a docs target, writing docs is Documentation.

| Category | Sub-kinds |
| --- | --- |
| Reconstruction | locate · relationship/flow · behavior · system/config |
| Implementation | new code · modify · refactor |
| Testing | write tests · run & verify |
| Debugging | reproduce · localize · fix |
| Planning | decompose · design |
| Operations | deps/env · git · build/CI |
| Documentation | code docs · commit & PR text |

A second axis — the **target** of the operation (code / tests / docs / config / infra) — is derived
from file paths and commands, and is what separates "read the README" from "read the router".

The command half of that axis landed early, in 0.1.x: `probez tools` reads each `Bash` call down to
the commands it ran and the kind of work each one is (`search`, `vcs`, `test`, …), and `rounds`
filters on both. It needed no additional collection, which is the claim below being demonstrated
rather than asserted. v0.2 still owes the path half, and the round-level categories themselves.

**Attribution caveat.** A project is the directory the agent session was *started* in, because that
is how the agent files its own logs. Work done in one repo from a session launched in another is
therefore booked against the launch directory, which will skew per-project percentages for anyone
who works across repos from one session. `tools[].input` carries the paths each tool touched, so
v0.2 can attribute by files actually edited rather than by launch directory — again with no
additional collection.

Every sub-kind above is derivable from v0.1 fields: `tools[].name` separates Write from Edit and
Grep from Read, `tools[].input` carries paths and shell commands, `tools[].is_error` followed by a
re-run is the reproduce→fix signal. **v0.2 requires no additional collection.**

## Roadmap

| | |
| --- | --- |
| **v0.1 — `collect`** | Record and normalize, locally — and read it back at every level: `sessions`, `session`, `tasks`, `task`, `rounds`, `round`, `tools` — including what `Bash` ran |
| **v0.2 — `analyze`** | The distribution above, per project and per task |
| **v0.3 — `view`** | `probez view <project>` writes a self-contained HTML profile and opens it — inline CSS and JS, no server, no CDN, no network |
| **v0.4 — `sync`** | collect → analyze → refresh the view, one command. The day-to-day entry point |
| **v0.5 — trend** | A snapshot is an observation; the decision comes from watching reconstruction move. Rounds are timestamped and the store is append-only, so this needs no new collection |

Each stage reads the previous stage's output file, so `rounds.jsonl` is the contract between them.
`sync` is a thin composition rather than a fourth pipeline, which works because `collect` is
idempotent and incremental.
