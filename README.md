# Diff Review with AI Agent

**Inline code review comments for VS Code — review AI-generated changes, submit feedback in batch, and let agents respond.**

Add review comments on any line in any file, then submit them all to Copilot, Claude Code, or any AI agent as a structured prompt. Comments include surrounding code context and git diff hunks so the AI knows exactly what changed and what you want fixed. Perfect for reviewing Copilot Edits, PR changes, or any code modifications.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Quick Start

### 1. Add Review Comments
Open any file → hover on the line gutter → click the **`+`** icon → type your feedback (e.g., "rename this variable", "add error handling") → click **Add Comment**.

### 2. Review & Manage
Click the **status bar** (`💬 2 open · 1 resolved`) to open the **comment panel** — search, filter, batch-resolve, or navigate to any comment.

### 3. Submit to AI
- **Send to Copilot** — click the 📤 button on any thread or use the comment panel to submit all
- **Copy to Clipboard** — click 📋 to copy the structured prompt, then paste into Claude Code, Codex, or any AI chat
- **MCP Server** — Claude Code connects directly via MCP for real-time comment interaction

---

## Features

![Inline Comments](examples/screenshot-inline.png)

### Inline Commenting on Any File
- **"+" gutter buttons** on every line — add comments on any file type (not just markdown)
- **Threaded replies** with **👤 User** and **🤖 Agent** role badges
- **Edit** comments inline, **resolve/reopen** threads, **delete** individual replies
- **Send to Copilot** button directly on each thread's title bar
- **Copy to Clipboard** button for pasting into any AI chat

### Git Diff Context in Prompts
When you submit comments, the prompt includes the **git diff hunk** for each commented line — showing what was added, removed, and changed. The AI sees both the current code and the change history:

```
### Line 15
```
→ 15 | const userData = await fetchUser(id);
```
**Git diff:**
```diff
@@ -13,5 +13,5 @@
-const data = fetch('/api/user/' + id);
+const userData = await fetchUser(id);
```
**Comment:** Good rename, but add error handling for the await
```

### Comment Panel (Status Bar)

![Comment Panel](examples/screenshot-panel.png)

Click the status bar to open an interactive panel with:
- **Search/filter** — type to find comments by text or filename
- **Global batch actions** — Submit All, Copy All, Resolve All, Delete Resolved, Clear All
- **Per-file batch actions** — Submit, Copy, Resolve, Delete Resolved scoped to a single file
- **Per-comment actions** — Go to, Send to Copilot, Copy, Resolve, Delete

### Comment Persistence
- Comments **survive window reloads** via VS Code workspace state
- **Branch-scoped** — comments are stored per repository + branch
- Switch branches → comments swap automatically
- New branches **inherit** comments from the parent branch, then diverge independently

### Line Tracking
- Comments **follow the code** when lines are added or removed above them
- CRLF-aware — works correctly on Windows with `\r\n` line endings

### 4 Copilot Language Model Tools
Enable in **Agent Mode → Tools** to let Copilot interact with your review comments:

![Agent Reply](examples/screenshot-agent.png)

| Tool | Description |
|---|---|
| `#listDiffComments` | List all comments with IDs, file locations, status, and thread text |
| `#replyToDiffComment` | Reply to a comment as the agent role |
| `#resolveDiffComment` | Mark a comment as resolved/done |
| `#deleteDiffComment` | Delete a comment thread |

**Example workflow:**
```
User: "Address all my review comments"
Agent: [calls #listDiffComments] → sees 3 open comments
       [makes code changes based on feedback]
       [calls #replyToDiffComment] → explains what was changed
       [calls #resolveDiffComment] → marks each as done
```

### MCP Server (Claude Code, Cursor, Windsurf, etc.)
The extension includes a standalone MCP server that any MCP-compatible AI client can connect to for real-time access to review comments. Available tools: `listDiffComments`, `replyToDiffComment`, `resolveDiffComment`, `deleteDiffComment`.

**The quick way:** run **`Diff Review: Register MCP Server with a Coding Agent`** from the command palette. It lists every MCP consumer it can find on your machine — VS Code and its forks (including per-profile configs), Codex CLI, Claude Code — and shows whether `diff-review` is registered with each:

| | meaning |
|---|---|
| `$(check)` registered | already points at the launcher, nothing to do |
| `$(warning)` registered — runs … | registered, but against a path that breaks on upgrade; pick it to repair |
| `$(circle-outline)` not registered | pick it to add |

Picking a consumer shows exactly what will be written and where, and backs the file up before changing it. Every row also offers **Copy** instead, if you would rather paste the config or run the `mcp add` command yourself — and rows we cannot edit safely are copy-only automatically.

The rest of this section is the manual equivalent.

Open the extension in VS Code once after installing. On activation it deploys a small launcher to a **stable, version-independent path** — point your MCP client at that, and the config keeps working across extension upgrades:

```
~/.diff-review/mcp-launcher.js          # macOS / Linux
%USERPROFILE%\.diff-review\mcp-launcher.js   # Windows
```

> Do **not** configure the extension's own `out/mcp-server.js` directly. VS Code puts the version in the install directory name (`jinqishen.diff-review-0.3.0`), so that path breaks on every upgrade. The launcher resolves the current build at runtime instead.

**Claude Code:**
```bash
# Windows:
claude mcp add diff-review node "%USERPROFILE%\.diff-review\mcp-launcher.js"

# macOS/Linux:
claude mcp add diff-review node ~/.diff-review/mcp-launcher.js
```

**Cursor:**
Add to your Cursor MCP settings (`~/.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "diff-review": {
      "command": "node",
      "args": ["/full/path/to/home/.diff-review/mcp-launcher.js"]
    }
  }
}
```

> ⚠️ Use an **absolute path** in JSON configs. Clients spawn the server directly rather than through a shell, so `~` is never expanded — Node treats it as an ordinary folder name and resolves it against the client's working directory, giving a confusing error about a path you never wrote:
>
> ```
> Error: Cannot find module '/some/other/dir/~/.diff-review/mcp-launcher.js'
> ```
>
> The `claude mcp add` command above is safe only because your *shell* expands `~` before Claude Code ever sees it.

**Other MCP clients:**
Any client supporting the stdio transport can connect. Configure it as command `node` with the launcher's absolute path as the only argument — no flags, no environment needed. The launcher is also directly executable (`/Users/you/.diff-review/mcp-launcher.js`) if your client prefers a single command string.

To check it by hand:
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | node ~/.diff-review/mcp-launcher.js
```
It should print a JSON list of the four tools. The launcher speaks JSON-RPC on stdin/stdout, so run on its own it will just sit and wait for input — that is correct behaviour, not a hang.

**Working on the extension itself?** Set `DIFF_REVIEW_SERVER` to override resolution and load your local build:
```bash
DIFF_REVIEW_SERVER=/path/to/diff-review/out/mcp-server.js node ~/.diff-review/mcp-launcher.js
```

<details>
<summary>How the launcher resolves the server</summary>

In order of preference:
1. `DIFF_REVIEW_SERVER` — explicit override; errors out if the file is missing rather than silently falling back.
2. `~/.diff-review/server-path` — written by the extension on each activation, so it names the exact build currently running.
3. A scan of the known extension directories (VS Code, Insiders, OSS, remote server, Cursor, Windsurf), picking the highest installed version.

</details>

> **Note:** The VS Code extension must be running (window open and activated) for the MCP server to connect. The MCP server communicates with the extension via a local IPC server — comments are always live, no stale files.

### Clipboard Support
Every action that sends to Copilot also has a **Copy to Clipboard** variant — paste the structured prompt into Claude Code, Codex CLI, ChatGPT, or any AI:
- **Per-thread**: 📋 button on the thread title bar
- **Per-file**: Copy action in the comment panel
- **Global**: "Diff Review: Copy All to Clipboard" in the command palette

---

## Commands

| Command | Description |
|---|---|
| `Diff Review: Show Comments Panel` | Open the interactive comment panel |
| `Diff Review: Submit All to Copilot` | Send all open comments to Copilot Chat |
| `Diff Review: Copy All to Clipboard` | Copy all open comments as a structured prompt |
| `Diff Review: Resolve All` | Resolve all open comments |
| `Diff Review: Delete All Resolved` | Delete all resolved comments |
| `Diff Review: Clear All Comments` | Delete all comments |

---

## Architecture

```
src/
  extension.ts   — Comment controller, persistence, IPC server, Copilot tools
  mcp-server.ts  — Standalone MCP server for Claude Code (connects to IPC)
```

**IPC Server**: The extension starts a local HTTP server on `127.0.0.1` (random port). The MCP server discovers the port via a temp file. All comment reads/writes go through the extension (single source of truth).

**Branch Scoping**: Comments are stored under `diffReview.state.{repoName}.{branchName}` in VS Code's workspace state. Branch switches are detected via the git extension API.

---

## Development

```bash
# Install dependencies
npm install

# Build extension + MCP server
npm run build

# Build extension only
npm run build:ext

# Build MCP server only
npm run build:mcp

# Package vsix
npm run package

# Deploy: package a vsix and install it via the `code` CLI (use after a version bump)
npm run deploy

# Deploy fast: copy the fresh build over the already-installed extension of the
# same version, skipping packaging (use while iterating on code)
npm run deploy:fast
```

Both deploy scripts build first. Reload the VS Code window afterwards
(**Developer: Reload Window**) to pick up the new build; on activation the
extension refreshes `~/.diff-review/mcp-launcher.js` and `server-path`, so MCP
clients keep resolving the current server without reconfiguration — restart the
MCP client too if you changed the server itself.

---

## Version History

| Version | Highlights |
|---|---|
| **0.1.3** | Git diff context in prompts — AI sees what changed, not just current code |
| **0.1.2** | Branch-scoped comment persistence — comments follow repo + branch, inherit on new branches |
| **0.1.1** | Clipboard support, bug fixes (activation crash, comment rendering, CRLF line tracking) |
| **0.1.0** | Initial release — inline comments, threaded replies, batch submit, comment panel, Copilot tools, MCP server, IPC, persistence, line tracking |

---

## License

[MIT](LICENSE)
