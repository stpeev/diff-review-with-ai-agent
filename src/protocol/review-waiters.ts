export type ReviewWaiter = (generation: number) => void;

/** Tracks review notifications for long-poll clients without owning HTTP objects. */
export class ReviewWaiters {
  private generationValue = 0;
  private readonly waiters = new Set<ReviewWaiter>();

  get generation(): number {
    return this.generationValue;
  }

  get size(): number {
    return this.waiters.size;
  }

  subscribe(waiter: ReviewWaiter): () => void {
    this.waiters.add(waiter);
    return () => this.waiters.delete(waiter);
  }

  announce(): { generation: number; waiterCount: number } {
    const waiterCount = this.waiters.size;
    this.generationValue++;
    // Clear before invoking callbacks: a callback may begin a new wait for a
    // later generation, and that new subscription must not be discarded by
    // cleanup for the generation being announced now.
    const released = [...this.waiters];
    this.waiters.clear();
    for (const waiter of released) waiter(this.generationValue);
    return { generation: this.generationValue, waiterCount };
  }
}
