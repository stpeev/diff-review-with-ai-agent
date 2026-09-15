import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { LAUNCHER_FILE } from './mcp-resolve';
import { McpConsumerTarget, discoverConsumers, register, renderSnippet, snippetDestination } from './mcp-consumers';
import {
  SlashCommandTarget,
  CommandId,
  discoverSlashCommands,
  renderClipboard,
  install,
  INVOCATION,
} from './slash-commands';
import { isAncestor, resolveExistingWorkspacePath } from './path-util';
import { LM_TOOLS, MCP_TOOLS, PolicyTools } from './review-policy';
import { gitScopeFor } from './git-scope';
import * as ipcDiscovery from './ipc-discovery';
import { sweepStaleDescriptors } from './ipc-descriptor-cleanup';
import { writeIpcDescriptor } from './ipc-descriptor-writer';
import * as scopeIdMod from './scope-id';
import { ReviewThreadIndex } from './review/thread-index';
import { anchoredLocation, type ReviewThreadMetadata } from './review/model';
import { hydrateThreadLocation } from './review/thread-hydration';
import { renderReviewPrompt } from './review/prompt';
import { AgentRegistry, AgentSession, claudePidFromSocketPath } from './agent-registry';
import { deliverToSession } from './agent-deliver';
import { deliverReviewOrFallback } from './agents/review-delivery';
import { verifyClaudeSessionIdentity } from './agent-session-verification';
import { ReviewService } from './review/service';
import { createLogger } from './logging';
import { ScopeRepository } from './storage/repository';
import { SaveQueue } from './storage/save-queue';
import { commitBranchState } from './storage/branch-commit';
import { afterSaveFailure } from './storage/save-failure-policy';
import { writeScopeMeta } from './storage/scope-meta';
import { migrateLegacyWorkspaceState, type LegacyWorkspaceState } from './storage/legacy-workspace-migration';
import { readRequestBody } from './protocol/body';
import { ReviewWaiters } from './protocol/review-waiters';
import { startLoopbackHttpServer } from './protocol/server';
import { pingIpcEndpoint } from './protocol/ping';
import {
  Role,
  ThreadStatus,
  SerializedComment,
  SerializedThread,
  BranchState,
  ScopeFile,
  serializeComments,
} from './comment-store';
import { restoreAnchorLine } from './review/anchor-restoration';
import { commentPreview, statusBarPresentation } from './review/presentation';
import { reviewPanelTitle } from './review/panel-summary';
import { commentPanelItems, type CommentPanelAction } from './review/comment-panel-presentation';
import { runScopeTransition, TransitionGeneration } from './workspace/coordinator';
import { branchLoadPlan, branchStateFromSnapshots } from './workspace/branch-state';
import { classifyWorkspaceFolder } from './workspace/folder-classifier';
import { createVsCodeReviewThreadStore } from './adapters/vscode/review-thread-store';
import { ReviewComment } from './adapters/vscode/review-comment';
import { presentReviewThread } from './adapters/vscode/review-thread-presentation';
import { requireThreadRange } from './adapters/vscode/thread-location';
import { getFileDiffHunks } from './adapters/vscode/git-diff';
import type { GitApi, GitRepository } from './adapters/vscode/git-api';
import { renamedPathFor } from './adapters/vscode/git-rename';
import { createCommentThreadAt as createVsCodeCommentThreadAt } from './adapters/vscode/comment-thread-creation';
import { buildPromptThreads } from './adapters/vscode/review-prompt-builder';
import { anchorForFileLine } from './adapters/vscode/file-anchor';
import { registerLineTracking } from './adapters/vscode/line-tracker';
import { registerReviewStateCommands } from './adapters/vscode/review-state-commands';
import { registerCommentEditCommands } from './adapters/vscode/comment-edit-commands';
import { registerReviewDeletionCommands } from './adapters/vscode/review-deletion-commands';
import { registerCommentCreationCommands } from './adapters/vscode/comment-creation-commands';
import { registerReviewBatchCommands } from './adapters/vscode/review-batch-commands';
import { registerDriftedLocationCommand } from './adapters/vscode/drifted-location-command';
import { executeReviewAction, type ReviewAction } from './adapters/vscode/review-action-handler';
import { commentActionMenu, driftedActionMenu } from './adapters/vscode/comment-action-presentation';
import { watchScopeFile } from './adapters/vscode/scope-file-watcher';
import { materializeStoredThread } from './adapters/vscode/stored-thread-materializer';
import {
  applyDriftedThreadAction,
  markDriftedThread,
  reattachDriftedThread,
  type DriftedThreadActionDeps,
} from './adapters/vscode/drifted-thread-actions';
import { registerReviewLanguageModelTools } from './adapters/vscode/review-language-model-tools';
import { registerReviewLanguageModelQueryTools } from './adapters/vscode/review-language-model-query-tools';
import { registerReviewPromptCommands } from './adapters/vscode/review-prompt-commands';
import { selectAgentSession as selectAgentSessionAdapter } from './adapters/vscode/agent-session-selection';
import { collectMcpInfo } from './adapters/vscode/mcp-info';
import { createIpcRequestHandler } from './adapters/vscode/ipc-request-handler';
import {
  deployMcpLauncher as deployMcpLauncherRuntime,
  deployStoragePathPointer as deployStoragePathPointerRuntime,
} from './adapters/setup/mcp-runtime';
import {
  consumerStatusNote,
  copyConsumerSnippet,
  registerMcpConsumer,
  type McpConsumerRegistrationDeps,
} from './adapters/setup/mcp-consumer-registration';
import { installAgentSlashCommands } from './adapters/setup/slash-command-installation';
import { slashCommandRowIcon, slashCommandRowLabel } from './adapters/setup/slash-command-presentation';

// --------------- Comment Model ---------------

let nextCommentId = 1;

function createReviewComment(
  body: string,
  role: Role,
  id?: number,
  stableId: string = crypto.randomUUID(),
  createdAt?: string,
): ReviewComment {
  const assignedId = id ?? nextCommentId++;
  if (assignedId >= nextCommentId) nextCommentId = assignedId + 1;
  return new ReviewComment(body, role, assignedId, stableId, createdAt);
}

/** Give legacy numeric-only records a deterministic identity before their first rewrite. */
function stableThreadId(st: SerializedThread): string {
  if (st.stableId) return st.stableId;
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        st.id,
        st.uri,
        st.startLine,
        st.endLine,
        st.comments.map((comment) => [comment.id, comment.timestamp]),
      ]),
    )
    .digest('hex');
}

/** Give legacy numeric-only comments a deterministic identity before their first rewrite. */
function stableCommentId(comment: SerializedComment): string {
  if (comment.stableId) return comment.stableId;
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([comment.id, comment.role, comment.timestamp, comment.body]))
    .digest('hex');
}

// --------------- Thread Tracking ---------------

const threadIndex = new ReviewThreadIndex<vscode.CommentThread, ReviewThreadMetadata>();

const reviewService = new ReviewService(
  createVsCodeReviewThreadStore({
    find: (threadId) => threadIndex.get(threadId),
    createComment: (text, author) => createReviewComment(text, author),
    commentId: (comment) => (comment as ReviewComment).id,
    isDrifted,
    metadata: (thread) => threadIndex.metadata(thread),
    anchorForLine,
    track: (thread, anchor) => trackThread(thread, undefined, anchor),
    untrack: (threadId) => threadIndex.remove(threadId),
    recordDeletion: recordThreadDeletion,
    present,
    touch: touchThread,
    refresh,
    queueSaveForThread,
    queueSaveForUri,
  }),
);

/**
 * A drifted comment is an ordinary tracked thread — it replies, resolves and
 * serializes like any other — that carries `meta.drift` because the anchor
 * ladder gave up on it. Its line is only where the anchor was *last seen*, so
 * every path that shifts or re-verifies a position must skip it. This is the
 * single check for that; there is no separate map to forget to look in.
 */
function isDrifted(thread: vscode.CommentThread): boolean {
  return threadIndex.metadata(thread)?.location.kind === 'drifted';
}

function statusOfThread(thread: vscode.CommentThread): ThreadStatus {
  return threadIndex.metadata(thread)?.status ?? 'open';
}

/** Threads whose line is still trustworthy — the starting point for shifting, re-verifying and submitting. */
function liveThreads(): vscode.CommentThread[] {
  return [...threadIndex.values()].filter((t) => !isDrifted(t));
}

function driftedEntries(): { id: number; thread: vscode.CommentThread }[] {
  return [...threadIndex.entries()].filter(([, t]) => isDrifted(t)).map(([id, thread]) => ({ id, thread }));
}

/** Open, and at a line we still vouch for — what "submit"/"copy" may put in front of an agent. */
function isOpenLive(thread: vscode.CommentThread): boolean {
  return !isDrifted(thread) && statusOfThread(thread) === 'open';
}

function driftedCount(): number {
  return [...threadIndex.values()].filter(isDrifted).length;
}

/**
 * The only place a thread's label, contextValue, state and collapsed-ness are
 * set. Everything else changes the underlying facts — status, `meta.drift`,
 * `meta.fileNote` — and calls this, so the view remains derived from domain
 * state rather than becoming the source of truth.
 */
function present(thread: vscode.CommentThread, status?: ThreadStatus) {
  const range = requireThreadRange(thread);
  const meta = threadIndex.metadata(thread) ?? {
    status: 'open' as const,
    location: anchoredLocation(range.start.line, range.end.line),
    updatedAt: new Date().toISOString(),
  };
  if (!threadIndex.metadata(thread)) threadIndex.setMetadata(thread, meta);
  presentReviewThread(thread, meta, status);
}

/** Build the thread for a stored comment, drifted or not, and track it. */
function materializeThread(
  st: SerializedThread,
  startLine: number,
  endLine: number,
  drifted: boolean,
  anchor?: { anchorHash?: string; anchorContext?: string },
): vscode.CommentThread {
  return materializeStoredThread(
    st,
    { startLine, endLine, drifted, ...anchor },
    {
      parseUri: vscode.Uri.parse,
      createThread: (uri, start, end) =>
        activeController!.createCommentThread(uri, new vscode.Range(start, 0, end, 0), []),
      createComment: createReviewComment,
      setComments: (thread, comments) => {
        thread.comments = comments;
      },
      setCanReply: (thread, canReply) => {
        thread.canReply = canReply;
      },
      stableCommentId,
      stableThreadId,
      track: trackThread,
      present,
      now: () => new Date().toISOString(),
    },
  );
}

function trackThread(
  thread: vscode.CommentThread,
  id?: number,
  meta?: Partial<ReviewThreadMetadata>,
  stableId: string = crypto.randomUUID(),
): number {
  const range = requireThreadRange(thread);
  const publicId = threadIndex.track(
    thread,
    {
      status: 'open',
      location: anchoredLocation(range.start.line, range.end.line),
      updatedAt: new Date().toISOString(),
      ...meta,
    },
    id,
    stableId,
  );
  return publicId;
}

function recordThreadDeletion(thread: vscode.CommentThread, publicId: number): void {
  const folder = ownerFolderForUri(thread.uri);
  if (!folder) return;
  const storedId = threadIndex.storageId(thread) ?? publicId;
  folder.deletedThreads.set(storedId, new Date().toISOString());
}

function touchThread(thread: vscode.CommentThread) {
  const now = new Date().toISOString();
  const meta = threadIndex.metadata(thread);
  if (meta) meta.updatedAt = now;
  else {
    const range = requireThreadRange(thread);
    threadIndex.setMetadata(thread, {
      status: 'open',
      location: anchoredLocation(range.start.line, range.end.line),
      updatedAt: now,
    });
  }
}

function findThreadForComment(comment: ReviewComment): vscode.CommentThread | undefined {
  for (const thread of threadIndex.values()) {
    if (thread.comments.includes(comment)) {
      return thread;
    }
  }
  return undefined;
}

// --------------- Helpers ---------------

function getThreadsByFile(): Map<string, { id: number; thread: vscode.CommentThread }[]> {
  const byFile = new Map<string, { id: number; thread: vscode.CommentThread }[]>();
  for (const [id, thread] of threadIndex.entries()) {
    const rel = vscode.workspace.asRelativePath(thread.uri);
    if (!byFile.has(rel)) byFile.set(rel, []);
    byFile.get(rel)!.push({ id, thread });
  }
  return byFile;
}

// --------------- Status Bar ---------------

let statusBar: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;
let activeController: vscode.CommentController | undefined;
let outputLog: vscode.OutputChannel;

/** Every output-channel line goes through this logger. */
const log = createLogger({
  write: (line) => outputLog.appendLine(line),
  prefix: 'Diff Review',
});

function refresh() {
  const n = threadIndex.size;
  const open = [...threadIndex.values()].filter((t) => statusOfThread(t) === 'open').length;
  const drifted = driftedCount();
  const presentation = statusBarPresentation(n, open, drifted, noWorkspaceWarned);
  if (presentation.visible) {
    statusBar.text = presentation.text!;
    statusBar.tooltip = presentation.tooltip!;
    statusBar.show();
  } else {
    statusBar.hide();
  }
}

// --------------- Scope & Folder State Machine (F2 + F3) ---------------

type FolderGitState = 'git' | 'pending' | 'plain';

interface FolderInfo {
  /** The workspace folder path this describes (as VS Code reports it). */
  folderPath: string;
  /** Symlink-resolved form of `folderPath`, used for scope hashing and ancestor checks. */
  realPath: string;
  state: FolderGitState;
  /** Set once resolved: `remote:...` / `repo:...` (git) or `folder:...` (plain). */
  scopeId?: string;
  /** Branch name, `_detached.<sha>`, or `_default` for scopes with no branch concept. */
  branchKey?: string;
  /** Absolute path to this scope's comments.json, once scopeId is known. */
  filePath?: string;
  pendingSince?: number;
  needsFlushOnSettle?: boolean;
  lastKnownFile?: ScopeFile;
  lastLoadedRevision: number;
  consecutiveSaveFailures: number;
  /** Deletions in the active branch, retained for concurrent-writer reconciliation. */
  deletedThreads: Map<number, string>;
  /** The most recent unsaved persistence error, cleared only by a successful save. */
  lastSaveError?: string;
  suppressWatcherUntil?: number;
  watcher?: vscode.Disposable;
  /** The matching `vscode.git` repository, once found. */
  repo?: GitRepository;
  /** In-flight `classifyFolder` run, so a repo opening mid-classification joins it instead of starting a second one. */
  classifying?: Promise<void>;
  /** Invalidates delayed Git discovery and superseded branch/scope transitions. */
  transitions: TransitionGeneration;
}

const PENDING_TIMEOUT_MS = 10_000;
const LINE_TRACKING_DEBOUNCE_MS = 500;
const MAX_AUTOMATIC_SAVE_RETRIES = 2;
const MAX_IPC_BODY_BYTES = 1_000_000;
const SHUTDOWN_SAVE_TIMEOUT_MS = 5_000;

let folders: FolderInfo[] = [];
/** True once we have logged that this window has files with nowhere to persist to. */
let noWorkspaceWarned = false;
/** URIs already named in the "outside any workspace folder" log line, so each file is reported once. */
const transientWarnedUris = new Set<string>();
const writerId = crypto.randomUUID();
let isShuttingDown = false;
const scopeRepository = new ScopeRepository();
const saveQueue = new SaveQueue<FolderInfo>();

function getGitApi(): GitApi | undefined {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension) return undefined;
  if (gitExtension.isActive) return gitExtension.exports.getAPI(1) as GitApi;
  return undefined;
}

async function activateGitApi(): Promise<GitApi | undefined> {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension) return undefined;
  try {
    const exports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
    return exports.getAPI(1) as GitApi;
  } catch {
    return undefined;
  }
}

function hasDotGitAbove(startDir: string): boolean {
  let dir = path.resolve(startDir);
  for (;;) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return true;
    } catch {
      // ignore and keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function scopeDirFor(scopeId: string): string {
  return path.join(globalStorageRoot(), 'scopes', scopeIdMod.scopeDirName(scopeId));
}

function globalStorageRoot(): string {
  return extensionContext.globalStorageUri.fsPath;
}

/**
 * Classify one workspace folder and, for git repos, resolve the scope id.
 * Filesystem existence of `.git` is checked synchronously and independently
 * of `vscode.git` — it only decides whether waiting for the extension is
 * worthwhile, never the scope id itself, so a hand-rolled walk can never
 * disagree with the extension about where a repo's root actually is.
 */
function classifyFolder(folder: FolderInfo): Promise<void> {
  // A repo can open while this folder is still in its `pending` poll loop,
  // and the `onDidOpenRepository` handler would then start a second
  // classification of the same folder. Both would settle it, loading every
  // persisted thread twice and leaving the first copy orphaned in the
  // gutter. Join the run already in flight instead.
  if (folder.classifying) return folder.classifying;
  const generation = folder.transitions.begin();
  const run = classifyFolderInner(folder, generation).finally(() => {
    if (folder.classifying === run) folder.classifying = undefined;
  });
  folder.classifying = run;
  return run;
}

async function classifyFolderInner(folder: FolderInfo, generation: number): Promise<void> {
  const realPath = folder.realPath;
  if (!folder.transitions.isCurrent(generation)) return;
  const hadGitMarker = hasDotGitAbove(realPath);
  if (hadGitMarker) {
    folder.state = 'pending';
    folder.pendingSince = Date.now();
  }
  const classification = await classifyWorkspaceFolder({
    isCurrent: () => folder.transitions.isCurrent(generation),
    hasDotGit: () => hadGitMarker,
    plainScopeId: () => scopeIdMod.scopeIdForFolder(realPath),
    resolveGit: () => resolveGitScope(folder, generation),
    now: Date.now,
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    pendingTimeoutMs: PENDING_TIMEOUT_MS,
    pollIntervalMs: 500,
  });
  if (!classification || !folder.transitions.isCurrent(generation)) return;

  folder.state = classification.state;
  folder.scopeId = classification.scopeId;
  folder.branchKey = classification.branchKey;
  if (classification.state === 'git') {
    const previousRepo = folder.repo;
    folder.repo = classification.repository;
    log(`${folder.folderPath}: git — scope ${folder.scopeId}, branch ${folder.branchKey}`);
    if (previousRepo !== folder.repo) registerRepoWatcher(folder, folder.repo);
  } else if (hadGitMarker) {
    log(`${folder.folderPath}: git extension never reported this repo — degrading to plain`);
  } else {
    log(`${folder.folderPath}: plain (no .git found)`);
  }
  settleFolder(folder);
}

/** Resolve a folder through the VS Code Git adapter after it has populated repository state. */
async function resolveGitScope(
  folder: FolderInfo,
  generation: number,
): Promise<{ scopeId: string; branchKey: string; repository: GitRepository } | undefined> {
  const git = await activateGitApi();
  if (!folder.transitions.isCurrent(generation)) return undefined;
  if (!git) return undefined;
  const repo = git.repositories.find((candidate) =>
    isAncestor(realpathOrSelf(candidate.rootUri.fsPath), folder.realPath),
  );
  if (!repo) return undefined;

  // The repo object exists well before its first status refresh fills
  // `state` in. Resolving from that empty state would key this folder to a
  // `repo:` scope on `_detached.unknown` — the wrong comments.json — so
  // stay pending and let the caller's poll loop ask again.
  const repoRealPath = realpathOrSelf(repo.rootUri.fsPath);
  const scope = gitScopeFor(repo.state, repoRealPath);
  if (!scope) return undefined;
  return { ...scope, repository: repo };
}

function registerRepoWatcher(folder: FolderInfo, repo: GitRepository) {
  repo.state.onDidChange(() => {
    const scope = gitScopeFor(repo.state, realpathOrSelf(repo.rootUri.fsPath));
    if (!scope) return;
    // A remote can appear after we settled (a slow refresh, or `git remote
    // add`), which moves this folder to a different scope file. Re-settle
    // onto it rather than stranding the session on the old one.
    if (scope.scopeId !== folder.scopeId) {
      void switchFolderScope(folder, scope).catch((error) => reportScopeTransitionFailure(folder, error));
      return;
    }
    if (folder.branchKey && scope.branchKey !== folder.branchKey) {
      void switchFolderBranch(folder, scope.branchKey).catch((error) => reportScopeTransitionFailure(folder, error));
    }
  });
}

function reportScopeTransitionFailure(folder: FolderInfo, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  log(`Kept ${folder.folderPath} on its current scope after save failure: ${detail}`);
  void vscode.window.showErrorMessage(
    `Diff Review: could not save comments before changing ${path.basename(folder.folderPath)}. The current review state was kept.`,
  );
}

/** The folder's scope id changed under us (see `registerRepoWatcher`): drop this scope's threads and re-settle onto the new scope file. */
async function switchFolderScope(folder: FolderInfo, scope: { scopeId: string; branchKey: string }) {
  log(`${folder.folderPath}: scope ${folder.scopeId} → ${scope.scopeId}`);
  await runScopeTransition(
    folder.transitions,
    () => flushFolderSaveNow(folder),
    () => {
      disposeFolderThreads(folder);
      folder.scopeId = scope.scopeId;
      folder.branchKey = scope.branchKey;
      settleFolder(folder);
      watchFolderScope(folder);
    },
  );
}

/** Called once a folder's scope/branch is known: sets `filePath`, loads its threads, flushes any deferred save. */
function settleFolder(folder: FolderInfo) {
  const filePath = path.join(scopeDirFor(folder.scopeId!), 'comments.json');
  folder.filePath = filePath;
  log(`${vscode.Uri.file(folder.folderPath).toString()}: storage resolved to ${vscode.Uri.file(filePath).toString()}`);
  migrateLegacyStateIfPresent(folder);
  // Idempotent: a re-settle (scope switch, or a repeat classification)
  // must not stack a second copy of every thread on top of the first.
  disposeFolderThreads(folder);
  loadFolderThreads(folder);
  refresh();
  if (folder.needsFlushOnSettle) {
    folder.needsFlushOnSettle = false;
    scheduleSave(folder);
  }
}

function ownerFolderForUri(uri: vscode.Uri): FolderInfo | undefined {
  if (uri.scheme !== 'file') return undefined;
  // Pending folders are eligible owners too — performScopeSave already
  // defers (needsFlushOnSettle) rather than writing for those, and treating
  // "not settled yet" the same as "truly outside any folder" would wrongly
  // flag an ordinary slow-to-activate repo as unable to persist at all.
  const candidates = folders.map((f) => ({
    scopeId: f.scopeId ?? '__pending__',
    folderRealPath: f.realPath,
    folder: f,
  }));
  const match = scopeIdMod.deepestScopeForFile(candidates, uri.fsPath);
  return match?.folder;
}

function threadsOwnedByFolder(folder: FolderInfo): number[] {
  const owned: number[] = [];
  for (const [id, thread] of threadIndex.entries()) {
    if (ownerFolderForUri(thread.uri) === folder) owned.push(id);
  }
  return owned;
}

/** Drop a folder's threads from memory (its scope, branch or file changed under us). */
function disposeFolderThreads(folder: FolderInfo) {
  for (const id of threadsOwnedByFolder(folder)) {
    threadIndex.get(id)?.dispose();
    threadIndex.remove(id);
  }
}

// --------------- Legacy workspaceState migration ---------------

/** Reproduces the pre-F2/F3 `stateKey()` derivation, for migration only. Safe to delete once no one runs the old build any more. */
function legacyStateKeyFor(folder: FolderInfo): string | undefined {
  if (folder.state === 'git' && folder.repo) {
    const repoName = path.basename(folder.repo.rootUri.fsPath);
    const branch = folder.repo.state?.HEAD?.name || '_detached';
    return `diffReview.state.${repoName}.${branch}`;
  }
  return undefined;
}

function migrateLegacyStateIfPresent(folder: FolderInfo) {
  try {
    const key = legacyStateKeyFor(folder);
    if (!key) return;
    const legacy = extensionContext.workspaceState.get<LegacyWorkspaceState>(key);
    const file = migrateLegacyWorkspaceState(legacy, folder.branchKey!, writerId);
    if (!file) return;
    if (scopeRepository.initializeIfMissing(folder.filePath!, () => file)) {
      log(
        `Migrated ${file.branches[folder.branchKey!]!.threads.length} thread(s) from legacy key ${key} into ${folder.scopeId}`,
      );
    }
  } catch (e: any) {
    log(`Legacy migration skipped for ${folder.folderPath}: ${e.message}`);
  }
}

// --------------- Scope File I/O (F3 + F5) ---------------

function readScopeFileOrEmpty(filePath: string): ScopeFile {
  return scopeRepository.read(filePath, writerId);
}

function writeMeta(folder: FolderInfo, file: ScopeFile) {
  writeScopeMeta(
    { scopeId: folder.scopeId!, folderPath: folder.folderPath, scopeDirectory: scopeDirFor(folder.scopeId!), file },
    scopeRepository,
  );
}

function currentBranchStateFromMemory(folder: FolderInfo): BranchState {
  return branchStateFromSnapshots(
    [...threadsOwnedByFolder(folder)].map((id) => {
      const thread = threadIndex.get(id)!;
      const metadata = threadIndex.metadata(thread);
      return {
        id: threadIndex.storageId(thread) ?? id,
        stableId: threadIndex.stableId(thread),
        uri: thread.uri.toString(),
        status: statusOfThread(thread),
        comments: serializeComments(thread.comments as ReviewComment[]),
        location:
          metadata?.location ??
          anchoredLocation(requireThreadRange(thread).start.line, requireThreadRange(thread).end.line),
        anchorHash: metadata?.anchorHash,
        anchorContext: metadata?.anchorContext,
        updatedAt: metadata?.updatedAt ?? new Date().toISOString(),
      };
    }),
    [...folder.deletedThreads.entries()].map(([id, deletedAt]) => ({ id, deletedAt })),
  );
}

function scheduleSave(folder: FolderInfo, debounceMs = 0) {
  saveQueue.schedule(
    folder,
    () => performScopeSave(folder),
    debounceMs,
    (error) => {
      log(`Save failed for ${folder.folderPath}: ${error instanceof Error ? error.message : String(error)}`);
    },
  );
}

async function performScopeSave(folder: FolderInfo): Promise<void> {
  if (folder.state === 'pending' || !folder.scopeId || !folder.filePath) {
    folder.needsFlushOnSettle = true;
    return;
  }
  try {
    folder.suppressWatcherUntil = Date.now() + 500;
    const merged = await scopeRepository.commit(folder.filePath, writerId, (onDisk) => {
      return commitBranchState({
        onDisk,
        lastKnownFile: folder.lastKnownFile,
        lastLoadedRevision: folder.lastLoadedRevision,
        branchKey: folder.branchKey!,
        branch: currentBranchStateFromMemory(folder),
        writerId,
      });
    });

    writeMeta(folder, merged);

    folder.lastKnownFile = merged;
    folder.lastLoadedRevision = merged.revision;
    folder.consecutiveSaveFailures = 0;
    folder.lastSaveError = undefined;
  } catch (e: any) {
    const failure = afterSaveFailure(folder.consecutiveSaveFailures, e, isShuttingDown, MAX_AUTOMATIC_SAVE_RETRIES);
    folder.consecutiveSaveFailures = failure.consecutiveSaveFailures;
    folder.lastSaveError = failure.lastSaveError;
    log(`Save error for ${folder.folderPath} (attempt ${folder.consecutiveSaveFailures}): ${e.message}`);
    if (failure.showWarning) {
      vscode.window.showErrorMessage(
        `Diff Review: comments in ${path.basename(folder.folderPath)} have failed to save ${folder.consecutiveSaveFailures} times in a row. Recent changes may be lost.`,
      );
    }
    if (failure.retryDelayMs !== undefined) scheduleSave(folder, failure.retryDelayMs);
    throw e;
  }
}

/** Drain every scheduled save at shutdown and report comments that remain unsaved. */
async function flushAllSaves(): Promise<void> {
  let drainFailure: unknown;
  try {
    await saveQueue.flushAll(SHUTDOWN_SAVE_TIMEOUT_MS);
  } catch (error) {
    drainFailure = error;
    log(`Save failed during shutdown: ${error instanceof Error ? error.message : String(error)}`);
  }
  const failedFolders = folders.filter((folder) => folder.lastSaveError);
  if (failedFolders.length > 0) {
    const names = failedFolders.map((folder) => path.basename(folder.folderPath)).join(', ');
    const message = `Diff Review shutdown completed with unsaved comments in: ${names}.`;
    log(message);
    throw new Error(message);
  }
  if (drainFailure) {
    throw new Error(
      `Diff Review shutdown could not confirm persistence: ${drainFailure instanceof Error ? drainFailure.message : String(drainFailure)}`,
    );
  }
}

/** Resolve the folder owning `thread.uri` and schedule its scope file to be saved. Threads outside every known folder are transient by design (F3: "no workspace folder" case). */
function queueSaveForThread(thread: vscode.CommentThread, debounceMs = 0) {
  const folder = ownerFolderForUri(thread.uri);
  if (!folder) {
    warnTransient(thread.uri);
    return;
  }
  scheduleSave(folder, debounceMs);
}

function queueSaveForUri(uri: vscode.Uri, debounceMs = 0) {
  const folder = ownerFolderForUri(uri);
  if (!folder) {
    warnTransient(uri);
    return;
  }
  scheduleSave(folder, debounceMs);
}

function warnTransient(uri: vscode.Uri) {
  noWorkspaceWarned = true;
  const key = uri.toString();
  if (!transientWarnedUris.has(key)) {
    transientWarnedUris.add(key);
    log(`A comment was added on a file outside any open workspace folder — it will not be saved: ${key}`);
  }
  refresh();
}

function persistenceStatus(): { pending: number; failed: string[] } {
  let pending = 0;
  const failed: string[] = [];
  for (const folder of folders) {
    const state = saveQueue.state(folder);
    if (state === 'dirty' || state === 'saving') pending++;
    if (saveQueue.error(folder) !== undefined) failed.push(folder.folderPath);
  }
  return { pending, failed };
}

// --------------- Loading threads for a settled folder ---------------

/** Keeps comment IDs ahead of loaded data; ReviewThreadIndex reserves thread handles while tracking. */
function reserveCommentIds(comments: SerializedComment[]) {
  for (const c of comments) if (c.id >= nextCommentId) nextCommentId = c.id + 1;
}

function instantiateThread(folder: FolderInfo, st: SerializedThread) {
  reserveCommentIds(st.comments);
  const location = hydrateThreadLocation(st, () => verifyOrLocateAnchor(folder, vscode.Uri.parse(st.uri), st));
  materializeThread(st, location.startLine, location.endLine, location.drifted, {
    anchorHash: location.anchorHash,
    anchorContext: location.anchorContext,
  });
}

const ANCHOR_CONTEXT_RADIUS = 2;
const ANCHOR_SEARCH_RADIUS = 50;

/**
 * Drift ladder steps 1-3 (content re-verification) plus step 4 (ask git about
 * a rename) — see the durability spec. Returns the line to use, or the
 * literal string 'drifted' once every avenue is exhausted (step 5).
 */
function verifyOrLocateAnchor(folder: FolderInfo, uri: vscode.Uri, st: SerializedThread): number | 'drifted' {
  return restoreAnchorLine(
    uri.fsPath,
    st.startLine,
    st.anchorHash,
    {
      fileExists: fs.existsSync,
      readTextFile: (filePath) => fs.readFileSync(filePath, 'utf-8'),
      renamedPath: (filePath) => findRenameTarget(folder, vscode.Uri.file(filePath))?.fsPath,
    },
    ANCHOR_CONTEXT_RADIUS,
    ANCHOR_SEARCH_RADIUS,
  );
}

/** Step 4 of the drift ladder: ask git whether a missing file was renamed. */
function findRenameTarget(folder: FolderInfo, uri: vscode.Uri): vscode.Uri | undefined {
  const repo = folder.repo;
  if (!repo) return undefined;
  const renamed = renamedPathFor(uri.fsPath, [repo.state.workingTreeChanges, repo.state.indexChanges]);
  return renamed ? vscode.Uri.file(renamed) : undefined;
}

function loadFolderThreads(folder: FolderInfo, file = readScopeFileOrEmpty(folder.filePath!)) {
  folder.lastKnownFile = file;
  folder.lastLoadedRevision = file.revision;
  const branch = file.branches[folder.branchKey!];
  folder.deletedThreads = new Map((branch?.deletedThreads ?? []).map(({ id, deletedAt }) => [id, deletedAt]));
  if (!branch || branch.threads.length === 0) return;
  for (const st of branch.threads) instantiateThread(folder, st);
  log(`${folder.folderPath}: loaded ${branch.threads.length} thread(s) for ${folder.branchKey}`);
}

/** Branch changed in one repo: touches only that repo's threads (fixes the pre-F2 bug where switching branch in one repo wiped every repo's comments). */
async function switchFolderBranch(folder: FolderInfo, newBranchKey: string) {
  const oldBranchKey = folder.branchKey!;
  log(`${folder.folderPath}: branch ${oldBranchKey} → ${newBranchKey}`);

  // Must complete before the reload below reads the file back, otherwise the
  // reload can race the write and load stale data.
  const transitioned = await runScopeTransition(
    folder.transitions,
    () => flushFolderSaveNow(folder),
    () => {
      disposeFolderThreads(folder);

      folder.branchKey = newBranchKey;
      const file = readScopeFileOrEmpty(folder.filePath!);
      folder.lastKnownFile = file;
      folder.lastLoadedRevision = file.revision;

      const plan = branchLoadPlan(file.branches, newBranchKey, oldBranchKey);
      const targetBranch = file.branches[newBranchKey];
      folder.deletedThreads = new Map((targetBranch?.deletedThreads ?? []).map(({ id, deletedAt }) => [id, deletedAt]));
      if (plan) {
        for (const st of plan.branch.threads) instantiateThread(folder, st);
        log(
          plan.inherited
            ? `${folder.folderPath}: inherited ${plan.branch.threads.length} thread(s) from ${oldBranchKey}`
            : `${folder.folderPath}: loaded ${plan.branch.threads.length} thread(s) for ${newBranchKey}`,
        );
        if (plan.inherited) scheduleSave(folder);
      }
    },
  );
  if (transitioned) refresh();
}

/** Flush used when switching branches, where an in-flight debounce must complete before the reload that follows reads the file back. */
async function flushFolderSaveNow(folder: FolderInfo): Promise<void> {
  try {
    await saveQueue.flush(folder, () => performScopeSave(folder));
  } catch (error) {
    log(`Save failed for ${folder.folderPath}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

function watchFolderScope(folder: FolderInfo) {
  if (!folder.filePath) return;
  folder.watcher?.dispose();
  const filePath = folder.filePath;
  const watcher = watchScopeFile({
    createWatcher: (targetPath) => {
      const pattern = new vscode.RelativePattern(vscode.Uri.file(path.dirname(targetPath)), path.basename(targetPath));
      return vscode.workspace.createFileSystemWatcher(pattern);
    },
    filePath,
    folderPath: folder.folderPath,
    folderName: path.basename(folder.folderPath),
    suppressWatcherUntil: () => folder.suppressWatcherUntil,
    now: Date.now,
    read: () => readScopeFileOrEmpty(filePath),
    replaceVisibleThreads: (file) => {
      disposeFolderThreads(folder);
      loadFolderThreads(folder, file);
    },
    refresh,
    log,
    showError: (message) => void vscode.window.showErrorMessage(message),
  });
  folder.watcher = watcher;
  extensionContext.subscriptions.push(watcher);
}

// --------------- Discover workspace folders at activation ---------------

async function discoverFolders(): Promise<void> {
  const wsFolders = vscode.workspace.workspaceFolders ?? [];
  if (wsFolders.length === 0) {
    log('No workspace folder open — comments in this window will not be persisted.');
    return;
  }
  for (const workspaceFolder of wsFolders) addWorkspaceFolder(workspaceFolder);
}

function addWorkspaceFolder(workspaceFolder: vscode.WorkspaceFolder): void {
  const realPath = realpathOrSelf(workspaceFolder.uri.fsPath);
  if (folders.some((folder) => folder.realPath === realPath)) return;
  const folder: FolderInfo = {
    folderPath: workspaceFolder.uri.fsPath,
    realPath,
    state: 'pending',
    lastLoadedRevision: 0,
    consecutiveSaveFailures: 0,
    deletedThreads: new Map(),
    transitions: new TransitionGeneration(),
  };
  folders.push(folder);
  void classifyFolder(folder).then(() => {
    if (folder.state === 'git' || folder.state === 'plain') watchFolderScope(folder);
    refresh();
  });
}

async function removeWorkspaceFolder(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
  const realPath = realpathOrSelf(workspaceFolder.uri.fsPath);
  const folder = folders.find((candidate) => candidate.realPath === realPath);
  if (!folder) return;
  // The removal itself is a transition: any delayed discovery must not load
  // this folder back into the view while the pending save is being drained.
  folder.transitions.invalidate();
  try {
    await flushFolderSaveNow(folder);
  } catch (error) {
    reportScopeTransitionFailure(folder, error);
    return;
  }
  folder.watcher?.dispose();
  disposeFolderThreads(folder);
  folders = folders.filter((candidate) => candidate !== folder);
  refresh();
}

function setupBranchWatcher(_context: vscode.ExtensionContext) {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension) {
    log('Git extension not found — branch scoping disabled for this window.');
    return;
  }
  activateGitApi().then((git) => {
    if (!git) return;
    // A repo opened after our initial classification pass (e.g. `git init`
    // in a plain folder, or a slow-to-register nested repo) should be
    // re-evaluated immediately, not just wait for its own future changes.
    git.onDidOpenRepository(() => {
      for (const folder of folders) {
        if (folder.state !== 'git')
          classifyFolder(folder).then(() => {
            if (folder.state === 'git') watchFolderScope(folder);
          });
      }
    });
  });
}

// --------------- Line Tracking ---------------

function setupLineTracking(context: vscode.ExtensionContext) {
  registerLineTracking(
    context.subscriptions,
    {
      liveThreads,
      isTracked: (thread) => threadIndex.has(threadIndex.publicId(thread) ?? -1),
      metadata: (thread) => threadIndex.metadata(thread),
      markDrifted: driftThread,
      scheduleSave: (thread) => queueSaveForThread(thread, LINE_TRACKING_DEBOUNCE_MS),
    },
    ANCHOR_CONTEXT_RADIUS,
    ANCHOR_SEARCH_RADIUS,
  );
}

/** The anchor is gone: mark this thread drifted in place (F4). It keeps its id, its conversation and its thread — only the promise that its line is current is withdrawn. */
function driftThread(thread: vscode.CommentThread) {
  const id = threadIndex.publicId(thread);
  if (id === undefined || !markDriftedThread(id, driftedThreadActionDeps())) return;
  log(`Thread #${id} drifted — its anchor is no longer found in the file.`);
}

// --------------- IPC HTTP Server ---------------

let ipcPort: number = 0;
let myWorkspaceRoots: string[] = [];
let descriptorFilePath: string | undefined;
let disposeIpcServer: (() => void) | undefined;
const agentRegistry = new AgentRegistry();
const reviewWaiters = new ReviewWaiters();

function notifyReviewWaiters(): void {
  const { generation, waiterCount } = reviewWaiters.announce();
  log(`Review generation ${generation} announced to ${waiterCount} waiting agent(s)`);
}

function sessionLogName(session: Pick<AgentSession, 'agent' | 'sessionId'>): string {
  return `${session.agent}:${session.sessionId.slice(-6)}`;
}

function cwdInWorkspace(cwd: string): boolean {
  const candidate = realpathOrSelf(cwd);
  return myWorkspaceRoots.some((root) => isAncestor(realpathOrSelf(root), candidate));
}

async function selectAgentSession(forcePicker = false): Promise<AgentSession | undefined> {
  const key = 'diffReview.boundSession';
  return selectAgentSessionAdapter<AgentSession>(
    {
      sessions: () => agentRegistry.list(),
      getBoundSessionId: () => extensionContext.workspaceState.get<string>(key),
      setBoundSessionId: (sessionId) => extensionContext.workspaceState.update(key, sessionId),
      pick: async (sessions) => {
        const picked = await vscode.window.showQuickPick(
          sessions.map((session) => ({
            label: session.label,
            description: `${session.agent === 'codex' ? 'Codex' : 'Claude Code'} · ${session.sessionId.slice(-6)}`,
            detail: session.cwd,
            session,
          })),
          { title: 'Send Diff Review to Agent Session', placeHolder: 'Choose the exact running session' },
        );
        return picked?.session;
      },
      log,
      sessionName: sessionLogName,
    },
    forcePicker,
  );
}

async function deliverOrFallback(targetThreads: vscode.CommentThread[]): Promise<void> {
  await deliverReviewOrFallback<vscode.CommentThread, AgentSession>(targetThreads, {
    hasSessions: () => agentRegistry.list().length > 0,
    selectSession: selectAgentSession,
    buildPrompt,
    directTools: MCP_TOOLS,
    fallbackTools: LM_TOOLS,
    deliver: deliverToSession,
    sessionName: sessionLogName,
    announceQueuedReview: notifyReviewWaiters,
    log,
    openChat: (prompt) => vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt }),
    writeClipboard: vscode.env.clipboard.writeText,
    showInformation: vscode.window.showInformationMessage,
    showWarning: vscode.window.showWarningMessage,
  });
}

function checkWorkspaceRoot(expected: string | undefined): boolean {
  if (!expected) return true; // caller made no claim — permissive, matches manual/legacy callers
  return myWorkspaceRoots.includes(expected);
}

function refreshWorkspaceDescriptor(): void {
  myWorkspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  if (!descriptorFilePath || !ipcPort) return;
  descriptorFilePath = writeIpcDescriptor(
    {
      tmpDir: os.tmpdir(),
      workspaceRoots: myWorkspaceRoots,
      port: ipcPort,
      processId: process.pid,
      previousPath: descriptorFilePath,
    },
    log,
  );
}

function startIpcServer(context: vscode.ExtensionContext): Promise<number> {
  myWorkspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  const handler = createIpcRequestHandler({
    reads: {
      workspaceRoots: () => myWorkspaceRoots,
      processId: () => process.pid,
      comments: () =>
        [...threadIndex.entries()].map(([id, thread]) => ({
          id,
          uri: thread.uri.toString(),
          startLine: requireThreadRange(thread).start.line,
          endLine: requireThreadRange(thread).end.line,
          status: isDrifted(thread) ? 'drifted' : statusOfThread(thread),
          comments: thread.comments.map((comment) => ({
            role: (comment as ReviewComment).role,
            body: typeof comment.body === 'string' ? comment.body : comment.body.value,
          })),
        })),
      health: () => ({
        comments: threadIndex.size,
        drifted: driftedCount(),
        persistence: persistenceStatus(),
      }),
    },
    sessions: {
      workspaceMatches: checkWorkspaceRoot,
      cwdInWorkspace,
      clearBoundSession: async (sessionId) => {
        if (extensionContext.workspaceState.get<string>('diffReview.boundSession') === sessionId) {
          await extensionContext.workspaceState.update('diffReview.boundSession', undefined);
        }
      },
      verifyClaudeSession: (session) =>
        verifyClaudeSessionIdentity(session, {
          pidFromSocketPath: claudePidFromSocketPath,
          processExists: (pid) => {
            process.kill(pid, 0);
            return true;
          },
          socketOwnerUid: (socketPath) => fs.statSync(socketPath).uid,
          currentUid: () => process.getuid?.(),
        }).ok,
      claudePidFromSocketPath,
      sessions: agentRegistry,
      log,
    },
    mutations: {
      workspaceMatches: checkWorkspaceRoot,
      reviewService,
      threadLocation: (threadId) => {
        const thread = threadIndex.get(threadId);
        return thread ? vscode.workspace.asRelativePath(thread.uri) : undefined;
      },
    },
    creates: {
      workspaceMatches: checkWorkspaceRoot,
      resolvePath: (expectedRoot, relativePath) =>
        resolveExistingWorkspacePath(expectedRoot ? [expectedRoot] : myWorkspaceRoots, relativePath, fs.existsSync),
      createComment: (filePath, startLine, endLine, text) =>
        createCommentThreadAt(vscode.Uri.file(filePath), startLine, endLine, text),
    },
    waiters: reviewWaiters,
    readBody,
    workspaceRoots: () => myWorkspaceRoots,
    log,
  });

  return startLoopbackHttpServer(handler).then(async (server) => {
    ipcPort = server.port;
    const tmpDir = os.tmpdir();
    await sweepStaleDescriptors(tmpDir, pingIpcEndpoint, log);
    descriptorFilePath = writeIpcDescriptor(
      { tmpDir, workspaceRoots: myWorkspaceRoots, port: ipcPort, processId: process.pid },
      log,
    );
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      disposeIpcServer = undefined;
      void server.close();
      try {
        if (descriptorFilePath) fs.unlinkSync(descriptorFilePath);
      } catch {
        /* already gone */
      }
    };
    disposeIpcServer = dispose;
    context.subscriptions.push({ dispose });
    return ipcPort;
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return readRequestBody(req, MAX_IPC_BODY_BYTES);
}

// --------------- MCP launcher deployment ---------------

/**
 * VS Code installs us into a versioned directory, so any MCP config pointing
 * straight at our `out/mcp-server.js` breaks on the next upgrade. Instead we
 * keep a stable launcher in ~/.diff-review and refresh it on every activation:
 * clients configure that path once and it keeps resolving to the current build.
 */
// --------------- MCP server info ---------------

function homeShort(filePath: string): string {
  const home = os.homedir();
  return filePath.startsWith(home + path.sep) ? '~' + filePath.slice(home.length) : filePath;
}

async function showMcpInfo(context: vscode.ExtensionContext) {
  const revealButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('folder-opened'),
    tooltip: 'Reveal in file explorer',
  };

  const items = collectMcpInfo({
    extensionPath: context.extensionPath,
    extensionVersion: context.extension.packageJSON.version,
    development: context.extensionMode === vscode.ExtensionMode.Development,
    ipcPort,
    descriptorPath: descriptorFilePath,
    storageRoot: globalStorageRoot(),
    folderCount: folders.length,
    descriptorDirectory: ipcDiscovery.descriptorDir(os.tmpdir()),
  }).map((row) => ({
    label: row.label,
    detail: row.detail,
    description: row.copy ? 'copy' : '',
    buttons: row.reveal && fs.existsSync(row.reveal) ? [revealButton] : [],
    row,
  }));

  const picker = vscode.window.createQuickPick<(typeof items)[number]>();
  picker.title = 'Diff Review — MCP Server Info';
  picker.placeholder = 'Select a row to copy it to the clipboard';
  picker.matchOnDetail = true;
  picker.items = items;

  picker.onDidTriggerItemButton(async (event) => {
    const target = event.item.row.reveal;
    if (target) {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
    }
  });

  picker.onDidAccept(async () => {
    const picked = picker.selectedItems[0];
    if (picked?.row.copy) {
      await vscode.env.clipboard.writeText(picked.row.copy);
      vscode.window.showInformationMessage(`Diff Review: copied ${picked.row.copy}`);
    }
    picker.hide();
  });

  picker.onDidHide(() => picker.dispose());
  picker.show();
}

// --------------- Activation ---------------

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  outputLog = vscode.window.createOutputChannel('Diff Review');
  log('Activating...');
  const globalStoragePath = vscode.Uri.file(context.globalStorageUri.fsPath.replace('vscode-userdata:', '')).toString();
  log(`Global storage: ${globalStoragePath}`);

  const controller = vscode.comments.createCommentController('diffReview', 'Diff Review');
  activeController = controller;
  context.subscriptions.push(controller);

  controller.commentingRangeProvider = {
    provideCommentingRanges(document: vscode.TextDocument) {
      return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
    },
  };

  controller.options = {
    prompt: 'Add review comment',
    placeHolder: 'Describe the change you want (e.g. "rename this variable", "add error handling")',
  };

  // --- Status bar (MUST be created before loading/refresh) ---
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = 'diffReview.showPanel';
  statusBar.tooltip = 'Click to view review comments';
  context.subscriptions.push(statusBar);

  // --- Discover workspace folders, classify each (git/pending/plain), and
  //     load its comments once settled (F2 + F3). ---
  discoverFolders().then(() => refresh());
  setupBranchWatcher(context);
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      refreshWorkspaceDescriptor();
      for (const folder of event.added) addWorkspaceFolder(folder);
      for (const folder of event.removed) {
        void removeWorkspaceFolder(folder);
      }
    }),
  );
  refresh();

  // --- Line tracking ---
  setupLineTracking(context);

  // --- MCP launcher + storage pointer ---
  const launcherDeployment = deployMcpLauncherRuntime(context.extensionPath);
  if (launcherDeployment.ok) log(`MCP launcher ready at ${LAUNCHER_FILE}`);
  else log(`Could not deploy MCP launcher: ${launcherDeployment.error}`);
  const storagePointerDeployment = deployStoragePathPointerRuntime(globalStorageRoot());
  if (!storagePointerDeployment.ok) {
    log(`Could not write storage-path pointer: ${storagePointerDeployment.error}`);
  }

  // --- IPC Server ---
  startIpcServer(context)
    .then((port) => {
      log(`IPC server listening on 127.0.0.1:${port}`);
    })
    .catch((err) => {
      log(`Failed to start IPC server: ${err}`);
    });

  registerCommentCreationCommands(context.subscriptions, {
    registerCommand: vscode.commands.registerCommand,
    reviewService,
    publicId: (thread) => threadIndex.publicId(thread),
    relativePath: vscode.workspace.asRelativePath,
    startLine: (thread) => requireThreadRange(thread).start.line,
    log,
  });

  registerCommentEditCommands(context.subscriptions, {
    registerCommand: vscode.commands.registerCommand,
    reviewService,
    findThread: findThreadForComment,
    publicId: (thread) => threadIndex.publicId(thread),
    relativePath: vscode.workspace.asRelativePath,
    startLine: (thread) => requireThreadRange(thread).start.line,
    log,
  });

  registerReviewDeletionCommands(context.subscriptions, {
    registerCommand: vscode.commands.registerCommand,
    reviewService,
    findThread: findThreadForComment,
    publicId: (thread) => threadIndex.publicId(thread),
    relativePath: vscode.workspace.asRelativePath,
    confirmThreadDeletion: async (commentCount) =>
      (await vscode.window.showWarningMessage(
        `Delete this comment thread and all ${commentCount} comments in it?`,
        { modal: true },
        'Delete',
      )) === 'Delete',
    refresh,
    queueSave: queueSaveForUri,
    log,
  });

  // --- Send single thread to agent ---
  context.subscriptions.push(
    vscode.commands.registerCommand('diffReview.sendThread', async (thread: vscode.CommentThread) => {
      await deliverOrFallback([thread]);
    }),
  );

  registerReviewStateCommands(context.subscriptions, {
    registerCommand: vscode.commands.registerCommand,
    reviewService,
    publicId: (thread) => threadIndex.publicId(thread),
    relativePath: vscode.workspace.asRelativePath,
    log,
  });

  registerDriftedLocationCommand(context.subscriptions, {
    registerCommand: vscode.commands.registerCommand,
    publicId: (thread) => threadIndex.publicId(thread),
    isDrifted,
    showActions: (id) => void showDriftedActions(id),
  });

  // --- Show MCP server info ---
  context.subscriptions.push(vscode.commands.registerCommand('diffReview.showMcpInfo', () => showMcpInfo(context)));

  // --- Register the MCP server with a discovered client ---
  context.subscriptions.push(vscode.commands.registerCommand('diffReview.registerMcpServer', () => showMcpConsumers()));

  // --- Install the agent slash commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('diffReview.installAgentCommands', () => showSlashCommandTargets()),
  );

  // --- Show comment panel ---
  context.subscriptions.push(vscode.commands.registerCommand('diffReview.showPanel', () => showCommentPanel()));

  // --- Submit all open to agent ---
  context.subscriptions.push(vscode.commands.registerCommand('diffReview.submitAll', () => submitAll()));
  context.subscriptions.push(
    vscode.commands.registerCommand('diffReview.selectAgentSession', () => selectAgentSession(true)),
  );

  registerReviewBatchCommands(context.subscriptions, {
    registerCommand: vscode.commands.registerCommand,
    reviewService,
    allEntries: () =>
      [...threadIndex.entries()].map(([id, thread]) => ({ id, status: statusOfThread(thread) as 'open' | 'resolved' })),
    entriesForFile: (fileKey) =>
      (getThreadsByFile().get(fileKey) ?? []).map(({ id, thread }) => ({
        id,
        status: statusOfThread(thread) as 'open' | 'resolved',
      })),
    confirm: async (message, action) =>
      (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
    showInformation: vscode.window.showInformationMessage,
  });

  registerReviewPromptCommands(context.subscriptions, {
    registerCommand: vscode.commands.registerCommand,
    allLiveThreads: liveThreads,
    threadsForFile: (fileKey) => (getThreadsByFile().get(fileKey) ?? []).map((entry) => entry.thread),
    isOpen: isOpenLive,
    buildPrompt,
    executeCommand: vscode.commands.executeCommand,
    writeClipboard: vscode.env.clipboard.writeText,
    showInformation: vscode.window.showInformationMessage,
  });

  // --- Register Copilot tools ---
  registerTools(context);
}

/**
 * Turn a caller-supplied workspace-relative path into an absolute one,
 * confined to `preferredRoot` when given (the routed IPC caller's matched
 * workspace root) or searched across every open folder otherwise (the LM
 * tool, which runs in-process and has no per-caller root of its own).
 */
/**
 * Create a new inline review comment thread at an arbitrary file/line,
 * mirroring what `diffReview.createNote` does for a comment typed into the
 * gutter by hand. Shared by the `/create` IPC endpoint and the
 * `diffReview_createComment` LM tool so the validation/creation logic isn't
 * duplicated between the two in-process callers.
 */
function createCommentThreadAt(
  uri: vscode.Uri,
  startLine0: number,
  endLine0: number,
  text: string,
): { threadId: number } | { error: string } {
  const created = createVsCodeCommentThreadAt(
    {
      fileExists: fs.existsSync,
      readTextFile: (filePath) => fs.readFileSync(filePath, 'utf-8'),
      displayPath: (target) => vscode.workspace.asRelativePath(target),
      createRange: (startLine, endLine) => new vscode.Range(startLine, 0, endLine, 0),
      createThread: (target, range) => activeController!.createCommentThread(target, range, []),
      disposeThread: (thread) => thread.dispose(),
      reviewService,
    },
    uri,
    startLine0,
    endLine0,
    text,
  );
  if ('threadId' in created) {
    log(`Comment #${created.threadId} created at ${vscode.workspace.asRelativePath(uri)}:${startLine0 + 1}`);
  }
  return created;
}

// --------------- Register with an MCP consumer ---------------

const STATUS_ICON: Record<McpConsumerTarget['status'], string> = {
  current: '$(check)',
  stale: '$(warning)',
  missing: '$(circle-outline)',
};

function mcpConsumerRegistrationDeps(): McpConsumerRegistrationDeps {
  return {
    launcherFile: LAUNCHER_FILE,
    renderSnippet,
    snippetDestination,
    register,
    copy: async (text) => void (await vscode.env.clipboard.writeText(text)),
    information: async (message, action) =>
      action
        ? await vscode.window.showInformationMessage(message, action)
        : await vscode.window.showInformationMessage(message),
    confirm: async (message, detail) =>
      await vscode.window.showInformationMessage(message, { modal: true, detail }, 'Write', 'Copy'),
    warning: async (message) => void (await vscode.window.showWarningMessage(message)),
    log,
    homeShort,
    installAgentCommands: () => void vscode.commands.executeCommand('diffReview.installAgentCommands'),
  };
}

async function copySnippet(target: McpConsumerTarget) {
  await copyConsumerSnippet(target, mcpConsumerRegistrationDeps());
}

/**
 * Confirm, then write. Every failure path ends at the clipboard rather than a
 * dead end, so a config we cannot edit is still a config the user can fix.
 */
async function registerWithConsumer(target: McpConsumerTarget) {
  await registerMcpConsumer(target, mcpConsumerRegistrationDeps());
}

async function showMcpConsumers() {
  const revealButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('folder-opened'),
    tooltip: 'Reveal in file explorer',
  };
  const copyButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('clippy'),
    tooltip: 'Copy the config instead of writing it',
  };

  if (!fs.existsSync(LAUNCHER_FILE)) {
    vscode.window.showWarningMessage(
      'Diff Review: the MCP launcher is not deployed yet. Run "Diff Review: Show MCP Server Info" to check.',
    );
    return;
  }

  const targets = discoverConsumers();
  if (targets.length === 0) {
    vscode.window.showInformationMessage('Diff Review: no MCP consumers found on this machine.');
    return;
  }

  const items = targets.map((target) => ({
    label: `${STATUS_ICON[target.status]} ${target.label}`,
    description: consumerStatusNote(target),
    detail: homeShort(target.configPath),
    buttons: fs.existsSync(target.configPath) ? [copyButton, revealButton] : [copyButton],
    target,
  }));

  const picker = vscode.window.createQuickPick<(typeof items)[number]>();
  picker.title = 'Diff Review — Register MCP Server';
  picker.placeholder = 'Select where to register the diff-review MCP server';
  picker.matchOnDetail = true;
  picker.items = items;

  picker.onDidTriggerItemButton(async (event) => {
    if (event.button === copyButton) {
      picker.hide();
      await copySnippet(event.item.target);
      return;
    }
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(event.item.target.configPath));
  });

  picker.onDidAccept(async () => {
    const picked = picker.selectedItems[0];
    picker.hide();
    if (picked) {
      await registerWithConsumer(picked.target);
    }
  });

  picker.onDidHide(() => picker.dispose());
  picker.show();
}

// --------------- Install agent slash commands ---------------

async function copySlashCommand(target: SlashCommandTarget, command: CommandId) {
  await vscode.env.clipboard.writeText(renderClipboard(target, command));
  vscode.window.showInformationMessage(
    `Diff Review: copied ${INVOCATION[command]} for ${target.label} to the clipboard.`,
  );
}

async function pickAndCopySlashCommands(target: SlashCommandTarget) {
  const choice = await vscode.window.showQuickPick(
    [
      { label: INVOCATION.perform, command: 'perform' as CommandId },
      { label: INVOCATION.address, command: 'address' as CommandId },
      { label: INVOCATION.register, command: 'register' as CommandId },
      { label: INVOCATION.unregister, command: 'unregister' as CommandId },
      { label: 'All four', command: undefined },
    ],
    { title: `Copy which command for ${target.label}?` },
  );
  if (!choice) return;

  if (choice.command) {
    await copySlashCommand(target, choice.command);
    return;
  }
  const text = (['perform', 'address', 'register', 'unregister'] as CommandId[])
    .map((c) => renderClipboard(target, c))
    .join('\n\n');
  await vscode.env.clipboard.writeText(text);
  vscode.window.showInformationMessage(`Diff Review: copied all four commands for ${target.label} to the clipboard.`);
}

/**
 * Confirm, then write the command files. Every failure path ends at the clipboard
 * rather than a dead end, so a file we cannot write is still one the user
 * can paste in by hand.
 */
async function installSlashCommands(target: SlashCommandTarget) {
  await installAgentSlashCommands(target, {
    install,
    copyCommands: pickAndCopySlashCommands,
    copyCommand: copySlashCommand,
    confirm: async (message, detail) =>
      await vscode.window.showInformationMessage(message, { modal: true, detail }, 'Write', 'Copy'),
    information: async (message) => void (await vscode.window.showInformationMessage(message)),
    warning: async (message) => void (await vscode.window.showWarningMessage(message)),
    log,
    homeShort,
  });
}

async function showSlashCommandTargets() {
  const revealButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('folder-opened'),
    tooltip: 'Reveal in file explorer',
  };
  const copyButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('clippy'),
    tooltip: 'Copy the commands instead of writing them',
  };

  const targets = discoverSlashCommands();
  if (targets.length === 0) {
    vscode.window.showInformationMessage('Diff Review: no agent slash-command directories found on this machine.');
    return;
  }

  const items = targets.map((target) => ({
    label: `${slashCommandRowIcon(target)} ${target.label}`,
    description: slashCommandRowLabel(target),
    detail: homeShort(target.dirPath),
    buttons: fs.existsSync(target.dirPath) ? [copyButton, revealButton] : [copyButton],
    target,
  }));

  const picker = vscode.window.createQuickPick<(typeof items)[number]>();
  picker.title = 'Diff Review — Install Agent Slash Commands';
  picker.placeholder = 'Select an agent to install the Diff Review commands';
  picker.matchOnDetail = true;
  picker.items = items;

  picker.onDidTriggerItemButton(async (event) => {
    if (event.button === copyButton) {
      picker.hide();
      await pickAndCopySlashCommands(event.item.target);
      return;
    }
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(event.item.target.dirPath));
  });

  picker.onDidAccept(async () => {
    const picked = picker.selectedItems[0];
    picker.hide();
    if (picked) {
      await installSlashCommands(picked.target);
    }
  });

  picker.onDidHide(() => picker.dispose());
  picker.show();
}

// --------------- Interactive QuickPick Panel ---------------

async function showCommentPanel() {
  if (threadIndex.size === 0) {
    vscode.window.showInformationMessage('No review comments.');
    return;
  }

  interface ActionItem extends vscode.QuickPickItem {
    action?: CommentPanelAction;
    threadId?: number;
    fileKey?: string;
    driftedId?: number;
  }

  const qp = vscode.window.createQuickPick<ActionItem>();
  const openCount = [...threadIndex.values()].filter((t) => statusOfThread(t) === 'open').length;
  const drifted = driftedCount();
  qp.title = reviewPanelTitle(threadIndex.size, openCount, drifted);
  qp.placeholder = 'Type to search comments… Select an action or comment.';
  qp.matchOnDescription = true;

  const panelThreads = [...threadIndex.entries()].map(([id, thread]) => {
    const range = requireThreadRange(thread);
    const metadata = threadIndex.metadata(thread);
    return {
      id,
      file: vscode.workspace.asRelativePath(thread.uri),
      startLine: range.start.line,
      status: statusOfThread(thread),
      location: metadata?.location ?? anchoredLocation(range.start.line, range.end.line),
      comments: thread.comments.map((comment) => ({
        body: typeof comment.body === 'string' ? comment.body : comment.body.value,
        role: (comment as ReviewComment).role,
      })),
    };
  });

  function buildItems(filter: string): ActionItem[] {
    return commentPanelItems(panelThreads, filter).map((item) => ({
      ...item,
      kind: item.separator ? vscode.QuickPickItemKind.Separator : undefined,
    }));
  }

  qp.items = buildItems('');
  qp.onDidChangeValue((value) => {
    qp.items = buildItems(value);
  });

  qp.onDidAccept(async () => {
    const pick = qp.selectedItems[0];
    if (!pick?.action) return;
    qp.hide();

    switch (pick.action) {
      case 'submitAll':
        await vscode.commands.executeCommand('diffReview.submitAll');
        break;
      case 'copyAll':
        await vscode.commands.executeCommand('diffReview.copyAll');
        break;
      case 'resolveAll':
        await vscode.commands.executeCommand('diffReview.resolveAll');
        break;
      case 'deleteResolved':
        await vscode.commands.executeCommand('diffReview.deleteResolved');
        break;
      case 'clearAll':
        await vscode.commands.executeCommand('diffReview.clearAll');
        break;
      case 'submitFile':
        if (pick.fileKey) await vscode.commands.executeCommand('diffReview.submitFile', pick.fileKey);
        break;
      case 'copyFile':
        if (pick.fileKey) await vscode.commands.executeCommand('diffReview.copyFile', pick.fileKey);
        break;
      case 'resolveFile':
        if (pick.fileKey) await vscode.commands.executeCommand('diffReview.resolveFile', pick.fileKey);
        break;
      case 'deleteResolvedFile':
        if (pick.fileKey) await vscode.commands.executeCommand('diffReview.deleteResolvedFile', pick.fileKey);
        break;
      case 'commentAction':
        if (pick.threadId !== undefined) await showCommentActions(pick.threadId);
        break;
      case 'driftedAction':
        if (pick.driftedId !== undefined) await showDriftedActions(pick.driftedId);
        break;
      case 'reattachAllInFile':
        if (pick.fileKey) await reattachAllInFile(pick.fileKey);
        break;
    }
  });

  qp.show();
}

// --------------- Per-Comment Action Submenu ---------------

async function showCommentActions(threadId: number) {
  const thread = threadIndex.get(threadId);
  if (!thread) return;

  const rel = vscode.workspace.asRelativePath(thread.uri);
  const line = requireThreadRange(thread).start.line + 1;
  const preview = commentPreview(thread.comments);
  const resolved = statusOfThread(thread) === 'resolved';

  const menu = commentActionMenu({ file: rel, line, preview, resolved });
  const pick = await vscode.window.showQuickPick(menu.items, {
    title: menu.title,
    placeHolder: 'Choose an action',
  });

  if (!pick) return;

  await executeReviewAction(pick.action as ReviewAction, threadId, {
    reviewService,
    getThread: (id) => threadIndex.get(id),
    goTo: async (selected) => {
      const doc = await vscode.workspace.openTextDocument(selected.uri);
      const editor = await vscode.window.showTextDocument(doc);
      const range = requireThreadRange(selected);
      const pos = range.start;
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      selected.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    },
    send: async (selected) => vscode.commands.executeCommand('diffReview.sendThread', selected),
    copy: async (selected) => vscode.commands.executeCommand('diffReview.copyThread', selected),
    confirmDeletion: async () =>
      (await vscode.window.showWarningMessage('Delete this comment thread?', { modal: true }, 'Delete')) === 'Delete',
  });
}

// --------------- Drifted Comment Actions (F4) ---------------

/** The drifted thread for `id`, or undefined if it is gone or no longer drifted. */
function driftedThread(
  id: number,
): { thread: vscode.CommentThread; meta: ReviewThreadMetadata; lastKnownLine: number } | undefined {
  const thread = threadIndex.get(id);
  const meta = thread && threadIndex.metadata(thread);
  if (!thread || meta?.location.kind !== 'drifted' || !isDrifted(thread)) return undefined;
  return { thread, meta, lastKnownLine: meta.location.lastKnownLine };
}

async function showDriftedActions(id: number) {
  const found = driftedThread(id);
  if (!found) return;
  const { thread, meta, lastKnownLine } = found;

  const uri = thread.uri;
  const rel = vscode.workspace.asRelativePath(uri);
  const preview = commentPreview(thread.comments);
  const fileExists = uri.scheme === 'file' && fs.existsSync(uri.fsPath);
  const resolved = statusOfThread(thread) === 'resolved';

  const menu = driftedActionMenu({ file: rel, preview, lastKnownLine, fileExists, resolved });
  const pick = await vscode.window.showQuickPick(menu.items, {
    title: menu.title,
    placeHolder: 'This comment left the gutter — its original location was not found',
  });
  if (!pick) return;

  switch (pick.action) {
    case 'showContext':
      vscode.window.showInformationMessage(
        meta.anchorContext ? `Original context:\n${meta.anchorContext}` : 'No stored context for this comment.',
        { modal: true },
      );
      break;
    case 'reattach':
      await reattachDrifted(id);
      break;
    case 'searchAgain':
      await searchAgainForDrifted(id);
      break;
    case 'fileNote':
    case 'toggleResolve':
    case 'delete':
      await applyDriftedThreadAction(pick.action, id, resolved, driftedThreadActionDeps());
      break;
  }
}

/** Re-run the drift ladder against the file's current content, in case the code came back (a rebase finishing, a branch switched back). */
async function searchAgainForDrifted(id: number) {
  const found = driftedThread(id);
  if (!found) return;
  const uri = found.thread.uri;
  if (uri.scheme !== 'file' || !fs.existsSync(uri.fsPath)) {
    vscode.window.showInformationMessage('That file does not exist any more.');
    return;
  }
  // Without a stored anchorHash (dropped when the thread drifted) there is
  // nothing to search for — only an exact re-attach applies.
  vscode.window.showInformationMessage(
    'Diff Review: no stored anchor to search for — use Re-attach instead to pick the line by hand.',
  );
}

/** Opens the file and lets the user confirm the current cursor position as the new anchor. */
async function reattachDrifted(id: number) {
  const found = driftedThread(id);
  if (!found) return;
  const uri = found.thread.uri;
  if (uri.scheme !== 'file' || !fs.existsSync(uri.fsPath)) {
    vscode.window.showWarningMessage('Diff Review: that file no longer exists.');
    return;
  }

  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  const choice = await vscode.window.showInformationMessage(
    'Place your cursor on the line this comment refers to, then confirm.',
    'Confirm',
    'Cancel',
  );
  if (choice !== 'Confirm') return;

  const active = vscode.window.activeTextEditor;
  if (!active || active.document.uri.toString() !== uri.toString()) {
    vscode.window.showWarningMessage('Diff Review: the active editor changed — try again from the same file.');
    return;
  }
  finishReattach(id, active.selection.active.line);
}

/** The user vouched for a line: clear the drift and re-anchor there. */
function finishReattach(id: number, line: number) {
  if (!reattachDriftedThread(id, line, driftedThreadActionDeps())) return;
  vscode.window.showInformationMessage('Diff Review: comment re-attached.');
}

function anchorForLine(uri: vscode.Uri, line: number): { anchorHash: string; anchorContext: string } | undefined {
  return anchorForFileLine(uri.fsPath, line, (filePath) => fs.readFileSync(filePath, 'utf-8'), ANCHOR_CONTEXT_RADIUS);
}

function driftedThreadActionDeps(): DriftedThreadActionDeps<vscode.CommentThread> {
  return {
    reviewService,
    confirmDeletion: async () =>
      (await vscode.window.showWarningMessage('Delete this drifted comment?', { modal: true }, 'Delete')) === 'Delete',
  };
}

async function reattachAllInFile(fileKey: string) {
  const ids = driftedEntries()
    .filter((e) => vscode.workspace.asRelativePath(e.thread.uri) === fileKey)
    .map((e) => e.id);
  for (const id of ids) {
    // A previous iteration may have re-attached or deleted this one.
    if (!driftedThread(id)) continue;
    await showDriftedActions(id);
  }
}

// --------------- Submit All ---------------

async function submitAll() {
  const openThreads = liveThreads().filter(isOpenLive);
  if (openThreads.length === 0) {
    vscode.window.showInformationMessage('No open review comments to submit.');
    return;
  }
  await deliverOrFallback(openThreads);
}

// --------------- Git Diff Context ---------------

// --------------- Prompt Builder ---------------

async function buildPrompt(targetThreads: vscode.CommentThread[], tools: PolicyTools = LM_TOOLS): Promise<string> {
  const promptThreads = await buildPromptThreads<vscode.Uri, vscode.CommentThread>(
    {
      uriKey: (uri) => uri.toString(),
      displayPath: (uri) => vscode.workspace.asRelativePath(uri),
      range: requireThreadRange,
      threadId: (thread) => threadIndex.publicId(thread),
      diffHunks: (uri) => getFileDiffHunks(uri, getGitApi),
      document: async (uri) => {
        const open = vscode.workspace.textDocuments.find(
          (document) => document.uri.toString() === uri.toString() || document.uri.fsPath === uri.fsPath,
        );
        return open ?? vscode.workspace.openTextDocument(uri);
      },
    },
    targetThreads,
  );
  return renderReviewPrompt(promptThreads, tools);
}

// --------------- Copilot Tools ---------------

function registerTools(context: vscode.ExtensionContext) {
  if (!vscode.lm || !vscode.lm.registerTool) return;

  registerReviewLanguageModelQueryTools(context.subscriptions, {
    resolveWorkspacePath: (relativePath) => resolveExistingWorkspacePath(myWorkspaceRoots, relativePath, fs.existsSync),
    createComment: createCommentThreadAt,
    listEntries: () =>
      [...threadIndex.entries()].map(([id, thread]) => {
        const location = threadIndex.metadata(thread)?.location;
        return {
          id,
          path: vscode.workspace.asRelativePath(thread.uri),
          status: statusOfThread(thread),
          comments: thread.comments.map((comment) => ({
            role: (comment as ReviewComment).role || 'user',
            text: typeof comment.body === 'string' ? comment.body : comment.body.value,
          })),
          line: requireThreadRange(thread).start.line,
          driftedLine: location?.kind === 'drifted' ? location.lastKnownLine : undefined,
        };
      }),
    driftedCount,
    log,
  });
  registerReviewLanguageModelTools(context.subscriptions, {
    reviewService,
    getThread: (threadId) => threadIndex.get(threadId),
    relativePath: vscode.workspace.asRelativePath,
    startLine: (thread) => requireThreadRange(thread).start.line,
    uri: (thread) => thread.uri,
    log,
  });
}

export function deactivate(): Thenable<void> {
  isShuttingDown = true;
  saveQueue.close();
  for (const folder of folders) folder.watcher?.dispose();
  disposeIpcServer?.();
  return flushAllSaves();
}
