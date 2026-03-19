import morphdom from "morphdom";
import { useEffect, useMemo, useRef } from "react";

import { useClickPassthrough } from "../../hooks/useClickPassthrough";
import { useCascadeStyles } from "../../hooks/useCascadeStyles";
import { useSnapshot } from "../../hooks/useSnapshot";
import { FilePreview } from "../modals/FilePreview";
import { PopupBubble } from "./PopupBubble";

type Props = {
  cascadeId: string | null;
  onContentUpdate?: () => void;
};

function buildIdeStyle(
  css: string | null,
  computedVars: Record<string, string> | null,
  bodyBg: string | null,
  bodyColor: string | null
): string {
  if (!css && !computedVars && !bodyBg && !bodyColor) return "";

  const vars = computedVars || {};
  let varDecls = "";
  for (const [key, val] of Object.entries(vars)) {
    if (!key.startsWith("__")) varDecls += `${key}: ${val};\n`;
  }

  // Detect if the IDE is running in a dark theme by checking body background/color
  const bgFallback = bodyBg || "transparent";
  const fgFallback = bodyColor || "inherit";

  // If bodyBg is transparent or black-text, use our app's dark theme as fallback
  const isTransparentBg = !bodyBg || bodyBg === "rgba(0, 0, 0, 0)" || bodyBg === "transparent";
  const isBlackText = !bodyColor || bodyColor === "rgb(0, 0, 0)";
  const needsDarkFallback = isTransparentBg || isBlackText;

  const effectiveBg = needsDarkFallback ? "hsl(var(--background, 240 10% 3.9%))" : bgFallback;
  const effectiveFg = needsDarkFallback ? "hsl(var(--foreground, 0 0% 98%))" : fgFallback;

  return `
    #chat-viewport {
      ${varDecls}
      --ag-body-bg: ${effectiveBg};
      --ag-body-fg: ${effectiveFg};
      background: var(--vscode-editor-background, var(--ide-chat-background, var(--ag-body-bg)));
      color: var(--vscode-editor-foreground, var(--ide-text-color, var(--ag-body-fg)));
      font-size: 14px;
      line-height: 1.6;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    }

    ${css || ""}

    /* IDE Tailwind Arbitrary Class Polyfills
       Because these class names come dynamically from the IDE snapshot HTML,
       Pilot's Tailwind compiler won't see them at build time. We must define
       them manually so IDE dialogs (like Open Project) render correctly. */
    .rounded-\\[var\\(--radius-lg\\)\\] { border-radius: var(--radius-lg); }
    .border-\\[var\\(--border\\)\\] { border-color: hsl(var(--border)); }
    .border-\\[var\\(--border-light\\)\\] { border-color: hsl(var(--border-light)); }
    .bg-\\[var\\(--bg-primary\\)\\] { background-color: hsl(var(--bg-primary)); }
    .bg-\\[var\\(--bg-secondary\\)\\] { background-color: hsl(var(--bg-secondary)); }
    .bg-\\[var\\(--accent\\)\\] { background-color: hsl(var(--accent)); }
    .text-\\[var\\(--text-primary\\)\\] { color: hsl(var(--text-primary)); }
    .text-\\[var\\(--text-muted\\)\\] { color: hsl(var(--text-muted)); }
    .text-\\[var\\(--text-inverse\\)\\] { color: hsl(var(--text-inverse)); }
    .shadow-\\[var\\(--shadow-lg\\)\\] { box-shadow: var(--shadow-lg); }
    
    .active\\:bg-\\[var\\(--bg-secondary\\)\\]:active { background-color: hsl(var(--bg-secondary)); }
    .active\\:bg-\\[var\\(--accent-hover\\)\\]:active { background-color: hsl(var(--accent-hover)); }

    /* IDE inline dialog polyfills (e.g. Confirm Undo, progress cards) */
    .bg-ide-chat-background {
      background-color: var(--vscode-editor-background, var(--ide-chat-background, hsl(var(--background))));
    }
    .hover\\:bg-primary-hover:hover,
    .bg-primary-hover {
      background-color: var(--vscode-button-hoverBackground, hsl(var(--primary) / 0.85));
    }
    .bg-secondary { background-color: hsl(var(--muted)); }
    .text-secondary-foreground { color: hsl(var(--muted-foreground)); }

    /* Tailwind utility polyfills for IDE-injected dialog overlays.
       These classes are NOT compiled by Pilot's Tailwind (they live in
       Shadow DOM HTML from the IDE), so we must define them manually. */
    .fixed { position: fixed; }
    .inset-0 { inset: 0; }
    .z-50 { z-index: 50; }
    .items-center { align-items: center; }
    .justify-center { justify-content: center; }
    .p-4 { padding: 1rem; }
    .bg-black\\/40 { background-color: rgb(0 0 0 / 0.4); }
    .border-gray-500\\/20 { border-color: rgb(107 114 128 / 0.2); }
    .translate-y-0 { --tw-translate-y: 0px; transform: translateY(var(--tw-translate-y)); }
    .max-w-\\[95\\%\\] { max-width: 95%; }
    .opacity-0 { opacity: 0 !important; }

    /* IDE popup/menu variable fallbacks 鈥?MUST come after captured IDE CSS.
       Use :host so that popups appended directly to the shadow root (outside
       the #chat-viewport wrapper) still inherit these variables.
       Note: We use bare HSL values (e.g. "240 10% 4%") to match Shadcn/UI and IDE export format. */
    :host {
      --bg-primary: var(--vscode-editor-background, var(--background, 0 0% 100%));
      --bg-secondary: var(--vscode-sideBar-background, var(--card, 0 0% 100%));
      --bg-tertiary: var(--vscode-input-background, var(--muted, 240 4.8% 95.9%));
      --text-primary: var(--vscode-editor-foreground, var(--foreground, 240 10% 3.9%));
      --text-secondary: var(--vscode-descriptionForeground, var(--muted-foreground, 240 3.8% 46.1%));
      --text-muted: var(--vscode-descriptionForeground, var(--muted-foreground, 240 3.8% 46.1%));
      --border: var(--vscode-panel-border, var(--border, 240 5.9% 90%));
      --border-light: var(--vscode-widget-border, var(--border, 240 5.9% 90%));
      --text-inverse: var(--vscode-button-foreground, var(--primary-foreground, 0 0% 98%));
      --accent: var(--vscode-button-background, var(--primary, 240 5.9% 10%));
      --accent-hover: var(--vscode-button-hoverBackground, var(--primary, 240 5.9% 10%));
      --shadow-lg: 0 8px 24px rgba(0,0,0,0.15);
      --shadow-md: 0 4px 12px rgba(0,0,0,0.1);
      --radius-lg: calc(var(--radius, 0.5rem) + 4px);
    }
  `;
}

/** Remove empty skeleton placeholder divs that IDE emits while streaming content.
 *  Skeletons are identified as: empty divs (no children, no text) with an
 *  explicit pixel height in their inline style 鈥?e.g. style="height: 2016.68px;"
 *  After removal, prune any ancestor divs that became empty as a result.
 */
function stripSkeletons(root: HTMLElement): void {
  const candidates = root.querySelectorAll<HTMLElement>("div[style*='height:'], div[style*='height: ']");
  const emptyParents = new Set<HTMLElement>();

  for (const el of candidates) {
    if (el.children.length === 0 && el.textContent?.trim() === "") {
      const parent = el.parentElement;
      el.remove();
      if (parent && parent !== root) emptyParents.add(parent);
    }
  }

  // Walk up: remove wrapper divs that became empty after skeleton removal
  for (const parent of emptyParents) {
    let node: HTMLElement | null = parent;
    while (node && node !== root && node.children.length === 0 && node.textContent?.trim() === "") {
      const grandparent = node.parentElement;
      node.remove();
      node = grandparent as HTMLElement | null;
    }
  }
}

function safeSetContent(viewport: HTMLElement, html: string): void {
  const temp = document.createElement("div");
  temp.id = "chat-viewport";
  temp.innerHTML = html;

  stripSkeletons(temp);

  try {
    morphdom(viewport, temp, {
      onBeforeElUpdated: (fromEl, toEl) => {
        if (fromEl.isEqualNode(toEl)) return false;
        return true;
      }
    });
  } catch {
    viewport.innerHTML = temp.innerHTML;
  }
}

export function ChatViewport({ cascadeId, onContentUpdate }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);

  const { snapshot } = useSnapshot(cascadeId);
  const { styles } = useCascadeStyles(cascadeId);
  const { popup, selectPopupItem, dismissPopup, filePreview, closeFilePreview } = useClickPassthrough({
    cascadeId,
    shadowRef
  });

  const ideStyleText = useMemo(
    () =>
      buildIdeStyle(
        styles?.css || null,
        styles?.computedVars || null,
        snapshot?.bodyBg || null,
        snapshot?.bodyColor || null
      ),
    [styles?.css, styles?.computedVars, snapshot?.bodyBg, snapshot?.bodyColor]
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (shadowRef.current) return;

    const root = host.attachShadow({ mode: "open" });
    shadowRef.current = root;

    root.innerHTML = `
      <style id="base-style">
        :host { 
          display: block; 
          height: 100%; 
          position: relative;
          z-index: 0;
          contain: style;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }
        
        /* 鈹€鈹€鈹€ CSS Reset for IDE elements 鈹€鈹€鈹€ */
        button, input, select, textarea {
          border: none;
          outline: none;
          background: none;
          color: inherit;
          font: inherit;
          padding: 0;
          margin: 0;
          -webkit-appearance: none;
          appearance: none;
        }
        *, *::before, *::after {
          box-sizing: border-box;
        }
        
        #chat-viewport { 
          position: relative;
          min-height: 100%; 
          padding: 8px 0 24px;
          overflow: hidden;
          word-wrap: break-word;
          overflow-wrap: break-word;
        }
        
        /* 鈹€鈹€鈹€ Reduce excessive IDE padding 鈹€鈹€鈹€ */
        #chat-viewport [class*="pt-[30vh]"] {
          padding-top: 8vh !important;
        }
        #chat-viewport [class*="pt-[20vh]"] {
          padding-top: 6vh !important;
        }
        
        /* 鈹€鈹€鈹€ Loading State 鈹€鈹€鈹€ */
        .loading { 
          display: flex; 
          flex-direction: column;
          align-items: center; 
          justify-content: center; 
          height: 260px; 
          color: hsl(var(--muted-foreground, 240 5% 64.9%)); 
          font-size: 13px;
          font-family: "Inter", system-ui, sans-serif;
          gap: 16px;
          opacity: 0.5;
          letter-spacing: 0.01em;
        }
        .loading svg {
          animation: spin 1.2s cubic-bezier(0.5, 0, 0.5, 1) infinite;
          opacity: 0.7;
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        
        /* 鈹€鈹€鈹€ Trap fixed-positioned IDE popups (tooltips, dropdowns) 鈹€鈹€鈹€
           Only target inline-style fixed elements (IDE tooltips/menus).
           Class-based fixed overlays (like Confirm Undo dialogs) should
           remain fixed so they cover the full viewport. */
        #chat-viewport [style*="position: fixed"]:not(.fixed),
        #chat-viewport [style*="position:fixed"]:not(.fixed) {
          position: absolute !important;
        }
        
        /* 鈹€鈹€鈹€ Interactive clickable elements 鈹€鈹€鈹€ */
        [data-cdp-click] { 
          cursor: pointer !important; 
        }
        [data-cdp-click]:hover { 
          filter: brightness(1.08);
        }
        [data-cdp-click]:active { 
          filter: brightness(0.95);
        }
        
        /* 鈹€鈹€鈹€ Content polish 鈹€鈹€鈹€ */
        /* Constrain icon-sized SVGs to their intended size.
           IDE injects SVGs with viewBox="0 0 24 24" that expand to fill
           the container if no width/height CSS is applied. */
        svg[viewBox="0 0 24 24"] {
          max-width: 24px !important;
          max-height: 24px !important;
        }
        img { max-width: 100%; height: auto; border-radius: 6px; }
        pre { 
          overflow-x: auto; 
          max-width: 100%; 
          border-radius: 8px;
          font-size: 13px;
          white-space: pre-wrap;
          word-break: break-word;
          /* 鈹€鈹€鈹€ Collapsed code blocks 鈹€鈹€鈹€ */
          max-height: 300px;
          overflow-y: hidden;
          position: relative;
          cursor: pointer;
          transition: max-height 0.3s ease;
        }
        pre.ag-expanded {
          max-height: none;
          overflow-y: auto;
        }
        pre:not(.ag-expanded)::after {
          content: "";
          position: absolute;
          bottom: 0; left: 0; right: 0;
          height: 48px;
          background: linear-gradient(transparent, var(--vscode-editor-background, var(--ag-body-bg, #0d1117)));
          pointer-events: none;
          border-radius: 0 0 8px 8px;
        }
        code {
          font-family: "JetBrains Mono", "Fira Code", "SF Mono", Menlo, monospace;
        }
        
        /* 鈹€鈹€鈹€ Minimal Scrollbar 鈹€鈹€鈹€ */
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { 
          background: hsl(var(--muted, 240 3.7% 15.9%) / 0.25); 
          border-radius: 10px; 
        }
        ::-webkit-scrollbar-thumb:hover { 
          background: hsl(var(--muted, 240 3.7% 15.9%) / 0.45); 
        }
        
        /* 鈹€鈹€鈹€ Smooth scroll 鈹€鈹€鈹€ */
        * { scroll-behavior: smooth; }

        /* 鈹€鈹€鈹€ Fix excessive line breaks 鈹€鈹€鈹€ */
        /* Message body uses flex-col which forces every child onto its own line */
        div[class*="leading-relaxed"][class*="select-text"][class*="flex-col"] {
          display: block !important;
        }
        p:empty { display: none; }
        p { margin: 0.25em 0; }
        p + p { margin-top: 0.5em; }
        /* Icon-wrapping divs inside text flow should be inline */
        div:has(> img:only-child) { display: inline; }
        img[src*="/icons/"], img[src*="/extensions/"] { 
          display: inline-block; vertical-align: middle; 
        }
        /* Context-mention spans should flow inline */
        .context-scope-mention { display: inline; }
        .context-scope-mention > span { display: inline; }

        /* 鈹€鈹€鈹€ IDE toolbar layout fixes 鈹€鈹€鈹€ */
        /* Make the model/settings toolbar sticky at top */
        #chat-viewport > div > div[class*="!border-b"][class*="justify-between"] {
          position: sticky;
          top: 0;
          z-index: 10;
          background: var(--vscode-editor-background, var(--ag-body-bg, hsl(var(--background, 0 0% 100%))));
        }
        /* Ensure popup dialogs aren't clipped by overflow */
        [role="dialog"][style*="position: fixed"] {
          z-index: 100 !important;
        }
      </style>
      <style id="ide-style"></style>
      <style id="theme-style"></style>
      <div id="chat-viewport">
        <div class="loading">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
          Waiting for content...
        </div>
      </div>
    `;

    // Click handler for code blocks: expand/collapse
    root.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;

      // 鈹€鈹€ Toggle expand/collapse on <pre> blocks 鈹€鈹€
      const pre = target.closest?.("pre");
      if (pre) pre.classList.toggle("ag-expanded");
    });
  }, []);

  useEffect(() => {
    const root = shadowRef.current;
    if (!root) return;

    // 1. Update IDE-specific styles
    const styleEl = root.getElementById("ide-style");
    if (styleEl) styleEl.textContent = ideStyleText;

    // 2. Sync Global Theme Variables into Shadow DOM
    const themeStyle = root.getElementById("theme-style");
    if (themeStyle) {
      const rootStyles = getComputedStyle(document.documentElement);
      const vars = [
        "--background", "--foreground", "--card", "--card-foreground",
        "--popover", "--popover-foreground", "--primary", "--primary-foreground",
        "--secondary", "--secondary-foreground", "--muted", "--muted-foreground",
        "--accent", "--accent-foreground", "--destructive", "--destructive-foreground",
        "--border", "--input", "--ring", "--radius"
      ];
      let varsCss = ":host { ";
      vars.forEach(v => {
        const val = rootStyles.getPropertyValue(v);
        if (val) varsCss += `${v}: ${val}; `;
      });
      varsCss += "}";
      themeStyle.textContent = varsCss;
    }
  }, [ideStyleText]);

  useEffect(() => {
    const root = shadowRef.current;
    if (!root) return;

    const viewport = root.getElementById("chat-viewport");
    if (!(viewport instanceof HTMLElement)) return;
    if (!snapshot?.html) return;

    safeSetContent(viewport, snapshot.html);
    onContentUpdate?.();
  }, [snapshot?.html]);

  return (
    <>
      <div ref={hostRef} className="h-full w-full" />
      <PopupBubble
        open={popup.open}
        items={popup.items}
        anchor={
          popup.clickX !== null && popup.clickY !== null
            ? { x: popup.clickX, y: popup.clickY }
            : null
        }
        onSelect={selectPopupItem}
        onClose={dismissPopup}
      />
      <FilePreview
        open={filePreview.open}
        payload={filePreview.payload && "error" in filePreview.payload ? null : filePreview.payload}
        loading={filePreview.loading}
        error={filePreview.error}
        onClose={closeFilePreview}
      />
    </>
  );
}
