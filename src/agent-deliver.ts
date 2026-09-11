import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { AgentSession } from './agent-roster';

function executable(file: string): boolean { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } }

export function resolveCodexBinary(envPath = process.env.PATH ?? '', home = os.homedir()): string | undefined {
    for (const dir of envPath.split(path.delimiter)) {
        const candidate = path.join(dir, 'codex');
        if (dir && executable(candidate)) return candidate;
    }
    const roots = process.platform === 'darwin'
        ? [path.join(home, '.vscode/extensions'), path.join(home, '.vscode-insiders/extensions')]
        : process.platform === 'win32'
            ? [path.join(home, '.vscode', 'extensions')]
            : [path.join(home, '.vscode/extensions'), path.join(home, '.vscode-server/extensions')];
    const platformDirs = process.platform === 'darwin'
        ? (process.arch === 'arm64' ? ['macos-aarch64', 'macos-x86_64'] : ['macos-x86_64', 'macos-aarch64'])
        : process.platform === 'win32' ? ['windows-x86_64'] : ['linux-x86_64', 'linux-aarch64'];
    for (const root of roots) {
        let versions: string[] = [];
        try { versions = fs.readdirSync(root).filter(x => /^openai\.chatgpt-/.test(x)).sort().reverse(); } catch { continue; }
        for (const version of versions) for (const platform of platformDirs) {
            const candidate = path.join(root, version, 'bin', platform, process.platform === 'win32' ? 'codex.exe' : 'codex');
            if (executable(candidate)) return candidate;
        }
    }
    return undefined;
}

export function deliverToSession(session: AgentSession, message: string): Promise<string> {
    if (session.agent !== 'codex') return Promise.reject(new Error('Claude direct delivery is experimental and unavailable'));
    const binary = resolveCodexBinary();
    if (!binary) return Promise.reject(new Error('Codex executable not found'));
    return new Promise((resolve, reject) => execFile(binary, ['queue', '--thread', session.sessionId, '--message', message],
        { timeout: 15000 }, (error, stdout, stderr) => error ? reject(new Error((stderr || error.message).trim())) : resolve(stdout.trim())));
}
