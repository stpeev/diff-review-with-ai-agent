export type SaveState = 'saved' | 'dirty' | 'saving' | 'failed';

type ScheduledSave = {
  timer: ReturnType<typeof setTimeout>;
  operation: () => Promise<void>;
  onError: (error: unknown) => void;
};

/** Serializes persistence work while exposing its lifecycle per storage scope. */
export class SaveQueue<Key> {
  private readonly scheduled = new Map<Key, ScheduledSave>();
  private readonly states = new Map<Key, SaveState>();
  private readonly errors = new Map<Key, unknown>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  state(key: Key): SaveState {
    return this.states.get(key) ?? 'saved';
  }

  /** Most recent persistence failure for this key, cleared by a successful save. */
  error(key: Key): unknown | undefined {
    return this.errors.get(key);
  }

  schedule(key: Key, operation: () => Promise<void>, delayMs: number, onError: (error: unknown) => void): boolean {
    if (this.closed) return false;
    const existing = this.scheduled.get(key);
    if (existing) clearTimeout(existing.timer);
    this.states.set(key, 'dirty');
    const timer = setTimeout(() => {
      this.scheduled.delete(key);
      void this.enqueue(key, operation).catch(onError);
    }, delayMs);
    this.scheduled.set(key, { timer, operation, onError });
    return true;
  }

  /** Stop accepting new work while allowing already-scheduled saves to drain. */
  close(): void {
    this.closed = true;
  }

  flush(key: Key, operation: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new SaveQueueClosedError());
    const scheduled = this.scheduled.get(key);
    if (scheduled) {
      clearTimeout(scheduled.timer);
      this.scheduled.delete(key);
    }
    return this.enqueue(key, operation);
  }

  async flushAll(timeoutMs?: number): Promise<void> {
    const drain = this.drainAll();
    if (timeoutMs === undefined) return drain;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        drain,
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => reject(new SaveQueueDrainTimeoutError(timeoutMs)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async drainAll(): Promise<void> {
    const pending = [...this.scheduled.entries()];
    this.scheduled.clear();
    const runs = pending.map(([key, save]) => {
      clearTimeout(save.timer);
      return this.enqueue(key, save.operation);
    });
    const results = await Promise.allSettled(runs);
    await this.tail;
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
    const inFlightFailure = this.errors.values().next().value;
    if (inFlightFailure !== undefined) throw inFlightFailure;
  }

  private enqueue(key: Key, operation: () => Promise<void>): Promise<void> {
    const run = this.tail.then(async () => {
      this.states.set(key, 'saving');
      try {
        await operation();
        this.states.set(key, 'saved');
        this.errors.delete(key);
      } catch (error) {
        this.states.set(key, 'failed');
        this.errors.set(key, error);
        throw error;
      }
    });
    this.tail = run.catch((): void => undefined);
    return run;
  }
}

export class SaveQueueDrainTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out draining pending saves after ${timeoutMs}ms.`);
    this.name = 'SaveQueueDrainTimeoutError';
  }
}

export class SaveQueueClosedError extends Error {
  constructor() {
    super('Cannot schedule a save after the queue has closed.');
    this.name = 'SaveQueueClosedError';
  }
}
