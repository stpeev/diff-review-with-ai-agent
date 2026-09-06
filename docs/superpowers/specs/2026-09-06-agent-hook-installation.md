# Agent Hook Installation

**Status:** proposed
**Date:** 2026-09-06

## Problem

Claude Code and Codex both run user-configured **hooks** — shell commands fired
at points in the agent's lifecycle. Two of them are load-bearing for
`2026-09-06-direct-delivery-to-agent-sessions.md`:

- **`Stop`**, which can return `{"decision":"block","reason":"..."}` to re-inject
  text and force the agent to keep going. This is the only channel that reaches
  an agent at the exact moment it goes idle, and it is the supported floor under
  the private delivery adapters.
- **`SessionEnd`**, which would prune the session roster promptly instead of
  lazily.

Nothing installs either. The delivery spec currently degrades around this — its
v1 rests on `awaitReview` polling and liveness-based pruning — but the Stop hook
is the piece that makes delivery feel immediate rather than eventual.

This is the third instance of a pattern the codebase already has twice:
`diffReview.registerMcpServer` writes MCP config across consumers
(`2026-09-05-mcp-consumer-registration-design.md`), and
`diffReview.installAgentCommands` writes slash-command files
(`2026-09-05-agent-slash-command-design.md`). Hooks are the same shape and should
look like their siblings.

## Goal

One command that reports whether the Diff Review hooks are installed for each
detected agent, and installs or repairs them on selection — with a copyable
config snippet as the always-available fallback, exactly as the MCP registration
command does.

## Non-goals

- Hooks beyond the two this project needs. Not a general hook manager.
- Project- and enterprise-scoped hook config. User scope only, matching the
  MCP registration spec's decision.
- Agents other than Claude Code and Codex. Cursor and the VS Code MCP host do
  not have a comparable hook system.
- Codex *plugin*-provided hooks (`<plugin>/hooks/hooks.json`). Those belong to
  the plugin that ships them.
- Removing or editing hooks this extension did not write.

## Why this is harder than MCP registration

MCP registration writes one canonical entry into a file whose shape is the same
idea in three dialects. Hooks differ in three ways that matter:

1. **The file is not the one MCP uses.** Claude Code reads MCP servers from
   `~/.claude.json` but hooks from `~/.claude/settings.json` — a different file
   the extension does not currently touch. Codex reads both from `CODEX_HOME`,
   but hooks live in `~/.codex/hooks.json`, not `config.toml`.
2. **Codex has a trust gate.** Its hook config carries per-handler state
   (`enabled`, `trusted`). A freshly written hook is not necessarily a running
   hook, so "installed" and "in effect" are different states and the command must
   report them separately.
3. **A hook is executable configuration.** A wrong entry does not fail closed
   like a bad MCP path — it runs on every matching event, and a `Stop` hook that
   errors or blocks incorrectly can wedge an agent mid-session. This raises the
   bar on both the writer and the uninstall path.

## The canonical entries

Both hooks invoke the same stable launcher the MCP server already uses, so
there is exactly one path to keep correct and it is never a versioned extension
path:

```
node ~/.diff-review/mcp-launcher.js --hook <event>
```

`--hook` is a new launcher mode: read the hook's JSON payload on stdin, resolve
the extension's IPC port with the existing `resolvePort` logic, ask it whether
this session has pending review comments, and write the hook's JSON result to
stdout. It reuses `src/ipc-discovery.ts` and `src/mcp-resolve.ts` wholesale.

For `Stop`, the result is either `{}` (nothing pending, let the agent stop) or:

```json
{ "decision": "block", "reason": "<poke text>" }
```

For `SessionEnd` it is always `{}`; the call is made for its side effect of
deregistering the session.

Two traps in reusing the launcher. It currently `require`s the resolved MCP
server and hands it stdio; hook mode must branch **before** that, because loading
the server is both unnecessary and too slow for a per-turn hook. And the existing
comment "stdout is the MCP transport, so diagnostics must go to stderr" still
holds but for a different reason — in hook mode stdout carries the hook's JSON
result, so it is no less exclusive.

The payload both agents deliver on stdin carries `session_id`, `cwd` and
`transcript_path`, which is what lets the hook tell the extension *which*
session is stopping — the same identity the roster in the delivery spec is keyed
on.

## Targets

| Agent | File | Shape |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | `hooks.<EventName>[] = { matcher?, hooks: [ { type: "command", command, timeout? } ] }` |
| Codex | `~/.codex/hooks.json` | `<EventName>[] = { matcher?, hooks: [...], enabled }`, plus per-handler `{ enabled, trusted }` state |

Event names are PascalCase in both (`Stop`, `SessionEnd`), which is a genuine
convenience — the same event constants serve both writers.

Claude Code's settings schema enumerates 33 hook events; Codex's set is a subset
covering the same lifecycle. Both include `Stop` and `SessionEnd`, so the two
hooks this project needs are portable. The `Stop` output contract
(`decision`/`reason`) is byte-identical across the two, which is why one launcher
mode serves both.

## Module: `src/agent-hooks.ts`

New file, pure, no `vscode` import, no `fs` — the same discipline as
`mcp-consumers.ts`, which it deliberately mirrors so the two commands can share
their UI shape.

```ts
type HookConsumerKind = 'claude-settings' | 'codex-hooks-json';
type HookStatus = 'current' | 'stale' | 'missing' | 'untrusted';

interface HookTarget {
    id: 'claude' | 'codex';
    label: string;
    kind: HookConsumerKind;
    configPath: string;
    status: HookStatus;
    /** For stale rows: the command currently registered. */
    current?: string;
    /** Codex only: written but not yet trusted, so not in effect. */
    trusted?: boolean;
}
```

Inspectors take file text and return status; writers take file text and return
the new text. `extension.ts` does the reading, backing up, and writing, exactly
as it does for MCP registration.

`untrusted` is a first-class status, not an error. A Codex row that is written
but untrusted must say so and tell the user how to trust it, because from the
extension's side it looks installed and from the agent's side it is inert.

## Command: `diffReview.installAgentHooks`

Titled **"Diff Review: Install the Diff Review Agent Hooks"**, sitting beside the
existing MCP and slash-command entries. Same QuickPick behaviour as
`registerMcpServer`: one row per detected agent, showing status; selecting a row
backs the file up and writes it; a copy-to-clipboard row is always present.

The command is offered after MCP registration in the same way slash-command
installation already is, since a hook without the MCP server is useless.

## Uninstall

Unlike MCP registration, this one needs a removal path. A `Stop` hook that
outlives the extension runs `node ~/.diff-review/mcp-launcher.js` on every turn
of every session and, if the launcher is gone, produces an error on every stop.

`diffReview.installAgentHooks` therefore offers **Remove** on rows it detects as
installed, and only ever removes entries whose command matches the canonical
launcher invocation — never anything else in the file.

## Failure behaviour

A hook that cannot reach the extension must fail **open**: print `{}` and exit 0.
The agent then stops normally. A hook that fails closed, or that blocks on an
unreachable IPC port, wedges the session — which is a far worse outcome than a
review that arrives late. The launcher's hook mode therefore has a short
self-imposed deadline and treats every error as "nothing pending".

## Open decisions

- **Whether `SessionEnd` is worth installing at all.** The delivery spec's
  liveness-based pruning already covers it. Installing a second hook doubles the
  surface for the sake of promptness. Proposed: `Stop` only in v1.
- **How the Codex trust gate is cleared.** Whether it can be set by writing
  config, or requires a user action in the Codex UI, is not yet established.
  Determines whether `untrusted` is a transient state or a permanent instruction
  to the user.
- **Claude settings scope.** `~/.claude/settings.json` is user-global, so the
  hook fires for every project, and the launcher decides per-`cwd` whether
  anything is pending. The alternative — project-scoped `.claude/settings.json`,
  committed or not — is narrower but contradicts the user-scope decision
  inherited from the MCP registration spec.
- **Whether the poke text is composed by the extension or the hook.** The
  launcher already talks to the extension, so either is possible.

## Verification

| # | Check | How |
|---|---|---|
| 1 | Codex hook shape | Install a hook, then call the app-server's `hooks/list` and confirm it appears with no `warnings` or `errors`. **Gates the Codex writer.** |
| 2 | Codex trust state | Determine empirically whether a freshly written hook reports trusted, and what clears it if not. |
| 3 | Claude hook fires | Install, run a session to completion, confirm the launcher is invoked with a payload carrying `session_id` and `cwd`. |
| 4 | Stop actually blocks | With comments pending, confirm the agent continues instead of stopping, and that the reason text reaches it. |
| 5 | Fails open | Stop the extension, then end an agent session; confirm it stops cleanly with no error and no hang. |
| 6 | Idempotent write | Install twice; confirm one entry, not two. |
| 7 | Foreign entries preserved | Install into a settings file that already has unrelated hooks; confirm they survive byte-identical. |
| 8 | Uninstall | Remove; confirm only the canonical entry goes and the file is otherwise unchanged. |
| 9 | Stale repair | Hand-edit the command to a versioned path; confirm the row reports `stale` and repairs. |

Checks 6–9 are unit-testable against the pure writers. Checks 1–5 need real
agent processes.

## Files

- `src/agent-hooks.ts` — **new.** Pure inspectors and writers for both formats.
- `src/mcp-launcher.ts` — add the `--hook <event>` mode.
- `src/extension.ts` — the `diffReview.installAgentHooks` command, file I/O,
  backup, and the post-MCP-registration offer.
- `package.json` — the command contribution.
- `test/agent-hooks.test.js` — **new.** Covers checks 6–9.
