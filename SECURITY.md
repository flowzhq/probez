# Security

## Reporting a vulnerability

Please report security issues privately to **security@codeflowz.ai** rather than opening a public
issue. Include steps to reproduce and the version you are running. You can expect an initial
response within a few business days.

## How probez handles your data

probez reads real work sessions, so the data-handling rules matter as much as the code. It reads
Claude Code session files under `~/.claude/projects`, Cursor agent transcripts under
`~/.cursor/projects`, and Codex CLI rollouts under `~/.codex/sessions` (or `$CODEX_HOME/sessions`).
Claude and Cursor write a subagent's run to a `subagents/` directory beside the session that spawned
it; Codex names a subagent on the rollout's `session_meta`. Those are read too — a subagent's
transcript is a session like any other here, and is copied into the store on the same terms as the
rest.

**Nothing leaves your machine, unless you set up a reader and press explain.** probez never opens a
connection to anything. There is no telemetry, no account, no upload path, and no remote
configuration. This is enforced by the codebase containing no HTTP client and no outbound socket
use, and checked in CI. The one exception is spelled out below under *the reader*, and it is a
program you name and a moment you choose.

**One repository is looked into outside the agent's session directory.** To say which commit a task
started from, probez opens `.git/logs/HEAD` — git's HEAD reflog — in the directory the agent ran in.
That is a read of one text file, read-only.

Where the reflog cannot reach the task, probez also runs one command in that directory:
`git log --first-parent --format=%H %ct`. It is spawned as argv with no shell, with the pager off
and `GIT_OPTIONAL_LOCKS=0` so it takes no lock, and it writes nothing. Nothing from the repository
is executed by probez, every failure is simply no answer, and probez works the same where git is not
installed. It runs only when it can add something: a reflog that still holds the repository's first
commit covers it whole, and for one of those no command is run at all.

What is kept from either is a commit hash per round and nothing else; branch names, commit messages,
and the identity of whoever made the commits are all in that reflog and that history, and none of
them are stored. A directory that is not a checkout, or one where neither source can answer, is
recorded as having no commit.

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
- `GET` is the only method with an implementation, apart from ten: `POST .../sync`, which runs a
  collection on that project, `POST .../rename`, which sets the name a project is shown under,
  `POST .../delete`, which removes a project from the store, `POST /api/clear`, which removes many
  of them, `POST .../explain`, which runs the
  reader on one question, `POST /api/compile`, which runs the reader on one question you typed into
  the search box, `POST /api/pricing`, which saves the token rates, `POST /api/reader`,
  which sets the command those two run, `POST /api/commands`, which names a command this machine
  knows, and `POST /api/import`, which takes in a project someone
  sent you. Nothing else accepts anything but `GET`, and all ten refuse `GET` themselves — a URL
  that collects, renames, deletes, imports or starts a program when it is merely visited is a URL
  that can be put in an `<img>` tag on any page you happen to open. Pricing and the reader are
  readable with `GET` because reading a setting changes nothing. **Searching is a `GET`** — it
  writes nothing, not even the index it is answered from. `/api/clear` is a `POST` in both halves:
  saying what would go writes nothing either, and is a `POST` only so that the half which acts
  cannot be reached by a URL.
- The page it serves may load only from its own origin, enforced by a content-security-policy on
  every response, and there is nothing off-origin in it to load.

**Browsing writes nothing.** Unlike `analyze`, which caches its result beside the rounds, reading
leaves the store byte-identical, and there is a test that asserts exactly that. Pressing **Sync**
writes, because that is what it is for: it runs `collect` and then rebuilds the analysis cache, the
same two things the commands of those names do. **Rename** rewrites one field of one manifest.
**Delete** removes one project's directory. Saving under **Settings** writes the rate table and the
reader, **Explain** writes what a reader answered about one question, **ask** writes what one
answered about a question you typed, naming a command writes `commands.json`, the **danger zone**
removes projects, and **Import** writes a new project. Those ten are the only writes the view can
make.

Those buttons change what the token protects. Before them, the token and the `Host` check stood
between a page you did not open and *reading* your prompts; now they also stand between it and
starting a collection on your machine, between it and deleting what has been recorded, and — where
a reader is configured — between it and running that command.

**Deleting and clearing are the only things in probez that destroy data.** There are three shapes
of it and they go through the same fence.

**Delete** removes one project's directory from the store — its rounds, the session copies beside
them, the analysis cache and the manifest. **Clear** removes many: `probez clear --all`, or the
danger zone's *clear the whole store*, takes every project; `probez clear --before 30d`, or *trim
old history*, takes every **session** whose last round is older than the window, along with the
archived transcript beside it, and removes any project left with nothing. A session with any newer
round is kept whole, so a project you still work in keeps its recent work.

Two checks keep all three pointed inside the store, and they are the same two: the slug must have
the shape `slugFor` produces, with no separators and no `..`, and the path it resolves to must be
under `<data-dir>/projects/`. Nothing outside the store is reachable from any of them, whatever a
request says. Trimming rewrites `rounds.jsonl` beside itself and moves the new file over the old
one, so a clear that is interrupted leaves the store as it was rather than half of it. Rates and the
reader are settings rather than projects and are never cleared.

None of it touches the agent's own session files, which probez has only ever read. So a collected
project comes back with `probez collect` minus whatever the agent has pruned since — and a session
cleared from the store is not remembered as cleared, so an unrestricted collect brings that back
too. If what you wanted was a smaller store rather than a fuller one, `probez collect --since 30d`
is the companion: it reads only sessions the agent has written to inside a window. An imported
project does not come back: the file it arrived as is the only other copy that ever existed here.

Everything that destroys says what will go before it goes, and asks. The command prints the plan —
how many projects, sessions, rounds and bytes — and waits for an answer on the terminal; with no
terminal to ask on it refuses rather than assuming, which is what makes `probez clear --all | tee
log` safe, and `--yes` is how a script says it means it. The view shows the same figures, and names
the largest projects rather than only counting them, in a panel that has to be opened before
anything can be pressed.

**Rename is a label and moves nothing.** The name is stored in the manifest and used for display and
for matching a project by name on the command line. A project's directory in the store is a hash of
the path an agent ran in and is not derived from the name, so a rename cannot land one project on top
of another or anywhere outside the store. Control characters are stripped for the same reason they
are stripped from an import: `probez projects` prints the name to a terminal, and a terminal obeys
escape sequences.

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
the rest of the store. By default what comes out is unredacted: `.jsonl` is a byte-for-byte copy of
`rounds.jsonl`, and `.json` adds the manifest and the analysis around the same rounds. Both contain prompts, file paths and shell
commands exactly as typed, so an export is a copy of the thing this page has been warning you about,
now outside the owner-only store and in whatever directory you chose. Read the last paragraph of
this file before sending one anywhere.

**`--darken` is the exception, and it is the one to use for anything leaving your machine.** With it
— *Darken the export* in the view's Export menu — the export is rewritten on the way out. Tokens
are salted with bytes generated for that export and thrown away, so they are one-way and two exports
of the same project share none of them.

*Replaced with `****`:* the prompt of every round, and the assistant's prose.

*Replaced with a token:* every file path, every shell command's arguments, every search term and
pattern, MCP server, MCP tool and skill names, the name of any command probez's own table does not
recognise, commit hashes, and the project's name, path and key.

*Kept exactly, because they are the measurement:* every count and duration — rounds, tasks, tokens,
cost, timing, errors — and the things the analyzer reads to classify. That last group is the part
worth reading twice, since it is what a darkened export still discloses:

- **Timestamps, in full.** Every round keeps its clock. That is when you were working, to the
  second, and it is not covered by any of the above.
- **Model ids** (`claude-opus-5`), because cost is computed from them.
- **Tool and command names probez recognises** (`Edit`, `Bash`, `git`, `npm`) — these are the
  figures. A name it does not recognise is tokenized, because that one is yours.
- **File extensions and conventional directory names** (`src`, `tests`, `docs`), since the target
  axis is read off them.
- **Session, message and tool-call ids**, which are opaque strings the harness generated. They carry
  no content, and they have to keep pairing with one another for `probez task` and `probez round` to
  resolve on the other side.
- **Which agent produced each round** (`claude-code`, `cursor`, `codex`).
- **The counts themselves**, which describe real work. A small project's shape can be recognisable
  to someone who already knows it.

Darkening is a way to send a shape. It is not anonymisation, and it is not a claim about what cannot
be inferred from one.

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

**And two derived files beside them.** `analysis.jsonl` holds what each round was counted as, which
is labels and numbers and no text. `search.jsonl` is the index `probez find` is answered from, and
it is worth naming here because of what is in it: alongside a column per field, it holds an inverted
index of the *words* of every prompt, every assistant message, every shell command and every path —
each word once, with the rounds it appears in. It is not the text back again, and it cannot be read
back as sentences, but anyone holding it can tell which words you and the agent used. It is written
under the same owner-only mode as the rest of the store, it goes when the project goes, and deleting
it costs nothing but speed — every command that reads it can also do without it.

**The reader: the one thing probez can run, and the one thing it can send.** The model is one you
already have. You write the command in `<data-dir>/reader.json`, as `{"command": ["claude", "-p"]}`
or `{"command": ["ollama", "run", "llama3"]}`, or set it under **Settings**; probez writes a prompt
to that command's stdin and reads its stdout. Two things use it, and no more — the number is checked
in review, because a list of callers that grows quietly is how this stops being one decision:

- `probez explain <id>`, or the **explain** button, takes a single question — one thing the agent
  needed to know, and the calls it spent finding out — and asks a model what it was, in a sentence.
- `probez find --ask "…"`, or **ask** mode in the search box, takes a question you typed and asks a
  model to write it as a probez **query**. What comes back is not an answer and is not believed:
  probez parses it, refuses it outright if it does not read, shows it to you, and only then answers
  it with the same code that answers a query you typed by hand. A model chooses which rounds to
  look at and never what any of them came to, so every figure stays derived from the rounds and a
  result read from a question is reproducible by someone with no reader configured at all.

Eight things bound both:

- probez still opens no socket. Whatever the command talks to, it talks to as you, under your
  account and your credentials, exactly as if you had typed it. probez holds no API key and has
  nowhere to put one.
- The command is argv and is run with no shell. A `;`, a `|` or a `$(…)` in it is an argument, not a
  second command, and nothing read out of a session can reach the argv — only the config file can.
- It runs when you ask, on the thing you asked about. Collecting, analyzing, browsing and every
  `GET` run nothing, and both routes that reach it refuse `GET`.
- What `explain` sends is that question's calls, and only those: the verb, how wide it reached, the
  words it searched for, the paths it named, and the command as it ran. No prompts you typed, no
  assistant text, no tool output.
- What `--ask` sends is the query language's field table, the values each field can take, a sample
  of the names this store holds — tool names, command names, model names — and your question. About
  five kilobytes, and it does not grow with the store. No prompts you typed, no assistant text, no
  tool output, no file contents.
- `--prompt` on either prints exactly what would be sent and runs nothing — which is also how to
  use this with no reader configured at all.
- What is sent is still your data. A shell command in a question's calls can contain a path, a
  hostname, or a secret you typed; a tool or command name in the `--ask` sample is a name out of a
  session log, and if that log came from an *imported* project it was written on somebody else's
  machine. Names are stripped of control characters and bounded in length and number, and what
  bounds the risk is what the answer can be: a query probez parses, which selects rows and does
  nothing else. Either way, sending to a hosted model sends it off this machine and a local model
  keeps it on. That choice is the command you write in the file.
- With no `reader.json` there is nothing probez can run, and it says so rather than falling back to
  anything. What a reader answers about a question is kept in `readings.json` beside that project's
  rounds and goes when the project goes; what it answers about a sentence is kept in `asked.json`
  beside `pricing.json`, keyed by the store it was asked of, so the same question is not paid for
  twice. Neither is ever shown in place of probez's own measurement.

**Naming a command classifies and nothing else.** `commands.json` sits beside `pricing.json` and
maps a command name to a kind of work, for the names probez cannot ship — a repository's own script
arrives as its last path segment, and `q` is too generic to put in a table everyone shares. Nothing
in it can make probez run a program, read anything outside its own data directory, or send anything
anywhere; the worst a wrong entry does is count some rounds in the wrong column, which the coverage
line and `analyze --unclassified` already exist to make visible. Names are bounded in length and
number and must match the same shape a shipped name does, so nothing in the file can reach a path.

**One more file, and one more write.** `pricing.json` sits beside `projects/` and holds the token
rates the analysis uses. It is written owner-only like everything else, contains no personal data,
and is the only thing the view's Settings screen can change. `POST /api/pricing` needs the run's
token and a matching `Host` like `sync` does, and it accepts a JSON body of at most 64 KB whose every
field must be a non-negative number before anything is saved. `reader.json` sits beside it and holds
the command above, under the same mode and the same checks; `POST /api/reader` takes the argv as a
list and stores it as one, so nothing is ever re-parsed into a shell line.

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
secrets that appeared in a prompt or a command line. probez does no redaction *of the store*, and a
credential typed into a shell command is stored exactly as typed. Review it before sharing any of
it. Redaction exists for one thing only, and it is `probez export --darken`, described above: it
redacts what leaves, never what is kept. Assume no other output of probez is safe to publish
unreviewed.
