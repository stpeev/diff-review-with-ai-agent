export function reviewPanelTitle(total: number, open: number, drifted: number): string {
  const resolved = total - open;
  return `Review Comments (${open} open, ${resolved} resolved${drifted > 0 ? `, ${drifted} drifted` : ''})`;
}
