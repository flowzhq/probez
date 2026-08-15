# Security

## Reporting a vulnerability

Please report security issues privately to **security@codeflowz.ai** rather than opening a public
issue. Include steps to reproduce and the version you are running. You can expect an initial
response within a few business days.

## How probez handles your data

probez reads real work sessions, so the data-handling rules matter as much as the code.

**Nothing leaves your machine.** probez never opens a connection to anything. There is no telemetry,
no account, no upload path, and no remote configuration. This is enforced by the codebase containing
no HTTP client and no outbound socket use, and checked in CI.

**`probez view` listens on a port, and that deserves stating plainly.** It is the one place probez
opens a socket. It serves your own store, unredacted, to your own browser, so it is fenced in five
ways:

- It binds `127.0.0.1`. It is not reachable from the network, not from another machine, and not
  from a container that is not sharing this host's loopback.
- Every `/api` request must carry a token that is generated fresh on each run and printed with the
  URL. Without it the data does not answer.
- Every request's `Host` header must be the address the server bound. This is the defence against
  DNS rebinding, where a page you visit resolves its own domain to `127.0.0.1` and talks to the
  server from inside your browser. The token alone would not stop that, because the browser would
  send it.
- `GET` is the only method with an implementation, apart from one: `POST .../sync`, which runs a
  collection on that project. Nothing else accepts anything but `GET`, and sync refuses `GET`
  itself — a URL that collects when it is merely visited is a URL that can be put in an `<img>`
  tag on any page you happen to open.
- The page it serves may load only from its own origin, enforced by a content-security-policy on
  every response, and there is nothing off-origin in it to load.

**Browsing writes nothing.** Unlike `analyze`, which caches its result beside the rounds, reading
leaves the store byte-identical, and there is a test that asserts exactly that. Pressing **Sync**
writes, because that is what it is for: it runs `collect` and then rebuilds the analysis cache, the
same two things the commands of those names do. It is the only write the view can make.

That one button changes what the token protects. Before it, the token and the `Host` check stood
between a page you did not open and *reading* your prompts; now they also stand between it and
starting a collection on your machine.

**Export hands data to your browser, which writes it wherever you say.** probez itself still writes
only under its own data directory — it cannot put a file in the folder you pick, and does not try.
What comes out is unredacted: `.jsonl` is a byte-for-byte copy of `rounds.jsonl`, and `.json` adds
the manifest and the analysis around the same rounds. Both contain prompts, file paths and shell
commands exactly as typed, so an export is a copy of the thing this page has been warning you about,
now outside the owner-only store and in whatever directory you chose. Read the last paragraph of
this file before sending one anywhere.

What it *does* put on screen is everything in `rounds.jsonl`: prompts in full, assistant messages in
full, and every tool input including file paths and shell commands. Anyone who can see your screen
while it is open can read those. It is a local tool for looking at your own work, and it is not a
dashboard to leave running on a shared machine.

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
