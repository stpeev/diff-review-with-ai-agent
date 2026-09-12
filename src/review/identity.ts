/** Allocate a window-wide handle without changing an existing persisted ID. */
export function allocatePublicThreadId(
  persistedId: number | undefined,
  occupied: ReadonlySet<number>,
  nextId: number,
): { id: number; nextId: number } {
  let id = persistedId ?? nextId;
  if (occupied.has(id)) id = nextId;
  while (occupied.has(id)) id++;
  return { id, nextId: Math.max(nextId, id + 1) };
}
