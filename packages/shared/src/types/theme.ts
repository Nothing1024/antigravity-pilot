/**
 * Theme/style payload for rendering IDE snapshots inside an isolated container.
 *
 * Source of truth: packages/server/src/api/cascade.ts `/styles/:id` returns `{ css, computedVars }`,
 * where `css` is namespaced to `#chat-viewport` and `computedVars` is a map of
 * CSS custom properties (plus a few fallback keys).
 */

/**
 * Map of computed CSS custom properties (e.g. `--vscode-*`, `--ide-*`).
 * The server may also include a few non-standard fallback keys like
 * `__bodyBg`, `__bodyColor`, `__bodyFontFamily`.
 */
export type ComputedVars = Record<string, string>;

export interface ThemeData {
  css: string;
  computedVars: ComputedVars;
}
