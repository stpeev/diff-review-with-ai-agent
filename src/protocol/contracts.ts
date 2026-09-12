import { z } from 'zod';

const workspaceExpectation = z.object({ expectWorkspaceRoot: z.string().optional() });

export const replyRequestSchema = workspaceExpectation.extend({
  threadId: z.number().int().positive(),
  text: z.string().min(1),
});

export const createRequestSchema = workspaceExpectation
  .extend({
    path: z.string().min(1),
    line: z.number().int().positive(),
    endLine: z.number().int().positive().optional(),
    text: z.string().min(1),
  })
  .superRefine((request, context) => {
    if (request.endLine !== undefined && request.endLine < request.line) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endLine'],
        message: 'endLine must not be before line.',
      });
    }
  });

export const threadMutationRequestSchema = workspaceExpectation.extend({
  threadId: z.number().int().positive(),
});

export const sessionUnregisterRequestSchema = workspaceExpectation.extend({
  sessionId: z.string().min(1),
});

export const sessionRegisterRequestSchema = workspaceExpectation.extend({
  agent: z.enum(['claude', 'codex']),
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  label: z.string().optional(),
  socketPath: z.string().optional(),
  token: z.string().optional(),
  pid: z.number().int().positive().optional(),
});

export class IpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpcValidationError';
  }
}

export function parseIpcRequest<T>(body: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new IpcValidationError('Request body must be valid JSON.');
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new IpcValidationError(result.error.issues[0]?.message ?? 'Invalid request body.');
  }
  return result.data;
}
