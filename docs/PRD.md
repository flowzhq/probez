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
  "round": 12, "task": 5, "commit": "9e4e660c1d7a4c2f0b8e5a3d61f27b90cc4e1a55", "agent": "main",
  "id": "msg_011CdwVKHe1jaMmvqeWS3tZp",
  "ts": "2026-08-11T19:09:53.830Z", "ms": 8420, "gen_ms": 14903, "wait_ms": null,
  "first_input": "tool_result",
  "model": "claude-opus-5",
  "in_tokens": 36028, "in_uncached": 2, "in_cache_read": 34209,
  "in_cache_write": 1817, "in_cache_write_5m": 0, "in_cache_write_1h": 1817,
  "out_tokens": 132,
  "mcp_server": null, "mcp_tool": null, "skill": null,
  "user_text": "why does the sync loop drop events?",
  "text": "Let me trace how EventLoop.flush calls into...",
  "thinking_chars": 1841,
  "tools": [
    {"name": "Read", "id": "toolu_013evtr8jYg2P6ypM2pmuWkR",
     "input": {"file_path": "src/loop.ts"}, "input_chars": 38,
     "result_chars": 8123, "is_error": false, "stderr_chars": null, "interrupted": null,
     "patch": null,
     "emitted_at": "2026-08-11T19:09:58.201Z", "result_at": "2026-08-11T19:09:58.243Z", "ms": 42}
  ],
  "events": [
    {"type": "tool_result", "ts": "2026-08-11T19:09:48.799Z", "chars": 581,
     "tool_call_id": "toolu_01GCiCgBY7BoAuSi88wMUexZ"},
    {"type": "reasoning", "ts": "2026-08-11T19:09:53.830Z", "chars": 1841},
    {"type": "text", "ts": "2026-08-11T19:09:56.260Z", "chars": 200},
    {"type": "tool_call", "ts": "2026-08-11T19:09:58.201Z",
     "tool_call_id": "toolu_013evtr8jYg2P6ypM2pmuWkR"}
  ]
}
```

| Field | Why it exists |
| --- | --- |
| `session`, `task`, `round` | Group rounds into tasks and order them |
| `agent` | Separate the main agent from subagent work |
| `commit` | Which state of the tree a task was asked against, read from git's HEAD reflog at collect time |
| `in_tokens`, `out_tokens`, `ms` | Weight each category, giving the percentages |
| `in_uncached`, `in_cache_write`, `in_cache_read` | The three price differently, so the sum alone says little about cost |
| `in_cache_write_5m`, `in_cache_write_1h` | A cache write has two prices: 1.25× input for a 5-minute entry, 2× for a 1-hour one |
| `gen_ms`, `wait_ms`, `first_input` | Separate the model's time from the person's, which `ms` cannot |
| `events[]` | The round's moments in order, so a timing question does not need a re-collect |
| `mcp_server`, `mcp_tool`, `skill` | Name work a built-in tool table cannot place |
| `user_text`, `text` | Classify the round's intent |
| `tools[].name`, `tools[].input` | Classify the operation and its target (code / tests / docs / config) |
| `tools[].id`, `emitted_at`, `result_at` | Pair a call with its result, including across rounds |
| `tools[].result_chars`, `input_chars` | Depth of a reconstruction step, and the true size of a truncated call |
| `tools[].is_error` | What the harness reported |
| `tools[].stderr_chars`, `interrupted` | What actually happened, which the harness flag does not report |
| `tools[].patch` | Lines an edit changed, for attributing work to the files it touched |

**Pricing is not in the round.** A round records tokens; what they cost depends on rates that change
and that differ per contract, so they live in `~/.probez/pricing.json` and are applied at read time.
Every share under "where agent work goes" is a share of cost, so a wrong rate is a wrong answer;
the rates ship at published list prices and are editable in the view's Settings screen. A model with
no rate is reported as outside the shares rather than counted as free.

**Not recorded:** reasoning text and tool result bodies, which become character counts only. Both
are large and add little next to `text` and tool inputs. In `tools[].input`, strings over 2000
characters are truncated to the first 200 plus a length marker; object structure and every file
path survives, so the target axis is unaffected while `Edit` and `Write` payloads stop dominating
the file. `input_chars` carries the size the cut removed, so a truncated call still says how large
it was.

**Two things worth being precise about.** `ms` spans the records the round itself wrote; `gen_ms`
runs from the input that prompted it, so it includes the wait before the model said anything. On one
442-round store the two are 0.66h and 1.82h — most of a round is outside `ms`. And `is_error` is the
harness's flag, meaning the call was accepted, not that it worked: a Bash call whose suite failed
comes back `false`. There is no exit code anywhere in the source records, so `stderr_chars` and
`interrupted` are the whole of the real signal.

A verbatim copy of each session file is kept next to `rounds.jsonl`. Agents prune old sessions, so
this is what keeps every dropped field re-derivable locally, and what makes a lean schema safe. It
is also what a schema change rebuilds from: `collect` rewrites a store it finds on an older version,
including the sessions the agent has since pruned.

## Taxonomy

Classification happens in two passes, and keeping them apart is what makes the second one small.
`act.ts` reads a call down to the **verbs** it performed — read, write, search, test, commit — which
are facts you could confirm by looking at the call. `classify.ts` maps each verb onto a category
through one flat table. A label you disagree with is a row to change, not a rule to trace.

Two rules keep the taxonomy honest. **Reading is never the same operation as writing**: reading
`CHANGELOG.md` is Planning, writing it is Documentation. And **a category is the shape of the act;
the target is what the act was done to** — which is why there is no separate category for working on
tests or on configuration. Those are targets, and the target axis already carries them.

| Category | Sub-kinds |
| --- | --- |
| Planning | read · clarify · decompose · design |
| Reconstruction | locate · read · inspect |
| Implementation | create · modify |
| Testing | test · run |
| Documentation | system · change · agent |
| Delivery | build · commit · publish · branch |
| Environment | deps · env · infra |
| Unclassified | incidental · unknown |

The one place a path changes a *category* rather than only a target is prose. Reading prose is
Planning, writing it is Documentation, and everything else is the verb's row. Because that question
is asked once, against the path, `Write` on a README and `cat > README.md` cannot disagree — which
they did while the check lived on the tool path only.

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

- **Repair was not detectable, and the fix was not the one assumed.** Only 2% of tool calls carry
  `is_error`, because it is a harness-level flag rather than an exit status: a `Bash` call running a
  suite with 47 failures returns `is_error: false`. This was written up as needing `exit_code`
  captured at extract time. There is no exit code in the source records — the field does not exist.
  What does exist is `stderr` and `interrupted` on the raw result, which v0.3 captures as
  `stderr_chars` and `interrupted`. On one 442-round store that surfaces 15 calls that failed while
  the harness reported success. The taxonomy does not yet spend it; the point here is that the
  blocker was a wrong guess about the source, not a missing capability.
- **`trace` is not detectable.** Following calls across files would mean knowing that one file was
  opened *because* of a symbol found in another, which needs result bodies the store does not keep.
  The nearest proxy, runs of consecutive reads, decays smoothly with no natural threshold: 25% of
  reads at a run of three, 17% at four, and nothing in the data prefers either. A sub-kind whose
  size is set by an unjustifiable constant is a knob, not a measurement.
- **Rounds that call no tool carry no label.** Nine percent of rounds are pure prose, and
  `thinking_chars` is zero throughout, so planning, explaining and summarising are indistinguishable
  there. They are excluded from the denominator and reported on the coverage line. Deliberation
  itself remains invisible to this instrument, whatever Planning's number says.

A fourth was removed in 0.3.2 rather than refused outright. **Review did not earn what it cost.** It
held one rule — a `git diff` after an edit is checking your work, the same command before one is
orienting — and paying for that rule meant every round carrying the history of its task, so no round
could be labelled on its own. Read-only git is now unconditionally Reconstruction. The distinction
was never load-bearing; the property bought back is that classification is a function of the call.

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
table lookup on a call, which is a different kind of analysis and belongs in its own version. v0.2
tried to smuggle one such rule into the per-call table as Review, and 0.3.2 took it back out: that
analysis wants its own pass, not a category propped up by task history.

Until then the categories should be read as what the agent *did*, not as what it was *achieving*.

**Attribution caveat.** A project is the directory the agent session was *started* in, because that
is how the agent files its own logs. Work done in one repo from a session launched in another is
therefore booked against the launch directory, which will skew per-project percentages for anyone
who works across repos from one session. `tools[].input` carries the paths each tool touched, so a
later version can attribute by files actually edited rather than by launch directory, again with no
additional collection.

Every sub-kind above is derived from v0.1 fields: `tools[].name` separates Write from Edit, and
`tools[].input` carries the paths and shell commands everything else is read out of. **v0.2 required
no additional collection**, and neither did the 0.3.2 rework.

One assumption in that list was wrong, and the correction is worth keeping: an earlier draft claimed
`tools[].name` also separates Grep from Read. It does not, in practice. A real store contains six
`Grep` calls and four `Glob` calls in total; effectively all searching goes through `Bash` as
`grep -rn`. The `locate` sub-kind comes from the command table, not from a tool name.

## How the stages fit together

Each stage reads the previous stage's output file, so **`rounds.jsonl` is the contract between
them**: `collect` writes it, `analyze` derives the distribution from it, and the view reads both
without re-deriving either.

That is what keeps anything built on top a thin composition rather than another pipeline, and it
works because `collect` is idempotent and incremental — re-running it appends what is new and
writes nothing the second time. The view already composes the two, per project, from a button.

What ships next is deliberately not written down here: a roadmap that turns out to be wrong is worse
than no roadmap, and this one was renumbered twice before the version it described had shipped.
[CHANGELOG.md](../CHANGELOG.md) is the record of what exists.

## v0.2 · the view

**A performance profiler for agent work.** The data has been hierarchical since v0.1 — project,
session, task, round — and reading it back has meant one table per command and joining them in your
head. The view is that hierarchy made navigable, arranged the way Chrome DevTools' Performance panel
is arranged, because the question is the same shape: where did the time go, and what was happening
there.

Four levels, and a round is a selection rather than a page:

```
/                            every project in the store
/p/<slug>                    summary · where work goes · sessions
/p/<slug>/s/<session>        work profile · the session strip · tasks
/p/<slug>/s/<session>/t/<n>  the trace, with the round inspector under it
```

**The trace is the centrepiece.** Two rows over one axis. The *ribbon* is phases: consecutive rounds
that were mostly the same kind of work, collapsed and named. The *strip* is the rounds themselves,
one cell each, and each cell is a stack rather than a block, because a round's weight splits across
the work it did.

Three decisions in it are worth recording, because each was a choice with an alternative:

- **The default axis is round index, not time.** Time is the truthful axis for cost and the useless
  one for reading — a session's slowest round can be four minutes and its fastest four
  milliseconds, so forty rounds become a sliver you cannot point at. Both are offered, the toggle
  says which you are looking at, and the header carries working time and elapsed time either way.
- **Phases are smoothed over five rounds, and the view says so.** Run-length encoding the raw
  per-round dominant gives a band every round or two — a real 122-round task produced 80 of them —
  because real work alternates on the scale of a single round. A phase is a claim about a stretch,
  so it is decided over a stretch. That is a choice rather than a measurement, so the window
  travels with the data and every round keeps its own unsmoothed label alongside.
- **Prose-only rounds are drawn, hatched, rather than dropped.** They carry no label and sit outside
  every share, which is exactly why the strip has to show them: a timeline that quietly omitted 5%
  of the rounds would be lying about how many there were.

**Every share carries its denominator**, the same coverage line the CLI prints, in the chart rather
than under it.

**The inspector marks the call, not only the round.** A round's labels are its calls added up, which
is the number every chart above is built from; each call now carries the categories it contributed,
so a `Bash` call that ran three commands shows all three and a share you disagree with leads back to
the call that produced it. That is the per-call line `probez round <id>` has always printed, which
is the point: two front ends over one classifier should not show different things.

**Why a server and not a file.** An earlier plan promised a self-contained HTML profile. A store on this
machine holds 3,667 rounds in one project and 6.5 MB of prose; inlining that produces a document
that is slow to open and stale the moment it is written. A loopback server lazy-loads instead, and
writes nothing at all. The cost is a socket, which is why `CONTRIBUTING.md` constraint 2 is now
"no *outbound* network" and why five separate CI checks fence in what the listener may do.

**The actions, and the line they sit on.** A project can be **synced** — `collect` then `analyze`,
on that project — **renamed**, **exported** and **deleted**; the store's rates can be **saved**, and
a project someone sent you can be **imported**. Sync makes exactly the writes those two commands
make, through the same `analysisRecords` that builds the cache for `analyze`, so the file cannot come
to mean two things depending on which wrote it last. Those five writes are all the view has, and each
is a `POST` that refuses `GET`, because a URL that collects — or imports, or deletes — when it is
merely visited is a URL that can be put in an `<img>` tag. Export does not bend constraint 3: the
server hands bytes to the browser and the browser writes them where the person said, which is also
the only way a page can put a file on disk.

**Rename is a label, and deliberately not a move.** A project's directory in the store is a hash of
the path an agent ran in, which is what makes a collect idempotent and what keeps two repos sharing a
basename apart. A name that decided a location would be a name that could be typed on top of another
project, so the chosen name lives in the manifest beside the derived one rather than replacing it:
`collect` recomputes `project` from the path every time it runs and carries `name` across, and
clearing `name` is a revert rather than a project with no name. The CLI reads the same field, so a
project renamed in the browser is the name `probez analyze <name>` answers to and the name
`probez projects` prints — a name that meant two things in the two front ends would be worse than no
rename at all.

**Delete is the only thing in probez that destroys anything**, which is the whole of what makes it
worth writing down. It is fenced twice — the slug must have the shape `slugFor` produces, and the
path it resolves to must be under `<data-dir>/projects/` — so it cannot be aimed out of the store,
and it removes nothing the agent wrote: constraint 3 says probez only ever *reads* the session files,
and that holds on the way out as well as on the way in. So a collected project comes back with
`probez collect`, minus whatever the agent has pruned since, and an imported one does not come back
at all. The view says both of those in the panel that asks, because the difference between them is
the difference between an inconvenience and a loss.

**Import is the one input probez does not control.** Everything else it reads was written by the
agent on this machine; an export was written by somebody else's, and arrives by whatever route
attachments arrive by. So it is parsed as hostile: every field type-checked, every string bounded,
control characters stripped from anything that reaches a terminal, token totals recomputed from
their parts rather than believed, and the store directory derived from a hash of the sender's project
identity so nothing in the file can decide where anything is written. What probez cannot do is
verify the contents — an imported round says whatever the sender's agent said, and probez shows it
as faithfully as your own. That is the feature and the risk together, which is why `SECURITY.md`
says so at the same length. An export written before the token split is refused rather than shown at
zero cost: a wrong number is worse than a missing project.

**What it deliberately does not do.** Reading never writes, not even the analysis cache that
`analyze` leaves behind as a side effect of being run. And it invents no categories: the sketch this
was designed from showed `SPEC` and `DEBUG` bands, and neither is a thing the analyzer can produce,
so neither is drawn.
