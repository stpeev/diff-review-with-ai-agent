# TODO

- [ ] Install prettier, eslint and other goodies to the project
- [ ] Add tests for the existing functionality (`npm test` runs node:test over `test/`; `mcp-consumers`, `ipc-discovery`, `scope-id`, and `comment-store` are covered — `extension.ts`'s glue is not, see below)
- [ ] Add a basic AGENTS.md file
- [ ] F6 (soft-delete + `Diff Review: Restore Deleted Comments`) and F7 (`Diff Review: Recover Comments` over stranded scopes) from `docs/superpowers/specs/2026-09-05-comment-storage-durability.md` — F1–F5 are implemented, these two are not
- [ ] `myWorkspaceRoots` (used for the IPC 409 workspace-mismatch check) is captured once at IPC server startup — adding/removing a workspace folder mid-session doesn't refresh it
- [ ] Manual/E2E verification of F1–F5 per the spec's Verification table — two real windows, a branch switch across two repos, drift discovery via an actual `git checkout`/rename, the re-attach flow, MCP end-to-end. Unit tests cover the pure modules and one integration smoke test covers the real IPC descriptor/ping glue, but nothing here has exercised the actual `vscode.CommentThread`/UI paths yet.
- [ ] Manual `npm run sandbox` walkthrough of `Diff Review: Install the Diff Review Agent Commands` per `docs/superpowers/plans/2026-09-06-agent-slash-command.md`'s Plan-Level Verification — install into Claude Code, run `/perform-diff-review` on a branch with a real change, confirm the threads land in the gutter, then run `/address-diff-review` and confirm the replies/resolutions land back. `src/slash-commands.ts`'s pure logic is fully unit-tested; the quick pick UI in `extension.ts` is not (same gap as the rest of that file, see above).


# DONE

- [x] Add a command to print out accurate current MCP server info (`Diff Review: Show MCP Server Info`)
- [x] Add a command to auto discover and add the MCP server (`Diff Review: Register MCP Server with a Coding Agent`)
- [x] Add a command to install `/perform-diff-review` and `/address-diff-review` as agent slash commands (`Diff Review: Install the Diff Review Agent Commands`) — see `docs/superpowers/specs/2026-09-05-agent-slash-command-design.md`
- [x] Move comment storage off `workspaceState` into `<globalStorageUri>/scopes/<scopeId>/comments.json` — stable across version upgrades (unlike the old versioned-install-folder concern), works without git, and survives two windows on the same folder (F1-F5 of the storage durability spec: scoped IPC ports, never-latch-`_default` git detection, the scope/storage move itself, content-based anchoring with a "Needs re-attaching" drift UI, and a reliable debounced write queue)
