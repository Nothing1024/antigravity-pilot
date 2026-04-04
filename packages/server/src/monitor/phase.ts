/**
 * Response Monitor (F2) — Detects the current phase of the Antigravity Agent
 * by inspecting DOM state via CSS selectors through CDP, and extracts
 * response text incrementally during generation for SSE streaming.
 *
 * Phase transitions:
 *   IDLE → THINKING → GENERATING → COMPLETED → IDLE
 *                                → APPROVAL_PENDING
 *                                → QUOTA_ERROR
 *                                → ERROR
 */

import { ResponsePhase } from "@ag/shared";

import { eventBus } from "../events/bus";
import { config } from "../config";
import { discovery, rpc } from "../rpc/routing";
import { cascadeStore } from "../store/cascades";
import { cascadeMap } from "../store/cascadeMap";

/** Track last-seen RPC status per cascade to suppress noisy repeated logs. */
const lastRpcStatus = new Map<string, string>();
/** Track which cascades are currently in CDP fallback to suppress repeated logs. */
const inCdpFallback = new Set<string>();

// --- Phase Detection Script (injected into Antigravity DOM) ---

const DETECT_PHASE_SCRIPT = `(() => {
  // 1. Check for stop button → GENERATING
  const stopBtn = document.querySelector(
    '[data-tooltip-id*="stop"], [data-tooltip-id*="cancel"], button[aria-label*="Stop"], button[aria-label*="stop"]'
  );
  if (stopBtn) {
    const style = getComputedStyle(stopBtn);
    if (style.display !== 'none' && style.visibility !== 'hidden') {
      return { phase: 'generating' };
    }
  }

  // 2. Check for approval dialog → APPROVAL_PENDING
  const approvalBtns = document.querySelectorAll('button');
  let hasAccept = false;
  let hasReject = false;
  for (const btn of approvalBtns) {
    const text = (btn.textContent || '').trim().toLowerCase();
    if (text === 'accept' || text === 'approve' || text.includes('accept all')) hasAccept = true;
    if (text === 'reject' || text === 'deny' || text === 'cancel') hasReject = true;
  }
  if (hasAccept && hasReject) return { phase: 'approval_pending' };

  // 3. Check for thinking/loading indicator → THINKING
  const thinkingEl = document.querySelector(
    '[class*="thinking"], [class*="loading"], [class*="spinner"], .animate-pulse, .animate-spin'
  );
  if (thinkingEl) {
    const style = getComputedStyle(thinkingEl);
    if (style.display !== 'none' && style.visibility !== 'hidden') {
      // Only THINKING if there's no response content yet
      const feedbackUp = document.querySelector('[data-tooltip-id^="up-"]');
      if (!feedbackUp) {
        return { phase: 'thinking' };
      }
    }
  }

  // 4. Check for quota/rate-limit error → QUOTA_ERROR
  const quotaEl = document.querySelector(
    '[class*="quota"], [class*="rate-limit"], [class*="usage-limit"]'
  );
  if (quotaEl) {
    const text = (quotaEl.textContent || '').toLowerCase();
    if (text.includes('limit') || text.includes('quota') || text.includes('exceeded')) {
      return { phase: 'quota_error' };
    }
  }

  // 5. Check for error state → ERROR
  const errorBanner = document.querySelector(
    '[class*="error-banner"], [class*="error-message"], [role="alert"]'
  );
  if (errorBanner) {
    const text = (errorBanner.textContent || '').toLowerCase();
    if (text.includes('error') || text.includes('failed') || text.includes('sorry')) {
      return { phase: 'error' };
    }
  }

  // 6. Check for feedback buttons → COMPLETED (agent just finished)
  const feedbackUp = document.querySelector('[data-tooltip-id^="up-"]');
  const feedbackDown = document.querySelector('[data-tooltip-id^="down-"]');
  if (feedbackUp && feedbackDown) {
    return { phase: 'completed' };
  }

  // 7. Default → IDLE
  return { phase: 'idle' };
})()`;

// --- Extract latest assistant response text ---
// Uses feedback buttons (👍👎) as anchors to locate the assistant message,
// then extracts only the markdown content, filtering out UI chrome.
export const EXTRACT_RESPONSE_SCRIPT = `(() => {
  const chatEl = document.getElementById('cascade')
    || document.getElementById('conversation')
    || document.getElementById('chat');
  if (!chatEl) return { text: '', length: 0 };

  // Strategy 1: Use feedback buttons as anchor to find the response container.
  // Feedback buttons (up-xxx / down-xxx) sit right next to the assistant's response.
  const feedbackUp = chatEl.querySelector('[data-tooltip-id^="up-"]');

  if (feedbackUp) {
    // Walk up to find the message container that holds both the response and feedback
    let msgContainer = feedbackUp.parentElement;
    for (let i = 0; i < 8 && msgContainer; i++) {
      // Look for a container that is large enough to be a message block
      if (msgContainer.offsetHeight > 60) break;
      msgContainer = msgContainer.parentElement;
    }

    if (msgContainer) {
      // Clone and remove non-content elements
      const clone = msgContainer.cloneNode(true);

      // Remove feedback buttons themselves
      clone.querySelectorAll('[data-tooltip-id]').forEach(el => el.remove());
      // Remove interactive buttons (Accept/Reject/Copy etc.)
      clone.querySelectorAll('button, [role="button"]').forEach(el => {
        const text = (el.textContent || '').trim().toLowerCase();
        if (['accept', 'reject', 'accept all', 'reject all', 'copy', 'apply',
             'retry', 'cancel', 'dismiss'].some(k => text.includes(k))) {
          el.remove();
        }
      });
      // Remove contenteditable (input area)
      clone.querySelectorAll('[contenteditable]').forEach(el => el.remove());

      const rawText = (clone.innerText || '').trim();
      // Post-process: remove common UI noise lines
      const lines = rawText.split('\\n').filter(line => {
        const t = line.trim();
        if (!t) return false;
        // Filter out file change indicators like "+252 -0"
        if (/^[+-]\\d+$/.test(t)) return false;
        // Filter out known UI strings
        if (t === 'Accept all' || t === 'Reject all') return false;
        if (t.startsWith('Ask anything') || t.includes('@ to mention')) return false;
        if (/^(Fast|Normal|Thinking)$/.test(t)) return false;
        if (/^Claude|^GPT|^Gemini|^Opus|^Sonnet|^Haiku/i.test(t) && t.length < 40) return false;
        // Filter out "N Files With Changes" header
        if (/^\\d+ Files? With Changes?$/i.test(t)) return false;
        return true;
      });

      const text = lines.join('\\n').trim();
      if (text.length > 5) {
        return { text, length: text.length };
      }
    }
  }

  // Strategy 2: Find markdown-rendered content blocks (no feedback buttons yet — still generating)
  const markdownSelectors = [
    '[class*="markdown-body"]',
    '[class*="message-content"]',
    '[class*="response-content"]',
    '[class*="assistant-message"]',
    '[data-role="assistant"]',
  ];

  for (const sel of markdownSelectors) {
    const blocks = chatEl.querySelectorAll(sel);
    if (blocks.length === 0) continue;

    const lastBlock = blocks[blocks.length - 1];
    // Make sure this isn't inside the input area
    if (lastBlock.closest('[contenteditable]')) continue;
    if (lastBlock.closest('[class*="input"]')) continue;

    const text = (lastBlock.innerText || '').trim();
    if (text.length > 5) {
      return { text, length: text.length };
    }
  }

  // Strategy 3: Last resort — find the last substantial text block in chat,
  // but explicitly exclude known UI containers.
  const allChildren = chatEl.children;
  for (let i = allChildren.length - 1; i >= 0; i--) {
    const child = allChildren[i];
    // Skip if it's the input area
    if (child.querySelector('[contenteditable]')) continue;
    // Skip if it contains model selector
    if (child.querySelector('[class*="model"]')) continue;

    const text = (child.innerText || '').trim();
    // Filter out short UI-only text
    if (text.length > 20) {
      // Final cleanup
      const cleanLines = text.split('\\n').filter(line => {
        const t = line.trim();
        if (!t) return false;
        if (/^[+-]\\d+$/.test(t)) return false;
        if (t === 'Accept all' || t === 'Reject all') return false;
        if (t.startsWith('Ask anything')) return false;
        if (/^\\d+ Files? With Changes?$/i.test(t)) return false;
        return true;
      });
      const cleaned = cleanLines.join('\\n').trim();
      if (cleaned.length > 10) {
        return { text: cleaned, length: cleaned.length };
      }
    }
  }

  return { text: '', length: 0 };
})()`;

/**
 * Detects the current phase for a single cascade and emits events on transitions.
 * Also extracts response text incrementally during GENERATING phase.
 */
async function detectPhase(cascadeId: string): Promise<void> {
  const c = cascadeStore.get(cascadeId);
  if (!c) return;

  const cdp = c.cdp;
  const contextId = cdp.rootContextId;
  if (!contextId) return;

  try {
    const result: any = await cdp.call("Runtime.evaluate", {
      expression: DETECT_PHASE_SCRIPT,
      returnByValue: true,
      contextId,
    });

    const detected = result.result?.value?.phase;
    if (!detected) return;

    const newPhase = detected as ResponsePhase;
    const oldPhase = c.phase;

    // --- Phase transition ---
    if (newPhase !== oldPhase) {
      c.phase = newPhase;
      c.lastPhaseChange = Date.now();

      console.log(
        `🔄 Phase change for "${c.metadata.chatTitle}": ${oldPhase} → ${newPhase}`
      );

      eventBus.emit("phase_change", {
        cascadeId,
        phase: newPhase,
        previousPhase: oldPhase,
        timestamp: Date.now(),
      });

      // Reset response text when starting fresh
      if (newPhase === ResponsePhase.IDLE || newPhase === ResponsePhase.THINKING) {
        c.responseText = "";
      }
    }

    // --- Incremental text extraction during active phases ---
    if (
      newPhase === ResponsePhase.GENERATING ||
      newPhase === ResponsePhase.COMPLETED ||
      newPhase === ResponsePhase.APPROVAL_PENDING
    ) {
      await extractResponseText(cascadeId, contextId);
    }
  } catch {
    // CDP call failed — connection might be unhealthy, handled by Connection Pool
  }
}

/**
 * Extract current response text and emit delta events.
 */
async function extractResponseText(
  cascadeId: string,
  contextId: number
): Promise<void> {
  const c = cascadeStore.get(cascadeId);
  if (!c) return;

  try {
    const textResult: any = await c.cdp.call("Runtime.evaluate", {
      expression: EXTRACT_RESPONSE_SCRIPT,
      returnByValue: true,
      contextId,
    });

    const text = (textResult.result?.value?.text || "").trim();
    if (!text) return;

    const previousText = c.responseText || "";

    // Only emit if text actually changed (new content appeared)
    if (text.length > previousText.length || text !== previousText) {
      // Compute delta: the new text appended since last extraction
      let delta = "";
      if (text.startsWith(previousText)) {
        // Simple append — most common case
        delta = text.slice(previousText.length);
      } else {
        // Text structure changed (e.g. reformatting) — send full text as delta
        delta = text;
      }

      if (delta) {
        c.responseText = text;

        eventBus.emit("response_text", {
          cascadeId,
          text,
          delta,
          timestamp: Date.now(),
        });
      }
    }
  } catch {
    // ignore text extraction failure
  }
}

/**
 * Fetch trajectory statuses per LS instance.
 * Returns a Map of workspaceId → best status for that instance.
 *
 * Previous approach (fetchBestRpcStatus) was WRONG: it picked the single
 * most active status across ALL instances and applied it to ALL cascades,
 * causing e.g. fusion to show as "generating" when only vibee was running.
 */
async function fetchPerInstanceStatus(): Promise<Map<string, string>> {
  const instances = await discovery.getInstances();
  const result = new Map<string, string>();

  await Promise.allSettled(
    instances.map(async (inst) => {
      try {
        const data = await rpc.call<{
          trajectorySummaries?: Record<string, { status?: string }>;
        }>("GetAllCascadeTrajectories", {}, inst);

        const summaries = data.trajectorySummaries;
        if (!summaries) return;

        let best = "CASCADE_RUN_STATUS_IDLE";
        for (const [, summary] of Object.entries(summaries)) {
          const status = summary.status ?? "CASCADE_RUN_STATUS_IDLE";
          if (statusPriority(status) > statusPriority(best)) {
            best = status;
          }
        }

        const wsId = inst.workspaceId ?? `pid-${inst.pid}`;
        result.set(wsId, best);
      } catch {
        // LS unreachable — skip
      }
    }),
  );

  return result;
}

/** Higher = more active. */
function statusPriority(status: string): number {
  switch (status) {
    case "CASCADE_RUN_STATUS_RUNNING": return 3;
    case "CASCADE_RUN_STATUS_ERROR": return 2;
    case "CASCADE_RUN_STATUS_IDLE": return 1;
    default: return 0;
  }
}

function mapRpcStatusToPhase(status: string): ResponsePhase {
  switch (status) {
    case "CASCADE_RUN_STATUS_IDLE":
      return ResponsePhase.IDLE;
    case "CASCADE_RUN_STATUS_RUNNING":
      return ResponsePhase.GENERATING;
    case "CASCADE_RUN_STATUS_ERROR":
      return ResponsePhase.ERROR;
    case "CASCADE_RUN_STATUS_UNLOADED":
      return ResponsePhase.IDLE;
    default:
      return ResponsePhase.IDLE;
  }
}

function applyPhaseChange(
  cascadeId: string,
  newPhase: ResponsePhase,
  source: "RPC" | "CDP",
): void {
  const c = cascadeStore.get(cascadeId);
  if (!c) return;

  const oldPhase = c.phase;
  if (newPhase === oldPhase) return;

  c.phase = newPhase;
  c.lastPhaseChange = Date.now();

  console.log(
    `🔄 Phase change (${source}) for "${c.metadata.chatTitle}": ${oldPhase} → ${newPhase}`,
  );

  eventBus.emit("phase_change", {
    cascadeId,
    phase: newPhase,
    previousPhase: oldPhase,
    timestamp: Date.now(),
  });

  if (newPhase === ResponsePhase.IDLE || newPhase === ResponsePhase.THINKING) {
    c.responseText = "";
  }
}

/**
 * Match a cascade's window title to an LS instance workspaceId.
 *
 * Window title format: "project-name — Antigravity" or "project-name - Tab Title"
 * WorkspaceId format: "file_Users_nothing_workspace_project-name"
 *
 * We extract the project name from both and compare.
 */
function matchCascadeToWorkspace(
  cascade: { metadata: { windowTitle: string } },
  statusMap: Map<string, string>,
): string | null {
  const wt = cascade.metadata.windowTitle ?? "";
  // Extract workspace name from window title (before " — " or " - ")
  const wsName = (wt.split(" — ")[0] || wt.split(" - ")[0] || "").trim().toLowerCase();
  if (!wsName) return null;

  for (const [wsId, status] of statusMap) {
    // wsId like "file_Users_nothing_workspace_vibee" — extract last segment
    const segments = wsId.split("_");
    const lastSegment = segments[segments.length - 1]?.toLowerCase() ?? "";

    // Also try matching against the path-based segments
    // e.g. "file_Users_nothing_workspace_antigravity_antigravity-pilot"
    // should match window title "antigravity-pilot"
    const fullPath = wsId.replace(/^file_/, "").toLowerCase();

    if (
      lastSegment === wsName ||
      wsName.includes(lastSegment) ||
      lastSegment.includes(wsName) ||
      fullPath.endsWith(wsName.replace(/-/g, "_")) ||
      fullPath.endsWith(wsName)
    ) {
      return status;
    }
  }

  return null;
}

/**
 * Run phase detection for all connected cascades.
 * Called from the snapshot loop (~1s interval).
 *
 * RPC mode: fetch per-instance trajectory statuses and map each
 * cascade to its own LS instance for accurate per-cascade phase.
 * Falls back to CDP DOM heuristics for fine-grained states.
 */
export async function updatePhases(): Promise<void> {
  const cascades = cascadeStore.getAll();

  if (!config.rpc.enabled) {
    // CDP-only mode: use DOM heuristics for all cascades
    await Promise.all(cascades.map((c) => detectPhase(c.id)));
    return;
  }

  // Fetch per-instance statuses
  let statusMap: Map<string, string>;
  try {
    statusMap = await fetchPerInstanceStatus();
  } catch {
    // RPC completely unavailable — fall back to CDP for all cascades
    for (const c of cascades) {
      if (!inCdpFallback.has(c.id)) {
        inCdpFallback.add(c.id);
        console.log(`[phase:cdp] ${c.id.slice(0, 8)}… RPC unavailable, using CDP fallback`);
      }
    }
    await Promise.all(cascades.map((c) => detectPhase(c.id)));
    return;
  }

  if (statusMap.size === 0) {
    // No LS instances found — fall back to CDP
    await Promise.all(cascades.map((c) => detectPhase(c.id)));
    return;
  }

  await Promise.all(
    cascades.map(async (c) => {
      // Prefer cascadeMap: use pre-resolved workspace for accurate lookup
      const mapping = cascadeMap.getByCascade(c.id);
      let matchedStatus: string | null = null;

      if (mapping) {
        // Find the status for this cascade's workspace
        for (const [wsId, status] of statusMap) {
          const normalWsId = wsId.toLowerCase();
          const normalMappingWsId = mapping.workspaceId.toLowerCase();
          if (
            normalWsId === normalMappingWsId ||
            normalWsId.includes(normalMappingWsId) ||
            normalMappingWsId.includes(normalWsId)
          ) {
            matchedStatus = status;
            break;
          }
        }
      }

      // Fallback: title-based matching (for cascades not yet in cascadeMap)
      if (!matchedStatus) {
        matchedStatus = matchCascadeToWorkspace(c, statusMap);
      }

      if (matchedStatus) {
        // Log status changes
        const prev = lastRpcStatus.get(c.id);
        if (matchedStatus !== prev) {
          console.log(`[phase:rpc] ${c.metadata.chatTitle}: ${prev ?? 'init'} → ${matchedStatus}`);
          lastRpcStatus.set(c.id, matchedStatus);
        }
        if (inCdpFallback.delete(c.id)) {
          console.log(`[phase:rpc] ${c.id.slice(0, 8)}… RPC recovered`);
        }

        const rpcPhase = mapRpcStatusToPhase(matchedStatus);

        if (
          rpcPhase === ResponsePhase.GENERATING ||
          rpcPhase === ResponsePhase.ERROR
        ) {
          applyPhaseChange(c.id, rpcPhase, "RPC");

          if (rpcPhase === ResponsePhase.GENERATING && c.cdp.rootContextId) {
            await extractResponseText(c.id, c.cdp.rootContextId);
          }
          return;
        }

        // RPC says IDLE — use CDP for fine-grained states (THINKING, APPROVAL_PENDING, etc.)
        await detectPhase(c.id);
      } else {
        // No matching LS instance — fall back to CDP
        if (!inCdpFallback.has(c.id)) {
          inCdpFallback.add(c.id);
          console.log(`[phase:cdp] ${c.metadata.chatTitle}: no matching LS instance, using CDP`);
        }
        await detectPhase(c.id);
      }
    }),
  );
}

