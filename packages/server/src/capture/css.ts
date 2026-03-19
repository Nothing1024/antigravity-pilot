import type { ComputedVars } from "@ag/shared";

import type { CDPConnection } from "../cdp/types";

export async function captureCSS(cdp: CDPConnection): Promise<string | null> {
  // NOTE: SCRIPT is injected into Electron; originally from legacy server.js; this is now the single source of truth.
  const SCRIPT = `(async () => {
        // Gather CSS and namespace it to prevent leaks
        let css = '';
        function namespaceRule(text) {
            // Replace body/html/:root/:host selectors with #chat-viewport
            text = text.replace(/(^|[\\s,}])body(?=[\\s,{:.])/gi, '$1#chat-viewport');
            text = text.replace(/(^|[\\s,}])html(?=[\\s,{:.])/gi, '$1#chat-viewport');
            text = text.replace(/(^|[\\s,}]):root(?=[\\s,{])/gi, '$1#chat-viewport');
            text = text.replace(/(^|[\\s,}]):host(?=[\\s,{(])/gi, '$1#chat-viewport');
            return text;
        }
        for (const sheet of document.styleSheets) {
            try {
                // Try direct access first (same-origin)
                for (const rule of sheet.cssRules) {
                    let text = rule.cssText;
                    // Skip @font-face rules to reduce CSS size
                    if (text.startsWith('@font-face')) continue;
                    css += namespaceRule(text) + '\\n';
                }
            } catch (e) {
                // Cross-origin sheet — fetch it manually
                if (sheet.href) {
                    try {
                        const resp = await fetch(sheet.href);
                        if (resp.ok) {
                            let text = await resp.text();
                            css += namespaceRule(text) + '\\n';
                        }
                    } catch (fetchErr) { /* skip if fetch fails too */ }
                }
            }
        }
        return { css };
    })()`;

  const contextId = cdp.rootContextId;
  if (!contextId) return null;

  try {
    const result: any = await cdp.call("Runtime.evaluate", {
      expression: SCRIPT,
      returnByValue: true,
      contextId: contextId,
      awaitPromise: true
    });
    return result.result?.value?.css || "";
  } catch {
    return "";
  }
}

// --- Capture Computed CSS Variables ---
export async function captureComputedVars(cdp: CDPConnection): Promise<ComputedVars> {
  // NOTE: SCRIPT is injected into Electron; originally from legacy server.js; this is now the single source of truth.
  const SCRIPT = `(() => {
        const cs = getComputedStyle(document.documentElement);
        const vars = {};
        // Extract key vscode CSS variables that control theming
        const keys = [
            '--vscode-editor-background', '--vscode-editor-foreground',
            '--vscode-sideBar-background', '--vscode-panel-background',
            '--vscode-input-background', '--vscode-input-foreground',
            '--vscode-input-border', '--vscode-focusBorder',
            '--vscode-button-background', '--vscode-button-foreground',
            '--vscode-list-activeSelectionBackground', '--vscode-list-activeSelectionForeground',
            '--vscode-list-hoverBackground', '--vscode-list-hoverForeground',
            '--vscode-errorForeground', '--vscode-foreground',
            '--vscode-descriptionForeground', '--vscode-textLink-foreground',
            '--vscode-badge-background', '--vscode-badge-foreground',
            '--vscode-checkbox-background', '--vscode-checkbox-border',
            '--vscode-notifications-border', '--vscode-banner-background',
            '--vscode-font-family', '--vscode-font-size', '--vscode-font-weight',
            '--vscode-editor-font-family', '--vscode-editor-font-size',
            // --- UI Separators & Borders ---
            '--vscode-panel-border', '--vscode-editorGroup-border', 
            '--vscode-widget-border', '--vscode-sash-hoverBorder',
            '--vscode-sideBarSectionHeader-border', '--vscode-chat-requestBorder',
            '--vscode-settings-focusedRowBorder', '--vscode-activityBar-border',
            '--vscode-menu-border', '--vscode-titleBar-border',
            // IDE-specific button & UI variables (set programmatically by Antigravity)
            '--ide-button-background', '--ide-button-foreground', '--ide-button-color',
            '--ide-button-hover-background', '--ide-button-secondary-background',
            '--ide-button-secondary-hover-background', '--ide-button-secondary-color',
            '--ide-chat-background', '--ide-editor-background',
            '--ide-text-color', '--ide-link-color', '--ide-message-block-bot-color',
            '--ide-task-section-background',
        ];
        for (const key of keys) {
            const val = cs.getPropertyValue(key).trim();
            if (val) vars[key] = val;
        }
        // Broad scan: capture ALL custom properties from ALL CSS rules
        const allProps = new Set();
        // From ALL stylesheet rules (not just :root/:host — IDEs define vars
        // on .dark, body, [data-theme], etc.)
        Array.from(document.styleSheets).forEach(sheet => {
            try {
                Array.from(sheet.cssRules).forEach(r => {
                    if (r.style) {
                        Array.from(r.style).filter(p => p.startsWith('--')).forEach(p => allProps.add(p));
                    }
                    // Also check rules inside @media blocks
                    if (r.cssRules) {
                        Array.from(r.cssRules).forEach(inner => {
                            if (inner.style) {
                                Array.from(inner.style).filter(p => p.startsWith('--')).forEach(p => allProps.add(p));
                            }
                        });
                    }
                });
            } catch(e) {}
        });
        // From document.documentElement inline style (programmatically set vars)
        const rootStyle = document.documentElement.style;
        for (let i = 0; i < rootStyle.length; i++) {
            const prop = rootStyle[i];
            if (prop.startsWith('--')) allProps.add(prop);
        }
        // From document.body inline style
        const bodyStyle = document.body.style;
        for (let i = 0; i < bodyStyle.length; i++) {
            const prop = bodyStyle[i];
            if (prop.startsWith('--')) allProps.add(prop);
        }
        // Resolve values: try documentElement first, then body (catches theme-scoped vars)
        const bodyCom = getComputedStyle(document.body);
        for (const prop of allProps) {
            if (!vars[prop]) {
                const val = cs.getPropertyValue(prop).trim() || bodyCom.getPropertyValue(prop).trim();
                if (val) vars[prop] = val;
            }
        }
        // Capture body computed background & color as fallback
        vars['__bodyBg'] = bodyCom.backgroundColor;
        vars['__bodyColor'] = bodyCom.color;
        vars['__bodyFontFamily'] = bodyCom.fontFamily;
        return vars;
    })()`;

  const contextId = cdp.rootContextId;
  if (!contextId) return {};

  try {
    const result: any = await cdp.call("Runtime.evaluate", {
      expression: SCRIPT,
      returnByValue: true,
      contextId
    });
    return result.result?.value || {};
  } catch {
    return {};
  }
}

