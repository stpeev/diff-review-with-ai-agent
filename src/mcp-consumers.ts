/**
 * Discovery and registration of MCP consumers.
 *
 * `mcp-resolve.ts` answers "which server would a client run?". This module
 * answers the other half: "which consumers are on this machine, and do they know
 * about us?" — then writes the entry, or hands back a command to paste when
 * writing would be guesswork.
 *
 * Everything here is pure or takes its filesystem roots as arguments, so the
 * risky parts (the TOML surgery especially) are testable without a VS Code
 * host. See test/mcp-consumers.test.js.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyEdits, modify, parse as parseJsonc, ParseError } from 'jsonc-parser';

import { LAUNCHER_FILE } from './mcp-resolve';

/** The key every consumer registers us under. */
export const SERVER_NAME = 'diff-review';

export type ConsumerKind = 'vscode-json' | 'codex-toml' | 'claude-json';

/** Is the entry absent, present but pointing elsewhere, or correct? */
export type Status = 'current' | 'stale' | 'missing';

export interface McpConsumerTarget {
    id: string;
    label: string;
    kind: ConsumerKind;
    configPath: string;
    status: Status;
    /** For stale rows: a readable rendering of what is registered now. */
    current?: string;
    /** False when writing the file would be guesswork; such rows copy only. */
    writable: boolean;
    /** Why `writable` is false, shown in the UI. */
    reason?: string;
}

/** What an `inspect*` function reports about one config file. */
export interface Inspection {
    status: Status;
    current?: string;
    writable: boolean;
    reason?: string;
}

// --------------- Path comparison ---------------

function expandHome(p: string, home: string): string {
    if (p === '~') return home;
    if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
    return p;
}

/**
 * Do two paths name the same file? Normalises `~`, resolves symlinks when the
 * file exists, and ignores case where the platform does.
 */
export function samePath(a: string, b: string, home = os.homedir()): boolean {
    const norm = (p: string) => {
        let out = path.resolve(expandHome(p, home));
        try { out = fs.realpathSync(out); } catch { /* not on disk yet; the literal path is the best we have */ }
        return process.platform === 'win32' || process.platform === 'darwin' ? out.toLowerCase() : out;
    };
    return norm(a) === norm(b);
}

/** The entry every writer produces. */
function canonicalEntry(launcher: string) {
    return { type: 'stdio', command: 'node', args: [launcher] };
}

function renderCommand(command: unknown, args: unknown): string {
    const parts = [String(command ?? '?'), ...(Array.isArray(args) ? args.map(String) : [])];
    return parts.join(' ');
}

/**
 * Classify an already-registered entry. Only `node <launcher>` is current —
 * anything else, including the versioned `out/mcp-server.js` path that breaks
 * on upgrade, is stale.
 */
function classifyEntry(entry: any, launcher: string, home: string): Inspection {
    const args = Array.isArray(entry?.args) ? entry.args : [];
    const isCurrent = entry?.command === 'node'
        && args.length === 1
        && samePath(String(args[0]), launcher, home);
    return isCurrent
        ? { status: 'current', writable: true }
        : { status: 'stale', current: renderCommand(entry?.command, entry?.args), writable: true };
}

// --------------- VS Code family: mcp.json ---------------

/**
 * These files are JSONC — VS Code writes them plain, but users add comments.
 * Read them tolerantly; a file we cannot parse becomes a copy-only row rather
 * than something we overwrite.
 */
export function inspectVsCodeJson(text: string | null, launcher: string, home = os.homedir()): Inspection {
    if (text === null || text.trim() === '') return { status: 'missing', writable: true };

    const errors: ParseError[] = [];
    const parsed = parseJsonc(text, errors, { allowTrailingComma: true });
    if (errors.length > 0 || parsed === undefined) {
        return { status: 'missing', writable: false, reason: 'the file is not valid JSON' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { status: 'missing', writable: false, reason: 'unrecognised config layout' };
    }

    // VS Code nests under "servers"; a few forks use the "mcpServers" spelling.
    const container = parsed.servers ?? parsed.mcpServers;
    if (container === undefined) return { status: 'missing', writable: true };
    if (typeof container !== 'object' || container === null || Array.isArray(container)) {
        return { status: 'missing', writable: false, reason: 'unrecognised config layout' };
    }

    const entry = container[SERVER_NAME];
    if (entry === undefined) return { status: 'missing', writable: true };
    return classifyEntry(entry, launcher, home);
}

/** Insert or repair the entry, preserving comments and formatting. */
export function writeVsCodeJson(text: string | null, launcher: string): string {
    const source = text === null || text.trim() === '' ? '{}' : text;
    const parsed = parseJsonc(source, [], { allowTrailingComma: true });
    // Follow whichever spelling the file already uses, so we do not create a
    // second, ignored container next to the real one.
    const key = parsed && typeof parsed === 'object' && parsed.mcpServers && !parsed.servers
        ? 'mcpServers' : 'servers';
    const edits = modify(source, [key, SERVER_NAME], canonicalEntry(launcher), {
        formattingOptions: { insertSpaces: true, tabSize: 4 },
    });
    return applyEdits(source, edits);
}

export function vsCodeSnippet(launcher: string): string {
    return JSON.stringify({ servers: { [SERVER_NAME]: canonicalEntry(launcher) } }, null, 4);
}

// --------------- Codex CLI: config.toml ---------------

const TOML_TABLE = `[mcp_servers.${SERVER_NAME}]`;

/** Does this line open a TOML table, and which one? */
function tableHeader(line: string): string | null {
    const match = /^\[([^\[\]]+)\]\s*$/.exec(line.trim());
    // Only column-0 headers delimit a table for our purposes; an indented one
    // is unusual enough that we would rather not touch the file.
    return match && line === line.trimStart() ? match[1].trim() : null;
}

/** The line range [start, end) holding the entry table and its sub-tables. */
function findCodexBlock(lines: string[]): { start: number; end: number } | null {
    const starts: number[] = [];
    lines.forEach((line, i) => {
        if (tableHeader(line) === `mcp_servers.${SERVER_NAME}`) starts.push(i);
    });
    if (starts.length !== 1) return null;

    const start = starts[0];
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        const header = tableHeader(lines[i]);
        // Sub-tables of our own entry belong to the span we replace.
        if (header && !header.startsWith(`mcp_servers.${SERVER_NAME}.`)) { end = i; break; }
    }
    return { start, end };
}

/** Read `key = ...` out of an entry block. Enough for command/args, no more. */
function tomlValue(block: string, key: string): string | undefined {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm').exec(block);
    return match?.[1];
}

function parseTomlStringArray(raw: string | undefined): string[] {
    if (!raw) return [];
    return [...raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1].replace(/\\(.)/g, '$1'));
}

export function inspectCodexToml(text: string | null, launcher: string, home = os.homedir()): Inspection {
    if (text === null || text.trim() === '') return { status: 'missing', writable: true };

    // Layouts we can read but would not edit safely.
    if (/^\s*mcp_servers\s*=/m.test(text)) {
        return { status: 'missing', writable: false, reason: 'mcp_servers is an inline table' };
    }
    if (new RegExp(`^\\s*mcp_servers\\.${SERVER_NAME}\\b`, 'm').test(text)) {
        return { status: 'missing', writable: false, reason: 'the entry uses dotted keys' };
    }

    const lines = text.split('\n');
    const headers = lines.filter(l => tableHeader(l) === `mcp_servers.${SERVER_NAME}`);
    if (headers.length > 1) {
        return { status: 'missing', writable: false, reason: 'duplicate [mcp_servers.diff-review] tables' };
    }
    if (headers.length === 0) return { status: 'missing', writable: true };

    const span = findCodexBlock(lines)!;
    const block = lines.slice(span.start, span.end).join('\n');
    const command = parseTomlStringArray(tomlValue(block, 'command'))[0];
    const args = parseTomlStringArray(tomlValue(block, 'args'));
    return classifyEntry({ command, args }, launcher, home);
}

/**
 * Replace the entry table in place, or append one. Deliberately textual: the
 * file is hand-edited and full of comments, and no TOML serialiser we could
 * add would give them back.
 */
export function writeCodexToml(text: string | null, launcher: string): string {
    const entry = [TOML_TABLE, 'command = "node"', `args = ["${launcher.replace(/"/g, '\\"')}"]`].join('\n');
    if (text === null || text.trim() === '') return entry + '\n';

    const lines = text.split('\n');
    const span = findCodexBlock(lines);
    if (!span) {
        const body = text.endsWith('\n') ? text : text + '\n';
        return `${body}\n${entry}\n`;
    }
    lines.splice(span.start, span.end - span.start, ...entry.split('\n'), '');
    return lines.join('\n');
}

export function codexSnippet(launcher: string): string {
    return `codex mcp add ${SERVER_NAME} -- node ${launcher}`;
}

// --------------- Claude Code: ~/.claude.json ---------------

export function inspectClaudeJson(text: string | null, launcher: string, home = os.homedir()): Inspection {
    if (text === null || text.trim() === '') return { status: 'missing', writable: true };
    let parsed: any;
    try { parsed = JSON.parse(text); } catch {
        return { status: 'missing', writable: false, reason: 'the file is not valid JSON' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { status: 'missing', writable: false, reason: 'unrecognised config layout' };
    }
    const servers = parsed.mcpServers;
    if (servers === undefined) return { status: 'missing', writable: true };
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
        return { status: 'missing', writable: false, reason: 'unrecognised config layout' };
    }
    const entry = servers[SERVER_NAME];
    if (entry === undefined) return { status: 'missing', writable: true };
    return classifyEntry(entry, launcher, home);
}

/**
 * Only used when the `claude` CLI is unavailable — the CLI is the sanctioned
 * path, and Claude Code rewrites this file from memory while it runs.
 */
export function writeClaudeJson(text: string | null, launcher: string): string {
    const parsed = text === null || text.trim() === '' ? {} : JSON.parse(text);
    parsed.mcpServers = { ...(parsed.mcpServers ?? {}), [SERVER_NAME]: canonicalEntry(launcher) };
    return JSON.stringify(parsed, null, 2) + '\n';
}

export function claudeSnippet(launcher: string, home = os.homedir()): string {
    return `claude mcp add ${SERVER_NAME} -- node ${shortenHome(launcher, home)}`;
}

/** `~` is safe in a shell command — the shell expands it — but never in JSON. */
function shortenHome(p: string, home: string): string {
    return p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

// --------------- Discovery ---------------

interface AppSpec {
    id: string;
    label: string;
    /** Directory name under the platform's user-data root. */
    dir: string;
}

const VSCODE_APPS: AppSpec[] = [
    { id: 'vscode', label: 'VS Code', dir: 'Code' },
    { id: 'vscode-insiders', label: 'VS Code Insiders', dir: 'Code - Insiders' },
    { id: 'vscodium', label: 'VSCodium', dir: 'VSCodium' },
    { id: 'cursor', label: 'Cursor', dir: 'Cursor' },
    { id: 'windsurf', label: 'Windsurf', dir: 'Windsurf' },
];

/** Where a platform keeps `<App>/User/`. */
function userDataRoot(app: AppSpec, home: string, platform: NodeJS.Platform): string {
    if (platform === 'win32') {
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        return path.join(appData, app.dir, 'User');
    }
    if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', app.dir, 'User');
    return path.join(home, '.config', app.dir, 'User');
}

function readText(file: string): string | null {
    try { return fs.readFileSync(file, 'utf-8'); } catch { return null; }
}

export interface ProfileRef {
    /** Path under `profiles/`, which may be nested (e.g. "builtin/agents"). */
    location: string;
    name: string;
}

/**
 * The profiles that keep their own MCP config.
 *
 * `storage.json` is authoritative — directories under `profiles/` outlive the
 * profiles that made them, so a readdir invents rows for state VS Code ignores.
 * A profile with `useDefaultFlags.mcp` reads the default profile's mcp.json, so
 * it is not a separate target either.
 */
export function parseProfiles(storageJson: string | null): ProfileRef[] {
    if (!storageJson) return [];
    let profiles: any;
    try { profiles = JSON.parse(storageJson).userDataProfiles; } catch { return []; }
    if (!Array.isArray(profiles)) return [];
    return profiles
        .filter(p => typeof p?.location === 'string' && typeof p?.name === 'string')
        .filter(p => p.useDefaultFlags?.mcp !== true)
        .map(p => ({ location: p.location as string, name: p.name as string }));
}

function targetFrom(
    id: string, label: string, kind: ConsumerKind, configPath: string,
    inspect: (text: string | null) => Inspection,
): McpConsumerTarget {
    const found = inspect(readText(configPath));
    return { id, label, kind, configPath, ...found };
}

export interface DiscoveryEnv {
    home?: string;
    platform?: NodeJS.Platform;
    launcher?: string;
}

/**
 * Every user-level MCP consumer on this machine. Apps that are not installed are
 * omitted; an installed app with no config file yet is a `missing` row, since
 * that is exactly the case the command exists to fix.
 */
export function discoverConsumers(env: DiscoveryEnv = {}): McpConsumerTarget[] {
    const home = env.home ?? os.homedir();
    const platform = env.platform ?? process.platform;
    const launcher = env.launcher ?? LAUNCHER_FILE;
    const targets: McpConsumerTarget[] = [];

    for (const app of VSCODE_APPS) {
        const root = userDataRoot(app, home, platform);
        if (!fs.existsSync(root)) continue;

        // Cursor documents ~/.cursor/mcp.json, so prefer it when present.
        const cursorConfig = path.join(home, '.cursor', 'mcp.json');
        const config = app.id === 'cursor' && fs.existsSync(cursorConfig)
            ? cursorConfig
            : path.join(root, 'mcp.json');

        targets.push(targetFrom(app.id, app.label, 'vscode-json', config,
            text => inspectVsCodeJson(text, launcher, home)));

        const profiles = parseProfiles(readText(path.join(root, 'globalStorage', 'storage.json')));
        for (const profile of profiles) {
            const dir = path.join(root, 'profiles', profile.location);
            if (!fs.existsSync(dir)) continue;
            targets.push(targetFrom(
                `${app.id}:profile:${profile.location}`, `${app.label} — profile "${profile.name}"`,
                'vscode-json', path.join(dir, 'mcp.json'),
                text => inspectVsCodeJson(text, launcher, home)));
        }
    }

    const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
    if (fs.existsSync(codexHome)) {
        targets.push(targetFrom('codex', 'Codex CLI', 'codex-toml',
            path.join(codexHome, 'config.toml'),
            text => inspectCodexToml(text, launcher, home)));
    }

    const claudeConfig = path.join(home, '.claude.json');
    if (fs.existsSync(claudeConfig) || fs.existsSync(path.join(home, '.claude'))) {
        targets.push(targetFrom('claude', 'Claude Code', 'claude-json', claudeConfig,
            text => inspectClaudeJson(text, launcher, home)));
    }

    return targets;
}

/** What lands on the clipboard for this client: ready to paste, absolute in JSON. */
export function renderSnippet(target: McpConsumerTarget, launcher = LAUNCHER_FILE, home = os.homedir()): string {
    switch (target.kind) {
        case 'codex-toml': return codexSnippet(launcher);
        case 'claude-json': return claudeSnippet(launcher, home);
        case 'vscode-json': return vsCodeSnippet(launcher);
    }
}

/** Where the snippet goes, phrased for a notification. */
export function snippetDestination(target: McpConsumerTarget): string {
    return target.kind === 'vscode-json' ? `paste it into ${target.configPath}` : 'run it in a terminal';
}

// --------------- Registration ---------------

export interface WriteResult {
    /** The backup taken before the write, when there was a file to back up. */
    backup?: string;
}

function backup(file: string): string | undefined {
    if (!fs.existsSync(file)) return undefined;
    const dest = file + '.diff-review-backup';
    fs.copyFileSync(file, dest);
    return dest;
}

/**
 * Write the entry into this consumer's config. Throws with a user-facing message
 * on failure; callers fall back to the clipboard.
 */
export function register(target: McpConsumerTarget, launcher = LAUNCHER_FILE): WriteResult {
    if (!target.writable) throw new Error(target.reason ?? 'this config cannot be edited safely');

    const text = readText(target.configPath);
    const transform = target.kind === 'codex-toml' ? writeCodexToml
        : target.kind === 'claude-json' ? writeClaudeJson
            : writeVsCodeJson;

    const next = transform(text, launcher);
    const saved = backup(target.configPath);
    fs.mkdirSync(path.dirname(target.configPath), { recursive: true });
    fs.writeFileSync(target.configPath, next, 'utf-8');
    return { backup: saved };
}
