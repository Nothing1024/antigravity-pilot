import type { AutoActionSettings, Snapshot } from "@ag/shared";

import type { CDPConnection } from "../cdp/types";
import { broadcast } from "../ws/broadcast";

// ── Runtime settings (loaded from config on startup, togglable via API) ──
export const autoActionSettings: AutoActionSettings = {
  autoAcceptAll: false,
  autoRetry: false,
  retryBackoff: true,
};

// ── Cooldown tracking ──
// accept_all: flat 5s cooldown
// auto_retry: exponential backoff 10s → 30s → 60s → 120s (resets when error disappears)
const cooldowns = new Map<string, Map<string, number>>();
const ACCEPT_COOLDOWN_MS = 5000;

// Retry backoff: track consecutive retry count per cascade
const retryCounters = new Map<string, number>();
const RETRY_DELAYS = [10_000, 30_000, 60_000, 120_000]; // escalating delays

function getRetryCooldownMs(cascadeId: string): number {
  const count = retryCounters.get(cascadeId) || 0;
  return RETRY_DELAYS[Math.min(count, RETRY_DELAYS.length - 1)];
}

function getCooldownMs(actionType: string, cascadeId: string): number {
  if (actionType !== "auto_retry") return ACCEPT_COOLDOWN_MS;
  // If backoff disabled, use flat 10s cooldown
  if (!autoActionSettings.retryBackoff) return RETRY_DELAYS[0];
  return getRetryCooldownMs(cascadeId);
}

function isOnCooldown(cascadeId: string, actionType: string): boolean {
  const last = cooldowns.get(cascadeId)?.get(actionType);
  if (!last) return false;
  return Date.now() - last < getCooldownMs(actionType, cascadeId);
}

function setCooldown(cascadeId: string, actionType: string): void {
  if (!cooldowns.has(cascadeId)) cooldowns.set(cascadeId, new Map());
  cooldowns.get(cascadeId)!.set(actionType, Date.now());
}

function incrementRetryCounter(cascadeId: string): number {
  const next = (retryCounters.get(cascadeId) || 0) + 1;
  retryCounters.set(cascadeId, next);
  return next;
}

/** Reset retry counter when the error disappears (= retry succeeded) */
export function resetRetryCounter(cascadeId: string): void {
  if (retryCounters.has(cascadeId)) {
    retryCounters.delete(cascadeId);
    cooldowns.get(cascadeId)?.delete("auto_retry");
  }
}

export function clearCooldowns(cascadeId: string): void {
  cooldowns.delete(cascadeId);
  retryCounters.delete(cascadeId);
}

// ── Main entry: called from snapshot loop after each capture ──
export async function checkAndExecuteAutoActions(
  cascadeId: string,
  chatTitle: string,
  snapshot: Snapshot,
  cdp: CDPConnection
): Promise<void> {
  const hasError = snapshot.html.includes("terminated due to error");

  // If error is gone and we had a retry counter → the retry worked, reset backoff
  if (!hasError && retryCounters.has(cascadeId)) {
    console.log(`🤖 ✅ Error cleared on "${chatTitle}" — resetting retry backoff`);
    resetRetryCounter(cascadeId);
  }

  const actions: string[] = [];

  // Quick text-based pre-filter (no CDP call if nothing matches)
  if (autoActionSettings.autoAcceptAll && snapshot.html.includes(">Accept all<")) {
    if (!isOnCooldown(cascadeId, "accept_all")) actions.push("accept_all");
  }

  if (autoActionSettings.autoRetry && hasError) {
    if (!isOnCooldown(cascadeId, "auto_retry")) actions.push("auto_retry");
  }

  if (actions.length === 0) return;

  // Build and execute a single CDP script that detects + clicks
  const script = buildAutoActionScript(actions);

  try {
    const result: any = await cdp.call("Runtime.evaluate", {
      expression: script,
      returnByValue: true,
      contextId: cdp.rootContextId
    });

    const val = result.result?.value;
    if (val?.clicked) {
      setCooldown(cascadeId, val.clicked);

      if (val.clicked === "auto_retry") {
        const count = incrementRetryCounter(cascadeId);
        const nextDelay = RETRY_DELAYS[Math.min(count, RETRY_DELAYS.length - 1)];
        console.log(
          `🤖 🔄 Auto Retry #${count} on "${chatTitle}" — next retry in ${nextDelay / 1000}s`
        );
      } else {
        console.log(
          `🤖 🟢 Auto Accept All on "${chatTitle}" (text: "${val.text}")`
        );
      }

      broadcast({
        type: "auto_action",
        cascadeId,
        action: val.clicked,
        title: chatTitle
      });
    }
  } catch {
    // CDP call failed — silently ignore
  }
}

// ── CDP script builder ──
// Runs inside Electron; finds the matching element and dispatches a full
// pointer+mouse event sequence for React/Electron compatibility.
function buildAutoActionScript(actions: string[]): string {
  const checks: string[] = [];

  if (actions.includes("accept_all")) {
    checks.push(`
      if (text === 'Accept all' || text === 'Accept All') {
        doClick(el);
        return { clicked: 'accept_all', text };
      }
    `);
  }

  if (actions.includes("auto_retry")) {
    checks.push(`
      if (text === 'Retry') {
        const container = el.closest('.relative.flex.flex-col')
          || el.closest('[class*="bg-agent"]')
          || el.closest('[class*="border-gray"]');
        if (container) {
          const ct = container.textContent || '';
          if (ct.includes('terminated') || ct.includes('Agent terminated due to error')) {
            doClick(el);
            return { clicked: 'auto_retry', text };
          }
        }
      }
    `);
  }

  return `(() => {
    const target = document.getElementById('cascade')
      || document.getElementById('conversation')
      || document.getElementById('chat');
    if (!target) return { clicked: null };

    function doClick(el) {
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const eventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y, screenX: x, screenY: y, view: window };
      const pointerInit = { ...eventInit, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      el.dispatchEvent(new PointerEvent('pointerover', pointerInit));
      el.dispatchEvent(new MouseEvent('mouseover', eventInit));
      el.dispatchEvent(new PointerEvent('pointerenter', { ...pointerInit, bubbles: false }));
      el.dispatchEvent(new MouseEvent('mouseenter', { ...eventInit, bubbles: false }));
      el.dispatchEvent(new PointerEvent('pointermove', pointerInit));
      el.dispatchEvent(new MouseEvent('mousemove', eventInit));
      el.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
      el.dispatchEvent(new MouseEvent('mousedown', { ...eventInit, button: 0, detail: 1 }));
      if (typeof el.focus === 'function') el.focus();
      el.dispatchEvent(new PointerEvent('pointerup', pointerInit));
      el.dispatchEvent(new MouseEvent('mouseup', { ...eventInit, button: 0, detail: 1 }));
      el.dispatchEvent(new MouseEvent('click', { ...eventInit, button: 0, detail: 1 }));
    }

    const clickables = target.querySelectorAll('button, [role="button"], [class*="cursor-pointer"]');
    for (const el of clickables) {
      const text = (el.textContent || '').trim();
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      ${checks.join("\n")}
    }

    return { clicked: null };
  })()`;
}
