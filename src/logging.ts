export type Logger = (message: string) => void;

export type LoggerOptions = {
  write: Logger;
  prefix: string;
  now?: () => Date;
};

export function createLogger({ write, prefix, now = () => new Date() }: LoggerOptions): Logger {
  return (message) => write(`[${now().toISOString()}] [${prefix}] ${message}`);
}
