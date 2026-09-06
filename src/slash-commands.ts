/**
 * The two Diff Review slash commands — `/perform-diff-review` and
 * `/address-diff-review` — as installable files for every agent that reads
 * commands from its own directory.
 *
 * One instruction body per command, wrapped in four formats. Only the
 * frontmatter differs per format; the Markdown below each command's marker
 * line is identical across all four, so each body is one thing to author and
 * one thing to review. See docs/superpowers/specs/2026-09-05-agent-slash-command-design.md.
 *
 * Pure: no `vscode` import, so it is requirable under plain `node --test`.
 * See test/slash-commands.test.js.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readText, backup } from './file-write';
import { VSCODE_APPS, userDataRoot, parseProfiles } from './vscode-profiles';

export type CommandId = 'perform' | 'address';
export type CommandKind = 'claude-md' | 'codex-md' | 'gemini-toml' | 'vscode-prompt';

export const INVOCATION: Record<CommandId, string> = {
    perform: '/perform-diff-review',
    address: '/address-diff-review',
};

export const MARKER: Record<CommandId, string> = {
    perform: '<!-- diff-review:perform v1 -->',
    address: '<!-- diff-review:address v1 -->',
};

const DESCRIPTION: Record<CommandId, string> = {
    perform: 'Review the current branch against its merge-base and leave inline Diff Review comments on what you find',
    address: 'Work every open Diff Review comment thread: address it in code, reply, and resolve',
};

const ALLOWED_TOOLS: Record<CommandId, string> = {
    perform: 'Bash, Read, Grep, Glob, mcp__diff-review__listDiffComments, mcp__diff-review__createDiffComment',
    address: 'Bash, Read, Edit, Grep, Glob, mcp__diff-review__listDiffComments, mcp__diff-review__replyToDiffComment, mcp__diff-review__resolveDiffComment',
};

// --------------- The shared instructional bodies ---------------

const BODY: Record<CommandId, string> = {
    perform: `${MARKER.perform}

# Perform a diff review

Review the current branch and leave inline comments on what you find, using
the Diff Review MCP tools. This command never edits code and never commits —
its entire output is comment threads for a human to read, and for
\`/address-diff-review\` to work afterwards.

## Procedure

### 1. Confirm the MCP server is reachable

Call \`listDiffComments\`. If the tool is not available, stop and tell the
user to run **\`Diff Review: Register MCP Server with a Coding Agent\`** from
the command palette — this command is useless without it.

Otherwise, note what it returns: the threads that already exist, so the
review below does not restate them.

### 2. Establish the diff range

Find the merge-base of \`HEAD\` against the first of \`origin/main\`, \`main\`,
or \`master\` that resolves:

\`\`\`bash
git merge-base HEAD origin/main 2>/dev/null \\
  || git merge-base HEAD main 2>/dev/null \\
  || git merge-base HEAD master 2>/dev/null
\`\`\`

Review \`git diff <base>...HEAD\` **plus** any uncommitted working-tree
changes (\`git diff HEAD\`). If no base resolves, say so and review the
working tree only.

### 3. Review the changed lines

Read the diff hunks, then read each changed file in full to get real context
around them. Focus on **correctness** — bugs, unhandled edge cases, missing
error handling, broken invariants — not style, not naming preferences, and
not pre-existing code the diff merely sits beside.

### 4. Leave a comment per finding

For each finding, call \`createDiffComment\` with:
- the workspace-relative file path
- the **1-based line number in the file as it stands right now** — diff
  hunk numbering is not file numbering, so read the file and confirm the
  line before commenting
- a specific, actionable description of the problem

One finding per thread. Do not bundle unrelated findings into one comment.

### 5. Never edit code. Never commit.

This command's entire output is comment threads. Fixing them is
\`/address-diff-review\`'s job, after the user has had a chance to read,
edit, or delete what you left.

### 6. Report

Summarise what you did: how many threads you created and where, and what
you reviewed but found clean.
`,
    address: `${MARKER.address}

# Address diff review comments

Work every open Diff Review comment thread, using the Diff Review MCP tools.

## Procedure

### 1. Confirm the MCP server is reachable

Call \`listDiffComments\`. If the tool is not available, stop and tell the
user to run **\`Diff Review: Register MCP Server with a Coding Agent\`** from
the command palette — this command is useless without it.

### 2. Work the open threads oldest-first

For each open thread, in order: read its full text and the surrounding code,
then make the change it asks for.

### 3. Reply to every thread you touch

Call \`replyToDiffComment\` stating exactly what changed — or, if you decided
not to change anything, why not. Do not resolve a thread without replying to
it first.

### 4. Resolve only what you actually addressed

Call \`resolveDiffComment\` only on threads you changed code for (or
explicitly decided, with a stated reason, needed no change). Leave anything
you could not act on open.

### 5. Never commit

Committing stays the user's call.

### 6. Report

State what you addressed, what you left open, and why.
`,
};

// --------------- Per-format wrapping ---------------

function claudeMd(command: CommandId): string {
    return `---\ndescription: ${DESCRIPTION[command]}\nallowed-tools: ${ALLOWED_TOOLS[command]}\n---\n\n${BODY[command]}`;
}

function vscodePromptMd(command: CommandId): string {
    return `---\ndescription: ${DESCRIPTION[command]}\nmode: agent\n---\n\n${BODY[command]}`;
}

function codexMd(command: CommandId): string {
    return BODY[command];
}

/**
 * Escape a body for embedding inside a TOML basic multi-line string
 * (`"""..."""`): a backslash starts an escape sequence, and a literal
 * `"""` inside the body would terminate the string early. Neither appears
 * in the authored bodies above, but escaping both means a future edit that
 * introduces either does not silently corrupt the Gemini file.
 */
function escapeTomlMultilineString(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
}

function escapeTomlString(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function geminiToml(command: CommandId): string {
    const description = escapeTomlString(DESCRIPTION[command]);
    // BODY[command] already ends in a single newline, so no extra one is
    // added before the closing delimiter — otherwise the Gemini file would
    // carry a blank line the other three formats don't.
    const body = escapeTomlMultilineString(BODY[command]);
    return `description = "${description}"\nprompt = """\n${body}"""\n`;
}

/** The full file content for one command in one wrapper format. */
export function renderBody(kind: CommandKind, command: CommandId): string {
    switch (kind) {
        case 'claude-md': return claudeMd(command);
        case 'vscode-prompt': return vscodePromptMd(command);
        case 'codex-md': return codexMd(command);
        case 'gemini-toml': return geminiToml(command);
    }
}

// --------------- Discovery and status ---------------

export type Status = 'current' | 'stale' | 'missing';

export interface CommandFile {
    command: CommandId;
    filePath: string;
    invocation: string;
    status: Status;
    /** True when we can safely write this file; false ⇒ copy-only. */
    writable: boolean;
    /** Why `writable` is false, shown in the UI. */
    reason?: string;
}

export interface SlashCommandTarget {
    id: string;
    label: string;
    kind: CommandKind;
    dirPath: string;
    /** Always both, in perform → address order. */
    files: CommandFile[];
    /** Worst of the two: any `missing` ⇒ missing, else any `stale` ⇒ stale. */
    status: Status;
    /** True when at least one file can be written. */
    writable: boolean;
}

const EXT: Record<CommandKind, string> = {
    'claude-md': 'md',
    'codex-md': 'md',
    'gemini-toml': 'toml',
    'vscode-prompt': 'prompt.md',
};

function fileName(command: CommandId, kind: CommandKind): string {
    return `${command}-diff-review.${EXT[kind]}`;
}

function inspectFile(dirPath: string, command: CommandId, kind: CommandKind): CommandFile {
    const filePath = path.join(dirPath, fileName(command, kind));
    const text = readText(filePath);
    const expected = renderBody(kind, command);
    const base = { command, filePath, invocation: INVOCATION[command] };

    if (text === null) return { ...base, status: 'missing', writable: true };
    if (text === expected) return { ...base, status: 'current', writable: true };

    const hasMarker = text.includes(MARKER[command]);
    return hasMarker
        ? { ...base, status: 'stale', writable: true }
        : { ...base, status: 'stale', writable: false, reason: 'file not written by Diff Review' };
}

const STATUS_RANK: Record<Status, number> = { missing: 2, stale: 1, current: 0 };

function buildTarget(id: string, label: string, kind: CommandKind, dirPath: string): SlashCommandTarget {
    const files = (['perform', 'address'] as CommandId[]).map(command => inspectFile(dirPath, command, kind));
    const status = files.reduce<Status>(
        (worst, f) => (STATUS_RANK[f.status] > STATUS_RANK[worst] ? f.status : worst),
        'current',
    );
    return { id, label, kind, dirPath, files, status, writable: files.some(f => f.writable) };
}

export interface DiscoveryEnv {
    home?: string;
    platform?: NodeJS.Platform;
    codexHome?: string;
}

/**
 * Every agent on this machine with a slash-command directory, and whether
 * our two commands are installed and current in it.
 *
 * A row exists for Claude Code / Codex / Gemini only when their own command
 * directory exists — that is the only evidence we have those agents are
 * installed at all. For the VS Code family, a row exists when the app's or
 * profile's own directory exists (matching `mcp-consumers.ts`'s
 * `discoverConsumers`), since `storage.json` or the app root already proves
 * installation independently of whether `prompts/` has been used yet.
 */
export function discoverSlashCommands(env: DiscoveryEnv = {}): SlashCommandTarget[] {
    const home = env.home ?? os.homedir();
    const platform = env.platform ?? process.platform;
    const targets: SlashCommandTarget[] = [];

    const claudeDir = path.join(home, '.claude', 'commands');
    if (fs.existsSync(claudeDir)) {
        targets.push(buildTarget('claude', 'Claude Code', 'claude-md', claudeDir));
    }

    const codexHome = env.codexHome ?? process.env.CODEX_HOME ?? path.join(home, '.codex');
    const codexDir = path.join(codexHome, 'prompts');
    if (fs.existsSync(codexDir)) {
        targets.push(buildTarget('codex', 'Codex CLI', 'codex-md', codexDir));
    }

    const geminiDir = path.join(home, '.gemini', 'commands');
    if (fs.existsSync(geminiDir)) {
        targets.push(buildTarget('gemini', 'Gemini CLI', 'gemini-toml', geminiDir));
    }

    const vscodeIds = new Set(['vscode', 'vscode-insiders', 'vscodium']);
    for (const app of VSCODE_APPS.filter(a => vscodeIds.has(a.id))) {
        const root = userDataRoot(app, home, platform);
        if (fs.existsSync(root)) {
            targets.push(buildTarget(app.id, app.label, 'vscode-prompt', path.join(root, 'prompts')));
        }

        const profiles = parseProfiles(readText(path.join(root, 'globalStorage', 'storage.json')));
        for (const profile of profiles) {
            const profileDir = path.join(root, 'profiles', profile.location);
            if (!fs.existsSync(profileDir)) continue;
            targets.push(buildTarget(
                `${app.id}:profile:${profile.location}`,
                `${app.label} — profile "${profile.name}"`,
                'vscode-prompt',
                path.join(profileDir, 'prompts'),
            ));
        }
    }

    return targets;
}

// --------------- Clipboard rendering and writers ---------------

/** What lands on the clipboard: the body, plus where to save it. */
export function renderClipboard(target: SlashCommandTarget, command: CommandId): string {
    const file = target.files.find(f => f.command === command)!;
    return `${renderBody(target.kind, command)}\n---\nSave this to: ${file.filePath}\n`;
}

export interface SlashWriteResult {
    command: CommandId;
    filePath: string;
    /** The backup taken before overwriting a stale file, when there was one. */
    backup?: string;
}

export interface InstallOutcome {
    written: SlashWriteResult[];
    errors: { command: CommandId; filePath: string; message: string }[];
}

/**
 * Write every file in `target` that is writable and not already current.
 * A failure writing one file does not stop the other from being attempted;
 * both successes and failures are reported so the caller can show both.
 */
export function install(target: SlashCommandTarget): InstallOutcome {
    const written: SlashWriteResult[] = [];
    const errors: InstallOutcome['errors'] = [];

    for (const file of target.files) {
        if (!file.writable || file.status === 'current') continue;
        try {
            const savedBackup = backup(file.filePath);
            fs.mkdirSync(path.dirname(file.filePath), { recursive: true });
            fs.writeFileSync(file.filePath, renderBody(target.kind, file.command), 'utf-8');
            written.push({ command: file.command, filePath: file.filePath, backup: savedBackup });
        } catch (e: any) {
            errors.push({ command: file.command, filePath: file.filePath, message: e.message });
        }
    }

    return { written, errors };
}

// Exported for test/slash-commands.test.js only — not part of the module's
// real surface, but the escaping logic is worth a direct unit test since the
// authored bodies never exercise the case it guards against.
export const __escapeTomlMultilineStringForTest = escapeTomlMultilineString;
