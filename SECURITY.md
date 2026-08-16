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
- `GET` is the only method with an implementation, apart from three: `POST .../sync`, which runs a
  collection on that project, `POST /api/pricing`, which saves the token rates, and
  `POST /api/import`, which takes in a project someone sent you. Nothing else accepts anything but
  `GET`, and all three refuse `GET` themselves — a URL that collects, or imports, when it is merely
  visited is a URL that can be put in an `<img>` tag on any page you happen to open. Pricing is
  readable with `GET` because reading a rate table changes nothing.
- The page it serves may load only from its own origin, enforced by a content-security-policy on
  every response, and there is nothing off-origin in it to load.

**Browsing writes nothing.** Unlike `analyze`, which caches its result beside the rounds, reading
leaves the store byte-identical, and there is a test that asserts exactly that. Pressing **Sync**
writes, because that is what it is for: it runs `collect` and then rebuilds the analysis cache, the
same two things the commands of those names do. Saving under **Settings** writes the rate table, and
**Import** writes a new project. Those three are the only writes the view can make.

That one button changes what the token protects. Before it, the token and the `Host` check stood
between a page you did not open and *reading* your prompts; now they also stand between it and
starting a collection on your machine.

**Import is somebody else's data, and probez cannot check any of it.** An export arrives by mail or
chat: it is a file of arbitrary JSON written by a machine that is not yours, and once imported,
probez shows it as faithfully as it shows your own work — prompts, shell commands and file paths,
unredacted, on screen and in the terminal. Nothing in it is executed, and it is treated as hostile
data throughout: every field is type-checked, every string is bounded, control characters are
stripped from anything that reaches a terminal so a sender cannot write escape sequences to it, and
the token totals are recomputed from their parts rather than believed. Where it lands is decided by
probez, never by the file — the store directory is a hash of the sender's project identity, so a
`project` field of `../../../../etc/pwned` becomes a directory named `etc-pwned-<hash>` inside the
store like anything else. Re-importing the same project from the same sender replaces it; a project
of the same name from a different sender sits beside it rather than overwriting it. The browser
route accepts a JSON body of at most 256 MB. What it cannot do is tell you whether what the file
says happened, happened.

**Export hands data to your browser, or to the file you name.** probez itself still writes
only under its own data directory — it cannot put a file in the folder you pick, and does not try.
`probez export` writes the same two formats from the command line, under the same owner-only mode as
the rest of the store. What comes out is unredacted either way: `.jsonl` is a byte-for-byte copy of
`rounds.jsonl`, and `.json` adds the manifest and the analysis around the same rounds. Both contain prompts, file paths and shell
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
character counts only. What probez keeps about a result stays counts: how many characters it
returned, how many it wrote to stderr, whether it was cut short, and how many lines and files an
edit changed. No output body, no diff text, and no file path from a result is stored.

**But the store holds more than that.** A verbatim copy of each original session file is kept next
to `rounds.jsonl`, and that copy does contain the full reasoning text and the full tool outputs the
round record leaves out, and it is the larger part of the store by far. "Character counts only"
describes `rounds.jsonl`, not `~/.probez`. Note also that agents prune their own old sessions while
these copies are permanent.

**One more file, and one more write.** `pricing.json` sits beside `projects/` and holds the token
rates the analysis uses. It is written owner-only like everything else, contains no personal data,
and is the only thing the view's Settings screen can change. `POST /api/pricing` needs the run's
token and a matching `Host` like `sync` does, and it accepts a JSON body of at most 64 KB whose every
field must be a non-negative number before anything is saved.

**What probez removes.** Only two things, both its own derived files. When `collect` meets a store
written by an older probez it rebuilds `rounds.jsonl` from the session copies — writing a temporary
file and moving it into place, so an interrupted run leaves the old one intact — and deletes the
`analysis.jsonl` computed from the rounds it replaced. The session copies are never touched, so the
rebuild reads from data it cannot lose. Nothing outside the data directory is ever removed.

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
