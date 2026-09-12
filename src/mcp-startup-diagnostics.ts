import * as fs from 'fs';
import * as path from 'path';

/** Append a private JSONL startup diagnostic without allowing diagnostics to stop MCP startup. */
export function writeMcpStartupDiagnostic(
  filePath: string,
  event: string,
  details: Record<string, unknown>,
  onFailure: (message: string) => void,
): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }) + '\n', {
      mode: 0o600,
    });
    fs.chmodSync(filePath, 0o600);
  } catch (error: any) {
    onFailure(`Could not write startup diagnostics: ${error.message ?? error}`);
  }
}
