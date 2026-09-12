import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { execFile } from 'child_process';
import { AgentSession } from './agent-registry';

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

/**
 * Send the two NDJSON frames printed by Claude Code's own uds-messaging help:
 * authenticate first, then enqueue a user message. This is a private protocol,
 * so a successful result means the bytes reached the socket, not that Claude
 * acknowledged or acted on them.
 */
export function deliverToClaude(session: AgentSession, message: string, timeoutMs = 5000): Promise<string> {
    if (!session.socketPath || !session.token) {
        return Promise.reject(new Error('Claude session did not publish a messaging socket and token'));
    }
    if (!message.trim()) return Promise.reject(new Error('Cannot deliver an empty message to Claude'));

    const payload = [
        JSON.stringify({ type: 'auth', token: session.token }),
        JSON.stringify({
            type: 'user',
            session_id: session.sessionId,
            message: { role: 'user', content: message },
        }),
        '',
    ].join('\n');

    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ path: session.socketPath! });
        let settled = false;
        let response = '';
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            if (error) {
                socket.destroy();
                reject(error);
                return;
            }
            const frames = response.split('\n').flatMap(line => {
                if (!line.trim()) return [];
                try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
            });
            const dropped = frames.find(frame => frame.type === 'peer_message_status' && frame.dropped === true);
            if (dropped) {
                reject(new Error(`Claude rejected the message${typeof dropped.drop_reason === 'string' ? `: ${dropped.drop_reason}` : ''}`));
                return;
            }
            const acknowledged = frames.some(frame => frame.type === 'peer_message_status');
            resolve(acknowledged ? 'accepted by Claude messaging socket' : 'written to Claude messaging socket (no protocol acknowledgement)');
        };
        socket.setTimeout(timeoutMs);
        socket.once('timeout', () => finish(new Error(`Claude messaging socket timed out after ${timeoutMs}ms`)));
        socket.once('error', error => finish(new Error(`Claude messaging socket failed: ${error.message}`)));
        socket.setEncoding('utf8');
        socket.on('data', chunk => { response += chunk; });
        socket.once('connect', () => socket.end(payload));
        socket.once('close', hadError => { if (!hadError) finish(); });
    });
}

export function deliverToSession(session: AgentSession, message: string): Promise<string> {
    if (session.agent === 'claude') return deliverToClaude(session, message);
    const binary = resolveCodexBinary();
    if (!binary) return Promise.reject(new Error('Codex executable not found'));
    return new Promise((resolve, reject) => execFile(binary, ['queue', '--thread', session.sessionId, '--message', message],
        { timeout: 15000 }, (error, stdout, stderr) => error ? reject(new Error((stderr || error.message).trim())) : resolve(stdout.trim())));
}
