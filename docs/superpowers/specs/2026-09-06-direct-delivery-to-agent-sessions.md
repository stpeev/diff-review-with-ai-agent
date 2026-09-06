# Direct Delivery to Running Agent Sessions

**Status:** proposed
**Date:** 2026-09-06

## Problem

`diffReview.sendThread` and `diffReview.submitAll` end at
`workbench.action.chat.open` (Copilot) or, failing that, the clipboard. For the
two agents most likely to have *produced* the diff being reviewed — Claude Code
and Codex — there is no delivery at all. The user copies a prompt and pastes it
into the right session by hand.

"The right session" is itself the hard part. On this machine, three live Claude
Code sessions share one workspace root and one extension host:

```
pid=22274 ppid=21592 name=diff-review-with-ai-agent-91 cwd=/Users/speev/projects/diff-review-with-ai-agent
pid=22469 ppid=21592 name=diff-review-with-ai-agent-a5 cwd=/Users/speev/projects/diff-review-with-ai-agent
pid=65818 ppid=21592 name=diff-review-with-ai-agent-72 cwd=/Users/speev/projects/diff-review-with-ai-agent
```

Neither `cwd` nor parent process distinguishes them. Any design that infers the
target from workspace state is guessing.

## Goal

Pressing Send delivers the review into one specific running agent session, in
that session's own input queue, without the user leaving the diff. Comments
remain persisted in the comment store exactly as today — delivery is a
notification, never the transport.

## Non-goals

- Replacing or bypassing the comment store. It stays the source of truth.
- Scraping agent transcripts, or reading agent state to decide when to send.
- Remote, cloud, or SSH-hosted agent sessions. Local same-user only.
- Changing Copilot behaviour. `workbench.action.chat.open` already works.
- Auto-resolving comments based on what the agent subsequently does.
- Delivering to agents other than Claude Code and Codex in v1. The roster in F1
  is generic; the adapters in F3/F4 are not.

## Architecture: poke + pull

The Send button does not carry the review text to the agent. It writes the
comments to the store (as today), then **pokes** a bound session with a short
instruction to go read them. The agent pulls the actual content through the
`diffReview_listComments` MCP tool that already exists.

This matters for three reasons:

1. One persistence path serves every agent. Payload formatting does not fork per
   channel.
2. Each channel becomes a thin, independently testable "did the poke arrive"
   unit.
3. The private channel (F3) *will* break on an agent upgrade. When it does, the
   comments are still saved and the failure degrades to "the agent picks them up
   on its next poll" (F5) rather than losing user input.

## Verified findings

Established by direct probing on 2026-09-06 against
`anthropic.claude-code-2.1.263` and `openai.chatgpt-26.901.22334`. Recorded here
because it is non-obvious and expensive to re-derive.

"Claude/Codex in VS Code" is four runtimes, not two:

| Surface | How it runs | Reachable by |
|---|---|---|
| Claude panel/sidebar | ext host spawns `claude --input-format stream-json` over **private pipes** | its own VS Code commands; UDS (F3) |
| Claude terminal CLI | connects as MCP *client* to the IDE ext's WS server (`~/.claude/ide/<port>.lock`) | UDS (F3); `terminal.sendText` |
| Codex panel | ext host spawns `codex app-server` over **private pipes** | `codex queue` (F4) |
| Codex CLI / desktop | shared thread store; daemon socket at `~/.codex/ipc/ipc.sock` | `codex queue` (F4) |

Panel sessions own their child's stdin, so no outside process can write to it.
Both adapters below route around that.

**Confirmed by live test.** `codex queue --thread <id> --message <text>` run from
a wholly separate process caused a live, idle `codex app-server` holding that
thread to start a turn and act on the message:

```
turn/started
item/completed  userMessage   "REVIEW: address inline comment #1"
item/completed  agentMessage  "I'll inspect the repository and locate inline comment #1..."
```

**Confirmed dead ends.** `claude-vscode.editor.open(sessionId, initialPrompt)`
reaches the composer via `setInputText` only — it prefills and does not submit —
and `createPanel` refuses the prompt outright for an already-open session
("Session is already open. Your prompt was not applied — enter it manually").
`at_mentioned` over the IDE WS carries only `{filePath, lineStart, lineEnd}`, not
free text.

## F1 — Session roster via self-registration

Do not infer the target. Both agents export their own identity into **every child
process**, and the MCP server is already a child process of each agent session.

Claude Code, read from a live child process:

```
CLAUDE_CODE_SESSION_ID=c71a7cc4-0124-4df4-99dc-89acb1f4f44c
CLAUDE_PID=65818
CLAUDE_CODE_MESSAGING_SOCKET=/tmp/cc-socks/65818.sock
CLAUDE_CODE_MESSAGING_TOKEN=<32 hex>
CLAUDE_CODE_ENTRYPOINT=claude-vscode
```

Codex, verified via `thread/shellCommand` on a live thread:

```
CODEX_SESSION_ID=01a07797-20f5-77f1-baa8-0f538aab92f4
CODEX_THREAD_ID=01a07797-20f5-77f1-baa8-0f538aab92f4
```

`CODEX_THREAD_ID` is exactly the id `codex queue --thread` accepts. For Claude
the environment supplies the socket path *and* the auth token, which removes the
fragile half of F3 entirely: no scanning `~/.claude/sessions/*.json`, no reading
the mode-600 `.key` file, no pid/cwd matching.

`mcp-server.ts` gains a startup step: read these variables and `POST
/session/register` to the extension IPC server it already resolves via
`resolvePort` (`src/ipc-discovery.ts`). No new discovery mechanism.

```ts
interface AgentSession {
    agent: 'claude' | 'codex';
    /** CLAUDE_CODE_SESSION_ID or CODEX_THREAD_ID. Roster key. */
    sessionId: string;
    /** Human label for the picker. Claude: sessions/<pid>.json `name`. Codex: threads.name/title. */
    label: string;
    cwd: string;
    /** Claude only. */
    socketPath?: string;
    token?: string;
    pid?: number;
    registeredAt: string;
    lastSeenAt: string;
}
```

Registration is idempotent on `sessionId`. Pruning is **liveness-based and needs
no cooperation from the agent**: an entry drops when the MCP server's stdio
closes, or lazily on read when a liveness check fails — for Claude, `pid` gone or
socket unconnectable; for Codex, thread missing or `archived` in
`~/.codex/state_5.sqlite`. A `SessionEnd` hook would make this prompt rather than
lazy, but it is an optimisation, not a dependency, and it requires the installer
specified in `2026-09-06-agent-hook-installation.md`. v1 does not rely on it.

The roster lives in memory in the extension host, rebuilt by registration. It is
not persisted — a session that outlives a window reload re-registers on its next
tool call.

## F2 — Binding and the target picker

The Send button targets a **bound** session, not a computed one.

- **0 roster entries** — today's behaviour unchanged (F6).
- **1 entry** — bind silently and send.
- **N entries** — a genuine user choice, not a guess. Show a QuickPick with real
  identity and let the user decide.

The binding is stored per workspace in `workspaceState`
(`diffReview.boundSession`) and surfaced on the button — *"Send to:
diff-review-with-ai-agent-72 ▾"* — with the chevron re-opening the picker. A
binding whose session has left the roster is treated as unbound.

Picker rows are ordered by recency, using signals that need no cooperation from
the agent:

- **Claude** — mtime of `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
  On the three-session example above this separated them cleanly (19:33, 19:31,
  and one idle since the previous day).
- **Codex** — `threads.recency_at_ms`, filtered by `cwd`. Codex stores exact
  paths including worktrees and subdirectories, so this is a **prefix** match,
  the same shape as `deepestAncestor` in `src/path-util.ts`.

These orderings are also the last-resort fallback for populating the picker when
a session never called the MCP server and so never registered.

## F3 — Claude adapter: UDS peer message

Write one newline-delimited JSON frame to `socketPath` from the roster,
authenticated with `token`.

Protocol as reverse-engineered from the `[uds-messaging]` module in the bundled
`claude` binary:

- Transport: unix domain socket, NDJSON, one object per line. The first line must
  arrive within 30s (`firstLineDeadlineMs = 30000`).
- Frame: an object with a string `type`. The user-message path requires
  `message.content` to be a non-empty string; `session_id`, when present, must
  match the receiving session or the frame is dropped; `uuid`, `msg_id`, `from`
  and `priority` are optional.
- Server-side checks: token match, peer pid and `procStart` verification,
  self-sent ancestry detection, socket-directory `ownerUids`, and the directory
  must match `^/tmp/cc-socks(-<uid>)?$`.
- Accepted frames land in `onEnqueue` — the session's input queue.

**This is a private, undocumented protocol and will break.** It is isolated
behind one module and one setting (`diffReview.experimentalDirectDelivery`,
default off in v1), and every failure falls through to F5. The exact frame has
**not** yet been round-tripped; see Verification.

## F4 — Codex adapter: `codex queue`

Supported, first-class, and confirmed working end to end:

```
codex queue --thread <CODEX_THREAD_ID> --message <poke text>
```

Two behaviours the UI must account for, both observed:

- The thread needs a **persisted rollout**. A thread with zero completed turns
  fails with `no rollout found for thread id`. Any session the user has actually
  talked to has one; treat the error as "not ready" rather than a hard failure.
- Queuing to an **idle** session starts a turn immediately. Queuing during a
  running turn appends behind it, which is the intent of a queue but looks like
  nothing happened. Report the outcome (`Queued message <id> for thread <id>`) in
  the notification so a mid-turn send is legible.

**Locating the binary is a real problem, not a detail.** `codex` is not
necessarily on `PATH` — on the author's machine it is not, and the only copy is

```
~/.vscode/extensions/openai.chatgpt-26.901.22334-darwin-arm64/bin/macos-aarch64/codex
```

which is a *versioned* extension path that breaks on the next ChatGPT extension
upgrade. This is the same footgun already documented in
`2026-09-05-mcp-consumer-registration-design.md`, so it gets the same treatment:
resolve at call time, never cache a versioned path. Order is `PATH` first, then
a scan of the extension roots for `openai.chatgpt-*/bin/<platform>/codex`,
reusing the `EXTENSION_ROOTS` list and version-pattern approach already in
`src/mcp-resolve.ts`. If neither resolves, F4 is unavailable and the send falls
to F6.

Writing to `~/.codex/queue_1.sqlite` directly would sidestep the binary, but that
means reimplementing a private schema and its revision triggers. Rejected: the
CLI is the supported surface and the binary-resolution cost is lower than the
schema-drift cost.

## F5 — Supported fallbacks

Both are agent-agnostic and survive any private-protocol breakage. They are the
floor the whole design rests on, not an afterthought.

**`diffReview_awaitReview` MCP tool.** Blocks and returns the moment Send is
pressed, otherwise returns "nothing yet, call again". An agent parked in this
loop receives the review with no push channel at all. Works for every MCP-capable
agent, including the panel runtimes that F3/F4 cannot otherwise reach. The
`/perform-diff-review` and `/address-diff-review` slash commands already
installed by `diffReview.installAgentCommands` are the natural place to put the
loop.

*How long it may block is a contract, not a guess.* Claude documents its
per-call limit as a "Hard wall-clock limit per call; **progress notifications do
not extend it**", so the usual keep-alive-by-progress trick is unavailable and
the tool must return on its own before the limit. Both agents expose a
per-server override, in files `mcp-consumers.ts` already writes:

| Agent | File | Field | Unit |
|---|---|---|---|
| Claude Code | `~/.claude.json` | `mcpServers["diff-review"].timeout` | ms |
| Codex | `~/.codex/config.toml` | `[mcp_servers.diff-review] tool_timeout_sec` | s |

So registration sets the value explicitly rather than inheriting an unknown
default, and `awaitReview` polls at a fixed fraction of it (proposed: write 60s,
return at 45s). Writing these fields is an extension of the existing writers in
`mcp-consumers.ts`, not new machinery. The tool must also cope with a user whose
config predates this and carries no override — hence returning well short of the
written value rather than at it.

**A blocking `Stop` hook.** Verified present with identical semantics in both
binaries (`Stop hook feedback:` in `claude`; `hooks/src/events/stop.rs` in
`codex`). Returning `{"decision":"block","reason":"..."}` re-injects text and
forces the agent to continue. This catches the agent exactly as it goes idle.

Neither this hook nor the `SessionEnd` hook F1 uses is installed by anything
today. Getting them onto a user's machine is a separate piece of work of
comparable size to MCP registration, specified in
`2026-09-06-agent-hook-installation.md`. **F5's Stop half and F1's hook-based
pruning are blocked on that spec**; the `awaitReview` half and F1's
liveness-based pruning are not, and are what v1 should rest on.

F5 covers "agent is waiting"; F3/F4 cover "agent is idle or mid-turn". Together
they cover every state.

## F6 — Degradation ladder

One ordered path, evaluated per send, so the button never silently does nothing:

1. Bound session + adapter succeeds → done, notify which session received it.
2. Adapter fails or the binding is stale → mark comments pending; F5 delivers on
   the agent's next poll or Stop. Notify that it is queued, not sent.
3. No roster entry and Copilot is present → `workbench.action.chat.open`, as
   today.
4. Otherwise → clipboard, as today.

Steps 3 and 4 are the current behaviour and must not regress.

## Trust boundary

This feature moves an agent's own auth token across a process boundary and then
uses it to inject text the agent will act on. That deserves stating explicitly
rather than being left implicit in F1 and F3.

**What is being trusted.** `POST /session/register` carries a
`CLAUDE_CODE_MESSAGING_TOKEN` and a socket path. The IPC server listens on
`127.0.0.1`, so any local process can call it, and a bogus registration would put
an attacker-chosen socket in the roster — at which point pressing Send writes the
poke text to *their* socket instead of the agent's. The poke is not secret (it is
"go read the comments"), so the exposure is misdirection rather than disclosure;
the real cost is a review that silently goes nowhere.

**Mitigations, in order of value:**

1. Reuse the existing workspace check. The IPC server already answers 409 on a
   workspace mismatch; registration gets the same treatment, so a registration
   whose `cwd` is outside this window's roots is refused.
2. Verify rather than believe. Every field a registrant asserts is checkable
   locally: `pid` must exist, `socketPath` must match
   `^/tmp/cc-socks(-<uid>)?/<pid>\.sock$` and be owned by the current uid,
   `sessionId` must match `~/.claude/sessions/<pid>.json`. Registration supplies
   convenience, not authority — a registration that fails these checks is
   dropped.
3. Treat the token as a secret in transit and at rest-in-memory. Never log it,
   never include it in `Show MCP Server Info` output, never write it to the
   comment store or to `workspaceState`. The roster is memory-only (F1) partly
   for this reason.

**What is explicitly not defended against.** A hostile process running as the
same user already has the tokens — it can read `~/.claude/sessions/*.key` (mode
600, same uid) directly. This design does not weaken that boundary, and does not
try to defend it.

## Open decisions

- **Frame `type` value for F3.** The handler dispatches on `type`, but which
  literal corresponds to the user-message path is not yet pinned. Blocks F3.
- **Whether F3 ships enabled.** Proposed: off by default in v1, promoted only
  after the frame is round-tripped and survives one agent upgrade.
- **Poke text.** A fixed instruction ("review comments are pending, call
  `listDiffComments`") versus including a short summary inline. Fixed text keeps
  the poke/pull split honest; a summary is friendlier when the agent is idle.
- **Per-thread versus per-batch sends.** `sendThread` and `submitAll` currently
  differ. Whether a single-thread send should poke at all, or only `submitAll`,
  is unresolved.
- **Multiple bound sessions.** Broadcasting a review to two agents is
  conceivable but probably wrong. v1 binds exactly one.
- **Whether `codex` binary resolution belongs in `mcp-resolve.ts`.** That module
  is currently about locating *this extension's* MCP server, and widening it to
  "locate any agent binary" may be the wrong shape. The `EXTENSION_ROOTS` list
  is the part worth sharing; a separate `agent-binary.ts` may be cleaner.

## Verification

| # | Check | How |
|---|---|---|
| 1 | F3 frame round-trips | Send a candidate frame to a disposable `claude` session's socket; confirm it appears in that session's input queue. **Gates F3.** |
| 2 | F3 rejects a bad token | Same, with a wrong `CLAUDE_CODE_MESSAGING_TOKEN`; expect a drop, not a crash. |
| 3 | F4 delivers to a panel session | Queue to a Codex thread open in the VS Code panel; confirm the turn starts. (Confirmed already against a driven `app-server`; not yet against the panel itself.) |
| 4 | F4 mid-turn | Queue while a turn is running; confirm it appends and the notification says so. |
| 5 | F1 registration | Start two agent sessions in one workspace; confirm two distinct roster entries with correct labels. |
| 6 | F1 pruning | Kill one session; confirm its entry disappears within one liveness check. |
| 7 | F2 picker | With three live sessions, confirm ordering matches actual last-active and that the binding persists across a window reload. |
| 8 | F5 long-poll | With no adapter available, confirm an agent in `awaitReview` receives the review on Send. |
| 9 | F6 ladder | Force each rung; confirm no send is ever silently dropped. |
| 10 | No regression | With no agent session registered, confirm Copilot and clipboard paths behave exactly as before. |
| 11 | `codex` binary resolution | With `codex` absent from `PATH`, confirm the extension-root scan finds it; then bump the ChatGPT extension version and confirm it still resolves. |
| 12 | Timeout contract | Confirm registration writes `timeout` / `tool_timeout_sec`, and that `awaitReview` returns before the limit on a client that has *no* override written. |
| 13 | Registration is verified, not believed | POST a registration with a foreign `cwd`, a dead `pid`, and a socket path outside `/tmp/cc-socks`; each must be refused. |
| 14 | Token never leaks | Grep logs, `Show MCP Server Info` output, the comment store and `workspaceState` for the messaging token after a full send cycle. |

Checks 1–4 need real agent processes and cannot be unit-tested. Checks 5–7 and 9
should be unit-testable against a pure roster/binding module in the style of
`ipc-discovery.ts`.

## Files

- `src/agent-roster.ts` — **new.** Pure. Roster shape, liveness predicates,
  recency ordering, binding resolution. No `vscode`, no `fs`, no network, same
  discipline as `ipc-discovery.ts`.
- `src/agent-deliver.ts` — **new.** The two adapters (F3 UDS write, F4 `codex
  queue` spawn) plus the F6 ladder. I/O lives here, including `codex` binary
  resolution (or a separate `src/agent-binary.ts` — see Open decisions).
- `src/mcp-server.ts` — read the identity environment variables at startup and
  `POST /session/register`.
- `src/extension.ts` — the `/session/register` IPC route, the roster instance,
  the F2 picker and `workspaceState` binding, and the changed `sendThread` /
  `submitAll` paths.
- `src/slash-commands.ts` — add the `awaitReview` loop to the installed prompts.
- `src/mcp-consumers.ts` — write the per-server tool timeout alongside the
  existing entry (`timeout` for `claude-json`, `tool_timeout_sec` for
  `codex-toml`).
- `package.json` — the `diffReview_awaitReview` language model tool, the
  `diffReview.experimentalDirectDelivery` setting, and a re-target command.
- `test/agent-roster.test.js` — **new.** Covers checks 5–7 and 9.
