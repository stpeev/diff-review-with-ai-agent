# MCP Reconnect After a VS Code Restart

**Status:** proposed
**Date:** 2026-09-24

## Problem

An agent session can outlive the VS Code window it talks to. T3 Code runs
Claude outside VS Code, so restarting or reloading the window leaves the
agent's `diff-review` MCP process running, and it never recovers:

1. **The port changes.** The extension listens on port 0
   (`src/protocol/server.ts`), so every extension-host start gets a new
   port. `resolveMcpTarget` (`src/mcp-target.ts`) stores the first result
   in `cachedTarget` and never clears it. Every later tool call goes to the
   dead port.
2. **The session registration is lost.** `AgentRegistry`
   (`src/agent-registry.ts`) lives only in the extension's memory. After a
   restart the window doesn't know the session, so Send has nowhere to
   deliver.
3. **Re-registering does nothing.** `createMcpSessionRegistrar`
   (`src/mcp-session-registration.ts`) reuses a successful registration for
   the life of the process unless a new label is passed. Running
   `/register-for-diff-review-send` again never sends a new POST.
4. **`awaitReview` counts from the old window.** The MCP sends
   `since=<lastReviewGeneration>`, but the new window's `ReviewWaiters`
   generation starts again at 0. A review sent before the first timeout
   response resets the counter is not reported as pending
   (`src/protocol/review-await.ts`: `generation > since`).

Retrying failed calls alone can't restore Send. Delivery is started by the
extension, and the MCP isn't calling anything when the user clicks Send. The
MCP has to reconnect and re-register on its own.

## Goal

Within about a minute of the right window coming back, with no action from
the user:

- MCP tool calls work again.
- Send delivers to the session again.

`/register-for-diff-review-send` reconnects immediately whenever the user
runs it.

## Non-goals

- Changing port discovery. `resolvePort` and `resolveMcpTarget` keep their
  current order and fallbacks: `--port`, the deepest cwd root match, the
  only live window, then the old `diff-review-port` file. Descriptor
  filenames stay as they are.
- Saving `AgentRegistry` in the extension across restarts. This would store
  messaging tokens on disk and still wouldn't fix the MCP's stale port.
- Remote or tunnelled VS Code windows.

## Design

Every change is in the MCP process. The extension's routes stay as they are.

### F1. A target resolver that can be reset

Replace the module-level `cachedTarget` with a resolver built from injected
dependencies, so it can be tested without real files, network or process
state:

```ts
interface TargetResolverDependencies {
  listDescriptors(): Descriptor[];
  ping(port: number, endpoint: string): Promise<boolean>;
  readLegacyPort(): number | undefined;
  portFlag: number | undefined;
  cwd: string;
  log(message: string): void;
}

interface TargetResolver {
  /** The current target, running discovery only when none is saved. */
  current(): Promise<ResolveResult>;
  /** Run discovery again, applying the same-root rule (F2). Returns undefined while held. */
  rescan(): Promise<ResolveResult | undefined>;
  /** Run discovery with the full first-connection rules and replace any saved root. */
  reconnect(): Promise<ResolveResult>;
  onTargetChanged(listener: (next: ResolveResult, previous: ResolveResult | undefined) => void): void;
}
```

`current()` behaves the way `resolveMcpTarget()` does today. The discovery
body, including the fallback to the old port file and its warning, moves in
unchanged. `mcp-target.ts` keeps `resolveMcpTarget` and `postToMcpTarget` as
thin wrappers around a default resolver wired to `fs`, `os` and
`process`, so existing callers don't change.

`cwd` is `CLAUDE_PROJECT_DIR || process.cwd()`, the same directory session
registration already uses. For Claude in T3 the two are normally equal.
Using one value makes routing and registration agree when they are not.

With `--port` set, every re-scan returns the flag's port and the resolver
never changes target.

### F2. Same-root rule for re-scans

A re-scan runs the discovery from F1 without changes and then checks the
result:

- If the saved target came from a **cwd match**, accept the result only if it
  is also a cwd match with the same `matchedRoot`. Treat anything else as
  "not back yet": another window found as the only live one, the old port
  file, an ambiguity error, or no windows at all. Keep the saved root, mark
  the target disconnected, and try again on the next heartbeat.
- If the saved target came from the **only live window** or the **old port
  file**, there is no root to keep. Accept the result as normal discovery
  would.

This rule stops a background re-scan from switching windows during the few
seconds a restart leaves some other window as the only one running. It
applies only to automatic re-scans. `reconnect()` (F5) ignores it.

When a held re-scan fails, the next tool call fails with a message naming
the window it is waiting for, for example: `Waiting for the VS Code window
for /path/to/root to come back. Run /register-for-diff-review-send to
connect to a different window.` The underlying `NoServerError` or
`AmbiguousPortError` text is logged to stderr.

### F3. Re-scan when a call fails

`postToMcpTarget` and the `awaitReview` GET use the resolver:

- **Connection refused** (`ECONNREFUSED`): the request never reached a
  server, so it is safe to repeat. Call `rescan()`. If that returns a target
  with a different port, retry the request once. Otherwise return the
  original error, or the waiting message from F2.
- **Reset, timeout, or any other failure after connecting**: the server may
  already have handled the request, so don't retry it. `/create` is not
  idempotent. Mark the target stale so the next call runs `rescan()` first,
  and return the error.
- **409 workspace mismatch**: another window now owns this port. Mark the
  target stale and return the error. The next call re-scans.

There is at most one retry per call, and no retry loop.

### F4. Heartbeat

`main()` in `src/mcp-server.ts` starts a heartbeat.
`createMcpServer()` does not, so building the server in tests stays free of
side effects.

- Every 60s, using `setInterval(...).unref()` so the timer doesn't keep the
  process alive.
- Each tick calls `/ping` on the saved port. `/ping` already returns
  `workspaceRoots` and `pid` (`src/protocol/read-routes.ts`). The tick
  counts as alive only if the call succeeds **and** the answer still
  includes the saved `matchedRoot`, when there is one. A different window
  that picked up the reused port counts as dead.
- If the ping fails, call `rescan()`.
- Ticks never overlap. If a tick is still running, the next one is skipped.
- Nothing is logged while the target stays healthy. Log once when the
  target is lost, and once when a new one is found.
- The first tick runs 60s after startup. Nothing is saved before the first
  tool call, so an idle MCP never scans.

### F5. Re-send registrations when the target changes

On `onTargetChanged` with a different port:

1. `lastReviewGeneration` is reset to 0. This fixes problem 4.
2. The registrar re-sends every session that registered successfully in
   this process, calling `/session/register` with the same payload as
   before: agent, session ID, label, cwd, socket path, token and pid. The
   Claude process has survived the restart, so the socket, token and pid are
   still valid, and the extension re-runs its usual identity check.

The registrar exposes this as `replayAll(): Promise<RegistrationOutcome[]>`.
It keeps each successful registration's payload next to the stored
promise. A failed replay is logged and stays saved, so the next target
change tries again. `clear(sessionId)`, called on unregister, removes it
from the replay set.

`/session/register` already updates an existing entry in place (it keeps
`registeredAt` and bumps `lastSeenAt`), so replaying a session the window
still knows is harmless.

### F6. An explicit register always starts fresh

The `registerAgentSession` tool, which `/register-for-diff-review-send`
calls:

1. Calls `resolver.reconnect()`. This runs the full first-connection rules,
   ignores the same-root hold, and replaces the saved root. This is how a
   user can deliberately point the session at a different window. An
   `AmbiguousPortError` or `NoServerError` is shown to the user as the tool
   result.
2. Calls the registrar with `{ force: true }`, which skips the stored
   registration and always sends the POST. The stored result is replaced
   with the new one.

The body of the `/register-for-diff-review-send` command file doesn't
change, so its marker version stays at v1.

## Testing

Vitest, with fakes for the dependencies, next to the source files.

- `mcp-target.test.ts` (resolver):
  - the first connection matches `resolvePort` for the flag, cwd match,
    only live window, old port file, and error cases;
  - a re-scan after a cwd match holds when only another window is running,
    and when discovery is ambiguous or finds nothing;
  - a re-scan accepts a new port with the same root and fires
    `onTargetChanged`;
  - a re-scan after an only-live-window connection follows normal
    discovery;
  - `reconnect()` ignores the hold and replaces the saved root;
  - `--port` never changes target.
- Retry on failure: connection refused retries once on a new port; a reset or
  timeout is not retried but marks the target stale; a 409 marks the target
  stale; there is never a second retry.
- Heartbeat, with an injected clock or tick function: a healthy ping does
  nothing; a failed ping re-scans; a ping answered by a window without the
  saved root counts as dead; overlapping ticks are skipped.
- `mcp-session-registration.test.ts`: `replayAll` re-sends each stored
  payload; a failed replay stays saved; `clear` removes a session from the
  replay set; `force` skips the stored registration.
- `awaitReview`: the generation resets to 0 on a target change.

Run `npm run check`. `mcp-server.ts` is a runtime entry point, so also run
`npm run build`.

## Rollout

No migration. Existing MCP processes keep the old behaviour until they
restart. Component auto-update refreshes installed registrations as usual.
Add a TODO entry that points here, and move it to DONE when the work lands.
