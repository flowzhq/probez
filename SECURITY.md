# Security

## Reporting a vulnerability

Please report security issues privately to **security@codeflowz.ai** rather than opening a public
issue. Include steps to reproduce and the version you are running. You can expect an initial
response within a few business days.

## How probez handles your data

probez reads real work sessions, so the data-handling rules matter as much as the code.

**Nothing leaves your machine.** probez makes no network calls. There is no telemetry, no account,
no upload path, and no remote configuration. This is enforced by the codebase containing no HTTP
client and no outbound socket use, and checked in CI.

**Everything is written under one directory.** That is `~/.probez` by default, overridable with
`--data-dir` or `PROBEZ_DATA_DIR`. Nothing is written outside it, and the source session files are
only ever read.

**What is recorded, in `rounds.jsonl`:** prompts, assistant messages, tool names, and tool inputs,
which include file paths and shell commands. Prompts and assistant text are stored in full; in a
tool input, individual strings over 2,000 characters are cut to the first 200 plus a length marker,
which a command line essentially never reaches. Tool *outputs* and reasoning text are recorded as
character counts only.

**But the store holds more than that.** A verbatim copy of each original session file is kept next
to `rounds.jsonl`, and that copy does contain the full reasoning text and the full tool outputs the
round record leaves out, and it is the larger part of the store by far. "Character counts only"
describes `rounds.jsonl`, not `~/.probez`. Note also that agents prune their own old sessions while
these copies are permanent: probez never deletes anything.

**The store is owner-only.** Directories are created `0700` and files `0600`, matching the mode the
agent already uses for the session files probez reads. `collect` also tightens anything under the
data directory it finds looser, so a store written by probez 0.1.0, which used the system default
and left `rounds.jsonl` world-readable, is repaired the next time you collect. probez only ever
removes access here, never grants it.

**`collect --all` concentrates everything.** It walks every project on the machine, so one directory
ends up holding the session history of every repository you have worked in, with client work
and personal projects side by side. That is a different exposure profile from the per-project
layout it reads from, and the reason the mode matters.

**Therefore:** treat `~/.probez` with the same care as the repositories it describes. It can contain
secrets that appeared in a prompt or a command line. probez does no redaction of any kind, and a
credential typed into a shell command is stored exactly as typed. Review it before sharing any of
it. Redaction for sharing is a planned feature and does not exist yet. Until it does, assume no
output of probez is safe to publish unreviewed.
