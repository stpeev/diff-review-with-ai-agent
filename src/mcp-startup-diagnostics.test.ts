import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expect, test } from 'vitest';
import { writeMcpStartupDiagnostic } from './mcp-startup-diagnostics';

test('writes a private JSONL startup event without exposing process data to stdout', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-review-diagnostic-'));
  const file = path.join(directory, 'diagnostics.jsonl');
  try {
    writeMcpStartupDiagnostic(file, 'started', { pid: 123 }, () => {
      throw new Error('unexpected failure');
    });
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toMatchObject({ event: 'started', pid: 123 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
