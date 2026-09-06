# Comment Storage Durability

**Status:** F1–F5 implemented; F6 and F7 not started
**Date:** 2026-09-05

## Problem

Comments live in `workspaceState` under `diffReview.state.<repoFolder>.<branch>`
(`stateKey()` in `src/extension.ts`). An audit of activation, branch switching,
line tracking, IPC and teardown found eleven defects in three groups:

- **Destructive.** Two windows on the same folder overwrite each other. MCP
  writes can land in the wrong project. Writes are never awaited.
- **Orphaning.** The key derives from mutable inputs — folder name, branch name,
  `repos[0]`, workspace identity. Any change strands a whole comment set.
- **Desynchronization.** Only line numbers persist, and only in-editor edits
  move them.

## Goal

Survive a second window, a `git pull`, a rebase, a folder move, a crash. Where
durability is impossible, fail loudly instead of showing an empty panel.

Out of scope: sharing or committing comments; requiring git (no-repo workspaces
are first-class, only branch scoping needs git); conflict resolution *within* a
thread — last-write-wins per thread is fine, per-*state* clobber is not.

**Order.** F7 first — the only fix that recovers already-lost data, and it
depends on nothing. Then F1 and F2, cheap and covering the likeliest failures.
F3 is structural and needs F1's revision stamp to be verifiable.

---

## F1 — Scope the IPC port file per workspace

*Fixes: MCP writes hitting the wrong project; the teardown unlink bug.*

`startIpcServer` writes one global `os.tmpdir()/diff-review-port`. The last
window to activate receives **all** MCP traffic — including `deleteDiffComment`,
which has no confirmation on the IPC path. The disposer unlinks it
unconditionally, so closing any window breaks discovery for the others.

Replace with per-window descriptors:

```
<tmpdir>/diff-review/<sha256(workspaceRoot).slice(0,16)>.json
  { port, workspaceRoot, pid, startedAt }
```

- Each window writes and removes only its own — the teardown bug disappears.
- `GET /ping` returns `{ workspaceRoot, pid }`; sweep non-responding descriptors
  on activation.
- `mcp-server.ts` resolution: `--port` → descriptor whose `workspaceRoot` is the
  deepest prefix of `process.cwd()` → sole live descriptor → else fail with the
  candidate list. Never guess.
- IPC mutations verify the expected workspace root, `409` on mismatch.
- Keep writing the legacy file for one release; log a deprecation.

## F2 — Never latch `_default`

*Fixes: git-not-ready at activation stranding a session.*

`getBranchKey()` returns `_default` when `git.repositories` is still empty, and
if `vscode.git` is inactive, `setupBranchWatcher` returns **without registering
anything** — stuck on `_default` for the session. `onDidOpenRepository` only
listens for *later* changes; discovery never re-evaluates the key.

Root cause: `_default` conflates *"no repo"* (permanent, correct) with *"repo
not reported yet"* (a race).

**`vscode.git` stays the authority.** We want independence from its *timing*,
not from it. It is the only source for HEAD, it emits the change events we need,
and it already handles what a hand-rolled walk gets wrong — `.git` as a *file*
(worktrees, submodules), `GIT_DIR`, `core.worktree`, bare repos, and the
`git.autoRepositoryDetection` setting. Reimplementing detection would give two
sources of truth that can disagree about the repo root, which is itself an
orphaning bug: the same folder would resolve to different scope ids depending on
who answered.

So the filesystem is used only as a **predicate** — *"is waiting worthwhile?"* —
never to derive a scope id:

- Walk up for a `.git` entry (file or directory; existence only, no parsing).
  None found → resolve `plain` immediately, never wait.
- Found → enter `pending` and wait for `vscode.git` to supply the authoritative
  root and branch. Await `gitExtension.activate()` rather than testing `isActive`.

| State | Meaning | Behavior |
|---|---|---|
| `git` | repo reported, branch known | Branch-scoped as today |
| `pending` | `.git` seen on disk, repo not yet reported | Hold in memory, defer saves, flush on settle |
| `plain` | no `.git` above | Persist immediately, no branch scoping |

`pending` is bounded (10s), then degrades to `plain` with a warning. Also:
re-evaluate in `onDidOpenRepository`, and log every transition.

### State is per scope, not per window

A multi-root workspace can hold several repos plus plain folders, each at a
different state simultaneously — repo A `git`, repo B `pending`, folder C
`plain`. State therefore attaches to a scope (F3), not to the window:

- Deferred saves are per scope. B being `pending` must not hold A's writes.
- Register `state.onDidChange` for **every** repo, not `repos[0]`.
- A branch switch in A must swap only A's threads. `switchToBranch()` currently
  calls `clearThreads()`, which disposes **every** thread in the window and then
  persists that — so with two repos, switching branch in one wipes the other's
  comments. Scope the clear, load and branch-inheritance copy to the repo that
  changed.
- The status bar aggregates across scopes.

Submodules and worktrees resolve to their own scope, since deepest-match wins and
each has its own HEAD. That is correct but surprising, so the panel should label
threads by scope when more than one is active.

Same root cause, also in scope:

- **Detached HEAD** is a shared bucket — rebase, bisect and tag checkout all map
  to `_detached`, inheriting the last episode's leftovers. Key on the short SHA
  and skip the inheritance copy while detached.
- **`repos[0]`** is nondeterministic in multi-root workspaces. Resolve per file
  instead; scope resolution is F3.

## F3 — Move storage out of `workspaceState`

*Fixes: cross-window clobber; all workspace-identity orphaning.*

`workspaceState` is shared by concurrent windows with no locking, and is keyed by
workspace identity — a folder move, a symlink, a `.code-workspace`, or
Remote-SSH each produce a different store and an empty panel.

```
<context.globalStorageUri>/scopes/<scopeId>/comments.json
```

`globalStorageUri` is always defined, is removed on uninstall, and respects
portable mode and `--user-data-dir`. Create the directory ourselves.

> `context.storageUri` is the obvious choice and a trap: same workspace-identity
> hash, `undefined` with no folder, no locking. It inherits every orphaning path
> here.

Nothing is written into the user's folder, so git and non-git behave identically
and read-only folders work. Branch scoping becomes a key *inside* the file.

Two windows then share one source of truth; a `FileSystemWatcher` reloads on
external change, which also surfaces agent-driven MCP edits live.

**Scope id** — per workspace folder, best available first:

| Condition | Scope id | Survives |
|---|---|---|
| Repo with `origin` | `remote:<normalized url>` | Folder move **and re-clone** |
| Repo, no remote | `repo:<sha256(realpath of repo root)>` | Stable in place |
| No `.git` above | `folder:<sha256(realpath of folder)>` | Stable in place |
| No workspace folder | none — in-memory only | — |

`realpath` collapses symlinks, so a folder opened both ways resolves to one
scope. A comment takes the scope of the *deepest* containing workspace folder,
which handles multi-root and mixed git/non-git roots and retires `repos[0]`.

Only `remote:` survives a re-clone. The other two are as fragile as today's key —
what changes is *visibility*: scopes sit in one listable directory, each with a
`meta.json` (last-known path, label, count) that F7 turns into recovery.

With no workspace folder at all, do not invent a scope: keep comments in memory
and show `$(warning) not persisted` in the status bar tooltip.

**Staging.** The concurrency guard ships first and makes the rest testable:

1. Add `revision` and `writerId` to `SerializedState`. Re-read before writing; on
   a revision mismatch, merge by thread ID (last-write-wins per thread, union of
   sets) instead of overwriting.
2. Move the backing store to the file above, same merge logic.
3. On first run against an empty scope, import the matching `workspaceState` key;
   leave the old key for one release.

## F4 — Anchor to content, not line numbers

*Fixes: drift from out-of-editor edits; deleted blocks; dangling files.*

`SerializedThread` stores only `startLine`/`endLine`, moved only by
`onDidChangeTextDocument`. A `git checkout`, `git pull`, or CLI formatter
silently reattaches every comment in the file to unrelated code — worse than
showing nothing.

- Persist an anchor: hash of the anchored line plus surrounding context.
- On load, verify; on mismatch search ±50 lines and re-anchor silently if found.
- Otherwise mark the thread `drifted` and surface it in the panel with its
  original text. A drifted comment is recoverable; a misplaced one is not.
- Fix `if (threadLine > oldEndLine)`, which skips threads *inside* the changed
  range — a comment in a deleted block stays put and points at whatever slid up.
  Deleted anchor range → `drifted`.
- `loadStateFromKey` calls `createCommentThread` without an existence check,
  creating phantoms for deleted files. Mark those `drifted` too.

### Drift is a last resort

Drift should be rare, or the feature is just nagging. Escalate only after
automatic recovery fails:

| Step | Check | Outcome |
|---|---|---|
| 1 | Anchor hash matches at the stored line | Attached, silent |
| 2 | Hash found within ±50 lines | Re-anchored, silent (logged) |
| 3 | Hash found anywhere in the file | Re-anchored, silent (logged) |
| 4 | File missing, but git reports a rename | Re-anchor to the new path, silent |
| 5 | None of the above | `drifted` |

Step 4 matters more than it looks: a rename otherwise drifts *every* comment in
the file at once, which is exactly the moment the feature would feel worst.

### Drifted comments: UX

A drifted thread has no trustworthy range, so it **leaves the gutter** as a
live thread. Leaving it in place at its last-known line, presented as if it
still described that code, is the original behavior and the bug.

It moves to the existing comment panel (`diffReview.showPanel`), under a
**Needs re-attaching** section grouped by file.

**Amended 2026-09-07.** Withholding the thread entirely proved to be its own
bug: a drifted comment vanished from the Comments view, which is where users
actually look, with only the status bar hinting that anything existed. A
drifted record now also gets a *ghost* thread — shown at its last-known line,
labelled `⚠ Moved — anchor not found (was L<n>)`, and deliberately excluded
from `threadMap` so it is never line-shifted, re-verified or serialized as a
live thread. Replying and resolving on a ghost write through to the drifted
record; only re-attaching restores a trustworthy position. No new view is introduced; the
panel already does search, grouping and per-item actions.

Each drifted entry shows the comment text and the **stored anchor snippet** —
the code as it was when the comment was written. Without that the user cannot
tell what the comment referred to, which makes re-attaching guesswork. Actions:

- **Show original context** — the snippet, plus the last-known path and line.
- **Re-attach…** — opens the file, user places the cursor, confirms. Re-anchors
  and re-hashes.
- **Search again** — re-run the ladder above, in case the code returned (common
  after a rebase is finished or a branch is switched back).
- **Keep as file note** — accept it as file-level rather than line-level, for
  comments whose target genuinely no longer exists.
- **Resolve** / **Delete** — it may simply be done, or no longer relevant.

Signalling is passive. The status bar gains a count —
`$(comment-discussion) 3 open · 1 drifted` — that opens the panel section when
clicked. No modals and no toasts: drift is discovered in bulk after a `git pull`
or rebase, so an interruption per comment would be intolerable. Drifted comments
are never auto-deleted; they are the ones most at risk of being lost.

After a rebase or a large pull, many threads drift at once, so the panel offers
**Re-attach all in file…**, walking them in order with the file open.

`listDiffComments` must report the state rather than a stale location — a
drifted thread returns `DRIFTED (was src/foo.ts:42)`, never a line number that
looks current. An agent given a wrong line will edit the wrong code, which is a
worse failure than being told the location is unknown.

Threads on `git:` diff-view URIs are out of scope here: those URIs are snapshots
that die with the editor, and are a separate problem from content drift.

## F5 — Make writes reliable

*Fixes: swallowed failures; save churn.*

All 22 `saveState()` call sites ignore the Thenable from
`workspaceState.update()`, so failures are silent and a crash loses the tail.

- Return the promise; serialize writes through one queue.
- Log failures; notify on repeated failure.
- Debounce line-tracking saves (~500ms) — currently every keystroke, which is
  what makes the F3 clobber so easy to hit.
- `await` the flush in `deactivate()`.

## F6 — Make agent deletion recoverable

*Fixes: unconfirmed destructive IPC.*

`POST /delete` disposes immediately. The UI path is modal-confirmed; the agent
path is not, and the caller is an LLM acting on natural language.

- Soft-delete to a `deleted` array with a timestamp, retained 30 days.
- Add `Diff Review: Restore Deleted Comments`.
- Have the tool report the deletion as recoverable.

## F7 — Recover stranded comment sets

*Fixes: sets already orphaned; orphaning F3 cannot prevent.*

**Independently shippable — depends on nothing else.** `Memento.keys()` exists
as of VS Code 1.68 and we target `^1.93.0`, so the current store is already
enumerable via the `diffReview.state.` prefix.

`Diff Review: Recover Comments` lists every non-active comment set — from
`workspaceState.keys()`, and after F3 from each `scopes/*/meta.json` — and offers
**Merge into current** or **Discard**. `SerializedState` already carries enough
to rebuild a thread, so this is a read plus F3's merge routine.

---

## Open decisions

- **`remote:` keying** makes two clones of one repo share storage (branch-scoped
  inside the file). Arguably right for the "one clone per branch" workflow, but
  surprising. Adding the repo root to the id separates them, at the cost of
  re-clone survival.
- **`drifted`** as a first-class state is a product decision, not just a bug fix.
  It adds a panel section, a status-bar count and a re-attach flow (see F4), and
  changes the model so a comment can exist without a valid location.

## Verification

`mcp-consumers.ts` set the precedent for unit-testing pure modules under `test/`.
Port resolution (F1), merge (F3) and anchoring (F4) should be extracted as pure
functions and tested there. The rest is manual, and each needs a reproduction
that fails before the change:

| Fix | Reproduction |
|---|---|
| F1 | Two projects open; each MCP client reaches its own window. Close one, the other still resolves. |
| F2 | Throttle git discovery; comments added during startup persist to the branch key. |
| F2 | Folder with no `.git` resolves to `plain` immediately, never waiting on the git extension. |
| F2 | Multi-root with two repos: switch branch in one; the other's comments stay visible and persisted. |
| F3 | Same folder in two windows, a comment in each; both survive. |
| F3 | Scope resolution: multi-root mixing git and plain roots stays separate; symlink and real path share one scope; a single file with no folder says not persisted and writes nothing. |
| F4 | `git checkout` a branch that shifts the file: re-anchor or `drifted`, never silent misplacement. |
| F4 | `git mv` a commented file: comments follow the rename silently (ladder step 4). |
| F4 | Force a drift: thread leaves the gutter, appears under Needs re-attaching with its original snippet, and re-attaches to a chosen line. |
| F4 | `listDiffComments` reports `DRIFTED (was …)` and never a stale line number. |
| F5 | Add a comment, kill the window immediately; it is present on reopen. |
| F6 | `deleteDiffComment` via MCP, then restore. |
| F7 | Seed two `diffReview.state.*` keys; both list, merging preserves the active set. |

## Files

| Path | Change |
|---|---|
| `src/extension.ts` | F2 key resolution, F4 anchoring, F5 write queue, F6 soft delete, F7 command |
| `src/ipc-discovery.ts` | New. Pure descriptor read/write/resolve (F1) |
| `src/comment-store.ts` | New. Pure serialize/merge/anchor (F3, F4) |
| `src/scope-id.ts` | New. Pure scope resolution (F3) |
| `src/mcp-server.ts` | F1 resolution order, F6 tool description |
| `package.json` | F7 command contribution |
| `test/` | Unit tests for the three pure modules |
| `README.md` | Storage location, non-git behavior, drifted comments |
