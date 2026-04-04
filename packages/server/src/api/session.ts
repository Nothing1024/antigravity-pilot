/** @deprecated Use /api/conversations instead. This file will be removed in v4.0. */
/**
 * Session API (F3/Phase 2) — List, switch, and create chat sessions
 * within the Antigravity IDE via CDP DOM inspection.
 */

import express from "express";

import { ResponsePhase } from "@ag/shared";

import { cascadeStore } from "../store/cascades";
import { captureHTML } from "../capture/html";
import { broadcast } from "../ws/broadcast";
import { hashString } from "../utils/hash";

export const sessionRouter: express.Router = express.Router();

console.warn("⚠️ session.ts routes are deprecated. Use /api/conversations instead.");

// --- CDP Scripts ---

/**
 * Extract list of conversation sessions visible in the IDE sidebar/history.
 * Searches for session list items by common selectors.
 */
const LIST_SESSIONS_SCRIPT = `(() => {
  const sessions = [];

  // Strategy 1: Search for conversation list items in sidebar
  const sidebarSelectors = [
    // Antigravity specific
    '[class*="conversation"][class*="list"] [class*="item"]',
    '[class*="chat"][class*="history"] [class*="item"]',
    '[class*="session"][class*="list"] [class*="item"]',
    // Generic tree view items
    '.tree-item[data-type*="conversation"]',
    '.list-view [role="treeitem"]',
    // HeadlessUI listbox items that look like sessions
    '[role="listbox"] [role="option"]',
  ];

  for (const sel of sidebarSelectors) {
    const items = document.querySelectorAll(sel);
    if (items.length === 0) continue;

    for (const item of items) {
      const text = (item.textContent || '').trim();
      if (!text || text.length > 200) continue;

      // Build selector path for click targeting
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

      const isActive = item.classList.contains('active') ||
                        item.classList.contains('selected') ||
                        item.getAttribute('aria-selected') === 'true' ||
                        item.getAttribute('data-headlessui-state')?.includes('selected');

      sessions.push({
        title: text.substring(0, 100),
        selector: item.id ? '#' + CSS.escape(item.id) : buildPath(item),
        active: !!isActive,
      });
    }

    if (sessions.length > 0) break; // Found sessions with first matching selector
  }

  // Strategy 2: If no sidebar found, try to find a conversation dropdown/switcher button
  if (sessions.length === 0) {
    const switcher = document.querySelector(
      '[data-tooltip-id*="conversation"], [data-tooltip-id*="session"], [data-tooltip-id*="chat-history"]'
    );
    if (switcher) {
      return {
        sessions: [],
        switcherSelector: switcher.id ? '#' + CSS.escape(switcher.id) : null,
        hint: 'Conversation switcher button found but sessions not listed. Click the switcher first.',
      };
    }
  }

  return { sessions, switcherSelector: null, hint: null };
})()`;

/**
 * Extract current model name from the IDE's model selector.
 */
const GET_MODEL_SCRIPT = `(() => {
  // Strategy 1: Look for model name in the toolbar/header area
  const modelSelectors = [
    // Model selector button label
    '[class*="model"][class*="select"] [class*="label"]',
    '[class*="model"][class*="selector"]',
    '[class*="model"][class*="name"]',
    '[data-tooltip-id*="model"]',
    // HeadlessUI Listbox button that contains model info
    '[class*="model"] button[role="combobox"]',
    '[class*="model"] [role="button"]',
    // Generic approach: look for known model names in toolbar
    '[class*="toolbar"] [class*="model"]',
    '[class*="header"] [class*="model"]',
  ];

  for (const sel of modelSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      const text = (el.textContent || '').trim();
      if (text && text.length < 100) {
        return {
          model: text,
          selector: el.id ? '#' + CSS.escape(el.id) : sel,
          source: 'selector',
        };
      }
    }
  }

  // Strategy 2: Check aria-labels of buttons in the chat header area
  const chatContainer = document.getElementById('cascade') ||
                        document.getElementById('conversation') ||
                        document.getElementById('chat');
  if (chatContainer) {
    const parent = chatContainer.parentElement || chatContainer;
    const buttons = parent.querySelectorAll('button, [role="button"], [role="combobox"]');
    const modelPatterns = /claude|gpt|gemini|anthropic|openai|sonnet|opus|haiku|llama|mistral|deepseek/i;

    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      const aria = btn.getAttribute('aria-label') || '';
      const combined = text + ' ' + aria;

      if (modelPatterns.test(combined) && combined.length < 100) {
        return {
          model: text || aria,
          selector: btn.id ? '#' + CSS.escape(btn.id) : null,
          source: 'pattern-match',
        };
      }
    }
  }

  return { model: null, selector: null, source: 'not-found' };
})()`;

/**
 * List available models by opening the model selector dropdown.
 */
const LIST_MODELS_SCRIPT = `(() => {
  // Look for model options in an already-open dropdown/listbox
  const listbox = document.querySelector('[role="listbox"]');
  if (listbox) {
    const options = listbox.querySelectorAll('[role="option"]');
    if (options.length > 0) {
      const models = [];
      for (const opt of options) {
        const text = (opt.textContent || '').trim();
        if (text && text.length < 100) {
          const isSelected = opt.getAttribute('aria-selected') === 'true' ||
                             opt.getAttribute('data-headlessui-state')?.includes('selected');
          const buildPath = (node) => {
            const parts = [];
            while (node && node !== document.body) {
              const parent = node.parentElement;
              if (!parent) break;
              const siblings = Array.from(parent.children);
              const index = siblings.indexOf(node) + 1;
              parts.unshift(node.tagName.toLowerCase() + ':nth-child(' + index + ')');
              node = parent;
            }
            return 'body > ' + parts.join(' > ');
          };
          models.push({
            name: text,
            selected: !!isSelected,
            selector: opt.id ? '#' + CSS.escape(opt.id) : buildPath(opt),
          });
        }
      }
      return { models, dropdownOpen: true };
    }
  }

  return { models: [], dropdownOpen: false };
})()`;

// --- API Routes ---

// GET /api/sessions/:cascadeId — List chat sessions
sessionRouter.get("/api/sessions/:cascadeId", async (req, res) => {
  const c = cascadeStore.get(req.params.cascadeId);
  if (!c) return res.status(404).json({ error: "Cascade not found" });

  const contextId = c.cdp.rootContextId;
  if (!contextId) return res.status(503).json({ error: "No CDP context" });

  try {
    const result: any = await c.cdp.call("Runtime.evaluate", {
      expression: LIST_SESSIONS_SCRIPT,
      returnByValue: true,
      contextId,
    });

    const val = result.result?.value;
    if (!val) return res.status(500).json({ error: "Failed to extract sessions" });

    res.json(val);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sessions/:cascadeId/switch — Switch to a session by clicking its element
sessionRouter.post("/api/sessions/:cascadeId/switch", async (req, res) => {
  const c = cascadeStore.get(req.params.cascadeId);
  if (!c) return res.status(404).json({ error: "Cascade not found" });

  const { selector } = req.body;
  if (!selector) return res.status(400).json({ error: "selector is required" });

  const contextId = c.cdp.rootContextId;
  if (!contextId) return res.status(503).json({ error: "No CDP context" });

  try {
    const result: any = await c.cdp.call("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, reason: 'Session element not found: ' + ${JSON.stringify(selector)} };
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.click();
        return { ok: true };
      })()`,
      returnByValue: true,
      contextId,
    });

    const val = result.result?.value;
    if (val?.ok) {
      // Wait a moment for the session to load, then refresh snapshot
      await new Promise((r) => setTimeout(r, 500));
      try {
        const snap = await captureHTML(c.cdp);
        if (snap) {
          c.snapshot = snap;
          c.snapshotHash = hashString(snap.html);
          broadcast({ type: "snapshot_update", cascadeId: c.id, snapshot: snap });
        }
      } catch {
        // ignore snapshot failure
      }
      res.json({ success: true });
    } else {
      res.status(500).json({ error: val?.reason || "Switch failed" });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sessions/:cascadeId/new — Create a new conversation session
sessionRouter.post("/api/sessions/:cascadeId/new", async (req, res) => {
  const c = cascadeStore.get(req.params.cascadeId);
  if (!c) return res.status(404).json({ error: "Cascade not found" });

  const contextId = c.cdp.rootContextId;
  if (!contextId) return res.status(503).json({ error: "No CDP context" });

  try {
    const result: any = await c.cdp.call("Runtime.evaluate", {
      expression: `(() => {
        const btn = document.querySelector('[data-tooltip-id="new-conversation-tooltip"]');
        if (btn) { btn.click(); return { ok: true }; }
        return { ok: false, reason: 'new-conversation button not found' };
      })()`,
      returnByValue: true,
      contextId,
    });

    const val = result.result?.value;
    if (val?.ok) {
      // Reset phase since we're starting a new conversation
      c.phase = ResponsePhase.IDLE;
      c.responseText = "";
      c.lastPhaseChange = Date.now();

      console.log(`🎉 New session created for "${c.metadata.chatTitle}"`);
      res.json({ success: true });
    } else {
      res.status(500).json({ error: val?.reason || "Failed to create session" });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/model/:cascadeId — Get current model
sessionRouter.get("/api/model/:cascadeId", async (req, res) => {
  const c = cascadeStore.get(req.params.cascadeId);
  if (!c) return res.status(404).json({ error: "Cascade not found" });

  // Try all contexts (model selector might be in main window, not chat iframe)
  const allContexts = c.cdp.contexts || [];
  const contextsToTry = c.cdp.rootContextId
    ? [{ id: c.cdp.rootContextId }, ...allContexts]
    : allContexts;

  for (const ctx of contextsToTry) {
    try {
      const result: any = await c.cdp.call("Runtime.evaluate", {
        expression: GET_MODEL_SCRIPT,
        returnByValue: true,
        contextId: ctx.id,
      });

      const val = result.result?.value;
      if (val?.model) {
        return res.json({
          model: val.model,
          source: val.source,
        });
      }
    } catch {
      continue;
    }
  }

  res.json({ model: null, source: "not-found" });
});

// PUT /api/model/:cascadeId — Switch model
sessionRouter.put("/api/model/:cascadeId", async (req, res) => {
  const c = cascadeStore.get(req.params.cascadeId);
  if (!c) return res.status(404).json({ error: "Cascade not found" });

  const { model } = req.body;
  if (!model) return res.status(400).json({ error: "model is required" });

  const allContexts = c.cdp.contexts || [];
  const contextsToTry = c.cdp.rootContextId
    ? [{ id: c.cdp.rootContextId }, ...allContexts]
    : allContexts;

  for (const ctx of contextsToTry) {
    try {
      // Step 1: Find and click the model selector button
      const selectorResult: any = await c.cdp.call("Runtime.evaluate", {
        expression: GET_MODEL_SCRIPT,
        returnByValue: true,
        contextId: ctx.id,
      });

      const selectorVal = selectorResult.result?.value;
      if (!selectorVal?.selector) continue;

      // Click the model selector to open dropdown
      await c.cdp.call("Runtime.evaluate", {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(selectorVal.selector)});
          if (el) { el.click(); return { ok: true }; }
          return { ok: false };
        })()`,
        returnByValue: true,
        contextId: ctx.id,
      });

      // Wait for dropdown to open
      await new Promise((r) => setTimeout(r, 300));

      // Step 2: Find and click the target model option
      const modelName = model.toLowerCase();
      const clickResult: any = await c.cdp.call("Runtime.evaluate", {
        expression: `((targetModel) => {
          // Search in listbox options
          const options = document.querySelectorAll('[role="option"], [role="menuitem"]');
          for (const opt of options) {
            const text = (opt.textContent || '').trim().toLowerCase();
            if (text.includes(targetModel) || targetModel.includes(text)) {
              opt.click();
              return { ok: true, selected: (opt.textContent || '').trim() };
            }
          }

          // Also try divs with cursor-pointer that contain the model name
          const divs = document.querySelectorAll('[class*="cursor-pointer"], [class*="hover:"]');
          for (const div of divs) {
            const text = (div.textContent || '').trim().toLowerCase();
            if (text.includes(targetModel)) {
              div.click();
              return { ok: true, selected: (div.textContent || '').trim() };
            }
          }

          return { ok: false, reason: 'Model "' + targetModel + '" not found in dropdown' };
        })(${JSON.stringify(modelName)})`,
        returnByValue: true,
        contextId: ctx.id,
      });

      const clickVal = clickResult.result?.value;
      if (clickVal?.ok) {
        console.log(`🔄 Model switched to "${clickVal.selected}" for "${c.metadata.chatTitle}"`);
        return res.json({ success: true, model: clickVal.selected });
      } else {
        // Close dropdown with Escape
        try {
          await c.cdp.call("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Escape",
            code: "Escape",
            windowsVirtualKeyCode: 27,
          });
          await c.cdp.call("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Escape",
            code: "Escape",
            windowsVirtualKeyCode: 27,
          });
        } catch {}

        return res.status(404).json({ error: clickVal?.reason || "Model not found" });
      }
    } catch {
      continue;
    }
  }

  res.status(500).json({ error: "Could not find model selector in any context" });
});

// GET /api/models/:cascadeId — List available models (opens dropdown temporarily)
sessionRouter.get("/api/models/:cascadeId", async (req, res) => {
  const c = cascadeStore.get(req.params.cascadeId);
  if (!c) return res.status(404).json({ error: "Cascade not found" });

  const allContexts = c.cdp.contexts || [];
  const contextsToTry = c.cdp.rootContextId
    ? [{ id: c.cdp.rootContextId }, ...allContexts]
    : allContexts;

  for (const ctx of contextsToTry) {
    try {
      // Step 1: Find and click model selector to open dropdown
      const selectorResult: any = await c.cdp.call("Runtime.evaluate", {
        expression: GET_MODEL_SCRIPT,
        returnByValue: true,
        contextId: ctx.id,
      });

      const selectorVal = selectorResult.result?.value;
      if (!selectorVal?.selector) continue;

      // Click to open
      await c.cdp.call("Runtime.evaluate", {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(selectorVal.selector)});
          if (el) el.click();
        })()`,
        returnByValue: true,
        contextId: ctx.id,
      });

      await new Promise((r) => setTimeout(r, 300));

      // Step 2: Extract model list
      const listResult: any = await c.cdp.call("Runtime.evaluate", {
        expression: LIST_MODELS_SCRIPT,
        returnByValue: true,
        contextId: ctx.id,
      });

      // Step 3: Close dropdown
      try {
        await c.cdp.call("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
        });
        await c.cdp.call("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
        });
      } catch {}

      const val = listResult.result?.value;
      if (val?.models?.length > 0) {
        return res.json({
          current: selectorVal.model,
          models: val.models,
        });
      }
    } catch {
      continue;
    }
  }

  res.json({ current: null, models: [] });
});

export default sessionRouter;
