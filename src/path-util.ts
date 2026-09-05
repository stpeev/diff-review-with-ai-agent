/**
 * Ancestor-path matching shared by IPC port resolution (`ipc-discovery.ts`)
 * and scope resolution (`scope-id.ts`). Both need "which of these roots is the
 * deepest ancestor of this path" and it is easy to get the separator boundary
 * wrong (`/foo` must not match `/foobar`), so it lives in one tested place.
 */
import * as path from 'path';

/** True when `root` is `target` itself, or a filesystem ancestor of it. */
export function isAncestor(root: string, target: string): boolean {
    const r = path.resolve(root);
    const t = path.resolve(target);
    if (r === t) return true;
    const withSep = r.endsWith(path.sep) ? r : r + path.sep;
    return t.startsWith(withSep);
}

/**
 * Among `items`, the one whose root (via `getRoot`) is the deepest ancestor of
 * `target` — i.e. the longest matching root wins, so a nested repo resolves to
 * itself rather than to an enclosing folder.
 */
export function deepestAncestor<T>(items: T[], getRoot: (item: T) => string, target: string): T | undefined {
    let best: T | undefined;
    let bestLen = -1;
    for (const item of items) {
        const root = path.resolve(getRoot(item));
        if (!isAncestor(root, target)) continue;
        if (root.length > bestLen) {
            best = item;
            bestLen = root.length;
        }
    }
    return best;
}
