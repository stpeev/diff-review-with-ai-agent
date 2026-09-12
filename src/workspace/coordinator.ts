/** Monotonic generation guard for asynchronous workspace transitions. */
export class TransitionGeneration {
  private value = 0;
  private tail: Promise<void> = Promise.resolve();

  begin(): number {
    return ++this.value;
  }

  /** Cancel all work started under prior generations. */
  invalidate(): void {
    this.value++;
  }

  isCurrent(generation: number): boolean {
    return generation === this.value;
  }

  serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * A scope transition may replace the in-memory view only after its old scope
 * has been persisted. A failed flush deliberately propagates to the caller,
 * leaving that view intact; a superseded transition becomes a no-op.
 */
export async function runScopeTransition(
  transitions: TransitionGeneration,
  flush: () => Promise<void>,
  replace: () => void,
): Promise<boolean> {
  const generation = transitions.begin();
  return transitions.serialize(async () => {
    await flush();
    if (!transitions.isCurrent(generation)) return false;
    replace();
    return true;
  });
}
