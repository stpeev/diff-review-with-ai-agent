/**
 * The extension version as a runtime value.
 *
 * The extension host reads it from its own manifest
 * (`context.extension.packageJSON.version`), but the MCP server is a
 * standalone bundle with no extension context, so Vite injects the version
 * from `package.json` as `__DIFF_REVIEW_VERSION__` at build time (see
 * `define` in `vite.config.ts` and `vitest.config.ts`). One source of truth:
 * the manifest.
 *
 * The `typeof` guard keeps an undefined global from crashing a bundle that
 * was produced without the define; the sibling test asserts the defined value
 * still equals the manifest, so a broken define fails the suite rather than
 * silently shipping a fallback.
 */
declare const __DIFF_REVIEW_VERSION__: string;

export const VERSION: string = typeof __DIFF_REVIEW_VERSION__ === 'string' ? __DIFF_REVIEW_VERSION__ : '0.0.0';
