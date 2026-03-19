import type { CDPConnection } from "./types";

export type ExtractedMetadata = {
  chatTitle: string | null;
  isActive: boolean;
  mode: "cascade" | "iframe";
  contextId: number;
};

export async function extractMetadata(cdp: CDPConnection): Promise<ExtractedMetadata | null> {
  // NOTE: SCRIPT is injected into Electron; originally from legacy server.js; this is now the single source of truth.
  const SCRIPT = `(() => {
        // Support both legacy #cascade and new iframe-based #chat/#conversation
        const cascade = document.getElementById('cascade');
        const chat = document.getElementById('chat');
        const conversation = document.getElementById('conversation');
        if (!cascade && !chat && !conversation) return { found: false };

        const root = conversation || chat || cascade || document;
        const generic = new Set(['explore', 'agent', 'chat', 'new chat', 'new conversation', 'conversation', 'home', 'settings', 'search', 'source control', 'run and debug', 'extensions', 'terminal', 'output', 'debug console', 'problems', 'status bar', 'notifications']);
        const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
        const valid = (v) => {
            const t = clean(v);
            if (t.length < 3 || t.length > 80) return false;
            if (generic.has(t.toLowerCase())) return false;
            // Detect concatenated UI text: usually has many words without spaces or weird casing
            // Or contains multiple action-like words
            const uiKeywords = ['Log in', 'Sign in', 'Open', 'View', 'Manager', 'Account', 'Profile', 'Menu'];
            let keywordCount = 0;
            for(const k of uiKeywords) {
                if(t.includes(k)) keywordCount++;
            }
            if(keywordCount > 2) return false;
            
            // If it has too many capitals without spaces relative to total length, it's likely smashed UI labels
            const caps = t.replace(/[^A-Z]/g, '').length;
            if (caps > 5 && caps > t.length * 0.4) return false;

            return true;
        };

        const pickMeaningfulPart = (value) => {
            const text = clean(value);
            if (!text) return '';
            const parts = text.split(/[—-]/).map(clean).filter(Boolean);
            for (const part of parts) {
                if (valid(part)) return part;
            }
            return valid(text) ? text : '';
        };

        const fromDocumentTitle = pickMeaningfulPart(document.title);

        const activeTabSelectors = [
            '.tabs-container .tab.active[aria-selected="true"]',
            '.editor-tabs-container .tab.active[aria-selected="true"]',
            '.tab.active[aria-selected="true"]'
        ];
        let fromActiveTab = '';
        for (const sel of activeTabSelectors) {
            const tab = document.querySelector(sel);
            if (!tab) continue;
            const ariaLabel = tab.getAttribute('aria-label') || '';
            const resourceName = tab.getAttribute('data-resource-name') || '';
            const text = tab.querySelector('.label-name')?.textContent || tab.textContent || '';
            fromActiveTab = pickMeaningfulPart(ariaLabel) || pickMeaningfulPart(resourceName) || pickMeaningfulPart(text);
            if (fromActiveTab) break;
        }

        let chatTitle = null;
        const possibleTitleSelectors = [
            '[data-testid*="conversation-title"]',
            '[data-testid*="chat-title"]',
            '[aria-label*="Conversation"]',
            '[class*="conversation"][class*="title"]',
            '[class*="chat"][class*="title"]',
            'h1',
            'h2',
            '[class*="title"]',
            '[class*="Title"]'
        ];

        for (const sel of possibleTitleSelectors) {
            const scoped = root.querySelector(sel);
            const fallback = scoped ? null : document.querySelector(sel);
            const el = scoped || fallback;
            if (el && valid(el.textContent)) {
                chatTitle = clean(el.textContent);
                break;
            }
        }

        chatTitle = chatTitle || fromDocumentTitle || fromActiveTab || null;
        
        return {
            found: true,
            chatTitle,
            isActive: document.hasFocus(),
            mode: cascade ? 'cascade' : 'iframe'
        };
    })()`;

  // Try finding context first if not known
  if (cdp.rootContextId) {
    try {
      const res: any = await cdp.call("Runtime.evaluate", {
        expression: SCRIPT,
        returnByValue: true,
        contextId: cdp.rootContextId
      });
      if (res.result?.value?.found) return { ...res.result.value, contextId: cdp.rootContextId };
    } catch {
      cdp.rootContextId = null;
    } // reset if stale
  }

  // Search all contexts (including iframe contexts)
  for (const ctx of cdp.contexts) {
    try {
      const result: any = await cdp.call("Runtime.evaluate", {
        expression: SCRIPT,
        returnByValue: true,
        contextId: ctx.id
      });
      if (result.result?.value?.found) {
        return { ...result.result.value, contextId: ctx.id };
      }
    } catch {
      // ignore
    }
  }
  return null;
}
