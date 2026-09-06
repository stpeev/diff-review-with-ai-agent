# Agent Slash Command Installation

**Status:** proposed
**Date:** 2026-09-05
**Updated:** 2026-09-06 — second command (`/perform-diff-review`), module split

## Problem

The extension pushes review comments *out*: `submitAll` opens Copilot chat with a
structured prompt, and every send action has a copy-to-clipboard twin. The MCP
server inverts that — an agent can pull comments with `listDiffComments`, reply,
and resolve — but nothing tells the agent *when* to pull, or what to do with what
it finds. The user has to type that instruction every time, and every user
invents their own wording.

The same gap exists on the write side. `createDiffComment` lets an agent leave
threads in the gutter, but nothing tells it to review a branch and do so.

Every coding agent worth targeting already solves this with user-defined slash
commands. None of them get one from us.

## Goal

One command that lists every agent on the machine with a slash-command
directory, says whether **our pair of commands** is installed and current, and
installs them on selection — with a copyable prompt body as the
always-available fallback, for agents with no command directory at all.

The pair is the loop, and neither half is much use alone:

| Command | Direction | MCP tools |
|---|---|---|
| `/perform-diff-review` | agent → editor | `listDiffComments`, `createDiffComment` |
| `/address-diff-review` | editor → agent | `listDiffComments`, `replyToDiffComment`, `resolveDiffComment` |

`/perform-diff-review` reviews the branch and leaves its findings as gutter
threads the user can read, edit, delete or accept in the editor.
`/address-diff-review` — run afterwards, ideally in a fresh context — works
those threads in the code. The handoff through the editor is the point: the
human sits between the two halves.

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
- **Installing one half of the pair.** A row is an agent, not a file. Users who
  install only `/perform-diff-review` get comments nothing knows how to work.
  Per-file control exists only as a consequence of the marker rule below, which
  can make one of the two files unwritable.
- **Arguments to either command.** `/perform-diff-review` derives its own diff
  range; `/address-diff-review` works every open thread. Argument syntax differs
  across all four wrapper formats, and neither command has a use for one yet.
- **Merging with `src/mcp-consumers.ts`.** The two modules share plumbing, not a
  job; folding this into that one drags launcher-path resolution into a feature
  that has no launcher. What they genuinely share is extracted instead — see
  **Module split**.

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

Each agent directory holds **two** files, named after the commands they define.

| Agent | Directory | Files | Format |
|---|---|---|---|
| Claude Code | `~/.claude/commands/` | `perform-diff-review.md`, `address-diff-review.md` | Markdown + YAML frontmatter |
| Codex CLI | `~/.codex/prompts/` | `perform-diff-review.md`, `address-diff-review.md` | plain Markdown |
| Gemini CLI | `~/.gemini/commands/` | `perform-diff-review.toml`, `address-diff-review.toml` | TOML (`description`, `prompt`) |
| VS Code family | `<profile>/prompts/` | `perform-diff-review.prompt.md`, `address-diff-review.prompt.md` | Markdown + frontmatter |

In every case the file's basename is the invocation: `/perform-diff-review` and
`/address-diff-review`.

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

## Module split

Three files, none importing `vscode`, all unit-testable under `node:test`.

### `src/slash-commands.ts` (new)

Discovery, status, bodies, writers. Named for what the files are: `command`
alone is VS Code's own word (`contributes.commands`, `registerCommand`), and
this feature contributes one of those too.

```ts
type CommandKind = 'claude-md' | 'codex-md' | 'gemini-toml' | 'vscode-prompt';
type CommandId = 'perform' | 'address';
type Status = 'current' | 'stale' | 'missing';

interface CommandFile {
    command: CommandId;
    filePath: string;
    invocation: string;   // '/perform-diff-review'
    status: Status;
    /** True when we can safely write this file; false ⇒ copy-only. */
    writable: boolean;
    /** Why writable is false, shown in the UI. */
    reason?: string;
}

interface SlashCommandTarget {
    id: string;           // 'claude', 'codex', 'vscode:profile:Work'
    label: string;        // 'Claude Code', 'VS Code — profile "Work"'
    kind: CommandKind;
    dirPath: string;
    /** Always both, in perform → address order. */
    files: CommandFile[];
    /** Worst of the two: any missing ⇒ missing, else any stale ⇒ stale. */
    status: Status;
    /** True when at least one file can be written. */
    writable: boolean;
}
```

Exported surface:

- `discoverSlashCommands(env?): SlashCommandTarget[]`
- `renderBody(kind, command): string` — the full file content
- `renderClipboard(target, command): string` — the body plus a "save this to
  `<path>`" line
- `install(target): WriteResult[]` — one result per file written; throws with a
  user-facing message on failure

### `src/vscode-profiles.ts` (new, extracted)

The VS Code-family install layout, moved out of `mcp-consumers.ts` unchanged
except where noted: `VSCODE_APPS`, `userDataRoot()`, `parseProfiles()`.

`parseProfiles` currently filters on `useDefaultFlags?.mcp !== true` — an
MCP-specific rule the Targets section above says does not apply to prompts. It
gains an optional flag-name parameter (`parseProfiles(storageJson, 'mcp')`);
callers that pass nothing get every profile. **This corrects the previous
revision of this spec, which claimed `parseProfiles` was reusable as-is.**

`samePath` is *not* shared. It exists to compare a configured launcher path
against ours; command status never compares paths. **This also corrects the
previous revision.**

`VSCODE_APPS` stays the full five-app list; the narrowing to three is this
feature's own filter, not a change to the shared data.

### `src/file-write.ts` (new, extracted)

`readText()`, `backup()` and the `WriteResult` interface, moved out of
`mcp-consumers.ts`. Small, but shared verbatim, and `backup()` encodes the
`.diff-review-backup` convention that must stay identical across both features.

`Status` is *not* shared. Both modules declare their own: the MCP one compares a
launcher path inside a parsed config, this one compares whole files byte for
byte. Same word, different question.

`mcp-consumers.ts` keeps its job and its public surface, losing roughly sixty
lines to the two extracted modules. Its existing tests continue to pass
unchanged, since every moved function keeps its signature bar the new optional
`parseProfiles` argument.

### Discovery

A row exists when the agent's **command directory** exists. Missing *files*
under an existing directory are `missing` entries; a missing *directory*
produces no row at all.

This inverts the MCP rule, where an absent `mcp.json` under an existing user
directory was still a row. The reason is that `mcp.json` is a file the consumer
creates on demand, whereas `~/.claude/commands` existing is the only evidence we
have that Claude Code is installed at all.

### Status

Per file, read and compare against `renderBody(kind, command)`:

- absent → `missing`
- byte-identical → `current`
- anything else → `stale`

The row's status is the worse of the two, so a half-installed agent never reads
as done.

### Version marker

Every rendered body carries a marker on its own line, in the comment syntax of
its format:

```
<!-- diff-review:perform v1 -->
<!-- diff-review:address v1 -->
```

A `stale` file **with** its marker is a previous version of ours: safe to
overwrite, backed up first. A `stale` file **without** it was written by the
user or another tool: that `CommandFile` degrades to `writable: false` with
`reason: 'file not written by Diff Review'`, and the only offered action is
copy.

The rule applies per file. A hand-tuned `address-diff-review.md` does not block
writing `perform-diff-review.md` alongside it; the row stays writable and the
modal says which of the two will be skipped and why.

Each marker's version bumps only when that body changes, independently of the
other.

### Writers

Write each file, creating parent directories as needed. No new runtime
dependency: the Gemini TOML files are ours alone, so we emit them rather than
parse and edit them.

`install` writes every file that is `writable` and not already `current`, and
returns a `WriteResult` per file. A failure on the first file does not suppress
the second: results and errors are collected, and the caller reports both.

**Backups.** Before overwriting a `stale` file, copy it to
`<file>.diff-review-backup`, overwriting a previous backup — same convention and
same reporting as the MCP writers. Never on `missing`.

## The prompt bodies

Two instruction bodies, four wrappers each. Only frontmatter differs by wrapper;
the Markdown below each marker is identical across all four, so each body is one
thing to maintain and one thing to review.

Frontmatter per kind:

- **`claude-md`** — `description`, `allowed-tools`
- **`vscode-prompt`** — `description`, `mode: agent`
- **`codex-md`** — none
- **`gemini-toml`** — `description` key, body as a multi-line `prompt` string

Both bodies open with the same failure check, because it is the failure everyone
will hit first: **call `listDiffComments`; if the tool is unavailable, stop and
tell the user to run `Diff Review: Register MCP Server with a Coding Agent`.**
The command is useless without the MCP server.

Their tone and their discipline about acting on the user's comments and nothing
else follow the existing `review-file` command.

### `/perform-diff-review`

1. Call `listDiffComments` — the availability check, and at the same time the
   list of threads that already exist, so the review does not restate them.
2. Establish the diff range: the merge-base of `HEAD` with the first of
   `origin/main`, `main`, `master` that resolves. Review
   `git diff <base>...HEAD` **plus** uncommitted working-tree changes. If no
   base resolves, say so and review the working tree only.
3. Review **only changed lines**. Correctness first — bugs, unhandled edge
   cases, missing error handling, broken invariants. Not style, not
   preferences, and not pre-existing code the diff merely sits next to.
4. `createDiffComment` per finding, with the workspace-relative path and a
   **1-based line number in the file as it currently stands**. Diff hunk
   numbering is not file numbering: read the file and confirm the line before
   commenting. One finding per thread.
5. **Never edit code. Never commit.** This command's entire output is comment
   threads; fixing them is `/address-diff-review`'s job, after the user has
   read them.
6. Report a summary: how many threads were created, where, and what was
   reviewed but found clean.

### `/address-diff-review`

1. Call `listDiffComments`.
2. Work the open threads oldest-first, addressing each in the code.
3. `replyToDiffComment` on each, stating what changed — or why it did not.
4. `resolveDiffComment` only on threads actually addressed.
5. Never commit.
6. Report what was addressed and what was left open.

Unchanged from the previous revision but for its name.

## Command: `diffReview.installAgentCommands`

Title: *Diff Review: Install the Diff Review Agent Commands*. Contributed
alongside `diffReview.registerMcpServer` and registered in `activate()`.

A quick pick in the same style, **one row per agent**, labelled by the row's
aggregate status:

```
$(check)           Claude Code                      installed
                   ~/.claude/commands/ — both commands
$(warning)         Codex CLI                        1 of 2 installed
                   ~/.codex/prompts/
$(warning)         VS Code — profile "Work"         installed — older version
                   .../User/profiles/work/prompts/
$(circle-outline)  Gemini CLI                       not installed
                   ~/.gemini/commands/
$(circle-outline)  Cursor                           not installed (manual)
                   .cursor/commands/ — workspace-scoped commands
```

Each row carries a reveal-in-file-explorer button pointing at the directory,
matching the MCP command.

The label is a function of the two file statuses, not of the row status alone:

| Files | Label | Icon |
|---|---|---|
| both `current` | installed | `$(check)` |
| both `missing` | not installed | `$(circle-outline)` |
| one `current`, one `missing` | 1 of 2 installed | `$(warning)` |
| any `stale` | installed — older version | `$(warning)` |
| any file not writable | the above, plus *(manual)* | unchanged |

`stale` wins over a `missing` sibling in the label, since the older-version case
is the one the user needs to understand before picking.

**On pick:**

- `current` → info message naming both invocations, no write.
- `missing` / `stale`, `writable` → modal listing both destination paths and
  both bodies, with before → after for a `stale` file, and an explicit line for
  any file being skipped under the marker rule. Buttons: **Write** / **Copy** /
  **Cancel**. Write backs up what it overwrites and reports every path written.
- not `writable` (neither file can be written) → straight to copy.

**Copy** opens a second quick pick — *perform / address / both* — then copies
the chosen bodies, each preceded by its "save this to `<path>`" line. Two full
prompt bodies on the clipboard unannounced is worse than one question, and an
agent with no command directory usually wants one of them at a time.

**Copy is available on every row**, including `current`. It is the entire path
for anyone on ChatGPT or a web agent with no command directory, so it is a
first-class action rather than a modal afterthought.

## Connection to MCP registration

The only edit to the existing flow: the MCP registration success message gains a
follow-up action pointing at this command. The two features are useless apart —
the MCP server with no prompts is a set of tools nobody invokes, and the prompts
with no MCP server are slash commands that error — so each should name the other
at the moment the user has just finished the first.

## Error handling

Every failure path ends in a copyable body rather than a dead end. Unreadable
file, unwritable directory, permission error — all downgrade the affected
`CommandFile` to copy-only with the reason shown, and never throw out of the
command handler. A row is only fully copy-only when both of its files are.

## Verification

`test/slash-commands.test.js`, under the existing `node:test` runner, over the
pure transforms:

- per-file status detection per kind across `missing` / `current` / `stale`
- row-status aggregation over all four combinations of two file statuses
- the marker rule: `stale` with marker is writable, `stale` without is not —
  and that one unwritable file leaves the other writable
- body rendering: both commands across all four wrappers, frontmatter correct,
  body identical below the marker between wrappers, Gemini's TOML string
  escaping intact
- path construction, including the nested profile `location` case that the MCP
  implementation got wrong the first time

`test/vscode-profiles.test.js` covers `parseProfiles` with and without a flag
name — the MCP caller's existing behaviour, and this feature's unfiltered one.
The existing `test/mcp-consumers.test.js` must keep passing untouched; that is
the check on the extraction.

Beyond the tests:

1. Run `discoverSlashCommands()` read-only against the real machine and eyeball
   the list — Claude Code, Codex, Gemini and the VS Code profiles all present.
2. Exercise the writers against temp-directory copies before anything touches a
   real path.
3. Manual sandbox pass (`npm run sandbox`) through each outcome:
   already-current, version upgrade, half-installed, one file hand-edited,
   copy-only.
4. End to end, the full loop: install into Claude Code, run
   `/perform-diff-review` on a branch with a real change, confirm the threads
   appear in the gutter, delete one and keep the rest, then run
   `/address-diff-review` and confirm the replies and resolutions land back in
   the editor.

## Files

| File | Change |
|---|---|
| `src/slash-commands.ts` | new — discovery, status, both bodies, writers |
| `src/vscode-profiles.ts` | new — extracted app list, user-data roots, `parseProfiles` |
| `src/file-write.ts` | new — extracted `readText`, `backup`, `WriteResult` |
| `src/mcp-consumers.ts` | drop the extracted code, import it back; `parseProfiles(json, 'mcp')` |
| `test/slash-commands.test.js` | new — tests over the pure transforms |
| `test/vscode-profiles.test.js` | new — profile parsing with and without a flag name |
| `src/extension.ts` | register `diffReview.installAgentCommands`, quick pick UI; MCP success follow-up |
| `package.json` | contribute the command |
| `README.md` | document both commands alongside MCP setup |
| `TODO.md` | record it |
