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

**Everything is written under one directory** — `~/.probez` by default, overridable with
`--data-dir` or `PROBEZ_DATA_DIR`. Nothing is written outside it, and the source session files are
only ever read.

**What is recorded:** prompts, assistant messages, tool names, and tool inputs — which include file
paths and shell commands. Tool *outputs* and reasoning text are recorded as character counts only.
A verbatim copy of each original session file is also kept.

**Therefore:** treat `~/.probez` with the same care as the repositories it describes. It can contain
secrets that appeared in a prompt or a command line. Review it before sharing any of it. Redaction
for sharing is a planned feature and does not exist yet — until it does, assume no output of probez
is safe to publish unreviewed.
