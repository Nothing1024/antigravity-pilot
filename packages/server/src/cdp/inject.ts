import type { CDPConnection } from "./types";

export type InjectMessageResult = { ok: true } | { ok: false; reason: string };

export async function injectMessage(
  cdp: CDPConnection,
  message: string
): Promise<InjectMessageResult> {
  // Keep `text` name to preserve the SCRIPT interpolation expression verbatim.
  const text = message;

  // NOTE: SCRIPT is injected into Electron; originally from legacy server.js; this is now the single source of truth.
  const SCRIPT = `(async () => {
        const text = ${JSON.stringify(text)};

        // Prioritized editor selector chain — most specific first
        // 1. Antigravity's chat input box (contenteditable within the cascade panel)
        // 2. Generic contenteditable within the Antigravity panel
        // 3. Any textarea (legacy Antigravity versions)
        // 4. Fallback: first contenteditable in the document
        const selectors = [
            '#antigravity\\\\.agentSidePanelInputBox [contenteditable="true"]',
            '.chat-input [contenteditable="true"]',
            '[class*="sidePanelInput"] [contenteditable="true"]',
            '[class*="cascade"] [contenteditable="true"]',
            '[class*="chat"] [contenteditable="true"]',
        ];
        
        let editor = null;
        let matchedSelector = null;
        for (const sel of selectors) {
            try {
                editor = document.querySelector(sel);
                if (editor) { matchedSelector = sel; break; }
            } catch { /* invalid selector, skip */ }
        }
        
        // Fallback to generic selectors
        if (!editor) {
            editor = document.querySelector('textarea');
            if (editor) matchedSelector = 'textarea';
        }
        if (!editor) {
            editor = document.querySelector('[contenteditable="true"]');
            if (editor) matchedSelector = '[contenteditable="true"] (generic fallback)';
        }
        
        if (!editor) return { ok: false, reason: "no editor found" };
        
        editor.focus();
        
        let method;
        if (editor.tagName === 'TEXTAREA') {
            const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
            nativeTextAreaValueSetter.call(editor, text);
            editor.dispatchEvent(new Event('input', { bubbles: true }));
            method = 'textarea-native-setter';
        } else {
            // Scope selection to ONLY the editor element using Range API.
            // document.execCommand("selectAll") is document-level and can
            // select content outside the editor, or leave IDE attachment
            // state (code blocks, file references, @-mentions) intact
            // even after text replacement — causing them to be submitted
            // alongside the user's message on the first send.
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(editor);
            sel.removeAllRanges();
            sel.addRange(range);

            // Delete existing content first so the IDE framework properly
            // clears any associated state (attachments, code block chips, etc.)
            document.execCommand("delete", false, null);

            // Brief pause to let React/framework process the deletion
            await new Promise(r => setTimeout(r, 50));

            // Now insert fresh text into the clean editor
            document.execCommand("insertText", false, text);
            method = 'contenteditable-execCommand';
        }
        
        await new Promise(r => setTimeout(r, 200));
        
        // Try to find the send button — multiple strategies for different Antigravity versions
        // 1. Latest Antigravity: uses a div with data-tooltip-id containing "send"
        const sendDiv = document.querySelector('[data-tooltip-id*="send"]:not([data-tooltip-id*="cancel"])');
        // 2. Legacy Antigravity: button-based selectors
        const sendBtn = document.querySelector('button[class*="arrow"]') || 
                       document.querySelector('button[aria-label*="Send"]') ||
                       document.querySelector('button[type="submit"]');

        let sendMethod;
        if (sendDiv) {
            sendDiv.click();
            sendMethod = "tooltip-div";
        } else if (sendBtn) {
            sendBtn.click();
            sendMethod = "button";
        } else {
            // Fallback: dispatch Enter key with full event properties
            const enterEvent = new KeyboardEvent("keydown", {
                bubbles: true,
                cancelable: true,
                key: "Enter",
                code: "Enter",
                keyCode: 13,
                which: 13,
                composed: true
            });
            editor.dispatchEvent(enterEvent);
            sendMethod = "enter-key";
        }

        // Clear leftover text from the editor after send.
        // execCommand("insertText") bypasses the IDE's React state, so the
        // IDE may not clear the DOM automatically after sending.
        // 300ms delay gives React enough time to process the send action
        // before we check for & remove any residual DOM content.
        await new Promise(r => setTimeout(r, 300));
        const leftover = (editor.textContent || '').trim();
        if (leftover) {
            editor.focus();
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(editor);
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand("delete", false, null);
        }

        return { ok: true, method, editorSel: matchedSelector, sendMethod };
    })()`;

  try {
    const res: any = await cdp.call("Runtime.evaluate", {
      expression: SCRIPT,
      returnByValue: true,
      awaitPromise: true,
      contextId: cdp.rootContextId
    });
    return (res.result?.value || { ok: false }) as InjectMessageResult;
  } catch (e: any) {
    return { ok: false, reason: e?.message || "unknown error" };
  }
}

