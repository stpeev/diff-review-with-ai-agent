import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, test } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test.skipIf(process.env.DIFF_REVIEW_LAUNCHER_SMOKE !== '1')(
  'the copied launcher resolves and executes a server outside the extension directory',
  () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-review-launcher-'));
    temporaryDirectories.push(directory);
    const copiedLauncher = path.join(directory, 'mcp-launcher.js');
    const server = path.join(directory, 'server.js');
    const marker = path.join(directory, 'started');
    fs.copyFileSync(path.resolve('out/mcp-launcher.js'), copiedLauncher);
    fs.writeFileSync(server, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`, 'utf8');

    execFileSync(process.execPath, [copiedLauncher], {
      cwd: directory,
      env: { ...process.env, DIFF_REVIEW_SERVER: server },
    });

    expect(fs.readFileSync(marker, 'utf8')).toBe('started');
  },
);

test.skipIf(process.env.DIFF_REVIEW_LAUNCHER_SMOKE !== '1')(
  'the copied launcher starts a server that only runs from its exported main',
  () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-review-launcher-'));
    temporaryDirectories.push(directory);
    const copiedLauncher = path.join(directory, 'mcp-launcher.js');
    const server = path.join(directory, 'server.js');
    const marker = path.join(directory, 'started');
    fs.copyFileSync(path.resolve('out/mcp-launcher.js'), copiedLauncher);
    // Mirrors the real server: work happens in main(), guarded by require.main.
    fs.writeFileSync(
      server,
      `async function main() { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); }\n` +
        `if (require.main === module) main();\n` +
        `exports.main = main;\n`,
      'utf8',
    );

    execFileSync(process.execPath, [copiedLauncher], {
      cwd: directory,
      env: { ...process.env, DIFF_REVIEW_SERVER: server },
    });

    expect(fs.readFileSync(marker, 'utf8')).toBe('started');
  },
);
