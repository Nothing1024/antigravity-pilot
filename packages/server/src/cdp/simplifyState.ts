/**
 * Global runtime state for IDE GPU simplification.
 *
 * When the user sets a simplify mode via the web UI, we remember it here
 * so that newly-discovered cascades can be automatically simplified
 * without the user having to click the button again.
 */

export type SimplifyMode = "off" | "light" | "full";

/** Current desired simplify mode — persisted in-memory across discovery cycles. */
let _mode: SimplifyMode = "off";

export function getSimplifyMode(): SimplifyMode {
  return _mode;
}

export function setSimplifyMode(mode: SimplifyMode): void {
  _mode = mode;
}
