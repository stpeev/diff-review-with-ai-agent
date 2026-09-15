#!/usr/bin/env node

const { spawn } = require('node:child_process');

const targets = ['extension', 'mcp-server', 'mcp-launcher'];
const children = targets.map((target) =>
  spawn('vite', ['build', '--watch', '--mode', target], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  }),
);

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = exitCode;
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
for (const child of children) {
  child.on('error', (error) => {
    process.stderr.write(`[diff-review] Could not start production watcher: ${error.message}\n`);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      process.stderr.write(`[diff-review] Production watcher stopped (${signal ?? `exit ${code ?? 0}`}).\n`);
      stop(code ?? 1);
    }
  });
}
