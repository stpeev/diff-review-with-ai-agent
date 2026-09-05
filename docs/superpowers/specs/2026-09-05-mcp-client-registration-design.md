# MCP Client Discovery and Registration

**Status:** implemented
**Date:** 2026-09-05

## Problem

The extension ships an MCP server and a stable launcher at
`~/.diff-review/mcp-launcher.js`, but every consumer has to be wired up by hand.
The README walks through it per consumer, which has two failure modes:

1. People never do it, so the MCP tools appear broken.
2. People wire it up against the versioned install path
   (`~/.vscode/extensions/jinqishen.diff-review-0.3.0/out/mcp-server.js`) instead
   of the launcher, and the config silently breaks on the next upgrade. This has
   already happened in the author's own Codex config.

## Goal

One command that lists every MCP consumer on the machine, says whether
`diff-review` is registered with each and whether that registration is correct,
and registers or repairs it on selection — with a copyable command as the
always-available fallback.

## Non-goals

- Extension-owned MCP registries (Cline's `cline_mcp_settings.json`, Kilo Code,
  Roo). Discoverable under each editor's `globalStorage`, but their schemas are
  unverified. Deferred.
- Workspace-scoped configs (`.vscode/mcp.json`, per-project `~/.claude.json`
  entries). User-level only.
- Remote hosts (`~/.vscode-server*/data/User/mcp.json`).
- Unregistering or editing entries other than `diff-review`.

## The canonical entry

Every writer and every copyable snippet produces exactly this, and nothing else:

```
command: node
args:    [<absolute path to ~/.diff-review/mcp-launcher.js>]
```

Never the versioned `out/mcp-server.js` path. `mcp-resolve.ts` already owns the
rule that the launcher resolves the real server at runtime; this feature is the
other half of it.

Paths in copied **JSON** are absolute — a literal `~` inside a JSON string is
not expanded by anything and is a documented footgun (README, "Cannot find
module"). Paths in copied **shell commands** keep `~`, because the shell expands
it before the client sees it.

## Module: `src/mcp-consumers.ts`

New file, pure, no `vscode` import — same shape as `mcp-resolve.ts`, so it stays
unit-testable once a framework lands and could be reused by the launcher.

```ts
type ConsumerKind = 'vscode-json' | 'codex-toml' | 'claude-json';
type Status = 'current' | 'stale' | 'missing';

interface McpConsumerTarget {
    id: string;          // 'vscode', 'vscode:profile:Work', 'cursor', 'codex', 'claude'
    label: string;       // 'VS Code', 'VS Code — profile "Work"', 'Codex CLI'
    kind: ConsumerKind;
    configPath: string;
    status: Status;
    /** For stale rows: the command line currently registered. */
    current?: string;
    /** True when we can safely write this file; false ⇒ copy-only row. */
    writable: boolean;
    /** Why writable is false, shown in the UI. */
    reason?: string;
}
```

Exported surface:

- `discoverConsumers(): McpConsumerTarget[]`
- `renderSnippet(target): string` — the JSON block or shell command to copy
- `register(target): void` — throws with a user-facing message on failure

### Discovery

**VS Code family.** Per-platform user-data roots, one row per app whose user dir
exists:

| Platform | Root |
|---|---|
| macOS | `~/Library/Application Support/<App>/User/` |
| Linux | `~/.config/<App>/User/` |
| Windows | `%APPDATA%\<App>\User\` |

Apps: `Code`, `Code - Insiders`, `VSCodium`, `Cursor`, `Windsurf`. The config is
`<root>/mcp.json`. A missing `mcp.json` under an existing user dir is a
`missing` row, not an absent one — that is the common case for a fresh install.

Cursor gets exactly one row. Its config is `~/.cursor/mcp.json` when that file
exists — the location Cursor documents — otherwise its user-data `mcp.json`.

**VS Code profiles.** Driven by `<root>/globalStorage/storage.json` →
`userDataProfiles[]` (`{ location, name, useDefaultFlags }`), one row per
profile, config at `<root>/profiles/<location>/mcp.json`.

> **Corrected during implementation.** The spec originally said to scan
> `profiles/*/mcp.json` and use `storage.json` only for display names. Testing
> against a real machine showed that wrong three ways: directories under
> `profiles/` outlive the profiles that created them (an orphan `342d1528` dir
> was listed with no matching profile), a `location` can be *nested*
> (`builtin/agents`), so `basename` mislabels it, and a profile with
> `useDefaultFlags.mcp === true` reads the **default** profile's `mcp.json` —
> writing to its own path would produce a file VS Code silently ignores.
> `storage.json` is therefore authoritative, and profiles that inherit MCP
> config are not listed. Covered by the `profiles:` tests.

**Codex CLI.** `~/.codex/config.toml`, honouring `$CODEX_HOME` when set.

**Claude Code.** `~/.claude.json`, top-level `mcpServers`.

### Status

Read the config, find the entry named `diff-review`:

- absent → `missing`
- present, `command` is `node` and the single arg resolves to the launcher →
  `current`
- present, anything else → `stale`, with `current` set to a readable rendering of
  what is there now

Path comparison normalises `~`, resolves symlinks, and is case-insensitive on
Windows and macOS.

### Writers

**`vscode-json`** — these files are JSONC; comments and trailing commas are
legal and Cursor users do write them. Use `jsonc-parser` (`modify` +
`applyEdits`) so comments and formatting survive the edit. This is the only new
runtime dependency. Writes `servers["diff-review"] = { type: "stdio", command:
"node", args: [<abs launcher>] }`, creating the file with `{ "servers": {} }` if
absent.

**`codex-toml`** — no TOML dependency. Status comes from a targeted scan for the
`[mcp_servers.diff-review]` table. Writing replaces that table in place — from its
`[mcp_servers.diff-review]` header line to the next line beginning with `[` in
column 0 that is not a sub-table of it (`[mcp_servers.diff-review.env]` and the
like stay inside the replaced span) — or appends it at end of file when absent. If the scan finds anything it does not
confidently understand (duplicate tables, the name in dotted-key form, an
inline-table `mcp_servers = { ... }`), the row is marked `writable: false` with
`reason: 'unrecognised config layout'` and degrades to copy-only. This is the
least certain writer, which is why the fallback exists.

**`claude-json`** — `~/.claude.json` is large and Claude Code rewrites it from
memory while running, so a direct write can be clobbered or can clobber. Prefer
shelling out to `claude mcp add diff-review -- node <launcher>`. When `claude` is
not on `PATH`, fall back to a direct JSON write of the top-level `mcpServers`
key. If the file parses but does not look like Claude Code's schema, degrade to
copy-only.

**Backups.** Before any in-place write, copy the file to
`<file>.diff-review-backup`, overwriting a previous backup. Reported in the
success message.

## Command: `diffReview.registerMcpServer`

Title: *Diff Review: Register MCP Server with a Client*. Contributed alongside
`diffReview.showMcpInfo` and registered in `activate()`.

A quick pick in the same style as `showMcpInfo`, each row labelled by status:

```
$(check)           VS Code                          registered
                   ~/Library/Application Support/Code/User/mcp.json
$(warning)         Codex CLI                        registered — points at the 0.3.0 install
                   ~/.codex/config.toml
$(circle-outline)  Cursor                           not registered
                   ~/.cursor/mcp.json
$(circle-outline)  Claude Code                      not registered (manual)
                   ~/.claude.json — unrecognised config layout
```

Each row carries a reveal-in-file-explorer button, matching `showMcpInfo`.

**On pick:**

- `current` → info message, "already registered against the launcher", no write.
- `missing` / `stale`, `writable` → modal showing the config path and the exact
  snippet, with before → after for `stale`. Buttons: **Write** / **Copy** /
  **Cancel**. Write backs up, writes, and reports both paths.
- not `writable` → straight to the clipboard, with a message naming the file to
  paste into and why we did not write it.

**Copy is available on every row**, including writable ones — it is a
first-class action, not a modal afterthought. What lands on the clipboard is
ready to paste:

- Codex → `codex mcp add diff-review -- node ~/.diff-review/mcp-launcher.js`
- Claude Code → `claude mcp add diff-review -- node ~/.diff-review/mcp-launcher.js`
- VS Code family → the JSON block, absolute launcher path already substituted

## Error handling

Every failure path ends in a copyable command rather than a dead end. Unreadable
file, malformed config, write failure, missing `claude` binary — all downgrade
the row to copy-only with the reason shown, and never throw out of the command
handler. The launcher itself may be missing if the extension has not finished
first activation; in that case the command reports that and points at
`diffReview.showMcpInfo`.

## Verification

The repo had no test framework. Rather than add a dependency, `npm test` bundles
the module with esbuild and runs Node's built-in `node:test` over `test/` — 22
tests, no new devDependency. Beyond those:

1. Run `discoverConsumers()` read-only against the real machine and eyeball the
   list against the known state — VS Code registered, Codex stale, Cursor and
   Claude Code missing.
2. Exercise each writer against temp-directory **copies of the real configs**,
   including the stale Codex file and a JSONC file with comments, asserting the
   output parses and that comments survived. Nothing touches the originals until
   these pass.
3. Manual pass through the command in the sandbox (`npm run sandbox`) for each
   of the three outcomes: already-current, stale repair, copy-only.

Results: Codex repaired with exactly one line changed (the `args` line) and all
32 tables intact; VS Code went 4 → 5 servers with every existing one preserved;
`~/.claude.json` lost none of its 1927 lines of unrelated state. No backup file
was ever written next to a real config, confirming the originals were never
opened for write.

## Files

| File | Change |
|---|---|
| `src/mcp-consumers.ts` | new — discovery, status, snippets, writers |
| `test/mcp-consumers.test.js` | new — 22 tests over the pure transforms |
| `src/extension.ts` | register `diffReview.registerMcpServer`, quick pick UI |
| `package.json` | contribute the command; add `jsonc-parser`; add `test` script |
| `README.md` | point the MCP setup section at the command |
| `TODO.md` | move "auto discover and add the MCP server" to DONE |
