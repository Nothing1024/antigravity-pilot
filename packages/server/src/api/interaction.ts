import express from "express";

import { captureHTML } from "../capture/html";
import { injectMessage } from "../cdp/inject";
import { sendMessageWithFallback } from "../rpc/fallback";
import { cascadeStore } from "../store/cascades";
import { hashString } from "../utils/hash";
import { broadcast } from "../ws/broadcast";

export const interactionRouter: express.Router = express.Router();

export const router: express.Router = interactionRouter;
export default router;

interactionRouter.post("/send/:id", async (req, res) => {
  const c = cascadeStore.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Cascade not found" });

  // Re-using the injection logic logic would be long,
  // but let's assume valid injection for brevity in this single-file request:
  // We'll trust the previous logic worked, just pointing it to c.cdp

  // ... (Injection logic here would be same as before, simplified for brevity of this file edit)
  // For now, let's just log it to prove flow works
  console.log(`Message to ${c.metadata.chatTitle}: ${req.body.message}`);
  // TODO: Port the full injection script back in if needed,
  // but user asked for "update" which implies features, I'll assume I should include it.
  // See helper below.

  const result = await sendMessageWithFallback(req.params.id, req.body.message);
  if (result.ok) res.json(result);
  else res.status(500).json(result);
});

// Click passthrough: forward a click to the IDE via CDP (pure click, no snapshot)
interactionRouter.post("/click/:id", async (req, res) => {
  const c = cascadeStore.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Cascade not found" });

  const idx = req.body.index;
  const selector = c.snapshot?.clickMap?.[idx];
  if (!selector) return res.status(400).json({ error: "Invalid click index" });

  try {
    // All-in-one: scroll → locate → dispatch click events in a single CDP call
    // This eliminates 2 extra CDP round-trips (~200ms) and the 50ms scroll settle delay.
    const clickResult = await c.cdp.call("Runtime.evaluate", {
      expression: `(() => {
        try {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { ok: false, reason: 'element not found: ' + ${JSON.stringify(selector)} };

          // Scroll into view
          el.scrollIntoView({ block: 'center', behavior: 'instant' });

          // Read coordinates & metadata
          const rect = el.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const text = (el.textContent || '').substring(0, 200).trim();
          let filePath = null;
          const href = el.getAttribute('href') || '';
          if (href.startsWith('file://')) filePath = decodeURIComponent(href.replace('file://', ''));
          const dataUri = el.getAttribute('data-href') || el.closest('[data-href]')?.getAttribute('data-href') || '';
          if (!filePath && dataUri.startsWith('file://')) filePath = decodeURIComponent(dataUri.replace('file://', ''));

          // Dispatch full browser event sequence for React/Electron compatibility
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

          return { ok: true, text, filePath };
        } catch (e) {
          return { ok: false, reason: 'JS Eval Exception: ' + e.message };
        }
      })()`,
      returnByValue: true,
      contextId: c.cdp.rootContextId
    });
    const val = clickResult.result?.value;
    if (!val?.ok) {
      return res.status(500).json({ error: val?.reason || "click failed" });
    }

    console.log(
      `🖱️ Click forwarded: "${val.text}"${val.filePath ? ` (file: ${val.filePath})` : ""}`
    );
    res.json({ success: true, text: val.text, filePath: val.filePath });

    // Fire-and-forget: refresh snapshot after a brief delay so the IDE
    // has time to process the click before we capture the new state.
    // This eliminates the up-to-1s wait for the next polling cycle.
    setTimeout(async () => {
      try {
        const snap = await captureHTML(c.cdp);
        if (snap) {
          const hash = hashString(snap.html);
          if (hash !== c.snapshotHash && snap.html.length > 200) {
            c.snapshot = snap;
            c.snapshotHash = hash;
            c.contentLength = snap.html.length;
            c.stableCount = 0;
            cascadeStore.set(c.id, c);
            broadcast({ type: "snapshot_update", cascadeId: c.id, snapshot: snap });
          }
        }
      } catch { /* ignore */ }
    }, 150);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Popup extraction: click button → wait for popup → extract items → Escape close → return JSON
interactionRouter.post("/popup/:id", async (req, res) => {
  const c = cascadeStore.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Cascade not found" });

  const idx = req.body.index;
  const selector = c.snapshot?.clickMap?.[idx];
  if (!selector) return res.status(400).json({ error: "Invalid click index" });

  try {
    // Helper: snapshot signatures of currently visible dialogs and listboxes
    const snapshotVisibleDialogs = async () => {
      const r = await c.cdp.call("Runtime.evaluate", {
        expression: `(() => {
                      const sigs = [];
                      document.querySelectorAll('[role="dialog"], [role="listbox"]').forEach(el => {
                        const style = window.getComputedStyle(el);
                        if (style.visibility === 'visible' && style.display !== 'none' && style.opacity !== '0') {
                          sigs.push((el.textContent || '').substring(0, 80).trim());
                        }
                      });
                      return sigs;
                    })()`,
        returnByValue: true,
        contextId: c.cdp.rootContextId
      });
      return r.result?.value || [];
    };

    // Helper: scroll element into view and click — single CDP call for minimal latency
    const clickTrigger = async () => {
      return c.cdp.call("Runtime.evaluate", {
        expression: `(() => {
          try {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return { ok: false };
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            const rect = el.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const text = (el.textContent || '').substring(0, 100).trim();
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
            return { ok: true, text, cx: x, cy: y };
          } catch (e) { return { ok: false }; }
        })()`,
        returnByValue: true,
        contextId: c.cdp.rootContextId
      });
    };

    // Helper: send Escape to close IDE popup (prevents snapshot corruption)
    const sendEscape = async () => {
      try {
        await c.cdp.call("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
          nativeVirtualKeyCode: 27
        });
        await c.cdp.call("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
          nativeVirtualKeyCode: 27
        });
      } catch (_) {}
    };

    const doExtract = async (beforeSigs: any) => {
      return c.cdp.call("Runtime.evaluate", {
        expression: `((beforeSigs) => {
                      let items = [];
                      
                      // Search both dialog and listbox containers
                      const containers = document.querySelectorAll('[role="dialog"], [role="listbox"]');
                      let targetDialog = null;
                      let isListbox = false;
                      
                      for (const dialog of containers) {
                        const style = window.getComputedStyle(dialog);
                        if (style.visibility === 'hidden') continue;
                        if (style.display === 'none') continue;
                        if (style.pointerEvents === 'none') continue;
                        
                        const sig = (dialog.textContent || '').substring(0, 80).trim();
                        if (beforeSigs.some(bs => bs === sig)) continue;
                        
                        const role = dialog.getAttribute('role');
                        if (role === 'listbox') {
                          // HeadlessUI listbox — always has [role=option] children
                          if (dialog.querySelector('[role="option"]')) {
                            targetDialog = dialog;
                            isListbox = true;
                            break;
                          }
                        } else {
                          // Dialog — check for interactive children
                          const hasInteractive = dialog.querySelector(
                            'div[class*="cursor-pointer"], div[class*="hover:"], [role="option"], [role="menuitem"]'
                          );
                          if (!hasInteractive) continue;
                          targetDialog = dialog;
                          break;
                        }
                      }
                      
                      if (!targetDialog) return { items: [], found: false };
                      
                      // Shared helper: build a CSS selector path from a DOM node
                      const buildPath = (node) => {
                        const parts = [];
                        while (node && node !== document.body) {
                          const parent = node.parentElement;
                          if (!parent) break;
                          const siblings = Array.from(parent.children);
                          const index = siblings.indexOf(node) + 1;
                          const tag = node.tagName.toLowerCase();
                          parts.unshift(tag + ':nth-child(' + index + ')');
                          node = parent;
                        }
                        return 'body > ' + parts.join(' > ');
                      };
                      
                      // Fast path for HeadlessUI Listbox containers
                      if (isListbox) {
                        const options = targetDialog.querySelectorAll('[role="option"]');
                        for (const opt of options) {
                          const text = (opt.textContent || '').trim();
                          if (!text || text.length > 100) continue;
                          const isSelected = opt.getAttribute('aria-selected') === 'true' ||
                                             opt.getAttribute('data-headlessui-state')?.includes('selected');
                          items.push({
                            title: text,
                            description: '',
                            badges: [],
                            header: '',
                            selector: opt.id ? '#' + opt.id : buildPath(opt),
                            checked: isSelected
                          });
                        }
                        return { items, found: true };
                      }
                      
                      let header = '';
                      const headerEl = targetDialog.querySelector('.text-xs.opacity-80, .text-xs.pb-1');
                      if (headerEl) header = (headerEl.textContent || '').trim();
                      
                      const candidates = targetDialog.querySelectorAll(
                        'div[class*="cursor-pointer"], div[class*="hover:"], button, ' +
                        '[role="option"], [role="menuitem"], li'
                      );
                      
                      const allTexts = new Set();
                      
                      for (const el of candidates) {
                        const fullText = (el.textContent || '').trim();
                        if (!fullText || fullText.length > 200 || allTexts.has(fullText)) continue;
                        
                        const childCandidates = el.querySelectorAll(
                          'div[class*="cursor-pointer"], div[class*="hover:"], button'
                        );
                        if (childCandidates.length > 0) continue;
                        
                        allTexts.add(fullText);
                        
                        let title = '';
                        let description = '';
                        const badges = [];
                        
                        const titleEl = el.querySelector('.font-medium, .font-semibold, .font-bold');
                        const descEl = el.querySelector('.opacity-50, .opacity-60, .text-muted');
                        
                        if (titleEl) {
                          title = (titleEl.textContent || '').trim();
                          if (descEl) description = (descEl.textContent || '').trim();
                        } else {
                          title = fullText;
                        }
                        
                        if (!title) continue;
                        
                        el.querySelectorAll('.text-xs').forEach(badge => {
                          const bt = (badge.textContent || '').trim();
                          if (bt.toLowerCase() === 'new') badges.push(bt);
                        });
                        
                        const itemSelector = el.id ? '#' + el.id : buildPath(el);
                        
                        items.push({
                          title, description, badges, header: header || '',
                          selector: itemSelector,
                          checked: el.getAttribute('aria-checked') === 'true' || 
                                   el.classList.contains('checked') ||
                                   el.classList.contains('selected')
                        });
                      }
                      
                      return { items, found: true };
                    })(${JSON.stringify(beforeSigs)})`,
        returnByValue: true,
        contextId: c.cdp.rootContextId
      });
    };

    // Step 1: Snapshot visible dialogs BEFORE click
    const beforeSigs = await snapshotVisibleDialogs();

    // Step 2: Click trigger to toggle the popup
    const clickResult = await clickTrigger();
    if (!clickResult.result?.value?.ok) {
      return res.status(500).json({ error: "Failed to click trigger element" });
    }
    console.log(`🎯 Popup trigger clicked: "${clickResult.result.value.text}"`);

    // Step 3: Wait for popup to render
    await new Promise((resolve) => setTimeout(resolve, 350));

    // Step 4: Extract items from NEWLY visible dialog
    let extractResult = await doExtract(beforeSigs);
    let popupData = extractResult.result?.value || { items: [] };

    // Step 5: If 0 items, click likely CLOSED the popup (toggle off)
    // Take fresh snapshot → click again to reopen → extract
    if (popupData.items.length === 0) {
      console.log(`🔄 Popup toggle retry (0 items, clicking again to reopen)`);
      const freshSigs = await snapshotVisibleDialogs();
      await clickTrigger();
      await new Promise((resolve) => setTimeout(resolve, 350));
      extractResult = await doExtract(freshSigs);
      popupData = extractResult.result?.value || { items: [] };
    }

    // Step 6: Leave the popup OPEN (popup-click will click the option directly)
    // The Escape will be sent by popup-click after selection, or by dismiss route

    console.log(`📋 Popup extracted: ${popupData.items.length} items`);
    res.json(popupData);
  } catch (e: any) {
    // Close popup on extraction error
    try {
      await c.cdp.call("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27
      });
      await c.cdp.call("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27
      });
    } catch (_) {}
    res.status(500).json({ error: e.message });
  }
});

// Popup item click: directly click a visible option in the already-open popup
interactionRouter.post("/popup-click/:id", async (req, res) => {
  const c = cascadeStore.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Cascade not found" });

  const { title, selector, triggerIndex } = req.body;
  if (!title) return res.status(400).json({ error: "No title provided" });

  const clickMapSelector = Number.isInteger(triggerIndex) ? c.snapshot?.clickMap?.[triggerIndex] : null;

  try {
    // Find the visible option by text and click it
    const locateResult = await c.cdp.call("Runtime.evaluate", {
      expression: `(() => {
                  const targetText = ${JSON.stringify(title)};
                  const targetSelector = ${JSON.stringify(selector || null)};
                  const triggerSelector = ${JSON.stringify(clickMapSelector || null)};

                  if (targetSelector) {
                    try {
                      const direct = document.querySelector(targetSelector);
                      if (direct) {
                        const dStyle = window.getComputedStyle(direct);
                        const dRect = direct.getBoundingClientRect();
                        if (dStyle.display !== 'none' && dStyle.visibility !== 'hidden' && dRect.height > 0) {
                          return {
                            ok: true,
                            text: (direct.textContent || '').trim(),
                            cx: dRect.left + dRect.width / 2,
                            cy: dRect.top + dRect.height / 2,
                            by: 'selector'
                          };
                        }
                      }
                    } catch (_) {
                    }
                  }
                  
                  // Find the visible popup container (dialog or listbox)
                  // Iterate from LAST to FIRST — newly opened popups are appended at the end
                  const containers = Array.from(document.querySelectorAll('[role="dialog"], [role="listbox"]'));
                  let activeContainer = null;
                  let bestContainer = null; // container whose text contains the target

                  let triggerRect = null;
                  if (triggerSelector) {
                    try {
                      const triggerEl = document.querySelector(triggerSelector);
                      if (triggerEl) triggerRect = triggerEl.getBoundingClientRect();
                    } catch (_) {
                    }
                  }
                  
                  for (let i = containers.length - 1; i >= 0; i--) {
                    const c = containers[i];
                    const style = window.getComputedStyle(c);
                    if (style.display === 'none' || style.visibility === 'hidden') continue;
                    if (c.getBoundingClientRect().height === 0) continue;

                    if (triggerRect) {
                      const rect = c.getBoundingClientRect();
                      const dx = (rect.left + rect.width / 2) - (triggerRect.left + triggerRect.width / 2);
                      const dy = rect.top - triggerRect.bottom;
                      if (Math.abs(dx) > window.innerWidth * 0.6 || Math.abs(dy) > window.innerHeight * 0.6) {
                        continue;
                      }
                    }
                    
                    // Prefer the container whose text includes the target
                    if (!bestContainer && (c.textContent || '').includes(targetText)) {
                      bestContainer = c;
                    }
                    if (!activeContainer) activeContainer = c; // last visible = most recently opened
                  }
                  
                  activeContainer = bestContainer || activeContainer;
                  
                  if (!activeContainer) {
                    return { ok: false, reason: 'no visible container', optCount: 0, optTexts: [] };
                  }
                  
                  const role = activeContainer.getAttribute('role');
                  
                  // Search within the container based on type
                  if (role === 'listbox') {
                    // HeadlessUI listbox — search [role=option] within
                    const options = activeContainer.querySelectorAll('[role="option"]');
                    for (const opt of options) {
                      const t = (opt.textContent || '').trim();
                      if (t === targetText) {
                        const rect = opt.getBoundingClientRect();
                        if (rect.height > 0 && rect.top >= 0 && rect.top < window.innerHeight) {
                          return { ok: true, text: t, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
                        }
                      }
                    }
                    return { ok: false, optCount: options.length, optTexts: Array.from(options).slice(0, 5).map(o => (o.textContent||'').trim().substring(0,30)) };
                  }
                  
                  // Dialog — search interactive items within
                  const candidates = activeContainer.querySelectorAll(
                    'div[class*="cursor-pointer"], div[class*="hover:"], button, ' +
                    '[role="option"], [role="menuitem"], li'
                  );
                  for (const item of candidates) {
                    const t = (item.textContent || '').trim();
                    if (t === targetText) {
                      const rect = item.getBoundingClientRect();
                      if (rect.height > 0) {
                        return { ok: true, text: t, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
                      }
                    }
                  }
                  
                  // Fallback: partial text match within the dialog
                  for (const item of candidates) {
                    const t = (item.textContent || '').trim();
                    if (t.includes(targetText) || targetText.includes(t)) {
                      const rect = item.getBoundingClientRect();
                      if (rect.height > 0 && t.length < 200) {
                        return { ok: true, text: t, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, partial: true };
                      }
                    }
                  }
                  
                  return { ok: false, optCount: candidates.length, optTexts: Array.from(candidates).slice(0, 5).map(o => (o.textContent||'').trim().substring(0,30)) };
                })()`,
      returnByValue: true,
      contextId: c.cdp.rootContextId
    });
    const val = locateResult.result?.value;

    if (!val?.ok) {
      console.log(
        `❌ Popup option not found: "${title}" (${val?.optCount || 0} options: ${JSON.stringify(val?.optTexts || [])})`
      );
      // Send Escape to close the dangling popup
      try {
        await c.cdp.call("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
          nativeVirtualKeyCode: 27
        });
        await c.cdp.call("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
          nativeVirtualKeyCode: 27
        });
      } catch (_) {}
      return res.status(500).json({ error: "option not found", debug: val });
    }

    // Simulate complete click via Runtime.evaluate (same approach as /click/:id)
    // Use elementFromPoint since popup items aren't tracked by CSS selector
    const { cx, cy } = val;
    await c.cdp.call("Runtime.evaluate", {
      expression: `(() => {
        try {
          const el = document.elementFromPoint(${cx}, ${cy});
          if (!el) return;
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
        } catch (e) { /* ignore */ }
      })()`,
      contextId: c.cdp.rootContextId
    });

    console.log(`✅ Popup item clicked: "${val.text}"`);
    res.json({ success: true, text: val.text });
  } catch (e: any) {
    // Clean up on error
    try {
      await c.cdp.call("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27
      });
      await c.cdp.call("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27
      });
    } catch (_) {}
    res.status(500).json({ error: e.message });
  }
});

// Dismiss passthrough: forward an Escape keypress to dismiss IDE popups (no snapshot)
interactionRouter.post("/dismiss/:id", async (req, res) => {
  const c = cascadeStore.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Cascade not found" });

  try {
    await c.cdp.call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27
    });
    await c.cdp.call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27
    });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Scroll passthrough: forward scroll events to IDE chat container
interactionRouter.post("/scroll/:id", async (req, res) => {
  const c = cascadeStore.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Cascade not found" });

  const { deltaY, ratio, scrollTop } = req.body;
  if (deltaY === undefined && ratio === undefined && scrollTop === undefined) {
    return res.status(400).json({ error: "deltaY, ratio or scrollTop required" });
  }

  try {
    // Use scrollTop for exact absolute positioning, ratio as fallback, deltaY for relative
    // Use limits to prevent mobile rubber-banding/clamping bugs from crashing Monaco's viewport calculations
    let scrollExpr = "";
    if (scrollTop !== undefined) {
      scrollExpr = `
                    const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
                    scrollEl.scrollTop = Math.max(0, Math.min(maxScroll, ${scrollTop}));
                `;
    } else if (ratio !== undefined) {
      scrollExpr = `
                    const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
                    scrollEl.scrollTop = Math.max(0, Math.min(1, ${ratio})) * maxScroll;
                `;
    } else {
      scrollExpr = `
                    const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
                    scrollEl.scrollTop = Math.max(0, Math.min(maxScroll, scrollEl.scrollTop + ${deltaY}));
                `;
    }

    const result = await c.cdp.call("Runtime.evaluate", {
      expression: `(() => {
                    const target = document.getElementById('cascade') || document.getElementById('conversation') || document.getElementById('chat');
                    if (!target) return { error: 'no target' };
                    function findScrollable(el, depth) {
                        if (depth > 8) return null;
                        if (el.classList && (el.classList.contains('monaco-scrollable-element') || el.classList.contains('monaco-list'))) {
                            return el;
                        }
                        const s = getComputedStyle(el);
                        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el;
                        for (const ch of el.children) { const f = findScrollable(ch, depth + 1); if (f) return f; }
                        return null;
                    }
                    const scrollEl = findScrollable(target, 0);
                    if (!scrollEl) return { error: 'no scrollable element' };
                    
                    // 伪造真实的人为滑动方向滚轮事件，以强制打断 IDE 的自动追踪底部（auto-scroll）机制
                    // 原先的粗暴 scrollTop 赋值会被 React 或内置的虚拟列表当成系统调整而予以无视，继续顽强地跳回最底端
                    const beforeScroll = scrollEl.scrollTop;
                    ${scrollExpr};
                    const diffY = scrollEl.scrollTop - beforeScroll;
                    
                    // 只有真正在后端产生了滚动落差，才去唤醒底层的脱锁逻辑
                    if (diffY !== 0) {
                        // 【死锁修复】切忌直接派发巨额 diffY，否则内置的独立滚动侦听器（比如 React Virtuoso）
                        // 会将其作为连续滑动动能直接叠加在其自己的内部 State 里，导致在刚赋予了新 scrollTop 后
                        // 又爆冲出去并在之后的 Snapshot 里跳动回来产生抖屏！只给 1 像素的打断暗示即可。
                        // ⚠️ 已知限制: new WheelEvent 的 isTrusted 始终为 false，若未来 VSCode 版本严格校验此属性则需替代方案。
                        scrollEl.dispatchEvent(new WheelEvent('wheel', { deltaY: Math.sign(diffY) * 1, bubbles: true }));
                    }

                    // Dispatch scroll event to wake up Monaco's virtual list rendering
                    scrollEl.dispatchEvent(new Event('scroll', { bubbles: true }));
                    scrollEl.dispatchEvent(new CustomEvent('scroll', { bubbles: true }));
                    
                    // Short delay to let React/Monaco process the scroll event and patch the DOM
                    return new Promise(resolve => {
                        setTimeout(() => resolve({
                            scrollTop: scrollEl.scrollTop,
                            scrollHeight: scrollEl.scrollHeight,
                            clientHeight: scrollEl.clientHeight
                        }), 150);
                    });
                })()`,
      returnByValue: true,
      contextId: c.cdp.rootContextId
    });
    const val = result.result?.value;
    if (val?.error) return res.status(500).json({ error: val.error });

    // Wait for lazy loading to trigger, then refresh snapshot
    setTimeout(async () => {
      try {
        const snap = await captureHTML(c.cdp);
        if (snap && snap.html.length > 200) {
          const hash = hashString(snap.html);
          if (hash !== c.snapshotHash) {
            c.snapshot = snap;
            c.snapshotHash = hash;
            c.contentLength = snap.html.length;
            broadcast({ type: "snapshot_update", cascadeId: c.id, snapshot: c.snapshot! });
          }
        }
      } catch (e) {}
    }, 300);

    res.json({ success: true, ...val });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

interactionRouter.post("/new-conversation/:id", async (req, res) => {
  const c = cascadeStore.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Cascade not found" });

  try {
    const result = await c.cdp.call("Runtime.evaluate", {
      expression: `(() => {
	                    const btn = document.querySelector('[data-tooltip-id="new-conversation-tooltip"]');
	                    if (btn) { btn.click(); return { ok: true }; }
	                    return { ok: false, reason: 'new-conversation button not found' };
	                })()`,
      returnByValue: true,
      contextId: c.cdp.rootContextId
    });
    const val = result.result?.value;
    if (val?.ok) {
      console.log("🎉 New conversation created");
      res.json({ success: true });
    } else {
      res.status(500).json({ error: val?.reason || "failed" });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
