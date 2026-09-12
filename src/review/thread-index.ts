import { allocatePublicThreadId } from './identity';

/** Window-local mapping between public thread handles and adapter-owned views. */
export class ReviewThreadIndex<Thread extends object, Metadata extends object> {
  private readonly threads = new Map<number, Thread>();
  private readonly publicIds = new WeakMap<Thread, number>();
  private readonly storageIds = new WeakMap<Thread, number>();
  private readonly stableIds = new WeakMap<Thread, string>();
  private readonly metadataByThread = new WeakMap<Thread, Metadata>();
  private nextId = 1;

  track(thread: Thread, metadata: Metadata, persistedId?: number, stableId?: string): number {
    const allocation = allocatePublicThreadId(persistedId, new Set(this.threads.keys()), this.nextId);
    this.nextId = allocation.nextId;
    this.threads.set(allocation.id, thread);
    this.publicIds.set(thread, allocation.id);
    this.storageIds.set(thread, persistedId ?? allocation.id);
    if (stableId) this.stableIds.set(thread, stableId);
    this.metadataByThread.set(thread, metadata);
    return allocation.id;
  }

  publicId(thread: Thread): number | undefined {
    return this.publicIds.get(thread);
  }

  storageId(thread: Thread): number | undefined {
    return this.storageIds.get(thread);
  }

  stableId(thread: Thread): string | undefined {
    return this.stableIds.get(thread);
  }

  metadata(thread: Thread): Metadata | undefined {
    return this.metadataByThread.get(thread);
  }

  setMetadata(thread: Thread, metadata: Metadata): void {
    this.metadataByThread.set(thread, metadata);
  }

  get(threadId: number): Thread | undefined {
    return this.threads.get(threadId);
  }

  has(threadId: number): boolean {
    return this.threads.has(threadId);
  }

  remove(threadId: number): boolean {
    return this.threads.delete(threadId);
  }

  get size(): number {
    return this.threads.size;
  }

  entries(): IterableIterator<[number, Thread]> {
    return this.threads.entries();
  }

  values(): IterableIterator<Thread> {
    return this.threads.values();
  }

  ids(): IterableIterator<number> {
    return this.threads.keys();
  }
}
