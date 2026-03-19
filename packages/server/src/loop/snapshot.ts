import type { QuotaInfo } from "@ag/shared";

import { checkAndExecuteAutoActions } from "../autoaction/index";
import { captureCSS, captureComputedVars } from "../capture/css";
import { captureHTML } from "../capture/html";
import type { CDPConnection } from "../cdp/types";
import { sendPushNotification } from "../push/sender";
import { cascadeStore } from "../store/cascades";
import { broadcast } from "../ws/broadcast";
import { hashString } from "../utils/hash";

// --- Quota Extraction ---
const EXTRACT_QUOTA_SCRIPT = `(() => {
    const el = document.getElementById('wusimpl.antigravity-quota-watcher');
    if (!el) return null;
    const anchor = el.querySelector('a');
    if (!anchor) return null;
    const statusText = anchor.textContent?.trim() || '';
    const ariaLabel = el.getAttribute('aria-label') || anchor.getAttribute('aria-label') || '';
    if (!ariaLabel) return { statusText, models: [], planName: null };
    const lines = ariaLabel.split('\\n');
    const models = [];
    let planName = null;
    for (const line of lines) {
        const planMatch = line.match(/\\(([^)]+)\\)\\s*$/);
        if (planMatch && !planName) planName = planMatch[1];
        if (line.startsWith('|') && !line.includes(':---') && !line.includes('模型') && !line.includes('Model')) {
            const cells = line.split('|').map(c => c.trim()).filter(c => c);
            if (cells.length >= 2) {
                const label = cells[0].replace(/^[🟢🟡🔴⚫\\s]+/, '').trim();
                const remainingStr = cells[1].trim();
                const resetTime = (cells[2] || '').trim();
                const pctMatch = remainingStr.match(/([\\d.]+)%/);
                const percentage = pctMatch ? parseFloat(pctMatch[1]) : null;
                if (label) models.push({ label, percentage, resetTime });
            }
        }
    }
    return { statusText, planName, models };
})()`;

async function extractQuotaInfo(cdp: CDPConnection): Promise<QuotaInfo | null> {
  try {
    const result: any = await cdp.call("Runtime.evaluate", {
      expression: EXTRACT_QUOTA_SCRIPT,
      returnByValue: true
    });
    return result.result?.value || null;
  } catch {
    return null;
  }
}

export async function updateSnapshots(): Promise<void> {
  // Parallel updates
  await Promise.all(
    cascadeStore.getAll().map(async (c) => {
      try {
        const snap = await captureHTML(c.cdp); // Only capture HTML
        if (snap) {
          const hash = hashString(snap.html);
          if (hash !== c.snapshotHash) {
            const oldLen = c.contentLength || 0;
            const newLen = snap.html.length;

            // Protect against empty/short snapshots overwriting good content
            if (newLen < 200 && oldLen > 500) {
              console.warn(
                `⚠️ Skipping short snapshot (${newLen} chars) for "${c.metadata.chatTitle}" (keeping ${oldLen} chars)`
              );
              c.stableCount = (c.stableCount || 0) + 1;
            } else {
              c.snapshot = snap;
              c.snapshotHash = hash;
              c.contentLength = newLen;
              c.stableCount = 0;

              broadcast({ type: "snapshot_update", cascadeId: c.id, snapshot: c.snapshot! });
            }
          } else {
            c.stableCount = (c.stableCount || 0) + 1;
          }
        }
      } catch {
        // ignore
      }

      // AI completion detection: fingerprint-based dedup
      // Only notify when feedback buttons appear AND the fingerprint changed
      if (c.snapshot?.hasFeedbackButtons && c.snapshot.feedbackFingerprint) {
        const fp = c.snapshot.feedbackFingerprint;
        if (fp !== c.lastFeedbackFingerprint) {
          c.lastFeedbackFingerprint = fp;
          console.log(
            `🔔 New AI completion for "${c.metadata.chatTitle}" (fp: ${fp}) — sending notification`
          );
          broadcast({ type: "ai_complete", cascadeId: c.id, title: c.metadata.chatTitle });
          sendPushNotification(c.metadata.chatTitle, c.id);
        }
      }

      // Keep store in sync: stableCount / lastFeedbackFingerprint are mutated in-place.
      cascadeStore.set(c.id, c);

      // ── Auto-actions (Accept All / Retry on error) ──
      if (c.snapshot) {
        try {
          await checkAndExecuteAutoActions(c.id, c.metadata.chatTitle, c.snapshot, c.cdp);
        } catch {
          // ignore
        }
      }

      // Quota polling
      try {
        const quota = await extractQuotaInfo(c.cdp);
        if (quota) {
          const qHash = hashString(JSON.stringify(quota));
          if (qHash !== c.quotaHash) {
            c.quota = quota;
            c.quotaHash = qHash;
            broadcast({ type: "quota_update", cascadeId: c.id, quota });
          }
        }
      } catch {
        // ignore
      }

      // Periodic CSS refresh: every 30 polls (~30s at 1s interval)
      c.cssRefreshCounter = (c.cssRefreshCounter || 0) + 1;
      if (c.cssRefreshCounter >= 30) {
        c.cssRefreshCounter = 0;
        try {
          const newCss = await captureCSS(c.cdp);
          const newVars = await captureComputedVars(c.cdp);
          let changed = false;
          if (newCss && newCss !== c.css) {
            c.css = newCss;
            changed = true;
          }
          if (newVars && JSON.stringify(newVars) !== JSON.stringify(c.computedVars)) {
            c.computedVars = newVars;
            changed = true;
          }
          if (changed) broadcast({ type: "css_update", cascadeId: c.id });
        } catch {
          // ignore
        }
      }

      // Ensure updated object stays in store (conservative; Map stores by ref anyway).
      cascadeStore.set(c.id, c);
    })
  );
}
