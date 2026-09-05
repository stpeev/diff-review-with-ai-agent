import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LAUNCHER_FILE, POINTER_FILE, STATE_DIR, Resolution, fromEnv, fromPointerFile, resolveServer } from './mcp-resolve';

// --------------- Types ---------------

type Role = 'user' | 'agent';

interface SerializedComment {
    id: number;
    role: Role;
    body: string;
    timestamp: string;
}

interface SerializedThread {
    id: number;
    uri: string;
    startLine: number;
    endLine: number;
    status: 'open' | 'resolved';
    comments: SerializedComment[];
}

interface SerializedState {
    version: 1;
    nextThreadId: number;
    nextCommentId: number;
    threads: SerializedThread[];
}

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

const threadMap = new Map<number, vscode.CommentThread>();
const threadIds = new WeakMap<vscode.CommentThread, number>();
let nextThreadId = 1;

function trackThread(thread: vscode.CommentThread, id?: number): number {
    const tid = id ?? nextThreadId++;
    threadMap.set(tid, thread);
    threadIds.set(thread, tid);
    return tid;
}

function untrackThread(thread: vscode.CommentThread): void {
    const id = threadIds.get(thread);
    if (id !== undefined) threadMap.delete(id);
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

function threadPreview(thread: vscode.CommentThread): string {
    const first = thread.comments[0];
    const text = typeof first.body === 'string' ? first.body : first.body.value;
    return text.length > 55 ? text.substring(0, 52) + '...' : text;
}

function resolveThread(thread: vscode.CommentThread) {
    thread.label = '✅ Resolved';
    thread.contextValue = 'resolved';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
}

function unresolveThread(thread: vscode.CommentThread) {
    thread.label = 'Open';
    thread.contextValue = 'open';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
}

// --------------- Status Bar ---------------

let statusBar: vscode.StatusBarItem;

function refresh() {
    const n = threadMap.size;
    const open = [...threadMap.values()].filter(t => t.contextValue !== 'resolved').length;
    if (n > 0) {
        statusBar.text = `$(comment-discussion) ${open} open · ${n - open} resolved`;
        statusBar.show();
    } else {
        statusBar.hide();
    }
}

// --------------- Persistence (branch-scoped) ---------------

let extensionContext: vscode.ExtensionContext;
let activeController: vscode.CommentController | undefined;
let currentBranchKey: string = '_default';
let outputLog: vscode.OutputChannel;

function getGitApi(): any | undefined {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (!gitExtension?.isActive) return undefined;
    return gitExtension.exports.getAPI(1);
}

function getBranchKey(): string {
    try {
        const git = getGitApi();
        if (!git) return '_default';
        const repos = git.repositories;
        if (!repos || repos.length === 0) return '_default';
        // Use first repo (most common case)
        const repo = repos[0];
        const repoName = path.basename(repo.rootUri.fsPath);
        const branch = repo.state?.HEAD?.name || '_detached';
        return `${repoName}.${branch}`;
    } catch {
        return '_default';
    }
}

function stateKey(branchKey?: string): string {
    return `diffReview.state.${branchKey ?? currentBranchKey}`;
}

function serializeState(): SerializedState {
    const threads: SerializedThread[] = [];
    for (const [id, thread] of threadMap) {
        threads.push({
            id,
            uri: thread.uri.toString(),
            startLine: thread.range.start.line,
            endLine: thread.range.end.line,
            status: thread.contextValue === 'resolved' ? 'resolved' : 'open',
            comments: thread.comments.map(c => {
                const rc = c as ReviewComment;
                return {
                    id: rc.id,
                    role: rc.role,
                    body: typeof rc.body === 'string' ? rc.body : rc.body.value,
                    timestamp: rc.createdAt,
                };
            }),
        });
    }
    return { version: 1, nextThreadId, nextCommentId, threads };
}

function saveState() {
    extensionContext.workspaceState.update(stateKey(), serializeState());
}

function clearThreads() {
    for (const thread of threadMap.values()) thread.dispose();
    threadMap.clear();
    nextThreadId = 1;
    nextCommentId = 1;
}

function loadStateFromKey(controller: vscode.CommentController, key: string) {
    const data = extensionContext.workspaceState.get<SerializedState>(stateKey(key));
    if (!data || !data.threads) return;

    nextThreadId = data.nextThreadId || 1;
    nextCommentId = data.nextCommentId || 1;

    for (const st of data.threads) {
        const uri = vscode.Uri.parse(st.uri);
        const range = new vscode.Range(st.startLine, 0, st.endLine, 0);
        const thread = controller.createCommentThread(uri, range, []);
        const comments = st.comments.map(
            sc => new ReviewComment(sc.body, sc.role, sc.id, sc.timestamp || new Date().toISOString())
        );
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
        trackThread(thread, st.id);
    }
}

function switchToBranch(controller: vscode.CommentController, newKey: string) {
    if (newKey === currentBranchKey) return;

    outputLog.appendLine(`[Diff Review] Branch switch: ${currentBranchKey} → ${newKey}`);

    // Save current branch's comments
    saveState();

    // Clear current threads from UI
    clearThreads();

    const oldKey = currentBranchKey;
    currentBranchKey = newKey;

    // Try loading saved state for the new branch
    const newData = extensionContext.workspaceState.get<SerializedState>(stateKey(newKey));

    if (newData && newData.threads && newData.threads.length > 0) {
        // New branch has its own saved comments — load them
        loadStateFromKey(controller, newKey);
        outputLog.appendLine(`[Diff Review] Loaded ${threadMap.size} comments for branch ${newKey}`);
    } else {
        // New branch has no saved comments — copy from the old branch (Option B)
        loadStateFromKey(controller, oldKey);
        if (threadMap.size > 0) {
            // Save the copied state under the new branch key
            saveState();
            outputLog.appendLine(`[Diff Review] Inherited ${threadMap.size} comments from ${oldKey} to ${newKey}`);
        } else {
            outputLog.appendLine(`[Diff Review] No comments to inherit — clean slate for ${newKey}`);
        }
    }

    refresh();
}

function setupBranchWatcher(context: vscode.ExtensionContext, controller: vscode.CommentController) {
    try {
        const git = getGitApi();
        if (!git) {
            outputLog.appendLine('[Diff Review] Git API not available — branch scoping disabled');
            return;
        }
        for (const repo of git.repositories) {
            repo.state.onDidChange(() => {
                const newKey = getBranchKey();
                if (newKey !== currentBranchKey) {
                    switchToBranch(controller, newKey);
                }
            });
        }
        // Also watch for new repos being opened
        git.onDidOpenRepository((repo: any) => {
            repo.state.onDidChange(() => {
                const newKey = getBranchKey();
                if (newKey !== currentBranchKey) {
                    switchToBranch(controller, newKey);
                }
            });
        });
        outputLog.appendLine(`[Diff Review] Branch watcher active, current: ${currentBranchKey}`);
    } catch (e: any) {
        outputLog.appendLine(`[Diff Review] Branch watcher setup failed: ${e.message}`);
    }
}

// --------------- Line Tracking ---------------

function setupLineTracking(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.contentChanges.length === 0) return;

            // Only track changes for documents that have comment threads
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

            for (const change of changes) {
                const startLine = change.range.start.line;
                const oldEndLine = change.range.end.line;
                // Normalize CRLF → LF before counting newlines
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
                    }
                }
            }

            saveState();
        })
    );
}

// --------------- IPC HTTP Server ---------------

let ipcServer: http.Server | undefined;
let ipcPort: number = 0;

function startIpcServer(context: vscode.ExtensionContext): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            // CORS headers for local use
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Access-Control-Allow-Origin', 'localhost');

            const url = new URL(req.url || '/', `http://localhost`);
            const method = req.method || 'GET';

            try {
                if (method === 'GET' && url.pathname === '/comments') {
                    // List all comments
                    const result = serializeState();
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                } else if (method === 'POST' && url.pathname === '/reply') {
                    const body = await readBody(req);
                    const { threadId, text } = JSON.parse(body);
                    const thread = threadMap.get(threadId);
                    if (!thread) {
                        res.writeHead(404);
                        res.end(JSON.stringify({ error: `Thread #${threadId} not found` }));
                        return;
                    }
                    const reply = new ReviewComment(text, 'agent');
                    thread.comments = [...thread.comments, reply];
                    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
                    saveState();
                    res.writeHead(200);
                    res.end(JSON.stringify({ ok: true, commentId: reply.id }));
                } else if (method === 'POST' && url.pathname === '/resolve') {
                    const body = await readBody(req);
                    const { threadId } = JSON.parse(body);
                    const thread = threadMap.get(threadId);
                    if (!thread) {
                        res.writeHead(404);
                        res.end(JSON.stringify({ error: `Thread #${threadId} not found` }));
                        return;
                    }
                    resolveThread(thread);
                    refresh();
                    saveState();
                    res.writeHead(200);
                    res.end(JSON.stringify({ ok: true }));
                } else if (method === 'POST' && url.pathname === '/unresolve') {
                    const body = await readBody(req);
                    const { threadId } = JSON.parse(body);
                    const thread = threadMap.get(threadId);
                    if (!thread) {
                        res.writeHead(404);
                        res.end(JSON.stringify({ error: `Thread #${threadId} not found` }));
                        return;
                    }
                    unresolveThread(thread);
                    refresh();
                    saveState();
                    res.writeHead(200);
                    res.end(JSON.stringify({ ok: true }));
                } else if (method === 'POST' && url.pathname === '/delete') {
                    const body = await readBody(req);
                    const { threadId } = JSON.parse(body);
                    const thread = threadMap.get(threadId);
                    if (!thread) {
                        res.writeHead(404);
                        res.end(JSON.stringify({ error: `Thread #${threadId} not found` }));
                        return;
                    }
                    threadMap.delete(threadId);
                    thread.dispose();
                    refresh();
                    saveState();
                    res.writeHead(200);
                    res.end(JSON.stringify({ ok: true }));
                } else if (method === 'GET' && url.pathname === '/health') {
                    res.writeHead(200);
                    res.end(JSON.stringify({ ok: true, comments: threadMap.size }));
                } else {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'Not found' }));
                }
            } catch (err: any) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });

        // Listen on random available port
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (addr && typeof addr !== 'string') {
                ipcPort = addr.port;
                ipcServer = server;
                // Write port file so MCP server can find us
                const portFile = path.join(os.tmpdir(), 'diff-review-port');
                fs.writeFileSync(portFile, String(ipcPort), 'utf-8');
                resolve(ipcPort);
            } else {
                reject(new Error('Failed to get server address'));
            }
        });

        server.on('error', reject);
        context.subscriptions.push({ dispose: () => { server.close(); try { fs.unlinkSync(path.join(os.tmpdir(), 'diff-review-port')); } catch {} } });
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
            label: '$(warning) Clients resolve a different build than this window',
            detail: why,
        });
    } else if (!resolved) {
        rows.push({ label: '$(error) Cannot resolve a server', detail: resolveError });
    }

    rows.push({
        label: '$(rocket) Launcher',
        detail: `${homeShort(LAUNCHER_FILE)} — ${existsNote(LAUNCHER_FILE)} · point your MCP client here`,
        copy: LAUNCHER_FILE,
        reveal: LAUNCHER_FILE,
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

    rows.push({
        label: '$(vm) This window’s build',
        detail: `${homeShort(ownServer)} — v${context.extension.packageJSON.version} · ${existsNote(ownServer)}`,
        copy: ownServer,
        reveal: ownServer,
    });

    const portFile = path.join(os.tmpdir(), 'diff-review-port');
    rows.push({
        label: '$(plug) IPC port',
        detail: ipcPort
            ? `${ipcPort} — advertised in ${portFile}`
            : `not listening — ${portFile} may be stale`,
        copy: ipcPort ? String(ipcPort) : undefined,
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

    rows.push({
        label: '$(terminal) Add to Claude Code',
        detail: `claude mcp add diff-review node ${homeShort(LAUNCHER_FILE)}`,
        copy: `claude mcp add diff-review node ${LAUNCHER_FILE}`,
    });

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

    // --- Status bar (MUST be created before loadState/refresh) ---
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusBar.command = 'diffReview.showPanel';
    statusBar.tooltip = 'Click to view review comments';
    context.subscriptions.push(statusBar);

    // --- Detect current branch and load state ---
    currentBranchKey = getBranchKey();
    outputLog.appendLine(`[Diff Review] Current branch key: ${currentBranchKey}`);

    // Migrate old unscoped state if it exists
    const oldData = extensionContext.workspaceState.get<SerializedState>('diffReview.state');
    if (oldData && oldData.threads && oldData.threads.length > 0) {
        const scopedData = extensionContext.workspaceState.get<SerializedState>(stateKey());
        if (!scopedData || !scopedData.threads || scopedData.threads.length === 0) {
            extensionContext.workspaceState.update(stateKey(), oldData);
            outputLog.appendLine(`[Diff Review] Migrated ${oldData.threads.length} threads from unscoped to ${currentBranchKey}`);
        }
        extensionContext.workspaceState.update('diffReview.state', undefined);
    }

    try {
        loadStateFromKey(controller, currentBranchKey);
        outputLog.appendLine(`[Diff Review] Loaded ${threadMap.size} persisted threads for ${currentBranchKey}`);
    } catch (e: any) {
        outputLog.appendLine(`[Diff Review] Error loading state: ${e.message}`);
    }
    refresh();

    // --- Line tracking ---
    setupLineTracking(context);

    // --- Branch watcher ---
    setupBranchWatcher(context, controller);

    // --- MCP launcher ---
    deployMcpLauncher(context);

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
            trackThread(thread);
            refresh();
            saveState();
        })
    );

    // --- Reply (additional comments in existing thread) ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.reply', (reply: vscode.CommentReply) => {
            const thread = reply.thread;
            const comment = new ReviewComment(reply.text, 'user');
            thread.comments = [...thread.comments, comment];
            saveState();
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
            saveState();
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
            if (thread.comments.length <= 1) {
                untrackThread(thread);
                thread.dispose();
            } else {
                thread.comments = thread.comments.filter(
                    c => (c as ReviewComment).id !== comment.id
                );
            }
            refresh();
            saveState();
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
            saveState();
        })
    );

    // --- Unresolve thread ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.unresolve', (thread: vscode.CommentThread) => {
            unresolveThread(thread);
            refresh();
            saveState();
        })
    );

    // --- Show MCP server info ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.showMcpInfo', () => showMcpInfo(context))
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
            for (const thread of threadMap.values()) {
                if (thread.contextValue !== 'resolved') { resolveThread(thread); count++; }
            }
            refresh();
            saveState();
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
            for (const [id, thread] of resolved) { threadMap.delete(id); thread.dispose(); }
            refresh();
            saveState();
        })
    );

    // --- Clear all ---
    context.subscriptions.push(
        vscode.commands.registerCommand('diffReview.clearAll', async () => {
            if (threadMap.size === 0) return;
            const answer = await vscode.window.showWarningMessage(
                `Delete all ${threadMap.size} review comment${threadMap.size !== 1 ? 's' : ''}?`, { modal: true }, 'Delete All'
            );
            if (answer !== 'Delete All') return;
            for (const thread of threadMap.values()) thread.dispose();
            threadMap.clear();
            refresh();
            saveState();
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
            for (const { thread } of entries) {
                if (thread.contextValue !== 'resolved') { resolveThread(thread); count++; }
            }
            refresh();
            saveState();
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
            for (const { id, thread } of resolved) { threadMap.delete(id); thread.dispose(); }
            refresh();
            saveState();
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

// --------------- Interactive QuickPick Panel ---------------

async function showCommentPanel() {
    if (threadMap.size === 0) {
        vscode.window.showInformationMessage('No review comments.');
        return;
    }

    interface ActionItem extends vscode.QuickPickItem {
        action?: string;
        threadId?: number;
        fileKey?: string;
    }

    const qp = vscode.window.createQuickPick<ActionItem>();
    const openCount = [...threadMap.values()].filter(t => t.contextValue !== 'resolved').length;
    const resolvedCount = threadMap.size - openCount;
    qp.title = `Review Comments (${openCount} open, ${resolvedCount} resolved)`;
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
            break;
        case 'unresolve':
            unresolveThread(thread);
            refresh();
            break;
        case 'delete': {
            const answer = await vscode.window.showWarningMessage(
                'Delete this comment thread?', { modal: true }, 'Delete'
            );
            if (answer !== 'Delete') break;
            threadMap.delete(threadId);
            thread.dispose();
            refresh();
            break;
        }
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

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

            parts.push(`### Line ${line}`);
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
    parts.push('Inspect the following review comments. Keep all other code unchanged.');
    parts.push('');
    parts.push('After making the changes, use the review tools to respond:');
    parts.push('- Use replyToDiffComment (with commentId and text) to explain what you changed for each comment');
    parts.push('- Use resolveDiffComment (with commentId) to mark each comment as done');
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
        if (threadMap.size === 0) {
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
        const thread = threadMap.get(commentId);
        if (!thread) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Comment #${commentId} not found.`)
            ]);
        }
        const reply = new ReviewComment(text, 'agent');
        thread.comments = [...thread.comments, reply];
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        saveState();
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Replied to comment #${commentId} as agent.`)
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
        const thread = threadMap.get(commentId);
        if (!thread) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Comment #${commentId} not found.`)
            ]);
        }
        thread.label = '✅ Resolved';
        thread.contextValue = 'resolved';
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        refresh();
        saveState();
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
        const thread = threadMap.get(commentId);
        if (!thread) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Comment #${commentId} not found.`)
            ]);
        }
        threadMap.delete(commentId);
        thread.dispose();
        refresh();
        saveState();
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Comment #${commentId} deleted.`)
        ]);
    }
}

export function deactivate() {}
