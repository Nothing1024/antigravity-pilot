import type { Snapshot } from "@ag/shared";

import { extractMetadata } from "../cdp/metadata";
import type { CDPConnection } from "../cdp/types";

export async function captureHTML(cdp: CDPConnection): Promise<Snapshot | null> {
  // NOTE: SCRIPT is injected into Electron; originally from legacy server.js; this is now the single source of truth.
  const SCRIPT = `(() => {
        // Build a unique CSS selector path for a given element
        function buildSelector(el) {
            const parts = [];
            let current = el;
            while (current && current !== document.body && current !== document.documentElement) {
                let selector = current.tagName.toLowerCase();
                if (current.id) {
                    selector = '#' + CSS.escape(current.id);
                    parts.unshift(selector);
                    break; // ID is unique enough
                }
                const parent = current.parentElement;
                if (parent) {
                    const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
                    if (siblings.length > 1) {
                        const idx = siblings.indexOf(current) + 1;
                        selector += ':nth-of-type(' + idx + ')';
                    }
                }
                parts.unshift(selector);
                current = parent;
            }
            return parts.join(' > ');
        }

        // Support both legacy #cascade and new iframe-based #conversation/#chat
        const chatEl = document.getElementById('cascade') 
            || document.getElementById('conversation') 
            || document.getElementById('chat');
        if (!chatEl) return { error: 'chat container not found' };
        
        // Capture the parent container to include the model-selection toolbar above the chat
        const target = (chatEl.parentElement && chatEl.parentElement !== document.body && chatEl.parentElement !== document.documentElement)
            ? chatEl.parentElement
            : chatEl;
        
        // Annotate clickable elements for click passthrough
        const clickSelector = 'button, a, [role="button"], [class*="cursor-pointer"], [role="menuitem"], [role="option"], [role="tab"], [role="combobox"], [aria-haspopup], [class*="backdrop"], [class*="overlay"]';
        const liveClickables = Array.from(target.querySelectorAll(clickSelector));
        const selectorMap = {};
        liveClickables.forEach((el, i) => {
            selectorMap[i] = buildSelector(el);
        });

        const clone = target.cloneNode(true);

        // Fix overflow clipping: remove classes that clip content in web context
        clone.querySelectorAll('[class]').forEach(el => {
            const cls = el.className;
            if (typeof cls === 'string' && (cls.includes('overflow-y-hidden') || cls.includes('overflow-x-clip') || cls.includes('overflow-hidden'))) {
                el.className = cls
                    .replace(/\boverflow-y-hidden\b/g, 'overflow-y-visible')
                    .replace(/\boverflow-x-clip\b/g, '')
                    .replace(/\boverflow-hidden\b/g, 'overflow-visible');
            }
        });

        // Tag clone elements with matching indexes
        const cloneClickables = Array.from(clone.querySelectorAll(clickSelector));
        // File extension pattern for detection
        const fileExtPattern = /\b([\w.-]+\.(?:md|txt|js|ts|jsx|tsx|py|rs|go|java|c|cpp|h|css|html|json|yaml|yml|toml|xml|sh|bash|sql|rb|php|swift|kt|scala|r|lua|pl|ex|exs|hs|ml|vue|svelte))\b/i;
        cloneClickables.forEach((el, i) => {
            if (i < liveClickables.length) el.setAttribute('data-cdp-click', i);
            // Detect file links by text content matching file patterns
            const text = (el.textContent || '').trim();
            const match = text.match(fileExtPattern);
            if (match) {
                el.setAttribute('data-file-name', match[1]);
            }
        });

        // Remove only the contenteditable editor — keep Planning/Model toolbar buttons
        const editor = clone.querySelector('[contenteditable="true"]');
        if (editor) {
            editor.remove();
        }

        // Move dialog overlays (e.g. Confirm Undo) to end of DOM tree.
        // In Shadow DOM, position:fixed z-index is limited by stacking context —
        // chat elements with transform/position:relative render ABOVE the dialog.
        // Moving dialog to last-child ensures it paints last (CSS painting order).
        // This is done in the clone so morphdom always receives consistent structure.
        const dialogOverlay = clone.querySelector('.fixed.inset-0[class*="bg-black"]');
        if (dialogOverlay) {
            clone.appendChild(dialogOverlay);
        }

        const bodyStyles = window.getComputedStyle(document.body);

        // Detect AI completion feedback buttons by their unique data-tooltip-id attributes
        const feedbackUp = target.querySelector('[data-tooltip-id^="up-"]');
        const feedbackDown = target.querySelector('[data-tooltip-id^="down-"]');
        const hasFeedbackButtons = !!(feedbackUp && feedbackDown);

        // Extract fingerprint: use feedback button's data-tooltip-id (contains React unique ID per message)
        let feedbackFingerprint = null;
        if (hasFeedbackButtons) {
            feedbackFingerprint = feedbackUp.getAttribute('data-tooltip-id') || null;
        }

        return {
            html: clone.outerHTML,
            bodyBg: bodyStyles.backgroundColor,
            bodyColor: bodyStyles.color,
            clickMap: selectorMap,
            hasFeedbackButtons,
            feedbackFingerprint
        };
    })()`;

  const contextId = cdp.rootContextId;
  if (!contextId) return null;

  try {
    const result: any = await cdp.call("Runtime.evaluate", {
      expression: SCRIPT,
      returnByValue: true,
      contextId: contextId
    });
    if (result.result?.value && !result.result.value.error) {
      return result.result.value as Snapshot;
    }
  } catch {
    // ignore
  }

  // Retry once: refresh context and try again
  try {
    const meta = await extractMetadata(cdp);
    if (meta?.contextId && meta.contextId !== contextId) {
      cdp.rootContextId = meta.contextId;
      const result: any = await cdp.call("Runtime.evaluate", {
        expression: SCRIPT,
        returnByValue: true,
        contextId: meta.contextId
      });
      if (result.result?.value && typeof result.result.value === 'string') {
        return ({ html: result.result.value } as any) as Snapshot;
      }
    }
  } catch {
    // ignore
  }
  return null;
}
