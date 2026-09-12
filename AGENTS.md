# Architecture guide

Keep review behavior in small, source-tested modules. `extension.ts` constructs
the VS Code application and adapts commands, comment views, IPC, and language
model tools. It must not grow new copies of a review mutation.

## Review operations

`src/review/service.ts` owns create, reply, edit, resolve, reopen, delete, and
location-transition operations. Adapters validate their external request shape,
call the service, and translate its result into UI, HTTP, or LM-tool output.
Put each new review mutation behind this service and cover it with a Vitest
test that uses a small store fake.

The service stays independent of VS Code, MCP, HTTP, filesystem, and process
globals. Give it the smallest effect interface it needs. Keep view concerns
such as logging and response presentation in the adapter.

## Storage and scopes

Persisted data is validated by `src/storage/schema.ts`; only a missing file is
treated as empty storage. Use `ScopeRepository` for storage access so a complete
read/merge/write transaction stays under its per-scope lock. Do not bypass the
repository with direct filesystem writes.

Thread IDs are public handles, while comments within a thread have separate
IDs. Treat an unknown or ambiguous handle as an error; never choose an
arbitrary thread.

`src/review/thread-index.ts` owns a window's public-handle allocation,
persisted-ID mapping, and thread metadata. Keep those facts out of VS Code
`contextValue`, labels, and ad-hoc maps. The `src/adapters/vscode/` modules own
comment views, ranges, and presentation; they do not define review behavior.

## Verification

Run `npm run check` after source changes. Run `npm run build` when changing
runtime entry points and `npm run package` when changing bundling, runtime
dependencies, or extension packaging. Tests import TypeScript source directly;
do not add generated `out/` imports or per-test build entries.
