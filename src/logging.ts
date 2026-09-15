export type Logger = (message: string) => void;

export function createPrefixedLogger(write: Logger, prefix: string): Logger {
  return (message) => write(`[${prefix}] ${message}`);
}
