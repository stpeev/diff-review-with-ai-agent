# TODO

- [ ] Upon load - check if some componenets like mcp-server or commands are already installed at some location, if so - update them automatically withoout asking user for confirmation
- [ ] Instead of multiple install XXX commands - have just one 'setup diff-review' that does all installations: mcp-server, commands, what else..?
- [ ] F6 (soft-delete + `Diff Review: Restore Deleted Comments`) and F7 (`Diff Review: Recover Comments` over stranded scopes) from `docs/superpowers/specs/2026-09-05-comment-storage-durability.md` — F1–F5 are implemented, these two are not
- [ ] Broaden extension-host coverage beyond activation and packaged smoke checks: exercise real `vscode.CommentThread` lifecycle, multi-root branch transitions, drift recovery, and MCP end-to-end delivery.


# DONE

- [x] The tests be siblings of the source code files themselves
- [x] Adopt Vite for production bundles, Vitest for source-level tests, explicit TypeScript checking, Prettier, ESLint, and `npm run check`; see `README.md` for the developer command contract.
- [x] Add `AGENTS.md` with review-service, persistence, and verification ownership rules.
- [x] Keep IPC workspace descriptors current when workspace folders are added or removed.

- [x] Add a command to print out accurate current MCP server info (`Diff Review: Show MCP Server Info`)
- [x] Add a command to auto discover and add the MCP server (`Diff Review: Register MCP Server with a Coding Agent`)
- [x] Add a command to install `/perform-diff-review`, `/address-diff-review`, `/register-for-diff-review-send`, and `/unregister-for-diff-review-send` as agent slash commands (`Diff Review: Install the Diff Review Agent Commands`) — see `docs/superpowers/specs/2026-09-05-agent-slash-command-design.md`
- [x] Move comment storage off `workspaceState` into `<globalStorageUri>/scopes/<scopeId>/comments.json` — stable across version upgrades (unlike the old versioned-install-folder concern), works without git, and survives two windows on the same folder (F1-F5 of the storage durability spec: scoped IPC ports, never-latch-`_default` git detection, the scope/storage move itself, content-based anchoring with a "Needs re-attaching" drift UI, and a reliable debounced write queue)
