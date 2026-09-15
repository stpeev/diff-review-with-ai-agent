# Maintainability and correctness specification

Status: implemented incrementally. Originally based on repository commit `52a1aca`, inspected on 2026-09-12.

## Implementation record

The repository now uses Vite library builds for the extension, MCP server, and
standalone launcher; Vitest runs TypeScript tests directly from source; and
TypeScript, formatting, ESLint boundaries, coverage, integration, package, and
extension-host commands are part of the documented workflow. Node 24 is the
minimum development, packaging, MCP, and launcher runtime. Review mutations
are delegated through `ReviewService`, persisted identities and locations are
explicit, workspace transitions and saves are serialized, and scope storage is
validated, migrated, locked, and exercised by real multi-process tests.

The extension remains the composition root for VS Code lifecycle effects. Its
review presentation, action menus, persisted-thread hydration/materialization,
Git lookup, scope watching, and workspace classification have been separated
into source-tested review, workspace, storage, and adapter modules. ESLint
prevents review and core modules from depending on adapters or runtime entry
points.

`npm run check`, `npm run test:integration`, `npm run test:coverage`, `npm run
build`, and `npm run package` pass locally. The local macOS VS Code 1.95 host
runner records the extension test as passing, then its Electron utility process
aborts after the renderer closes; Linux CI runs the same host suite under
`xvfb-run`.

## Outcome

Make review behavior understandable, independently testable, and safe to change. A maintainer should be able to implement a review operation in one place, test it without VS Code, and trust that editor commands, language-model tools, and MCP requests all execute that same behavior.

Adopt **Vite for production bundling, Vitest for source-level TypeScript tests, and TypeScript for explicit type checking**. Extract the application out of `extension.ts` incrementally. Keep one npm package and the three existing runtime entry points. A framework, monorepo, dependency-injection container, or wholesale rewrite is unnecessary.

Success means fewer places to reason about, explicit ownership of mutable state and asynchronous work, and tests that exercise operational failure modes. Smaller files are a consequence, not the primary objective.

## Evidence and priorities

| Observation                                                                                                                                                                                                 | Consequence                                                                                                                                                           | Priority |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `src/extension.ts` is 2,999 lines; the complete `src/` tree is roughly 5,500 lines. It contains comment state, storage, Git lifecycle, HTTP routing, agent delivery, commands, UI, and prompt construction. | Most coordination behavior cannot be tested without importing the extension and its global state.                                                                     | P0       |
| `threadMap` holds `vscode.CommentThread` objects; status is recovered from UI `contextValue`, while other state lives in weak maps.                                                                         | UI representation acts as the application model; correctness depends on keeping several representations synchronized.                                                 | P0       |
| IPC handlers, command handlers, and LM tool classes independently mutate threads, refresh presentation, and schedule persistence.                                                                           | Equivalent operations can diverge in validation, durability, and side effects.                                                                                        | P0       |
| `flushFolderSaveNow` logs and consumes a save rejection; `switchFolderBranch` then disposes the old threads.                                                                                                | A branch transition can discard unsaved in-memory changes. This is a code-path finding, not a reproduced data-loss incident.                                          | P0       |
| `readScopeFileOrEmpty` returns an empty scope after malformed JSON and other read errors.                                                                                                                   | A later save can replace unreadable existing data with an empty or incomplete state.                                                                                  | P0       |
| Persisted IDs are scoped to branches/files, but loaded threads share a window-wide map keyed only by number. The merge also matches threads by number.                                                      | Independent scopes or writers can collide; counter maxima alone do not establish globally unique identity.                                                            | P0       |
| Storage uses revision checks, last-write-wins thread merging, and atomic rename. There is no cross-process transaction around read/merge/write.                                                             | Atomic replacement prevents partial-file visibility, but does not prevent concurrent lost updates. Deletion resurrection is already documented in `comment-store.ts`. | P0       |
| `esbuild.config.js` enumerates three production bundles and 14 standalone test bundles; JavaScript tests import `out/test/*`.                                                                               | Adding testable source requires maintaining a second build graph. Tests are separated from source types and production packaging.                                     | P1       |
| `compile` emits TypeScript output into the same `out/` used by bundling. `package` invokes unpinned `npx vsce` without a build prerequisite.                                                                | Output can depend on previous commands; packaging can use stale artifacts.                                                                                            | P1       |
| `mcp-server.ts` combines discovery, transport, session registration, tool definitions, and automatic startup.                                                                                               | Importing it is unsuitable for isolated tests; process lifecycle is difficult to exercise directly.                                                                   | P1       |

Baseline: `npm test` ran 160 tests: 158 passed and two failed in `test/review-policy.test.js`. Both expect “Work each open thread” where the source now emits “Inspect each open thread”. Reconcile the intended wording before migration; do not silently drop those assertions. `tsc --noEmit -p tsconfig.json` failed with 29 diagnostics: 27 related to optional comment ranges in `extension.ts` and two excessively deep type instantiations in MCP tool registration. The current build/test scripts do not enforce this type check. Resolve these with explicit location handling and compatible, bounded SDK/schema types rather than blanket assertions or suppression. No extension-host or packaged-install verification was performed for this specification.

Preserve the useful existing extractions, including review policy, path resolution, scope identity, agent registry, and delivery helpers. Move and refine them according to ownership; do not rewrite working behavior merely to make the tree uniform.

## Target architecture

The extension is the authority for review state. MCP remains a client of its application API over IPC; it does not become a second writer to comment storage.

```text
src/
  extension.ts                 # Construct, start, and dispose the application
  mcp-server.ts                # Construct and start MCP over stdio
  mcp-launcher.ts              # Resolve and load the installed MCP bundle
  review/
    model.ts                   # Thread, comment, location, scoped identity
    operations.ts              # Create/reply/edit/resolve/delete/reattach rules
    service.ts                 # Execute operations and coordinate effects
    anchors.ts                 # Anchor calculation and location recovery
    prompt.ts                  # Review prompt rendering from plain data
    policy.ts                  # Shared agent instructions
  workspace/
    scope.ts                   # Scope classification and identity rules
    coordinator.ts             # Discovery, folder and branch transitions
  storage/
    schema.ts                  # Validation and version migrations
    repository.ts              # Load, commit, concurrency, recovery semantics
    save-queue.ts              # Debouncing, retries, flush and shutdown
  agents/
    registry.ts                # Sessions and binding rules
    delivery.ts                # Delivery outcomes and fallback policy
    providers/                 # Claude and Codex-specific integration
  protocol/
    contracts.ts               # IPC schemas, DTOs and error codes
    client.ts                  # Discovery, requests, timeout and cancellation
    server.ts                  # HTTP lifecycle and routing to services
  adapters/
    vscode/                    # Comments, commands, panels, LM tools, Git API
    mcp/                       # Tool registration and session context
    setup/                     # Consumer config, slash commands, launcher install
  platform/                    # Concrete filesystem/process/clock utilities
```

These are responsibility boundaries, not a requirement to create every file immediately. Keep small, cohesive modules together until separation helps.

Dependency rules:

1. The review model and operations use plain TypeScript data and have no dependency on VS Code, MCP, sockets, filesystem access, or process globals.
2. Application services depend on narrow interfaces for effects they actually need: review storage, workspace lookup, delivery, clock, and identifiers. Construct dependencies explicitly; do not use a global service locator.
3. Adapters translate external inputs, call services, and render results. They contain no independent review mutation rules.
4. Entry points own startup and teardown. Importing a reusable module must not open sockets, register tools, read user configuration, or start a process.
5. Use direct imports and enforce boundary restrictions with ESLint. Avoid circular dependencies and a catch-all `utils.ts`.

VS Code comment objects become disposable views of domain state. Editing mode, labels, and collapsed state belong to the view; persisted status and anchor/location state belong to the model. Views never determine domain status by parsing a label or `contextValue`.

## Operational contracts

**One mutation path.** All entry points invoke the same create, reply, edit, resolve, reopen, delete, and reattach operations. Each operation performs validation, changes state, records persistence work, and emits a defined update for views. Use typed results such as not-found, invalid-location, workspace-mismatch, storage-unavailable, and delivery-failed. Translate those into HTTP, MCP, or UI responses at the boundary.

**Identity is explicit.** Introduce a typed internal reference containing scope, branch, and thread identity. Separate thread IDs from individual comment IDs; existing LM parameters named `commentId` sometimes refer to a thread. Preserve existing external names during extraction with explicit translation. A later versioned migration should introduce collision-resistant persisted identities and an unambiguous compatibility mapping for numeric public handles. Ambiguous legacy references must fail clearly rather than select an arbitrary thread.

**Location states are explicit.** Model anchored, drifted, and file-note locations as distinct variants. Define valid transitions and persist them. A drifted location must never silently become an actionable line; file-note intent and multi-line ranges must survive a save/reload cycle. Convert one-based external lines to zero-based internal lines exactly once.

**Workspace transitions are serialized.** A coordinator owns each folder's classification, current branch, generation, subscriptions, and pending work. A branch/scope change flushes the old state successfully before replacing it. Failed saves retain the old state and surface the failure. Rapid transitions and stale asynchronous completions cannot write into a newer scope. Folder additions/removals update IPC workspace checks and descriptors as well as the review model. Preserve current new-branch inheritance behavior until a separate product decision changes it.

**Persistence has a defined concurrency boundary.** Extract the existing implementation first, with characterization tests. Then introduce an inter-process per-scope lock covering the complete read/validate/apply/write transaction, including ID allocation where required. Specify timeout, stale-owner recovery, and crash behavior before choosing the lock implementation. Do not assume an in-process promise chain protects two extension windows.

Use operation-aware reconciliation: concurrent independent replies must survive, deletions need tombstones, and incompatible edits require a deterministic policy that retains recoverable conflicting content. Revision checking and atomic rename remain useful inside this protocol. Test two real writer processes before claiming multi-window durability. A database conversion is outside the initial scope.

**Unreadable data is not missing data.** Validate complete persisted records and schema versions. Only a missing file permits empty initialization. Corruption or an unsupported version blocks replacement and exposes recovery information. Back up original data before migrations, make migrations repeatable, and document whether older versions can read the new format. Do not combine the first structural extraction with a schema change.

**Save status is observable.** The queue tracks dirty, saving, saved, and failed state. Define bounded retry behavior and expose unsaved failures without relying on repeated user actions. Shutdown stops new work, cancels waiters, drains pending writes, closes transports, removes owned descriptors, and disposes watchers. A bounded shutdown timeout must report unresolved persistence; it must not be described as successful saving.

**Delivery distinguishes acceptance from completion.** A message accepted by a socket or queue is not proof that an agent addressed the review. Keep delivery, fallback, review notification, and thread resolution separate. Treat a timeout after a possible send as an uncertain result; avoid automatic duplicate delivery unless the transport supplies an idempotency contract.

**External boundaries are validated.** Reuse runtime schemas for IPC requests/responses and derive types where practical. Validate IDs, text, ranges, workspace ownership, and session context consistently. Centralize request limits, timeouts, cancellation, and error mapping. Remove abandoned long-poll waiters on disconnect. Diagnostics identify operation and scope without exposing credentials; MCP stdout remains transport-only.

## Build and test system

The unusual part of the current esbuild usage is the separate bundle for every tested module. Esbuild itself does not prevent good unit tests; VS Code documents it as a supported bundling option. The architectural separation is required whichever bundler is used. [VS Code bundling guidance](https://code.visualstudio.com/api/working-with-extensions/bundling-extension)

Choose Vite library builds for the production entry points and Vitest for the test workflow. Vite supports explicit library entries and CommonJS output; this project needs Node-oriented configuration rather than browser defaults. Vitest can run source imports and use a dedicated test configuration. [Vite library mode](https://vite.dev/guide/build#library-mode), [Vitest setup](https://vitest.dev/guide/)

Alternatives considered: retaining esbuild plus Vitest would solve the immediate test-build duplication with less migration risk; webpack plus a separate runner would also work but adds configuration without a demonstrated requirement here. Vite is the proposed destination for a conventional build/watch/test toolchain. Validate its three output contracts before removing the current build.

Build requirements:

- Preserve `out/extension.js`, `out/mcp-server.js`, and `out/mcp-launcher.js` as CommonJS artifacts during migration. Changing the package to ESM is unnecessary.
- Build each runtime as a self-contained bundle. In particular, the launcher is copied alone into `~/.diff-review`; it must not reference generated sibling chunks. Avoid shared chunks between entries for this migration.
- Externalize Node built-ins and externalize `vscode` for the extension. Bundle required npm runtime dependencies because VSIX packaging uses `--no-dependencies`.
- Preserve the effective `jsonc-parser` module-resolution behavior called out in the existing configuration. Verify the packaged registration path without repository `node_modules` available.
- Clean generated output once before production builds; individual builds must not erase other outputs. Stop TypeScript from emitting competing files into `out/`.
- Pin a compatible stable Vite/Vitest/tooling set and document the development Node version. Build-tool Node requirements and shipped runtime compatibility are separate decisions. Node 24 is the supported MCP/launcher runtime; verify dependencies under that runtime. A syntax target alone is not compatibility proof.
- Pin `@vscode/vsce` locally. Packaging must build from source through an explicit prerequisite or `vscode:prepublish`, fail on errors, and exclude tests, fixtures, and development output. Update debug, sandbox, and deployment scripts together.

Developer command contract:

| Command                                 | Required behavior                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                     | Check source, tests, and configuration with no emitted output.                                                       |
| `npm test`                              | Run discovered TypeScript unit and service tests directly from source, once; no production build or editor required. |
| `npm run test:watch`                    | Watch/filter tests during development.                                                                               |
| `npm run test:integration`              | Exercise filesystem, IPC, process, and provider adapters in isolated temporary environments.                         |
| `npm run test:extension`                | Run a small real VS Code extension-host suite.                                                                       |
| `npm run test:coverage`                 | Report source coverage, including untested modules, with agreed ratcheting thresholds.                               |
| `npm run lint` / `npm run format:check` | Enforce boundaries, promise handling, and consistent formatting.                                                     |
| `npm run build` / `npm run watch`       | Build/watch the three production artifacts.                                                                          |
| `npm run check`                         | Run the fast CI gate: formatting, lint, types, and unit/service tests.                                               |
| `npm run package`                       | Produce a fresh VSIX reproducibly. Release CI also runs integration, host, and packaged smoke checks.                |

Port the existing assertions to `.test.ts` imports from source. Convert runner APIs and cleanup hooks deliberately; do not merely rename files. Use strict types for test fixtures and fakes. Use fake clocks for debounce/retry tests, real temporary files for storage behavior, and real loopback sockets or child processes for transport contracts. Avoid a giant mock of the entire VS Code API.

The extension-host suite should use the official VS Code test tooling to cover behavior that source tests cannot prove: activation, actual comment objects and commands, workspace changes, and disposal. Keep packaging smoke tests separate because a development host can hide missing bundled dependencies. [VS Code testing guidance](https://code.visualstudio.com/api/working-with-extensions/testing-extension)

## Migration sequence and acceptance gates

| Stage                             | Work                                                                                                                                                           | Gate before proceeding                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 0. Establish baseline             | Reconcile the two failing tests and 29 type diagnostics; inventory command/tool schemas, persisted fixtures, and bundle contents; document supported runtimes. | Baseline checks pass reproducibly and known behavior/defects are recorded.                                             |
| 1. Replace test workflow          | Add Vitest, source TypeScript tests, explicit type checks, ESLint and formatting. Keep production build temporarily.                                           | All existing behavior assertions run from source; no test imports `out/`; adding a test requires no build-target edit. |
| 2. Replace production build       | Prove Vite output contracts, migrate scripts, pin packaging tools, remove standalone targets and obsolete config.                                              | All three bundles and a clean packaged install pass smoke checks; the copied launcher works independently.             |
| 3. Extract one vertical operation | Introduce plain review state and route reply through the service from commands, IPC, and LM tools.                                                             | Equivalent inputs produce equivalent state and persistence effects; adapter tests prove delegation.                    |
| 4. Complete ownership extraction  | Route remaining operations through services; extract workspace coordinator, save queue, transport, and lifecycle.                                              | No business mutations remain in adapters; transition/shutdown failure tests pass.                                      |
| 5. Harden persistence             | Add scoped identity, versioned migration, corruption handling, transaction locking, and conflict/delete semantics as separately reviewable changes.            | Legacy fixtures migrate safely; two-process races, failures, and recovery tests pass.                                  |
| 6. Enforce maintenance rules      | Add CI gates and a concise architecture guide/AGENTS.md; update README and TODO to the actual workflow.                                                        | Clean checkout can check, build, test and package with documented commands; boundary violations fail CI.               |

Keep each change releasable. Preserve wire schemas, storage paths, branch inheritance, and installation behavior through structural stages. Isolate deliberate behavior/schema changes with migration and rollback notes. Do not restore old code against a new storage version unless compatibility has been demonstrated.

Required correctness scenarios include failed save during branch switch; rapid A→B→C changes; delayed Git discovery with new comments; duplicate numeric IDs across roots; simultaneous creates/replies/deletes from two writers; malformed and future-version storage; drift/file-note/range reloads; live workspace membership changes; IPC mismatch and cancellation; ambiguous delivery outcomes; shutdown with pending work; and launcher execution away from the extension directory.

The refactor is complete when `extension.ts` only wires lifecycle and adapters, every review mutation has one implementation, tests import source without build registration, persistence guarantees are verified under real concurrency, and a packaged install passes the same essential user workflows. Use file size and coverage as review signals; neither substitutes for these behavior gates.
