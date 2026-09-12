export class RequestBodyTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Request body exceeds the ${limitBytes}-byte limit.`);
    this.name = 'RequestBodyTooLargeError';
  }
}

export interface RequestBodyStream {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  destroy?(error?: Error): void;
}

/** Read a JSON request body without allowing an unbounded in-memory buffer. */
export function readRequestBody(stream: RequestBodyStream, limitBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    stream.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) {
        const error = new RequestBodyTooLargeError(limitBytes);
        stream.destroy?.(error);
        fail(error);
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    stream.on('error', fail);
  });
}
