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
  `;
}

function safeSetContent(viewport: HTMLElement, html: string): void {
  const temp = document.createElement("div");
  temp.id = "chat-viewport";
  temp.innerHTML = html;

  try {
    morphdom(viewport, temp, {
      onBeforeElUpdated: (fromEl, toEl) => {
        if (fromEl.isEqualNode(toEl)) return false;
        return true;
      }
    });
  } catch {
    viewport.innerHTML = html;
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
          contain: layout style;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }
        
        /* ─── CSS Reset for IDE elements ─── */
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
          animation: fadeIn 0.35s ease-out;
          overflow: hidden;
          word-wrap: break-word;
          overflow-wrap: break-word;
        }
        
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        
        /* ─── Reduce excessive IDE padding ─── */
        #chat-viewport [class*="pt-[30vh]"] {
          padding-top: 8vh !important;
        }
        #chat-viewport [class*="pt-[20vh]"] {
          padding-top: 6vh !important;
        }
        
        /* ─── Loading State ─── */
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
        
        /* ─── Trap fixed-positioned IDE popups ─── */
        #chat-viewport [style*="position: fixed"],
        #chat-viewport [style*="position:fixed"] {
          position: absolute !important;
        }
        
        /* ─── Interactive clickable elements ─── */
        [data-cdp-click] { 
          cursor: pointer !important; 
          transition: opacity 0.15s ease, filter 0.15s ease; 
        }
        [data-cdp-click]:hover { 
          opacity: 0.85; 
          filter: brightness(1.05);
        }
        [data-cdp-click]:active { 
          opacity: 0.7; 
        }
        
        /* ─── Content polish ─── */
        img { max-width: 100%; height: auto; border-radius: 6px; }
        pre { 
          overflow-x: auto; 
          max-width: 100%; 
          border-radius: 8px;
          font-size: 13px;
        }
        code {
          font-family: "JetBrains Mono", "Fira Code", "SF Mono", Menlo, monospace;
        }
        
        /* ─── Minimal Scrollbar ─── */
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { 
          background: hsl(var(--muted, 240 3.7% 15.9%) / 0.25); 
          border-radius: 10px; 
        }
        ::-webkit-scrollbar-thumb:hover { 
          background: hsl(var(--muted, 240 3.7% 15.9%) / 0.45); 
        }
        
        /* ─── Smooth scroll ─── */
        * { scroll-behavior: smooth; }
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
