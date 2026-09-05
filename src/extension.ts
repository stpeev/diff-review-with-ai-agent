import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { LAUNCHER_FILE, POINTER_FILE, STATE_DIR, Resolution, fromEnv, fromPointerFile, resolveServer } from './mcp-resolve';
import { McpConsumerTarget, discoverConsumers, register, renderSnippet, snippetDestination } from './mcp-consumers';
import { isAncestor } from './path-util';
import * as ipcDiscovery from './ipc-discovery';
import * as scopeIdMod from './scope-id';
import {
    Role, ThreadStatus, SerializedComment, SerializedThread, BranchState, ScopeFile,
    emptyBranch, emptyScopeFile, mergeScopeFiles,
    hashAnchor, anchorContextSnippet, findAnchorLine,
} from './comment-store';

// --------------- Comment Model ---------------

let nextCommentId = 1;

class ReviewComment implements vscode.Comment {
    readonly id: number;
    body: string | vscode.MarkdownString;
    mode: vscode.CommentMode;
    author: vscode.CommentAuthorInformation;
    role: Role;
    contextValue: string;
    createdAt: string; // ISO string for serialization
    timestamp: Date;   // vscode.Comment expects Date

    constructor(body: string, role: Role, id?: number, createdAt?: string) {
        this.id = id ?? nextCommentId++;
        // A loaded comment passes its persisted id and bypasses the ++ above —
        // without this, a freshly created comment in a new session could reuse
        // an id already held by something we just loaded from disk.
        if (this.id >= nextCommentId) nextCommentId = this.id + 1;
        this.body = body;
        this.role = role;
        this.mode = vscode.CommentMode.Preview;
        this.author = role === 'agent'
            ? { name: '🤖 Agent' }
            : { name: '👤 You' };
        this.contextValue = role === 'agent' ? 'agentComment' : 'userComment';
        this.createdAt = createdAt ?? new Date().toISOString();
        this.timestamp = new Date(this.createdAt);
    }
}

// --------------- Thread Tracking ---------------

interface ThreadMeta {
    anchorHash?: string;
    anchorContext?: string;
    updatedAt: string;
}

/** A comment whose anchor could not be found on load or after an edit. It has
 *  no `vscode.CommentThread` — per the durability spec, a drifted comment
 *  leaves the gutter rather than sit at a line it no longer describes. */
interface DriftedRecord {
    id: number;
    uri: string;
    lastKnownLine: number;
    status: ThreadStatus;
    comments: SerializedComment[];
    anchorContext?: string;
    updatedAt: string;
}

const threadMap = new Map<number, vscode.CommentThread>();
const threadIds = new WeakMap<vscode.CommentThread, number>();
const threadMeta = new WeakMap<vscode.CommentThread, ThreadMeta>();
const driftedMap = new Map<number, DriftedRecord>();
let nextThreadId = 1;

function trackThread(thread: vscode.CommentThread, id?: number, meta?: Partial<ThreadMeta>): number {
    const tid = id ?? nextThreadId++;
    // Same reasoning as the comment-id bump above: a loaded thread passes its
    // persisted id, so the counter must be kept ahead of every id we have
    // ever seen, not just ones minted in this session.
    if (tid >= nextThreadId) nextThreadId = tid + 1;
    threadMap.set(tid, thread);
    threadIds.set(thread, tid);
    threadMeta.set(thread, { updatedAt: new Date().toISOString(), ...meta });
    return tid;
}

function untrackThread(thread: vscode.CommentThread): void {
    const id = threadIds.get(thread);
    if (id !== undefined) threadMap.delete(id);
}

function touchThread(thread: vscode.CommentThread) {
    const meta = threadMeta.get(thread);
    if (meta) meta.updatedAt = new Date().toISOString();
    else threadMeta.set(thread, { updatedAt: new Date().toISOString() });
}

function findThreadForComment(commentId: number): vscode.CommentThread | undefined {
    for (const thread of threadMap.values()) {
        if (thread.comments.some(c => (c as ReviewComment).id === commentId)) {
            return thread;
        }
    }
    return undefined;
}

// --------------- Helpers ---------------

function getThreadsByFile(): Map<string, { id: number; thread: vscode.CommentThread }[]> {
    const byFile = new Map<string, { id: number; thread: vscode.CommentThread }[]>();
    for (const [id, thread] of threadMap) {
        const rel = vscode.workspace.asRelativePath(thread.uri);
        if (!byFile.has(rel)) byFile.set(rel, []);
        byFile.get(rel)!.push({ id, thread });
    }
    return byFile;
}

function getDriftedByFile(): Map<string, DriftedRecord[]> {
    const byFile = new Map<string, DriftedRecord[]>();
    for (const rec of driftedMap.values()) {
        const rel = vscode.workspace.asRelativePath(vscode.Uri.parse(rec.uri));
        if (!byFile.has(rel)) byFile.set(rel, []);
        byFile.get(rel)!.push(rec);
    }
    return byFile;
}

function threadPreview(thread: vscode.CommentThread): string {
    const first = thread.comments[0];
    const text = typeof first.body === 'string' ? first.body : first.body.value;
    return text.length > 55 ? text.substring(0, 52) + '...' : text;
}

function driftedPreview(rec: DriftedRecord): string {
    const first = rec.comments[0];
    const text = first ? first.body : '';
    return text.length > 55 ? text.substring(0, 52) + '...' : text;
}

function resolveThread(thread: vscode.CommentThread) {
    thread.label = '✅ Resolved';
    thread.contextValue = 'resolved';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    touchThread(thread);
}

function unresolveThread(thread: vscode.CommentThread) {
    thread.label = 'Open';
    thread.contextValue = 'open';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    touchThread(thread);
}

// --------------- Status Bar ---------------

let statusBar: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;
let activeController: vscode.CommentController | undefined;
let outputLog: vscode.OutputChannel;

function refresh() {
    const n = threadMap.size;
    const open = [...threadMap.values()].filter(t => t.contextValue !== 'resolved').length;
    const drifted = driftedMap.size;
    const parts: string[] = [];
    if (n > 0) parts.push(`${open} open · ${n - open} resolved`);
    if (drifted > 0) parts.push(`${drifted} drifted`);

    if (parts.length > 0) {
        statusBar.text = `$(comment-discussion) ${parts.join(' · ')}`;
        statusBar.tooltip = noWorkspaceWarned
            ? 'Click to view review comments. Some comments in this window are not being saved — see the output log.'
            : 'Click to view review comments';
        statusBar.show();
    } else if (noWorkspaceWarned) {
        // No comments yet, but this window already can't persist any — a
        // silent empty status bar would hide that entirely.
        statusBar.text = '$(warning) Diff Review: not persisted';
        statusBar.tooltip = 'This window has no workspace folder open — comments will not be saved.';
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
    saveTimer?: ReturnType<typeof setTimeout>;
    suppressWatcherUntil?: number;
    watcher?: vscode.FileSystemWatcher;
    /** The matching `vscode.git` repository, once found. */
    repo?: any;
}

const PENDING_TIMEOUT_MS = 10_000;
const LINE_TRACKING_DEBOUNCE_MS = 500;

let folders: FolderInfo[] = [];
/** True once we have logged that this window has files with nowhere to persist to. */
let noWorkspaceWarned = false;
const writerId = crypto.randomUUID();
/** All writes — across every folder's scope — go through one chain so concurrent saves cannot interleave (F5). */
let writeChain: Promise<void> = Promise.resolve();

function getGitApi(): any | undefined {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (!gitExtension) return undefined;
    if (gitExtension.isActive) return gitExtension.exports.getAPI(1);
    return undefined;
}

async function activateGitApi(): Promise<any | undefined> {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (!gitExtension) return undefined;
    try {
        const exports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
        return exports.getAPI(1);
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

function shortSha(sha: string | undefined): string {
    return (sha ?? 'unknown').slice(0, 8);
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
async function classifyFolder(folder: FolderInfo): Promise<void> {
    const realPath = folder.realPath;
    if (!hasDotGitAbove(realPath)) {
        folder.state = 'plain';
        folder.scopeId = scopeIdMod.scopeIdForFolder(realPath);
        folder.branchKey = '_default';
        outputLog.appendLine(`[Diff Review] ${folder.folderPath}: plain (no .git found)`);
        settleFolder(folder);
        return;
    }

    folder.state = 'pending';
    folder.pendingSince = Date.now();
    const resolved = await tryResolveGitScope(folder);
    if (resolved) return;

    // Bounded wait: poll briefly for the git extension/repo to show up, then
    // degrade to `plain` rather than staying stuck on `pending` forever.
    const deadline = Date.now() + PENDING_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 500));
        if (await tryResolveGitScope(folder)) return;
    }

    outputLog.appendLine(`[Diff Review] ${folder.folderPath}: git extension never reported this repo — degrading to plain`);
    folder.state = 'plain';
    folder.scopeId = scopeIdMod.scopeIdForFolder(realPath);
    folder.branchKey = '_default';
    settleFolder(folder);
}

/** Attempt to resolve `folder` against `vscode.git`. Returns true once `state` has settled to `git`. */
async function tryResolveGitScope(folder: FolderInfo): Promise<boolean> {
    const git = await activateGitApi();
    if (!git) return false;
    const repo = git.repositories.find((r: any) => isAncestor(realpathOrSelf(r.rootUri.fsPath), folder.realPath));
    if (!repo) return false;

    folder.repo = repo;
    const repoRealPath = realpathOrSelf(repo.rootUri.fsPath);
    const remoteUrl: string | undefined = repo.state.remotes?.[0]?.fetchUrl || repo.state.remotes?.[0]?.pushUrl;
    folder.scopeId = remoteUrl ? scopeIdMod.scopeIdForRemote(remoteUrl) : scopeIdMod.scopeIdForRepo(repoRealPath);
    folder.branchKey = repo.state.HEAD?.name || `_detached.${shortSha(repo.state.HEAD?.commit)}`;
    folder.state = 'git';
    outputLog.appendLine(`[Diff Review] ${folder.folderPath}: git — scope ${folder.scopeId}, branch ${folder.branchKey}`);

    registerRepoWatcher(folder, repo);
    settleFolder(folder);
    return true;
}

function registerRepoWatcher(folder: FolderInfo, repo: any) {
    repo.state.onDidChange(() => {
        const newBranchKey = repo.state.HEAD?.name || `_detached.${shortSha(repo.state.HEAD?.commit)}`;
        if (folder.branchKey && newBranchKey !== folder.branchKey) {
            switchFolderBranch(folder, newBranchKey);
        }
    });
}

/** Called once a folder's scope/branch is known: sets `filePath`, loads its threads, flushes any deferred save. */
function settleFolder(folder: FolderInfo) {
    folder.filePath = path.join(scopeDirFor(folder.scopeId!), 'comments.json');
    migrateLegacyStateIfPresent(folder);
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
    const candidates = folders.map(f => ({ scopeId: f.scopeId ?? '__pending__', folderRealPath: f.realPath, folder: f }));
    const match = scopeIdMod.deepestScopeForFile(candidates, uri.fsPath);
    return (match as any)?.folder;
}

function threadsOwnedByFolder(folder: FolderInfo): { threadIds: number[]; driftedIds: number[] } {
    const owned = { threadIds: [] as number[], driftedIds: [] as number[] };
    for (const [id, thread] of threadMap) {
        if (ownerFolderForUri(thread.uri) === folder) owned.threadIds.push(id);
    }
    for (const [id, rec] of driftedMap) {
        if (ownerFolderForUri(vscode.Uri.parse(rec.uri)) === folder) owned.driftedIds.push(id);
    }
    return owned;
}

// --------------- Legacy workspaceState migration ---------------

interface LegacySerializedState {
    version: 1;
    nextThreadId: number;
    nextCommentId: number;
    threads: SerializedThread[];
}

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
        if (fs.existsSync(folder.filePath!)) return; // new store already has data for this scope
        const key = legacyStateKeyFor(folder);
        if (!key) return;
        const legacy = extensionContext.workspaceState.get<LegacySerializedState>(key);
        if (!legacy || !legacy.threads || legacy.threads.length === 0) return;

        const branch: BranchState = { nextThreadId: legacy.nextThreadId, nextCommentId: legacy.nextCommentId, threads: legacy.threads.map(t => ({ ...t, updatedAt: new Date(0).toISOString() })) };
        const file = emptyScopeFile(writerId);
        file.branches[folder.branchKey!] = branch;
        fs.mkdirSync(path.dirname(folder.filePath!), { recursive: true });
        fs.writeFileSync(folder.filePath!, JSON.stringify(file));
        outputLog.appendLine(`[Diff Review] Migrated ${legacy.threads.length} thread(s) from legacy key ${key} into ${folder.scopeId}`);
    } catch (e: any) {
        outputLog.appendLine(`[Diff Review] Legacy migration skipped for ${folder.folderPath}: ${e.message}`);
    }
}

// --------------- Scope File I/O (F3 + F5) ---------------

function readScopeFileOrEmpty(filePath: string): ScopeFile {
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.branches) return parsed as ScopeFile;
        throw new Error('malformed scope file');
    } catch (e: any) {
        if (e.code !== 'ENOENT') outputLog.appendLine(`[Diff Review] Could not read ${filePath}, starting empty: ${e.message}`);
        return emptyScopeFile(writerId);
    }
}

function writeFileAtomic(filePath: string, content: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, filePath);
}

function writeMeta(folder: FolderInfo, file: ScopeFile) {
    try {
        const total = Object.values(file.branches).reduce((sum, b) => sum + b.threads.length, 0);
        const meta = {
            scopeId: folder.scopeId,
            lastKnownPath: folder.folderPath,
            label: path.basename(folder.folderPath),
            commentCount: total,
            updatedAt: new Date().toISOString(),
        };
        writeFileAtomic(path.join(scopeDirFor(folder.scopeId!), 'meta.json'), JSON.stringify(meta));
    } catch {
        // meta.json is advisory (recovery UI, not yet built) — never fail a save over it.
    }
}

function currentBranchStateFromMemory(folder: FolderInfo): BranchState {
    const owned = threadsOwnedByFolder(folder);
    const threads: SerializedThread[] = [];
    let maxThreadId = 0;
    let maxCommentId = 0;

    for (const id of owned.threadIds) {
        const thread = threadMap.get(id)!;
        const meta = threadMeta.get(thread);
        const comments = thread.comments.map(c => {
            const rc = c as ReviewComment;
            maxCommentId = Math.max(maxCommentId, rc.id);
            return { id: rc.id, role: rc.role, body: typeof rc.body === 'string' ? rc.body : rc.body.value, timestamp: rc.createdAt };
        });
        maxThreadId = Math.max(maxThreadId, id);
        threads.push({
            id, uri: thread.uri.toString(),
            startLine: thread.range.start.line, endLine: thread.range.end.line,
            status: thread.contextValue === 'resolved' ? 'resolved' : 'open',
            comments,
            updatedAt: meta?.updatedAt ?? new Date().toISOString(),
            anchorHash: meta?.anchorHash, anchorContext: meta?.anchorContext,
        });
    }
    for (const id of owned.driftedIds) {
        const rec = driftedMap.get(id)!;
        maxThreadId = Math.max(maxThreadId, id);
        for (const c of rec.comments) maxCommentId = Math.max(maxCommentId, c.id);
        threads.push({
            id, uri: rec.uri, startLine: rec.lastKnownLine, endLine: rec.lastKnownLine,
            status: rec.status, comments: rec.comments, updatedAt: rec.updatedAt,
            anchorContext: rec.anchorContext, drifted: true,
        });
    }

    return { nextThreadId: maxThreadId + 1, nextCommentId: maxCommentId + 1, threads };
}

function scheduleSave(folder: FolderInfo, debounceMs = 0) {
    if (folder.saveTimer) clearTimeout(folder.saveTimer);
    folder.saveTimer = setTimeout(() => {
        folder.saveTimer = undefined;
        writeChain = writeChain.then(() => performScopeSave(folder)).catch(err => {
            outputLog.appendLine(`[Diff Review] Save failed for ${folder.folderPath}: ${err.message ?? err}`);
        });
    }, debounceMs);
}

async function performScopeSave(folder: FolderInfo): Promise<void> {
    if (folder.state === 'pending' || !folder.scopeId || !folder.filePath) {
        folder.needsFlushOnSettle = true;
        return;
    }
    try {
        const onDisk = readScopeFileOrEmpty(folder.filePath);
        const ourBranch = currentBranchStateFromMemory(folder);
        let merged: ScopeFile;

        if (folder.lastKnownFile && onDisk.revision === folder.lastLoadedRevision) {
            // No one wrote since we last read: our in-memory branch state is
            // authoritative and overwrites directly. Unioning against onDisk
            // here — onDisk being nothing but our own prior write — would
            // resurrect every thread we just deleted, since a deleted thread
            // is (correctly) absent from memory but still union-kept from
            // disk. Union only applies when there is a genuine other side.
            merged = { ...onDisk, writerId, revision: onDisk.revision + 1, branches: { ...onDisk.branches, [folder.branchKey!]: ourBranch } };
        } else {
            // A concurrent writer moved the revision past what we last saw —
            // merge so their other-branch (or other-thread) writes are not
            // clobbered. This is where the documented delete/union limitation
            // applies: a thread deleted here but untouched on the other side
            // still survives the merge (no tombstone until F6).
            const base = folder.lastKnownFile ?? onDisk;
            const mine: ScopeFile = { ...base, writerId, branches: { ...base.branches, [folder.branchKey!]: ourBranch } };
            merged = mergeScopeFiles(mine, onDisk, writerId);
        }

        folder.suppressWatcherUntil = Date.now() + 500;
        writeFileAtomic(folder.filePath, JSON.stringify(merged));
        writeMeta(folder, merged);

        folder.lastKnownFile = merged;
        folder.lastLoadedRevision = merged.revision;
        folder.consecutiveSaveFailures = 0;
    } catch (e: any) {
        folder.consecutiveSaveFailures = (folder.consecutiveSaveFailures ?? 0) + 1;
        outputLog.appendLine(`[Diff Review] Save error for ${folder.folderPath} (attempt ${folder.consecutiveSaveFailures}): ${e.message}`);
        if (folder.consecutiveSaveFailures === 3) {
            vscode.window.showErrorMessage(
                `Diff Review: comments in ${path.basename(folder.folderPath)} have failed to save ${folder.consecutiveSaveFailures} times in a row. Recent changes may be lost.`
            );
        }
        throw e;
    }
}

/** Every scheduled save's timer, flushed synchronously-as-possible at shutdown (F5). */
async function flushAllSaves(): Promise<void> {
    for (const folder of folders) {
        if (folder.saveTimer) {
            clearTimeout(folder.saveTimer);
            folder.saveTimer = undefined;
            writeChain = writeChain.then(() => performScopeSave(folder)).catch(() => {});
        }
    }
    await writeChain;
}

/** Resolve the folder owning `thread.uri` and schedule its scope file to be saved. Threads outside every known folder are transient by design (F3: "no workspace folder" case). */
function queueSaveForThread(thread: vscode.CommentThread, debounceMs = 0) {
    const folder = ownerFolderForUri(thread.uri);
    if (!folder) {
        warnTransient();
        return;
    }
    scheduleSave(folder, debounceMs);
}

function queueSaveForUri(uri: vscode.Uri, debounceMs = 0) {
    const folder = ownerFolderForUri(uri);
    if (!folder) { warnTransient(); return; }
    scheduleSave(folder, debounceMs);
}

function warnTransient() {
    if (!noWorkspaceWarned) {
        noWorkspaceWarned = true;
        outputLog.appendLine('[Diff Review] A comment was added on a file outside any open workspace folder — it will not be saved.');
    }
    refresh();
}

// --------------- Loading threads for a settled folder ---------------

/** Keeps the global id counters ahead of a loaded thread's id and its comments' ids — `trackThread`/`ReviewComment` do the same for live threads, but a drifted record is set directly into `driftedMap`, bypassing both. */
function reserveIds(threadId: number, comments: SerializedComment[]) {
    if (threadId >= nextThreadId) nextThreadId = threadId + 1;
    for (const c of comments) if (c.id >= nextCommentId) nextCommentId = c.id + 1;
}

function instantiateThread(folder: FolderInfo, st: SerializedThread) {
    if (st.drifted) {
        reserveIds(st.id, st.comments);
        driftedMap.set(st.id, {
            id: st.id, uri: st.uri, lastKnownLine: st.startLine, status: st.status,
            comments: st.comments, anchorContext: st.anchorContext, updatedAt: st.updatedAt,
        });
        return;
    }

    const uri = vscode.Uri.parse(st.uri);
    const verified = verifyOrLocateAnchor(folder, uri, st);
    if (verified === 'drifted') {
        reserveIds(st.id, st.comments);
        driftedMap.set(st.id, {
            id: st.id, uri: st.uri, lastKnownLine: st.startLine, status: st.status,
            comments: st.comments, anchorContext: st.anchorContext, updatedAt: st.updatedAt,
        });
        return;
    }

    const line = typeof verified === 'number' ? verified : st.startLine;
    const range = new vscode.Range(line, 0, line, 0);
    const thread = activeController!.createCommentThread(uri, range, []);
    const comments = st.comments.map(sc => new ReviewComment(sc.body, sc.role, sc.id, sc.timestamp || new Date().toISOString()));
    thread.comments = comments;
    thread.canReply = true;
    if (st.status === 'resolved') {
        thread.label = '✅ Resolved';
        thread.contextValue = 'resolved';
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    } else {
        thread.label = 'Open';
        thread.contextValue = 'open';
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }
    trackThread(thread, st.id, { anchorHash: st.anchorHash, anchorContext: st.anchorContext, updatedAt: st.updatedAt });
}

const ANCHOR_CONTEXT_RADIUS = 2;
const ANCHOR_SEARCH_RADIUS = 50;

/**
 * Drift ladder steps 1-3 (content re-verification) plus step 4 (ask git about
 * a rename) — see the durability spec. Returns the line to use, or the
 * literal string 'drifted' once every avenue is exhausted (step 5).
 */
function verifyOrLocateAnchor(folder: FolderInfo, uri: vscode.Uri, st: SerializedThread): number | 'drifted' {
    if (!st.anchorHash) return st.startLine; // legacy data written before anchoring existed — best effort, self-heals on next save

    let filePath = uri.fsPath;
    if (!fs.existsSync(filePath)) {
        const renamed = findRenameTarget(folder, uri);
        if (renamed) filePath = renamed.fsPath;
        else return 'drifted';
    }

    let lines: string[];
    try {
        lines = fs.readFileSync(filePath, 'utf-8').split(/\r\n|\n/);
    } catch {
        return 'drifted';
    }

    const found = findAnchorLine(lines, st.anchorHash, st.startLine, ANCHOR_CONTEXT_RADIUS, ANCHOR_SEARCH_RADIUS);
    return found === undefined ? 'drifted' : found;
}

/** Step 4 of the drift ladder: ask git whether a missing file was renamed. */
function findRenameTarget(folder: FolderInfo, uri: vscode.Uri): vscode.Uri | undefined {
    const repo = folder.repo;
    if (!repo) return undefined;
    const changeLists = [repo.state.workingTreeChanges, repo.state.indexChanges].filter(Boolean);
    for (const changes of changeLists) {
        for (const change of changes) {
            if (change.originalUri?.fsPath === uri.fsPath && change.uri) return change.uri;
        }
    }
    return undefined;
}

function loadFolderThreads(folder: FolderInfo) {
    const file = readScopeFileOrEmpty(folder.filePath!);
    folder.lastKnownFile = file;
    folder.lastLoadedRevision = file.revision;
    const branch = file.branches[folder.branchKey!];
    if (!branch || branch.threads.length === 0) return;
    for (const st of branch.threads) instantiateThread(folder, st);
    outputLog.appendLine(`[Diff Review] ${folder.folderPath}: loaded ${branch.threads.length} thread(s) for ${folder.branchKey}`);
}

/** Branch changed in one repo: touches only that repo's threads (fixes the pre-F2 bug where switching branch in one repo wiped every repo's comments). */
async function switchFolderBranch(folder: FolderInfo, newBranchKey: string) {
    const oldBranchKey = folder.branchKey!;
    outputLog.appendLine(`[Diff Review] ${folder.folderPath}: branch ${oldBranchKey} → ${newBranchKey}`);

    // Must actually complete before the reload below reads the file back —
    // `writeChain` resolves later than this call returns, so without
    // awaiting it the reload can race the write and load stale data.
    await flushFolderSaveNow(folder);

    const owned = threadsOwnedByFolder(folder);
    for (const id of owned.threadIds) { threadMap.get(id)?.dispose(); threadMap.delete(id); }
    for (const id of owned.driftedIds) driftedMap.delete(id);

    folder.branchKey = newBranchKey;
    const file = readScopeFileOrEmpty(folder.filePath!);
    folder.lastKnownFile = file;
    folder.lastLoadedRevision = file.revision;

    const newBranch = file.branches[newBranchKey];
    if (newBranch && newBranch.threads.length > 0) {
        for (const st of newBranch.threads) instantiateThread(folder, st);
        outputLog.appendLine(`[Diff Review] ${folder.folderPath}: loaded ${newBranch.threads.length} thread(s) for ${newBranchKey}`);
    } else {
        const oldBranch = file.branches[oldBranchKey];
        if (oldBranch && oldBranch.threads.length > 0) {
            for (const st of oldBranch.threads) instantiateThread(folder, st);
            outputLog.appendLine(`[Diff Review] ${folder.folderPath}: inherited ${oldBranch.threads.length} thread(s) from ${oldBranchKey}`);
            scheduleSave(folder);
        }
    }
    refresh();
}

/** Flush used when switching branches, where an in-flight debounce must complete before the reload that follows reads the file back. */
async function flushFolderSaveNow(folder: FolderInfo): Promise<void> {
    if (folder.saveTimer) { clearTimeout(folder.saveTimer); folder.saveTimer = undefined; }
    const p = writeChain.then(() => performScopeSave(folder)).catch(err => {
        outputLog.appendLine(`[Diff Review] Save failed for ${folder.folderPath}: ${err.message ?? err}`);
    });
    writeChain = p;
    await p;
}

function watchFolderScope(folder: FolderInfo) {
    if (!folder.filePath) return;
    folder.watcher?.dispose();
    const pattern = new vscode.RelativePattern(vscode.Uri.file(path.dirname(folder.filePath)), 'comments.json');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onExternalChange = () => {
        if (folder.suppressWatcherUntil && Date.now() < folder.suppressWatcherUntil) return; // our own write
        outputLog.appendLine(`[Diff Review] ${folder.folderPath}: external change to ${folder.filePath}, reloading`);
        const owned = threadsOwnedByFolder(folder);
        for (const id of owned.threadIds) { threadMap.get(id)?.dispose(); threadMap.delete(id); }
        for (const id of owned.driftedIds) driftedMap.delete(id);
        loadFolderThreads(folder);
        refresh();
    };
    watcher.onDidChange(onExternalChange);
    watcher.onDidCreate(onExternalChange);
    folder.watcher = watcher;
    extensionContext.subscriptions.push(watcher);
}

// --------------- Discover workspace folders at activation ---------------

async function discoverFolders(): Promise<void> {
    const wsFolders = vscode.workspace.workspaceFolders ?? [];
    if (wsFolders.length === 0) {
        outputLog.appendLine('[Diff Review] No workspace folder open — comments in this window will not be persisted.');
        return;
    }
    for (const wf of wsFolders) {
        const folder: FolderInfo = {
            folderPath: wf.uri.fsPath,
            realPath: realpathOrSelf(wf.uri.fsPath),
            state: 'pending',
            lastLoadedRevision: 0,
            consecutiveSaveFailures: 0,
        };
        folders.push(folder);
        classifyFolder(folder).then(() => {
            if (folder.state === 'git') watchFolderScope(folder);
            else if (folder.state === 'plain') watchFolderScope(folder);
        });
    }
}

function setupBranchWatcher(context: vscode.ExtensionContext) {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (!gitExtension) {
        outputLog.appendLine('[Diff Review] Git extension not found — branch scoping disabled for this window.');
        return;
    }
    activateGitApi().then(git => {
        if (!git) return;
        // A repo opened after our initial classification pass (e.g. `git init`
        // in a plain folder, or a slow-to-register nested repo) should be
        // re-evaluated immediately, not just wait for its own future changes.
        git.onDidOpenRepository(() => {
            for (const folder of folders) {
                if (folder.state !== 'git') classifyFolder(folder).then(() => {
                    if (folder.state === 'git') watchFolderScope(folder);
                });
            }
        });
    });
}

// --------------- Line Tracking ---------------

function setupLineTracking(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.contentChanges.length === 0) return;

            const docUri = e.document.uri.toString();
            const affected: vscode.CommentThread[] = [];
            for (const thread of threadMap.values()) {
                if (thread.uri.toString() === docUri) affected.push(thread);
            }
            if (affected.length === 0) return;

            // Process content changes in reverse order (bottom-up) to avoid cascading shifts
            const changes = [...e.contentChanges].sort(
                (a, b) => b.range.start.line - a.range.start.line
            );

            // Threads whose anchored line fell inside a shrunk range need
            // re-verification against the live document rather than a blind
            // shift — otherwise a comment inside a deleted block silently
            // stays put, now pointing at whatever slid up into it.
            const needsReverify = new Set<vscode.CommentThread>();

            for (const change of changes) {
                const startLine = change.range.start.line;
                const oldEndLine = change.range.end.line;
                const normalizedText = change.text.replace(/\r\n/g, '\n');
                const newLines = normalizedText.split('\n').length - 1;
                const oldLines = oldEndLine - startLine;
                const delta = newLines - oldLines;

                if (delta === 0) continue;

                for (const thread of affected) {
                    const threadLine = thread.range.start.line;
                    if (threadLine > oldEndLine) {
                        const newStart = threadLine + delta;
                        const newEnd = thread.range.end.line + delta;
                        if (newStart >= 0) {
                            thread.range = new vscode.Range(newStart, 0, newEnd, 0);
                        }
                    } else if (threadLine >= startLine && threadLine <= oldEndLine && delta < 0) {
                        needsReverify.add(thread);
                    }
                }
            }

            if (needsReverify.size > 0) {
                const liveLines = e.document.getText().split(/\r\n|\n/);
                for (const thread of needsReverify) {
                    const meta = threadMeta.get(thread);
                    if (!meta?.anchorHash) continue; // no anchor to check against — leave the old shift behavior
                    const found = findAnchorLine(liveLines, meta.anchorHash, thread.range.start.line, ANCHOR_CONTEXT_RADIUS, ANCHOR_SEARCH_RADIUS);
                    if (found !== undefined) {
                        thread.range = new vscode.Range(found, 0, found, 0);
                    } else {
                        driftThread(thread);
                    }
                }
            }

            for (const thread of affected) {
                if (threadMap.has(threadIds.get(thread) ?? -1)) queueSaveForThread(thread, LINE_TRACKING_DEBOUNCE_MS);
            }
        })
    );
}

/** Move a live thread into `driftedMap`: it has no trustworthy line any more, so it leaves the gutter (F4). */
function driftThread(thread: vscode.CommentThread) {
    const id = threadIds.get(thread);
    if (id === undefined) return;
    const meta = threadMeta.get(thread);
    const comments = thread.comments.map(c => {
        const rc = c as ReviewComment;
        return { id: rc.id, role: rc.role, body: typeof rc.body === 'string' ? rc.body : rc.body.value, timestamp: rc.createdAt };
    });
    driftedMap.set(id, {
        id, uri: thread.uri.toString(), lastKnownLine: thread.range.start.line,
        status: thread.contextValue === 'resolved' ? 'resolved' : 'open',
        comments, anchorContext: meta?.anchorContext, updatedAt: new Date().toISOString(),
    });
    threadMap.delete(id);
    thread.dispose();
    queueSaveForUri(vscode.Uri.parse(driftedMap.get(id)!.uri));
    refresh();
    outputLog.appendLine(`[Diff Review] Thread #${id} drifted — its anchor is no longer found in the file.`);
}

// --------------- IPC HTTP Server ---------------

let ipcServer: http.Server | undefined;
let ipcPort: number = 0;
let myWorkspaceRoots: string[] = [];
let descriptorFilePath: string | undefined;

async function pingCandidate(port: number, timeoutMs = 800): Promise<boolean> {
    return new Promise(resolve => {
        const req = http.get(`http://127.0.0.1:${port}/ping`, res => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
    });
}

async function sweepStaleDescriptors(tmpDir: string): Promise<void> {
    const dir = ipcDiscovery.descriptorDir(tmpDir);
    let entries: string[];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return;
    }
    for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const file = path.join(dir, entry);
        try {
            const d = JSON.parse(fs.readFileSync(file, 'utf-8'));
            if (typeof d.port !== 'number' || !(await pingCandidate(d.port))) {
                fs.unlinkSync(file);
                outputLog.appendLine(`[Diff Review] Swept stale IPC descriptor ${entry}`);
            }
        } catch {
            try { fs.unlinkSync(file); } catch { /* already gone */ }
        }
    }
}

function checkWorkspaceRoot(expected: string | undefined): boolean {
    if (!expected) return true; // caller made no claim — permissive, matches manual/legacy callers
    return myWorkspaceRoots.includes(expected);
}

function findThreadOrDrifted(threadId: number): { kind: 'live'; thread: vscode.CommentThread } | { kind: 'drifted'; rec: DriftedRecord } | undefined {
    const thread = threadMap.get(threadId);
    if (thread) return { kind: 'live', thread };
    const rec = driftedMap.get(threadId);
    if (rec) return { kind: 'drifted', rec };
    return undefined;
}

function startIpcServer(context: vscode.ExtensionContext): Promise<number> {
    return new Promise((resolve, reject) => {
        myWorkspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);

        const server = http.createServer(async (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Access-Control-Allow-Origin', 'localhost');

            const url = new URL(req.url || '/', `http://localhost`);
            const method = req.method || 'GET';

            try {
                if (method === 'GET' && url.pathname === '/ping') {
                    res.writeHead(200);
                    res.end(JSON.stringify({ workspaceRoots: myWorkspaceRoots, pid: process.pid }));
                } else if (method === 'GET' && url.pathname === '/comments') {
                    const threads = [
                        ...[...threadMap.entries()].map(([id, t]) => ({
                            id, uri: t.uri.toString(), startLine: t.range.start.line, endLine: t.range.end.line,
                            status: t.contextValue === 'resolved' ? 'resolved' : 'open',
                            comments: t.comments.map(c => ({ role: (c as ReviewComment).role, body: typeof c.body === 'string' ? c.body : c.body.value })),
                        })),
                        ...[...driftedMap.values()].map(rec => ({
                            id: rec.id, uri: rec.uri, startLine: rec.lastKnownLine, endLine: rec.lastKnownLine,
                            status: 'drifted', comments: rec.comments.map(c => ({ role: c.role, body: c.body })),
                        })),
                    ];
                    res.writeHead(200);
                    res.end(JSON.stringify({ threads }));
                } else if (method === 'POST' && url.pathname === '/reply') {
                    const body = await readBody(req);
                    const { threadId, text, expectWorkspaceRoot } = JSON.parse(body);
                    if (!checkWorkspaceRoot(expectWorkspaceRoot)) { respondMismatch(res); return; }
                    const found = findThreadOrDrifted(threadId);
                    if (!found) { res.writeHead(404); res.end(JSON.stringify({ error: `Thread #${threadId} not found` })); return; }
                    if (found.kind === 'live') {
                        const reply = new ReviewComment(text, 'agent');
                        found.thread.comments = [...found.thread.comments, reply];
                        found.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
                        touchThread(found.thread);
                        queueSaveForThread(found.thread);
                        res.writeHead(200);
                        res.end(JSON.stringify({ ok: true, commentId: reply.id }));
                    } else {
                        const comment: SerializedComment = { id: nextCommentId++, role: 'agent', body: text, timestamp: new Date().toISOString() };
                        found.rec.comments.push(comment);
                        found.rec.updatedAt = comment.timestamp;
                        queueSaveForUri(vscode.Uri.parse(found.rec.uri));
                        res.writeHead(200);
                        res.end(JSON.stringify({ ok: true, commentId: comment.id, note: 'This thread is drifted — its original location was not found.' }));
                    }
                } else if (method === 'POST' && url.pathname === '/resolve') {
                    const body = await readBody(req);
                    const { threadId, expectWorkspaceRoot } = JSON.parse(body);
                    if (!checkWorkspaceRoot(expectWorkspaceRoot)) { respondMismatch(res); return; }
                    const found = findThreadOrDrifted(threadId);
                    if (!found) { res.writeHead(404); res.end(JSON.stringify({ error: `Thread #${threadId} not found` })); return; }
                    if (found.kind === 'live') {
                        resolveThread(found.thread);
                        refresh();
                        queueSaveForThread(found.thread);
                    } else {
                        found.rec.status = 'resolved';
                        found.rec.updatedAt = new Date().toISOString();
                        queueSaveForUri(vscode.Uri.parse(found.rec.uri));
                    }
                    res.writeHead(200);
                    res.end(JSON.stringify({ ok: true }));
                } else if (method === 'POST' && url.pathname === '/unresolve') {
                    const body = await readBody(req);
                    const { threadId, expectWorkspaceRoot } = JSON.parse(body);
                    if (!checkWorkspaceRoot(expectWorkspaceRoot)) { respondMismatch(res); return; }
                    const thread = threadMap.get(threadId);
                    if (!thread) { res.writeHead(404); res.end(JSON.stringify({ error: `Thread #${threadId} not found` })); return; }
                    unresolveThread(thread);
                    refresh();
                    queueSaveForThread(thread);
                    res.writeHead(200);
                    res.end(JSON.stringify({ ok: true }));
                } else if (method === 'POST' && url.pathname === '/delete') {
                    const body = await readBody(req);
                    const { threadId, expectWorkspaceRoot } = JSON.parse(body);
                    if (!checkWorkspaceRoot(expectWorkspaceRoot)) { respondMismatch(res); return; }
                    const found = findThreadOrDrifted(threadId);
                    if (!found) { res.writeHead(404); res.end(JSON.stringify({ error: `Thread #${threadId} not found` })); return; }
                    if (found.kind === 'live') {
                        threadMap.delete(threadId);
                        found.thread.dispose();
                        refresh();
                        queueSaveForUri(found.thread.uri);
                    } else {
                        driftedMap.delete(threadId);
                        queueSaveForUri(vscode.Uri.parse(found.rec.uri));
                    }
                    res.writeHead(200);
                    res.end(JSON.stringify({ ok: true }));
                } else if (method === 'GET' && url.pathname === '/health') {
                    res.writeHead(200);
                    res.end(JSON.stringify({ ok: true, comments: threadMap.size, drifted: driftedMap.size }));
                } else {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'Not found' }));
                }
            } catch (err: any) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });

        function respondMismatch(res: http.ServerResponse) {
            res.writeHead(409);
            res.end(JSON.stringify({ error: 'workspace mismatch', have: myWorkspaceRoots }));
        }

        server.listen(0, '127.0.0.1', async () => {
            const addr = server.address();
            if (addr && typeof addr !== 'string') {
                ipcPort = addr.port;
                ipcServer = server;

                const tmpDir = os.tmpdir();
                await sweepStaleDescriptors(tmpDir);
                const descriptor: ipcDiscovery.Descriptor = {
                    port: ipcPort, workspaceRoots: myWorkspaceRoots, pid: process.pid, startedAt: new Date().toISOString(),
                };
                fs.mkdirSync(ipcDiscovery.descriptorDir(tmpDir), { recursive: true });
                descriptorFilePath = ipcDiscovery.descriptorPath(tmpDir, myWorkspaceRoots, process.pid);
                fs.writeFileSync(descriptorFilePath, JSON.stringify(descriptor), 'utf-8');

                // Deprecated global pointer, kept for one release so an
                // un-upgraded launcher still finds *a* window. New consumers
                // should resolve through the descriptor directory above.
                const legacyPortFile = path.join(tmpDir, 'diff-review-port');
                fs.writeFileSync(legacyPortFile, String(ipcPort), 'utf-8');
                outputLog.appendLine('[Diff Review] (deprecated) also wrote the legacy global port file — MCP clients should resolve via the per-window descriptor directory.');

                resolve(ipcPort);
            } else {
                reject(new Error('Failed to get server address'));
            }
        });

        server.on('error', reject);
        context.subscriptions.push({
            dispose: () => {
                server.close();
                try { if (descriptorFilePath) fs.unlinkSync(descriptorFilePath); } catch { /* already gone */ }
            }
        });
    });
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}

// --------------- MCP launcher deployment ---------------

/**
 * VS Code installs us into a versioned directory, so any MCP config pointing
 * straight at our `out/mcp-server.js` breaks on the next upgrade. Instead we
 * keep a stable launcher in ~/.diff-review and refresh it on every activation:
 * clients configure that path once and it keeps resolving to the current build.
 */
function deployMcpLauncher(context: vscode.ExtensionContext) {
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });

        // Pointer file: lets the launcher skip scanning and use the exact build
        // that is actually running right now.
        const serverPath = path.join(context.extensionPath, 'out', 'mcp-server.js');
        fs.writeFileSync(POINTER_FILE, serverPath, 'utf-8');

        const source = path.join(context.extensionPath, 'out', 'mcp-launcher.js');
        fs.copyFileSync(source, LAUNCHER_FILE);

        outputLog.appendLine(`[Diff Review] MCP launcher ready at ${LAUNCHER_FILE}`);
    } catch (err) {
        // Non-fatal: everything except the MCP integration still works.
        outputLog.appendLine(`[Diff Review] Could not deploy MCP launcher: ${err}`);
    }
}

/**
 * Writes `~/.diff-review/storage-path`, pointing at this window's
 * `globalStorageUri`. Nothing reads it yet — comments are still reached over
 * the HTTP IPC server — but a future file-based reader (e.g. one running
 * while the editor is closed) needs a way to find the directory without
 * guessing the editor flavor and platform, the same problem the MCP launcher
 * pointer already solves for the server path.
 */
function deployStoragePathPointer() {
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.writeFileSync(path.join(STATE_DIR, 'storage-path'), globalStorageRoot(), 'utf-8');
    } catch (err) {
        outputLog.appendLine(`[Diff Review] Could not write storage-path pointer: ${err}`);
    }
}

// --------------- MCP server info ---------------

interface McpInfoRow {
    label: string;
    detail: string;
    /** Text copied when the row is picked; rows without it are informational. */
    copy?: string;
    /** Path revealed by the "open folder" button, when the file exists. */
    reveal?: string;
}

function homeShort(p: string): string {
    const home = os.homedir();
    return p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

function existsNote(p: string): string {
    return fs.existsSync(p) ? 'exists' : 'MISSING';
}

const SOURCE_LABEL: Record<Resolution['source'], string> = {
    env: 'DIFF_REVIEW_SERVER override',
    pointer: 'pointer file written by this extension',
    scan: 'scan of installed extensions',
};

/**
 * Build the rows for the MCP info picker. Kept separate from the UI so the
 * interesting part — what a client resolves versus what this window runs — is
 * plain to read.
 */
function collectMcpInfo(context: vscode.ExtensionContext): McpInfoRow[] {
    const rows: McpInfoRow[] = [];
    const ownServer = path.join(context.extensionPath, 'out', 'mcp-server.js');

    let resolved: Resolution | null = null;
    let resolveError = '';
    try {
        resolved = resolveServer();
    } catch (err: any) {
        resolveError = err.message;
    }

    // A client running the launcher may end up on a different build than this
    // window — a stale pointer file, an env override, or an older copy left in
    // another extensions root. That mismatch is the whole reason to look here,
    // so it goes first.
    if (resolved && resolved.path !== ownServer) {
        const why = resolved.source === 'env'
            ? `DIFF_REVIEW_SERVER is set to ${homeShort(resolved.path)}`
            : resolved.source === 'pointer'
                ? `the pointer file points at ${homeShort(resolved.path)} — another window may have written it`
                : `no pointer file matched, so the scan picked ${homeShort(resolved.path)}`;
        rows.push({
            label: '$(warning) Consumers resolve a different build than this window',
            detail: why,
        });
    } else if (!resolved) {
        rows.push({ label: '$(error) Cannot resolve a server', detail: resolveError });
    }

    rows.push({
        label: '$(rocket) Launcher',
        detail: `${homeShort(LAUNCHER_FILE)} — ${existsNote(LAUNCHER_FILE)} · point your MCP consumer here`,
        copy: LAUNCHER_FILE,
        reveal: LAUNCHER_FILE,
    });

    rows.push({
        label: '$(terminal) Add to Claude Code',
        detail: `claude mcp add diff-review node ${homeShort(LAUNCHER_FILE)}`,
        copy: `claude mcp add diff-review node ${LAUNCHER_FILE}`,
    });

    const envOverride = fromEnv();
    if (envOverride) {
        rows.push({
            label: '$(symbol-variable) DIFF_REVIEW_SERVER',
            detail: `${homeShort(envOverride)} — ${existsNote(envOverride)}`,
            copy: envOverride,
        });
    }

    const pointer = fromPointerFile();
    rows.push({
        label: '$(file-symlink-file) Pointer file',
        detail: pointer
            ? `${homeShort(POINTER_FILE)} → ${homeShort(pointer)} — ${existsNote(pointer)}`
            : `${homeShort(POINTER_FILE)} — MISSING · activate the extension once to write it`,
        copy: POINTER_FILE,
        reveal: STATE_DIR,
    });

    if (resolved) {
        rows.push({
            label: '$(server) Resolved server',
            detail: `${homeShort(resolved.path)} — via ${SOURCE_LABEL[resolved.source]}`
                + (resolved.version ? ` · v${resolved.version}` : ''),
            copy: resolved.path,
            reveal: resolved.path,
        });
    }

    // Internals of interest only while hacking on the extension itself. The
    // rows above stay in both modes: they are what a user needs when their MCP
    // client is silently running a stale build.
    if (context.extensionMode === vscode.ExtensionMode.Development) {
        rows.push({
            label: '$(vm) This window’s build',
            detail: `${homeShort(ownServer)} — v${context.extension.packageJSON.version} · ${existsNote(ownServer)}`,
            copy: ownServer,
            reveal: ownServer,
        });

        rows.push({
            label: '$(plug) IPC port',
            detail: ipcPort
                ? `${ipcPort} — descriptor at ${homeShort(descriptorFilePath ?? '')}`
                : `not listening — ${homeShort(ipcDiscovery.descriptorDir(os.tmpdir()))} may be stale`,
            copy: ipcPort ? String(ipcPort) : undefined,
        });

        rows.push({
            label: '$(database) Comment storage',
            detail: `${homeShort(globalStorageRoot())} — ${folders.length} folder(s) tracked`,
            copy: globalStorageRoot(),
            reveal: globalStorageRoot(),
        });
    }

    return rows;
}

async function showMcpInfo(context: vscode.ExtensionContext) {
    const revealButton: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('folder-opened'),
        tooltip: 'Reveal in file explorer',
    };

    const items = collectMcpInfo(context).map(row => ({
        label: row.label,
        detail: row.detail,
        description: row.copy ? 'copy' : '',
        buttons: row.reveal && fs.existsSync(row.reveal) ? [revealButton] : [],
        row,
    }));

    const picker = vscode.window.createQuickPick<typeof items[number]>();
    picker.title = 'Diff Review — MCP Server Info';
    picker.placeholder = 'Select a row to copy it to the clipboard';
    picker.matchOnDetail = true;
    picker.items = items;

    picker.onDidTriggerItemButton(async event => {
        const target = event.item.row.reveal;
        if (target) { await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target)); }
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
    outputLog.appendLine('[Diff Review] Activating...');

    const controller = vscode.comments.createCommentController('diffReview', 'Diff Review');
    activeController = controller;
    context.subscriptions.push(controller);

    controller.commentingRangeProvider = {
        provideCommentingRanges(document: vscode.TextDocument) {
            return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
        }
    };

    controller.options = {
        prompt: 'Add review comment',
        placeHolder: 'Describe the change you want (e.g. "rename this variable", "add error handling")'
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
    refresh();

    // --- Line tracking ---
    setupLineTracking(context);

    // --- MCP launcher + storage pointer ---
    deployMcpLauncher(context);
    deployStoragePathPointer();

    // --- IPC Server ---
    startIpcServer(context).then(port => {
        outputLog.appendLine(`[Diff Review] IPC server listening on 127.0.0.1:${port}`);
    }).catch(err => {
        outputLog.appendLine(`[Diff Review] Failed to start IPC server: ${err}`);
    });

    // --- Create comment (first comment in a new thread) ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.createNote', (reply: vscode.CommentReply) => {
            const thread = reply.thread;
            const comment = new ReviewComment(reply.text, 'user');
            thread.comments = [comment];
            thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
            thread.canReply = true;
            thread.label = 'Open';
            thread.contextValue = 'open';
            const anchor = computeAnchorForNewThread(thread);
            trackThread(thread, undefined, anchor);
            refresh();
            queueSaveForThread(thread);
        })
    );

    // --- Reply (additional comments in existing thread) ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.reply', (reply: vscode.CommentReply) => {
            const thread = reply.thread;
            const comment = new ReviewComment(reply.text, 'user');
            thread.comments = [...thread.comments, comment];
            touchThread(thread);
            queueSaveForThread(thread);
        })
    );

    // --- Edit comment ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.editComment', (comment: ReviewComment) => {
            const thread = findThreadForComment(comment.id);
            if (!thread) return;
            thread.comments = thread.comments.map(c => {
                if ((c as ReviewComment).id === comment.id) {
                    const edited = c as ReviewComment;
                    edited.mode = vscode.CommentMode.Editing;
                    return edited;
                }
                return c;
            });
        })
    );

    // --- Save edited comment ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.saveEdit', (comment: ReviewComment) => {
            const thread = findThreadForComment(comment.id);
            if (!thread) return;
            thread.comments = thread.comments.map(c => {
                if ((c as ReviewComment).id === comment.id) {
                    const saved = c as ReviewComment;
                    saved.mode = vscode.CommentMode.Preview;
                    return saved;
                }
                return c;
            });
            touchThread(thread);
            queueSaveForThread(thread);
        })
    );

    // --- Cancel edit ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.cancelEdit', (comment: ReviewComment) => {
            const thread = findThreadForComment(comment.id);
            if (!thread) return;
            thread.comments = thread.comments.map(c => {
                if ((c as ReviewComment).id === comment.id) {
                    const cancelled = c as ReviewComment;
                    cancelled.mode = vscode.CommentMode.Preview;
                    return cancelled;
                }
                return c;
            });
        })
    );

    // --- Delete individual comment ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.deleteNote', (comment: ReviewComment) => {
            const thread = findThreadForComment(comment.id);
            if (!thread) return;
            const uri = thread.uri;
            if (thread.comments.length <= 1) {
                untrackThread(thread);
                thread.dispose();
            } else {
                thread.comments = thread.comments.filter(
                    c => (c as ReviewComment).id !== comment.id
                );
                touchThread(thread);
            }
            refresh();
            queueSaveForUri(uri);
        })
    );

    // --- Send single thread to Copilot ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.sendThread', async (thread: vscode.CommentThread) => {
            const prompt = await buildPrompt([thread]);
            try {
                await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
            } catch {
                await vscode.env.clipboard.writeText(prompt);
                vscode.window.showInformationMessage('Prompt copied to clipboard.');
            }
        })
    );

    // --- Resolve thread ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.resolve', (thread: vscode.CommentThread) => {
            resolveThread(thread);
            refresh();
            queueSaveForThread(thread);
        })
    );

    // --- Unresolve thread ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.unresolve', (thread: vscode.CommentThread) => {
            unresolveThread(thread);
            refresh();
            queueSaveForThread(thread);
        })
    );

    // --- Show MCP server info ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.showMcpInfo', () => showMcpInfo(context))
    );

    // --- Register the MCP server with a discovered client ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.registerMcpServer', () => showMcpConsumers())
    );

    // --- Show comment panel ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.showPanel', () => showCommentPanel())
    );

    // --- Submit all open to Copilot ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.submitAll', () => submitAll())
    );

    // --- Resolve all ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.resolveAll', () => {
            let count = 0;
            const touched: vscode.CommentThread[] = [];
            for (const thread of threadMap.values()) {
                if (thread.contextValue !== 'resolved') { resolveThread(thread); touched.push(thread); count++; }
            }
            refresh();
            for (const thread of touched) queueSaveForThread(thread);
            if (count > 0) vscode.window.showInformationMessage(`Resolved ${count} comment${count !== 1 ? 's' : ''}.`);
        })
    );

    // --- Delete all resolved ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.deleteResolved', async () => {
            const resolved = [...threadMap.entries()].filter(([, t]) => t.contextValue === 'resolved');
            if (resolved.length === 0) { vscode.window.showInformationMessage('No resolved comments to delete.'); return; }
            const answer = await vscode.window.showWarningMessage(
                `Delete ${resolved.length} resolved comment${resolved.length !== 1 ? 's' : ''}?`, { modal: true }, 'Delete'
            );
            if (answer !== 'Delete') return;
            const uris: vscode.Uri[] = [];
            for (const [id, thread] of resolved) { uris.push(thread.uri); threadMap.delete(id); thread.dispose(); }
            refresh();
            for (const uri of uris) queueSaveForUri(uri);
        })
    );

    // --- Clear all ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.clearAll', async () => {
            if (threadMap.size === 0 && driftedMap.size === 0) return;
            const total = threadMap.size + driftedMap.size;
            const answer = await vscode.window.showWarningMessage(
                `Delete all ${total} review comment${total !== 1 ? 's' : ''}?`, { modal: true }, 'Delete All'
            );
            if (answer !== 'Delete All') return;
            const uris: vscode.Uri[] = [];
            for (const thread of threadMap.values()) { uris.push(thread.uri); thread.dispose(); }
            for (const rec of driftedMap.values()) uris.push(vscode.Uri.parse(rec.uri));
            threadMap.clear();
            driftedMap.clear();
            refresh();
            for (const uri of uris) queueSaveForUri(uri);
        })
    );

    // --- File-level batch: submit file ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.submitFile', async (fileKey: string) => {
            const byFile = getThreadsByFile();
            const entries = byFile.get(fileKey);
            if (!entries) return;
            const openThreads = entries.filter(e => e.thread.contextValue !== 'resolved').map(e => e.thread);
            if (openThreads.length === 0) { vscode.window.showInformationMessage('No open comments in this file.'); return; }
            const prompt = await buildPrompt(openThreads);
            try {
                await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
            } catch {
                await vscode.env.clipboard.writeText(prompt);
                vscode.window.showInformationMessage('Prompt copied to clipboard.');
            }
        })
    );

    // --- File-level batch: resolve file ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.resolveFile', (fileKey: string) => {
            const byFile = getThreadsByFile();
            const entries = byFile.get(fileKey);
            if (!entries) return;
            let count = 0;
            const touched: vscode.CommentThread[] = [];
            for (const { thread } of entries) {
                if (thread.contextValue !== 'resolved') { resolveThread(thread); touched.push(thread); count++; }
            }
            refresh();
            for (const thread of touched) queueSaveForThread(thread);
            if (count > 0) vscode.window.showInformationMessage(`Resolved ${count} comment${count !== 1 ? 's' : ''} in ${fileKey}.`);
        })
    );

    // --- File-level batch: delete resolved in file ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.deleteResolvedFile', async (fileKey: string) => {
            const byFile = getThreadsByFile();
            const entries = byFile.get(fileKey);
            if (!entries) return;
            const resolved = entries.filter(e => e.thread.contextValue === 'resolved');
            if (resolved.length === 0) { vscode.window.showInformationMessage('No resolved comments in this file.'); return; }
            const answer = await vscode.window.showWarningMessage(
                `Delete ${resolved.length} resolved comment${resolved.length !== 1 ? 's' : ''} in ${fileKey}?`, { modal: true }, 'Delete'
            );
            if (answer !== 'Delete') return;
            const uris: vscode.Uri[] = [];
            for (const { id, thread } of resolved) { uris.push(thread.uri); threadMap.delete(id); thread.dispose(); }
            refresh();
            for (const uri of uris) queueSaveForUri(uri);
        })
    );

    // --- Copy single thread to clipboard ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.copyThread', async (thread: vscode.CommentThread) => {
            const prompt = await buildPrompt([thread]);
            await vscode.env.clipboard.writeText(prompt);
            vscode.window.showInformationMessage('Comment prompt copied to clipboard.');
        })
    );

    // --- Copy all open to clipboard ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.copyAll', async () => {
            const openThreads = [...threadMap.values()].filter(t => t.contextValue !== 'resolved');
            if (openThreads.length === 0) { vscode.window.showInformationMessage('No open comments to copy.'); return; }
            const prompt = await buildPrompt(openThreads);
            await vscode.env.clipboard.writeText(prompt);
            vscode.window.showInformationMessage(`${openThreads.length} comment(s) copied to clipboard.`);
        })
    );

    // --- Copy file comments to clipboard ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.copyFile', async (fileKey: string) => {
            const byFile = getThreadsByFile();
            const entries = byFile.get(fileKey);
            if (!entries) return;
            const openThreads = entries.filter(e => e.thread.contextValue !== 'resolved').map(e => e.thread);
            if (openThreads.length === 0) { vscode.window.showInformationMessage('No open comments in this file.'); return; }
            const prompt = await buildPrompt(openThreads);
            await vscode.env.clipboard.writeText(prompt);
            vscode.window.showInformationMessage(`${openThreads.length} comment(s) from ${fileKey} copied to clipboard.`);
        })
    );

    // --- Register Copilot tools ---
    registerTools(context);
}

/** Anchor a freshly created thread against the file's current content, if it can be read. */
function computeAnchorForNewThread(thread: vscode.CommentThread): { anchorHash: string; anchorContext: string } | undefined {
    try {
        if (thread.uri.scheme !== 'file' || !fs.existsSync(thread.uri.fsPath)) return undefined;
        const lines = fs.readFileSync(thread.uri.fsPath, 'utf-8').split(/\r\n|\n/);
        const line = thread.range.start.line;
        if (line < 0 || line >= lines.length) return undefined;
        const context = anchorContextSnippet(lines, line, ANCHOR_CONTEXT_RADIUS);
        return { anchorHash: hashAnchor(lines[line], context.split('\n')), anchorContext: context };
    } catch {
        return undefined;
    }
}

// --------------- Register with an MCP consumer ---------------

const STATUS_ICON: Record<McpConsumerTarget['status'], string> = {
    current: '$(check)',
    stale: '$(warning)',
    missing: '$(circle-outline)',
};

function statusNote(target: McpConsumerTarget): string {
    if (!target.writable) return `not registered (manual) — ${target.reason}`;
    switch (target.status) {
        case 'current': return 'registered';
        case 'stale': return `registered — runs ${target.current}`;
        case 'missing': return 'not registered';
    }
}

async function copySnippet(target: McpConsumerTarget) {
    const snippet = renderSnippet(target);
    await vscode.env.clipboard.writeText(snippet);
    vscode.window.showInformationMessage(
        `Diff Review: copied the ${target.label} config — ${snippetDestination(target)}.`);
}

/**
 * Confirm, then write. Every failure path ends at the clipboard rather than a
 * dead end, so a config we cannot edit is still a config the user can fix.
 */
async function registerWithConsumer(target: McpConsumerTarget) {
    if (target.status === 'current') {
        vscode.window.showInformationMessage(
            `Diff Review: ${target.label} is already registered against the launcher.`);
        return;
    }

    if (!target.writable) {
        await copySnippet(target);
        return;
    }

    const before = target.status === 'stale' ? `Currently runs:\n  ${target.current}\n\n` : '';
    const answer = await vscode.window.showInformationMessage(
        `${target.status === 'stale' ? 'Repair' : 'Register'} diff-review in ${target.label}?`,
        {
            modal: true,
            detail: `${target.configPath}\n\n${before}Will run:\n  node ${LAUNCHER_FILE}`,
        },
        'Write', 'Copy',
    );

    if (answer === 'Copy') { await copySnippet(target); return; }
    if (answer !== 'Write') return;

    try {
        const { backup } = register(target);
        vscode.window.showInformationMessage(
            `Diff Review: registered with ${target.label}.` +
            (backup ? ` Previous config saved to ${homeShort(backup)}.` : ''));
    } catch (err: any) {
        outputLog.appendLine(`[Diff Review] register failed for ${target.id}: ${err.message}`);
        await copySnippet(target);
        vscode.window.showWarningMessage(
            `Diff Review: could not write ${homeShort(target.configPath)} (${err.message}). ` +
            'The config is on your clipboard instead.');
    }
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
            'Diff Review: the MCP launcher is not deployed yet. Run "Diff Review: Show MCP Server Info" to check.');
        return;
    }

    const targets = discoverConsumers();
    if (targets.length === 0) {
        vscode.window.showInformationMessage('Diff Review: no MCP consumers found on this machine.');
        return;
    }

    const items = targets.map(target => ({
        label: `${STATUS_ICON[target.status]} ${target.label}`,
        description: statusNote(target),
        detail: homeShort(target.configPath),
        buttons: fs.existsSync(target.configPath) ? [copyButton, revealButton] : [copyButton],
        target,
    }));

    const picker = vscode.window.createQuickPick<typeof items[number]>();
    picker.title = 'Diff Review — Register MCP Server';
    picker.placeholder = 'Select where to register the diff-review MCP server';
    picker.matchOnDetail = true;
    picker.items = items;

    picker.onDidTriggerItemButton(async event => {
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
        if (picked) { await registerWithConsumer(picked.target); }
    });

    picker.onDidHide(() => picker.dispose());
    picker.show();
}

// --------------- Interactive QuickPick Panel ---------------

async function showCommentPanel() {
    if (threadMap.size === 0 && driftedMap.size === 0) {
        vscode.window.showInformationMessage('No review comments.');
        return;
    }

    interface ActionItem extends vscode.QuickPickItem {
        action?: string;
        threadId?: number;
        fileKey?: string;
        driftedId?: number;
    }

    const qp = vscode.window.createQuickPick<ActionItem>();
    const openCount = [...threadMap.values()].filter(t => t.contextValue !== 'resolved').length;
    const resolvedCount = threadMap.size - openCount;
    const driftedCount = driftedMap.size;
    qp.title = `Review Comments (${openCount} open, ${resolvedCount} resolved${driftedCount > 0 ? `, ${driftedCount} drifted` : ''})`;
    qp.placeholder = 'Type to search comments… Select an action or comment.';
    qp.matchOnDescription = true;

    function buildItems(filter: string): ActionItem[] {
        const items: ActionItem[] = [];
        const lf = filter.toLowerCase();

        // Global actions (always shown)
        items.push(
            { label: '$(send) Submit All Open to Copilot', description: `${openCount} open`, action: 'submitAll' },
            { label: '$(clippy) Copy All Open to Clipboard', description: `${openCount} open`, action: 'copyAll' },
            { label: '$(check-all) Resolve All', description: `${openCount} open`, action: 'resolveAll' },
            { label: '$(trash) Delete All Resolved', description: `${resolvedCount} resolved`, action: 'deleteResolved' },
            { label: '$(clear-all) Clear All', description: `${threadMap.size} total`, action: 'clearAll' },
            { label: '', kind: vscode.QuickPickItemKind.Separator },
        );

        const byFile = getThreadsByFile();

        for (const [file, entries] of byFile) {
            const sorted = entries.sort((a, b) => a.thread.range.start.line - b.thread.range.start.line);

            // Filter: check if any comment in this file matches
            const matchingEntries = lf
                ? sorted.filter(({ thread }) => {
                    const texts = thread.comments.map(c =>
                        typeof c.body === 'string' ? c.body : c.body.value
                    ).join(' ').toLowerCase();
                    return file.toLowerCase().includes(lf) || texts.includes(lf);
                })
                : sorted;

            if (matchingEntries.length === 0) continue;

            const fileOpen = matchingEntries.filter(e => e.thread.contextValue !== 'resolved').length;
            const fileResolved = matchingEntries.length - fileOpen;

            // File header with batch actions
            items.push({ label: `📁 ${file}  (${fileOpen} open, ${fileResolved} resolved)`, kind: vscode.QuickPickItemKind.Separator });
            items.push(
                { label: `  $(send) Submit ${file}`, description: `${fileOpen} open`, action: 'submitFile', fileKey: file },
                { label: `  $(clippy) Copy ${file}`, description: `${fileOpen} open`, action: 'copyFile', fileKey: file },
                { label: `  $(check-all) Resolve ${file}`, description: `${fileOpen} open`, action: 'resolveFile', fileKey: file },
                { label: `  $(trash) Delete Resolved in ${file}`, description: `${fileResolved} resolved`, action: 'deleteResolvedFile', fileKey: file },
            );

            // Individual comments
            for (const { id, thread } of matchingEntries) {
                const line = thread.range.start.line + 1;
                const preview = threadPreview(thread);
                const resolved = thread.contextValue === 'resolved';
                const status = resolved ? '✅' : '💬';
                const replyCount = thread.comments.length - 1;
                const replyInfo = replyCount > 0 ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : '';
                const roles = thread.comments.map(c => (c as ReviewComment).role === 'agent' ? '🤖' : '👤').join('');
                items.push({
                    label: `    ${status} L${line}: ${preview}`,
                    description: `${roles}${replyInfo ? '  ' + replyInfo : ''}`,
                    threadId: id,
                    action: 'commentAction',
                });
            }
        }

        // Needs re-attaching (F4): drifted threads have left the gutter, so
        // they only ever appear here, grouped by their last-known file.
        if (driftedMap.size > 0) {
            const byDriftedFile = getDriftedByFile();
            const dl = filter.toLowerCase();
            items.push({ label: `🧩 Needs re-attaching (${driftedMap.size})`, kind: vscode.QuickPickItemKind.Separator });
            for (const [file, recs] of byDriftedFile) {
                const matching = dl
                    ? recs.filter(r => file.toLowerCase().includes(dl) || r.comments.some(c => c.body.toLowerCase().includes(dl)))
                    : recs;
                if (matching.length === 0) continue;
                if (matching.length > 1) {
                    items.push({ label: `  $(sync) Re-attach all in ${file}…`, description: `${matching.length} drifted`, action: 'reattachAllInFile', fileKey: file });
                }
                for (const rec of matching) {
                    items.push({
                        label: `    🧩 (was L${rec.lastKnownLine + 1}): ${driftedPreview(rec)}`,
                        description: file,
                        driftedId: rec.id,
                        action: 'driftedAction',
                    });
                }
            }
        }

        return items;
    }

    qp.items = buildItems('');
    qp.onDidChangeValue(value => { qp.items = buildItems(value); });

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
    const thread = threadMap.get(threadId);
    if (!thread) return;

    const rel = vscode.workspace.asRelativePath(thread.uri);
    const line = thread.range.start.line + 1;
    const preview = threadPreview(thread);
    const resolved = thread.contextValue === 'resolved';

    interface ActionItem extends vscode.QuickPickItem { action: string; }

    const items: ActionItem[] = [
        { label: '$(eye) Go to Comment', description: `${rel}:${line}`, action: 'goto' },
        { label: '$(send) Send to Copilot', description: 'Submit this comment as a prompt', action: 'send' },
        { label: '$(clippy) Copy to Clipboard', description: 'Copy this comment as a prompt', action: 'copy' },
        { label: resolved ? '$(debug-restart) Reopen' : '$(check) Resolve', action: resolved ? 'unresolve' : 'resolve' },
        { label: '$(trash) Delete', action: 'delete' },
    ];

    const pick = await vscode.window.showQuickPick(items, {
        title: `${resolved ? '✅' : '💬'} L${line}: ${preview}`,
        placeHolder: 'Choose an action',
    });

    if (!pick) return;

    switch (pick.action) {
        case 'goto': {
            const doc = await vscode.workspace.openTextDocument(thread.uri);
            const editor = await vscode.window.showTextDocument(doc);
            const pos = thread.range.start;
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(thread.range, vscode.TextEditorRevealType.InCenter);
            thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
            break;
        }
        case 'send':
            await vscode.commands.executeCommand('diffReview.sendThread', thread);
            break;
        case 'copy':
            await vscode.commands.executeCommand('diffReview.copyThread', thread);
            break;
        case 'resolve':
            resolveThread(thread);
            refresh();
            queueSaveForThread(thread);
            break;
        case 'unresolve':
            unresolveThread(thread);
            refresh();
            queueSaveForThread(thread);
            break;
        case 'delete': {
            const answer = await vscode.window.showWarningMessage(
                'Delete this comment thread?', { modal: true }, 'Delete'
            );
            if (answer !== 'Delete') break;
            const uri = thread.uri;
            threadMap.delete(threadId);
            thread.dispose();
            refresh();
            queueSaveForUri(uri);
            break;
        }
    }
}

// --------------- Drifted Comment Actions (F4) ---------------

async function showDriftedActions(id: number) {
    const rec = driftedMap.get(id);
    if (!rec) return;

    const uri = vscode.Uri.parse(rec.uri);
    const rel = vscode.workspace.asRelativePath(uri);
    const preview = driftedPreview(rec);
    const fileExists = uri.scheme === 'file' && fs.existsSync(uri.fsPath);

    interface ActionItem extends vscode.QuickPickItem { action: string; }

    const items: ActionItem[] = [
        { label: '$(diff) Show Original Context', description: `${rel} (was L${rec.lastKnownLine + 1})`, action: 'showContext' },
        ...(fileExists ? [
            { label: '$(target) Re-attach…', description: 'Place your cursor on the line, then confirm', action: 'reattach' },
            { label: '$(search) Search Again', description: 'Re-scan the file for this anchor', action: 'searchAgain' },
        ] : []),
        { label: '$(note) Keep as File Note', description: 'No specific line — attach to the top of the file', action: 'fileNote' },
        { label: rec.status === 'resolved' ? '$(debug-restart) Reopen' : '$(check) Resolve', action: 'toggleResolve' },
        { label: '$(trash) Delete', action: 'delete' },
    ];

    const pick = await vscode.window.showQuickPick(items, {
        title: `🧩 ${rel}: ${preview}`,
        placeHolder: 'This comment left the gutter — its original location was not found',
    });
    if (!pick) return;

    switch (pick.action) {
        case 'showContext':
            vscode.window.showInformationMessage(
                rec.anchorContext ? `Original context:\n${rec.anchorContext}` : 'No stored context for this comment.',
                { modal: true }
            );
            break;
        case 'reattach':
            await reattachDrifted(id);
            break;
        case 'searchAgain':
            await searchAgainForDrifted(id);
            break;
        case 'fileNote':
            await keepDriftedAsFileNote(id);
            break;
        case 'toggleResolve':
            rec.status = rec.status === 'resolved' ? 'open' : 'resolved';
            rec.updatedAt = new Date().toISOString();
            queueSaveForUri(uri);
            refresh();
            break;
        case 'delete': {
            const answer = await vscode.window.showWarningMessage('Delete this drifted comment?', { modal: true }, 'Delete');
            if (answer !== 'Delete') break;
            driftedMap.delete(id);
            queueSaveForUri(uri);
            refresh();
            break;
        }
    }
}

/** Re-run the drift ladder against the file's current content, in case the code came back (a rebase finishing, a branch switched back). */
async function searchAgainForDrifted(id: number) {
    const rec = driftedMap.get(id);
    if (!rec) return;
    const uri = vscode.Uri.parse(rec.uri);
    if (uri.scheme !== 'file' || !fs.existsSync(uri.fsPath)) {
        vscode.window.showInformationMessage('That file does not exist any more.');
        return;
    }
    // Without a stored anchorHash (this record predates anchoring, or was
    // hand-created) there is nothing to search for — only an exact re-attach applies.
    const doc = await vscode.workspace.openTextDocument(uri);
    vscode.window.showInformationMessage('Diff Review: no stored anchor to search for — use Re-attach instead to pick the line by hand.');
    void doc;
}

/** Opens the file and lets the user confirm the current cursor position as the new anchor. */
async function reattachDrifted(id: number) {
    const rec = driftedMap.get(id);
    if (!rec) return;
    const uri = vscode.Uri.parse(rec.uri);
    if (uri.scheme !== 'file' || !fs.existsSync(uri.fsPath)) {
        vscode.window.showWarningMessage('Diff Review: that file no longer exists.');
        return;
    }

    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    const choice = await vscode.window.showInformationMessage(
        'Place your cursor on the line this comment refers to, then confirm.',
        'Confirm', 'Cancel'
    );
    if (choice !== 'Confirm') return;

    const active = vscode.window.activeTextEditor;
    if (!active || active.document.uri.toString() !== uri.toString()) {
        vscode.window.showWarningMessage('Diff Review: the active editor changed — try again from the same file.');
        return;
    }
    const line = active.selection.active.line;
    finishReattach(id, uri, line);
    void editor;
}

function finishReattach(id: number, uri: vscode.Uri, line: number) {
    const rec = driftedMap.get(id);
    if (!rec || !activeController) return;

    let anchor: { anchorHash: string; anchorContext: string } | undefined;
    try {
        const lines = fs.readFileSync(uri.fsPath, 'utf-8').split(/\r\n|\n/);
        if (line >= 0 && line < lines.length) {
            const context = anchorContextSnippet(lines, line, ANCHOR_CONTEXT_RADIUS);
            anchor = { anchorHash: hashAnchor(lines[line], context.split('\n')), anchorContext: context };
        }
    } catch { /* best effort */ }

    const range = new vscode.Range(line, 0, line, 0);
    const thread = activeController.createCommentThread(uri, range, []);
    thread.comments = rec.comments.map(c => new ReviewComment(c.body, c.role, c.id, c.timestamp));
    thread.canReply = true;
    if (rec.status === 'resolved') {
        thread.label = '✅ Resolved'; thread.contextValue = 'resolved';
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    } else {
        thread.label = 'Open'; thread.contextValue = 'open';
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }
    trackThread(thread, id, anchor);
    driftedMap.delete(id);
    refresh();
    queueSaveForThread(thread);
    vscode.window.showInformationMessage('Diff Review: comment re-attached.');
}

/** Accept a drifted comment as file-level — anchored at line 0 with no further drift checking. */
async function keepDriftedAsFileNote(id: number) {
    const rec = driftedMap.get(id);
    if (!rec || !activeController) return;
    const uri = vscode.Uri.parse(rec.uri);
    const range = new vscode.Range(0, 0, 0, 0);
    const thread = activeController.createCommentThread(uri, range, []);
    thread.comments = rec.comments.map(c => new ReviewComment(c.body, c.role, c.id, c.timestamp));
    thread.canReply = true;
    thread.label = rec.status === 'resolved' ? '✅ Resolved (file note)' : 'Open (file note)';
    thread.contextValue = rec.status === 'resolved' ? 'resolved' : 'open';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    trackThread(thread, id); // no anchor — this thread is intentionally exempt from future drift checks
    driftedMap.delete(id);
    refresh();
    queueSaveForThread(thread);
}

async function reattachAllInFile(fileKey: string) {
    const byDriftedFile = getDriftedByFile();
    const recs = byDriftedFile.get(fileKey);
    if (!recs || recs.length === 0) return;
    for (const rec of [...recs]) {
        if (!driftedMap.has(rec.id)) continue; // handled by a previous iteration (e.g. deleted)
        await showDriftedActions(rec.id);
    }
}

// --------------- Submit All ---------------

async function submitAll() {
    const openThreads = [...threadMap.values()].filter(t => t.contextValue !== 'resolved');
    if (openThreads.length === 0) {
        vscode.window.showInformationMessage('No open review comments to submit.');
        return;
    }
    const prompt = await buildPrompt(openThreads);
    try {
        await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
    } catch {
        await vscode.env.clipboard.writeText(prompt);
        vscode.window.showInformationMessage(
            `Prompt with ${openThreads.length} comment(s) copied to clipboard.`
        );
    }
}

// --------------- Git Diff Context ---------------

interface DiffHunk {
    header: string;
    lines: string[];
}

async function getFileDiffHunks(uri: vscode.Uri): Promise<DiffHunk[]> {
    try {
        const git = getGitApi();
        if (!git) return [];
        const repo = git.repositories.find((r: any) =>
            uri.fsPath.startsWith(r.rootUri.fsPath)
        );
        if (!repo) return [];

        // Get unstaged diff (working tree vs index)
        const unstaged = await repo.diff(false) || '';
        // Get staged diff (index vs HEAD)
        const staged = await repo.diff(true) || '';
        // Combine — unstaged first since it reflects current file state
        const fullDiff = unstaged + '\n' + staged;

        if (!fullDiff.trim()) return [];

        const rel = path.relative(repo.rootUri.fsPath, uri.fsPath).replace(/\\/g, '/');

        // Split diff into per-file sections
        const fileSections = fullDiff.split(/^(?=diff --git )/m);
        const targetPrefix = `diff --git a/${rel} b/${rel}`;
        const fileSection = fileSections.find(s => s.startsWith(targetPrefix));
        if (!fileSection) return [];

        // Split into hunks by @@ markers
        const hunkParts = fileSection.split(/^(?=@@)/m);
        const hunks: DiffHunk[] = [];

        for (const part of hunkParts) {
            if (!part.startsWith('@@')) continue;
            const lines = part.split('\n');
            const header = lines[0];
            const body = lines.slice(1).filter(l => l !== '' || lines.indexOf(l) < lines.length - 1);
            hunks.push({ header, lines: body });
        }

        return hunks;
    } catch {
        return [];
    }
}

function findRelevantHunk(hunks: DiffHunk[], targetLine: number): string | undefined {
    for (const hunk of hunks) {
        // Parse @@ -oldStart,oldCount +newStart,newCount @@
        const m = hunk.header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (!m) continue;

        const newStart = parseInt(m[3], 10);
        const newCount = parseInt(m[4] ?? '1', 10);
        const newEnd = newStart + newCount - 1;

        // Target line is 1-based
        if (targetLine >= newStart && targetLine <= newEnd) {
            // Return the hunk with limited context (max 15 lines around comment)
            const allLines = [hunk.header, ...hunk.lines];
            if (allLines.length <= 20) return allLines.join('\n');
            // Find the approximate position in the hunk
            let newLineCounter = newStart;
            let bestIndex = 1; // skip header
            for (let i = 1; i < allLines.length; i++) {
                const line = allLines[i];
                if (!line.startsWith('-')) {
                    if (newLineCounter === targetLine) {
                        bestIndex = i;
                        break;
                    }
                    newLineCounter++;
                }
            }
            const start = Math.max(1, bestIndex - 7);
            const end = Math.min(allLines.length, bestIndex + 7);
            return [hunk.header, ...allLines.slice(start, end)].join('\n');
        }
    }
    return undefined;
}

// --------------- Prompt Builder ---------------

async function buildPrompt(targetThreads: vscode.CommentThread[]): Promise<string> {
    const byFile = new Map<string, vscode.CommentThread[]>();
    for (const thread of targetThreads) {
        const key = thread.uri.toString();
        if (!byFile.has(key)) byFile.set(key, []);
        byFile.get(key)!.push(thread);
    }

    const parts: string[] = [];
    parts.push(
        'Inspect the following review comments to the code. Each comment includes ' +
        'the file, line number, surrounding code context, the git diff (if available), and the comment text itself.\n'
    );

    for (const [uriStr, fileThreads] of byFile) {
        const uri = vscode.Uri.parse(uriStr);
        const rel = vscode.workspace.asRelativePath(uri);
        parts.push(`## ${rel}\n`);

        // Get diff hunks for this file (once per file)
        const hunks = await getFileDiffHunks(uri);

        const sorted = [...fileThreads].sort(
            (a, b) => a.range.start.line - b.range.start.line
        );

        for (const thread of sorted) {
            const line = thread.range.start.line + 1;

            // Format comment thread with roles
            const body = thread.comments
                .map(c => {
                    const role = (c as ReviewComment).role || 'user';
                    const text = typeof c.body === 'string' ? c.body : c.body.value;
                    return thread.comments.length > 1 ? `[${role}]: ${text}` : text;
                })
                .join('\n');

            // Grab ~5 lines of surrounding code for context
            let codeContext = '';
            try {
                let doc = vscode.workspace.textDocuments.find(
                    d => d.uri.toString() === uriStr
                );
                if (!doc) {
                    doc = vscode.workspace.textDocuments.find(
                        d => d.uri.fsPath === uri.fsPath
                    );
                }
                if (!doc) {
                    doc = await vscode.workspace.openTextDocument(uri);
                }
                const s = Math.max(0, thread.range.start.line - 2);
                const e = Math.min(doc.lineCount - 1, thread.range.end.line + 2);
                const lines: string[] = [];
                for (let i = s; i <= e; i++) {
                    const marker = i === thread.range.start.line ? '→' : ' ';
                    lines.push(`${marker} ${i + 1} | ${doc.lineAt(i).text}`);
                }
                codeContext = lines.join('\n');
            } catch {
                // Proceed without context
            }

            // Find relevant diff hunk for this line
            const diffHunk = findRelevantHunk(hunks, line);

            const tid = threadIds.get(thread);
            parts.push(tid !== undefined ? `### Line ${line} (Thread #${tid})` : `### Line ${line}`);
            if (codeContext) {
                parts.push('```');
                parts.push(codeContext);
                parts.push('```');
            }
            if (diffHunk) {
                parts.push('**Git diff:**');
                parts.push('```diff');
                parts.push(diffHunk);
                parts.push('```');
            }
            parts.push(`**Comment:** ${body}\n`);
        }
    }

    parts.push('---');
    parts.push('Address the review comments above. Keep all other code unchanged.');
    parts.push('');
    parts.push('Each comment heading carries its thread ID as "(Thread #N)"; use that N as threadId below.');
    parts.push('After making the changes, use the review tools to respond:');
    parts.push('- Use replyToDiffComment (with threadId and text) to explain what you changed for each comment');
    parts.push('- Use resolveDiffComment (with threadId) to mark each comment as done, once the change is made');
    parts.push('- If you could not address a comment, reply explaining why and leave it unresolved');
    return parts.join('\n');
}

// --------------- Copilot Tools ---------------

function registerTools(context: vscode.ExtensionContext) {
    if (!vscode.lm || !vscode.lm.registerTool) return;

    context.subscriptions.push(
        vscode.lm.registerTool('diffReview_listComments', new ListCommentsTool()),
        vscode.lm.registerTool('diffReview_replyToComment', new ReplyToCommentTool()),
        vscode.lm.registerTool('diffReview_resolveComment', new ResolveCommentTool()),
        vscode.lm.registerTool('diffReview_deleteComment', new DeleteCommentTool()),
    );
}

class ListCommentsTool implements vscode.LanguageModelTool<{}> {
    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<{}>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (threadMap.size === 0 && driftedMap.size === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No review comments.')
            ]);
        }
        const lines: string[] = [];
        for (const [id, thread] of threadMap) {
            const rel = vscode.workspace.asRelativePath(thread.uri);
            const line = thread.range.start.line + 1;
            const status = thread.contextValue === 'resolved' ? 'RESOLVED' : 'OPEN';
            const comments = thread.comments.map(c => {
                const role = (c as ReviewComment).role || 'user';
                const text = typeof c.body === 'string' ? c.body : c.body.value;
                return `  [${role}] ${text}`;
            }).join('\n');
            lines.push(`#${id} | ${rel}:${line} | ${status}\n${comments}`);
        }
        for (const [id, rec] of driftedMap) {
            const rel = vscode.workspace.asRelativePath(vscode.Uri.parse(rec.uri));
            const comments = rec.comments.map(c => `  [${c.role}] ${c.body}`).join('\n');
            lines.push(`#${id} | DRIFTED (was ${rel}:${rec.lastKnownLine + 1}) | ${rec.status.toUpperCase()}\n${comments}`);
        }
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(lines.join('\n\n'))
        ]);
    }
}

interface ReplyParams { commentId: number; text: string; }

class ReplyToCommentTool implements vscode.LanguageModelTool<ReplyParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ReplyParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { commentId, text } = options.input;
        const found = findThreadOrDrifted(commentId);
        if (!found) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Comment #${commentId} not found.`)
            ]);
        }
        if (found.kind === 'live') {
            const reply = new ReviewComment(text, 'agent');
            found.thread.comments = [...found.thread.comments, reply];
            found.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
            touchThread(found.thread);
            queueSaveForThread(found.thread);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Replied to comment #${commentId} as agent.`)
            ]);
        }
        const comment: SerializedComment = { id: nextCommentId++, role: 'agent', body: text, timestamp: new Date().toISOString() };
        found.rec.comments.push(comment);
        found.rec.updatedAt = comment.timestamp;
        queueSaveForUri(vscode.Uri.parse(found.rec.uri));
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Replied to comment #${commentId} as agent. Note: this thread is DRIFTED — its original location was not found, so the reply may no longer be actionable at a specific line.`)
        ]);
    }
}

interface CommentIdParam { commentId: number; }

class ResolveCommentTool implements vscode.LanguageModelTool<CommentIdParam> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<CommentIdParam>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { commentId } = options.input;
        const found = findThreadOrDrifted(commentId);
        if (!found) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Comment #${commentId} not found.`)
            ]);
        }
        if (found.kind === 'live') {
            resolveThread(found.thread);
            refresh();
            queueSaveForThread(found.thread);
        } else {
            found.rec.status = 'resolved';
            found.rec.updatedAt = new Date().toISOString();
            queueSaveForUri(vscode.Uri.parse(found.rec.uri));
        }
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Comment #${commentId} resolved.`)
        ]);
    }
}

class DeleteCommentTool implements vscode.LanguageModelTool<CommentIdParam> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<CommentIdParam>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { commentId } = options.input;
        const found = findThreadOrDrifted(commentId);
        if (!found) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Comment #${commentId} not found.`)
            ]);
        }
        if (found.kind === 'live') {
            threadMap.delete(commentId);
            const uri = found.thread.uri;
            found.thread.dispose();
            refresh();
            queueSaveForUri(uri);
        } else {
            driftedMap.delete(commentId);
            queueSaveForUri(vscode.Uri.parse(found.rec.uri));
        }
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Comment #${commentId} deleted.`)
        ]);
    }
}

export function deactivate(): Thenable<void> {
    for (const folder of folders) folder.watcher?.dispose();
    return flushAllSaves();
}
