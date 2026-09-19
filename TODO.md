# TODO

- [ ] F6 (soft-delete + `Diff Review: Restore Deleted Comments`) and F7 (`Diff Review: Recover Comments` over stranded scopes) from `docs/superpowers/specs/2026-09-05-comment-storage-durability.md` — F1–F5 are implemented, these two are not
- [ ] Broaden extension-host coverage beyond activation and packaged smoke checks: exercise real `vscode.CommentThread` lifecycle, multi-root branch transitions, drift recovery, and MCP end-to-end delivery.


# DONE

- [x] The tests be siblings of the source code files themselves
- [x] Adopt Vite for production bundles, Vitest for source-level tests, explicit TypeScript checking, Prettier, ESLint, and `npm run check`; see `README.md` for the developer command contract.
- [x] Add `AGENTS.md` with review-service, persistence, and verification ownership rules.
- [x] Keep IPC workspace descriptors current when workspace folders are added or removed.

- [x] Add a command to print out accurate current MCP server info (`Diff Review: Show MCP Server Info`)
- [x] Add a command to auto discover and add the MCP server (`Diff Review: Register MCP Server with a Coding Agent`) — superseded by `Diff Review: Setup`
- [x] Add a command to install `/perform-diff-review`, `/address-diff-review`, `/register-for-diff-review-send`, and `/unregister-for-diff-review-send` as agent slash commands (`Diff Review: Install the Diff Review Agent Commands`) — see `docs/superpowers/specs/2026-09-05-agent-slash-command-design.md` — superseded by `Diff Review: Setup`
- [x] Move comment storage off `workspaceState` into `<globalStorageUri>/scopes/<scopeId>/comments.json` — stable across version upgrades (unlike the old versioned-install-folder concern), works without git, and survives two windows on the same folder (F1-F5 of the storage durability spec: scoped IPC ports, never-latch-`_default` git detection, the scope/storage move itself, content-based anchoring with a "Needs re-attaching" drift UI, and a reliable debounced write queue)
- [x] Upon extension load - check if some components like mcp-server or commands are already installed at some location, if so - update them automatically without asking user for confirmation. Log the activity. (`src/adapters/setup/component-auto-update.ts`: stale-but-writable MCP registrations and agent command files are refreshed in place on activation; missing/current/non-writable ones are never touched, and every update or failure goes to the Diff Review output channel)
- [x] Replace the multiple install commands with one `Diff Review: Setup` — a multi-select checklist of every detected MCP consumer / agent, nothing preselected, that registers the MCP server and installs the four agent commands for each ticked row (`src/adapters/setup/setup-command.ts`). Already-current parts are skipped, every file is backed up before a write, and anything that cannot be written safely (or fails) ends on the clipboard. `Diff Review: Show MCP Server Info` stays as the informational command, and activation-time auto-update still refreshes previously installed components silently.
- [x] Emitted prompts treat a comment like a normal chat message: `renderReviewPrompt` now carries only the comment payload plus one closing line ("Reply here and then copy a short summary into the thread with `diffReview_replyToComment` (threadId and text); if it makes sense mark it resolved with `diffReview_resolveComment`." — MCP names on the direct-delivery path). The line names both destinations on purpose: the tools write into the gutter, so without it an agent finishes on its tool calls and never answers in the conversation. The five-step policy survives only in `/address-diff-review`; `prosePolicy`, `ThreadRef`, and `PolicyOptions` are deleted, and the slash-command bodies stayed byte-identical so no marker version bump was needed.
