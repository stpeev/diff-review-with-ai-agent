# Agent Slash Command Installation

**Status:** proposed
**Date:** 2026-09-05

## Problem

The extension pushes review comments *out*: `submitAll` opens Copilot chat with a
structured prompt, and every send action has a copy-to-clipboard twin. The MCP
server inverts that — an agent can pull comments with `listDiffComments`, reply,
and resolve — but nothing tells the agent *when* to pull, or what to do with what
it finds. The user has to type that instruction every time, and every user
invents their own wording.

Every coding agent worth targeting already solves this with user-defined slash
commands. None of them get one from us.

## Goal

One command that lists every agent on the machine with a slash-command
directory, says whether `/address-diff-review-comments` is installed and current,
and installs it on selection — with a copyable prompt body as the
always-available fallback, for agents with no command directory at all.

The shape deliberately mirrors `Diff Review: Register MCP Server with a Coding
Agent` (see `2026-09-05-mcp-consumer-registration-design.md`). Same discovery
idea, same quick-pick vocabulary, same copy-is-first-class rule.

## Non-goals

- **Workspace-scoped command directories** as write targets. Cursor
  (`.cursor/commands/`) and Windsurf (`.windsurf/workflows/`) are project-level.
  Writing into the user's repository is a different decision from writing into
  their home directory; they get copy-only rows.
- **Editing or removing command files other than ours.**
- **Project-level Claude Code commands** (`.claude/commands/`). User-level only,
  matching the MCP spec's scope.
- **Merging with `src/mcp-consumers.ts`.** The two modules share a concept, not
  an implementation; folding this into that one drags launcher-path resolution
  into a feature that has no launcher. The exception is the VS Code profile
  enumeration: `parseProfiles` and `samePath` are already correct and already
  exported, so this module imports those two rather than re-deriving rules that
  took a round of corrections to get right.

## Why this is easier than MCP registration

Every target reads commands from its **own dedicated directory, one file per
command**. There is no shared config file owned by someone else. That removes,
at a stroke, the four hardest parts of the MCP work: JSONC comment preservation,
TOML table surgery, the `~/.claude.json` clobbering hazard, and schema
detection. Status is a string comparison. Installation is a file write.

The one risk MCP registration did *not* have is the reverse: because the file is
ours alone, a user may hand-edit it, and an overwrite then destroys their work.
See **Version marker** below.

## Targets

| Agent | Path | Format | Invocation |
|---|---|---|---|
| Claude Code | `~/.claude/commands/address-diff-review-comments.md` | Markdown + YAML frontmatter | `/address-diff-review-comments` |
| Codex CLI | `~/.codex/prompts/address-diff-review-comments.md` | plain Markdown | `/address-diff-review-comments` |
| Gemini CLI | `~/.gemini/commands/address-diff-review-comments.toml` | TOML (`description`, `prompt`) | `/address-diff-review-comments` |
| VS Code family | `<profile>/prompts/address-diff-review-comments.prompt.md` | Markdown + frontmatter | `/address-diff-review-comments` |

Codex honours `$CODEX_HOME`, as in the MCP module.

VS Code-family roots and profile enumeration follow the MCP spec — per-platform
user-data roots, with `globalStorage/storage.json` → `userDataProfiles[]` as the
authority on profiles, including the nested `location` rule. `useDefaultFlags`
does not apply here: it has an `mcp` flag, not a prompts flag, so it governs the
MCP module only. The app list is narrowed to `Code`, `Code - Insiders` and
`VSCodium` for the reason below.

> Cursor and Windsurf are absent from this table. Their native command formats
> are workspace-scoped, and whether either honours VS Code's user-level
> `prompts/` directory is unverified — so neither gets a `vscode-prompt` row on
> the strength of a guess. Both appear in the quick pick as copy-only rows
> pointing at their own project-level directory. Confirming prompt-file support
> would move them into this table later.

## Module: `src/agent-command.ts`

New file, pure, no `vscode` import — same constraints as `mcp-consumers.ts`, so
it stays unit-testable and could be reused elsewhere.

```ts
type CommandKind = 'claude-md' | 'codex-md' | 'gemini-toml' | 'vscode-prompt';
type Status = 'current' | 'stale' | 'missing';

interface AgentCommandTarget {
    id: string;          // 'claude', 'codex', 'gemini', 'vscode', 'vscode:profile:Work'
    label: string;       // 'Claude Code', 'VS Code — profile "Work"'
    kind: CommandKind;
    filePath: string;
    invocation: string;  // what the user types
    status: Status;
    /** True when we can safely write this file; false ⇒ copy-only row. */
    writable: boolean;
    /** Why writable is false, shown in the UI. */
    reason?: string;
}
```

Exported surface:

- `discoverAgentCommands(env?): AgentCommandTarget[]`
- `renderBody(kind): string` — the full file content for that agent
- `renderClipboard(target): string` — the body plus a "save this to `<path>`" line
- `install(target): WriteResult` — throws with a user-facing message on failure

`WriteResult` is the shape `mcp-consumers.ts` already exports (written path plus
optional backup path); this module re-uses it rather than inventing a parallel
one.

### Discovery

A row exists when the agent's **command directory** exists. A missing *file*
under an existing directory is a `missing` row; a missing *directory* produces
no row at all.

This inverts the MCP rule, where an absent `mcp.json` under an existing user
directory was still a row. The reason is that `mcp.json` is a file the consumer
creates on demand, whereas `~/.claude/commands` existing is the only evidence we
have that Claude Code is installed at all.

### Status

Read the file and compare against `renderBody(kind)`:

- absent → `missing`
- byte-identical → `current`
- anything else → `stale`

### Version marker

Every rendered body carries a marker on its own line, in the comment syntax of
its format:

```
<!-- diff-review:address-comments v1 -->
```

A `stale` file **with** the marker is a previous version of ours: safe to
overwrite, backed up first. A `stale` file **without** it was written by the
user or another tool: the row degrades to `writable: false` with
`reason: 'file not written by Diff Review'`, and the only offered action is
copy. This is what keeps an overwrite from destroying a hand-tuned prompt.

The marker version bumps only when the body changes.

### Writers

Write the file, creating parent directories as needed. No new runtime
dependency: the Gemini TOML file is ours alone, so we emit it rather than parse
and edit it.

**Backups.** Before overwriting a `stale` file, copy it to
`<file>.diff-review-backup`, overwriting a previous backup — same convention and
same reporting as the MCP writers. Never on `missing`.

## The prompt body

One instruction body, four wrappers. Only frontmatter differs; the Markdown
below the marker is identical across all four, so there is one thing to maintain
and one thing to review.

Frontmatter per kind:

- **`claude-md`** — `description`, `allowed-tools`
- **`vscode-prompt`** — `description`, `mode: agent`
- **`codex-md`** — none
- **`gemini-toml`** — `description` key, body as a multi-line `prompt` string

The body instructs the agent to:

1. Call `listDiffComments`. **If the tool is unavailable, stop and tell the user
   to run `Diff Review: Register MCP Server with a Coding Agent`** — the command
   is useless without the MCP server, and this is the failure everyone will hit
   first.
2. Work the open threads oldest-first, addressing each in the code.
3. `replyToDiffComment` on each, stating what changed — or why it did not.
4. `resolveDiffComment` only on threads actually addressed.
5. Never commit.
6. Report what was addressed and what was left open.

Its tone and its discipline about acting on the user's comments and nothing else
follow the existing `review-file` command.

## Command: `diffReview.installAgentCommand`

Title: *Diff Review: Install the `/address-diff-review-comments` Agent Command*.
Contributed alongside `diffReview.registerMcpServer` and registered in
`activate()`.

A quick pick in the same style, each row labelled by status:

```
$(check)           Claude Code                      installed
                   ~/.claude/commands/address-diff-review-comments.md
$(warning)         Codex CLI                        installed — older version
                   ~/.codex/prompts/address-diff-review-comments.md
$(circle-outline)  Gemini CLI                       not installed
                   ~/.gemini/commands/address-diff-review-comments.toml
$(circle-outline)  Cursor                           not installed (manual)
                   .cursor/commands/ — workspace-scoped commands
```

Each row carries a reveal-in-file-explorer button, matching the MCP command.

**On pick:**

- `current` → info message, no write.
- `missing` / `stale`, `writable` → modal showing the destination path and the
  body, with before → after for `stale`. Buttons: **Write** / **Copy** /
  **Cancel**. Write backs up when overwriting, writes, and reports both paths.
- not `writable` → straight to the clipboard, naming the file to paste into and
  why we did not write it.

**Copy is available on every row**, including `current`. It is the entire path
for anyone on ChatGPT or a web agent with no command directory, so it is a
first-class action rather than a modal afterthought.

## Connection to MCP registration

The only edit to the existing flow: the MCP registration success message gains a
follow-up action pointing at this command. The two features are useless apart —
the MCP server with no prompt is a tool nobody invokes, and the prompt with no
MCP server is a slash command that errors — so each should name the other at the
moment the user has just finished the first.

## Error handling

Every failure path ends in a copyable body rather than a dead end. Unreadable
file, unwritable directory, permission error — all downgrade the row to
copy-only with the reason shown, and never throw out of the command handler.

## Verification

`test/agent-command.test.js`, under the existing `node:test` runner, over the
pure transforms:

- status detection per kind across `missing` / `current` / `stale`
- the marker rule: `stale` with marker is writable, `stale` without is not
- body rendering per wrapper — frontmatter correct, body identical below the
  marker, Gemini's TOML string escaping intact
- path construction, including the nested profile `location` case that the MCP
  implementation got wrong the first time

Beyond the tests:

1. Run `discoverAgentCommands()` read-only against the real machine and eyeball
   the list — Claude Code, Codex, Gemini and the VS Code profiles all present.
2. Exercise the writers against temp-directory copies before anything touches a
   real path.
3. Manual sandbox pass (`npm run sandbox`) through each outcome:
   already-current, version upgrade, hand-edited file, copy-only.
4. End to end: install into Claude Code, leave real comments in the editor, run
   the slash command, confirm the replies and resolutions land back in the
   editor.

## Files

| File | Change |
|---|---|
| `src/agent-command.ts` | new — discovery, status, bodies, writers |
| `test/agent-command.test.js` | new — tests over the pure transforms |
| `src/extension.ts` | register `diffReview.installAgentCommand`, quick pick UI; MCP success follow-up |
| `package.json` | contribute the command |
| `README.md` | document the command alongside MCP setup |
| `TODO.md` | record it |
