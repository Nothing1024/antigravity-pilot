import type { CDPConnection } from "./types";

export type SimplifyResult = { ok: true; applied: string[] } | { ok: false; reason: string };

/**
 * CSS to inject into the IDE page to reduce GPU rendering burden.
 *
 * Strategy:
 *  • Hide everything EXCEPT the chat/cascade panel (editor, sidebar, terminal, minimap, etc.)
 *  • Disable all CSS animations/transitions/transforms across the IDE
 *  • Remove decorative elements (shadows, gradients, backdrop-filters)
 *  • Reduce composite layers by removing will-change/transform hints
 *  • Force simpler rendering paths
 */
const SIMPLIFY_CSS = `
/* ══════════════════════════════════════════════════════════
   Antigravity Pilot — IDE GPU Simplification Layer
   ══════════════════════════════════════════════════════════ */

/* ── 1. Kill ALL animations & transitions globally ── */
*, *::before, *::after {
  animation: none !important; animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition: none !important; transition-duration: 0s !important;
  transition-delay: 0s !important;
}

/* ── 2. Hide panels via content-visibility (more efficient than display:none) ── */
.part.editor { content-visibility: hidden !important; height: 0 !important; overflow: hidden !important; }
.editor-group-container { content-visibility: hidden !important; height: 0 !important; }
.part.sidebar { content-visibility: hidden !important; width: 0 !important; overflow: hidden !important; }
.part.panel { content-visibility: hidden !important; height: 0 !important; }
.part.statusbar { display: none !important; }
.activitybar { display: none !important; }
.part.titlebar { max-height: 28px !important; overflow: hidden !important; }

/* ── 3. Reduce GPU composite layers ── */
* { will-change: auto !important; }
*, *::before, *::after { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }

/* ── 4. Stop canvas rendering in hidden panels (GPU heavy) ── */
.part.editor canvas, .part.sidebar canvas, .part.panel canvas { display: none !important; }
.part.editor ::-webkit-scrollbar,
.part.sidebar ::-webkit-scrollbar,
.part.panel ::-webkit-scrollbar { display: none !important; }

/* ── 5. Isolate chat panel rendering scope ── */
.part.auxiliarybar { contain: layout style paint !important; }

/* ── 6. Sash handling: hide all, show only chat panel's right sash ── */
.monaco-sash { background: transparent !important; }
.monaco-sash[data-ag-sash] { background: rgba(128,128,128,0.4) !important; }
.monaco-sash[data-ag-sash]:hover { background: rgba(128,128,128,0.8) !important; }
`;

/**
 * Lighter version: only disables animations and hides minimap/terminal,
 * but keeps the editor visible (for users who still glance at the IDE).
 */
const SIMPLIFY_CSS_LIGHT = `
/* ══════════════════════════════════════════════════════════
   Antigravity Pilot — IDE Light Simplification
   ══════════════════════════════════════════════════════════ */

/* ── Kill animations & transitions ── */
*, *::before, *::after {
  animation-duration: 0s !important;
  transition-duration: 0s !important;
}

/* ── Hide GPU-heavy but non-essential elements ── */
.minimap, .minimap-shadow-visible { display: none !important; }
.part.panel { visibility: hidden !important; height: 0 !important; min-height: 0 !important; }
.breadcrumbs-below-tabs { display: none !important; }

/* ── Reduce GPU layers ── */
* { will-change: auto !important; }
* { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }

/* ── Reduce cursor blink (GPU composite per frame) ── */
.cursor { animation: none !important; opacity: 1 !important; }

/* ── Simplify scrollbars ── */
.monaco-editor .scrollbar .slider {
  border-radius: 0 !important;
  background: rgba(128,128,128,0.3) !important;
}
`;

const SIMPLIFY_STYLE_ID = "ag-pilot-simplify";

/**
 * Inject simplification CSS into the IDE via CDP.
 * This is idempotent — calling it multiple times will update the existing style.
 *
 * @param mode - "full" hides everything except chat; "light" keeps editor visible
 */
export async function injectSimplify(
  cdp: CDPConnection,
  mode: "full" | "light" = "full"
): Promise<SimplifyResult> {
  const css = mode === "full" ? SIMPLIFY_CSS : SIMPLIFY_CSS_LIGHT;
  const applied: string[] = [];

  // Inject into ALL contexts (main window + iframes) to ensure full coverage
  const contexts = cdp.contexts;
  if (!contexts.length) {
    return { ok: false, reason: "no execution contexts available" };
  }

  const markSashJs = mode === "full" ? `
    // Mark only the chat panel's right sash for visibility
    const aux = document.getElementById('workbench.parts.auxiliarybar');
    if (aux) {
      const svv = aux.parentElement;
      const rightEdge = svv.offsetLeft + svv.offsetWidth;
      document.querySelectorAll('.monaco-sash.vertical').forEach(sa => {
        sa.removeAttribute('data-ag-sash');
        const sashLeft = parseInt(sa.style.left) || 0;
        if (Math.abs(sashLeft - rightEdge) < 10 && sa.parentElement?.classList.contains('sash-container')) {
          sa.setAttribute('data-ag-sash', '1');
        }
      });
    }
  ` : '';

  const SCRIPT = `(() => {
    const STYLE_ID = ${JSON.stringify(SIMPLIFY_STYLE_ID)};
    const css = ${JSON.stringify(css)};

    // Remove existing if any (idempotent)
    let existing = document.getElementById(STYLE_ID);
    if (existing) existing.remove();

    // Create and inject
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);

    ${markSashJs}

    ${mode === "full" ? `
    // Force cancel all running CSS animations
    const runningAnims = document.getAnimations?.() || [];
    runningAnims.forEach(a => { try { a.cancel(); } catch {} });

    // NOTE: no rAF throttling — it breaks chat panel / WebUI updates
    ` : ''}

    return { ok: true, location: window.location.href.substring(0, 80) };
  })()`;

  let anyOk = false;
  for (const ctx of contexts) {
    try {
      const result: any = await cdp.call("Runtime.evaluate", {
        expression: SCRIPT,
        returnByValue: true,
        contextId: ctx.id
      });
      if (result.result?.value?.ok) {
        applied.push(result.result.value.location || `context-${ctx.id}`);
        anyOk = true;
      }
    } catch {
      // context might be destroyed, skip
    }
  }

  // Set prefers-reduced-motion via CDP Emulation
  if (mode === "full") {
    try {
      await cdp.call("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }]
      });
    } catch {
      // Emulation domain may not be available
    }
  }

  if (!anyOk) {
    return { ok: false, reason: "failed to inject into any context" };
  }
  return { ok: true, applied };
}

/**
 * Remove the simplification CSS from the IDE.
 */
export async function removeSimplify(cdp: CDPConnection): Promise<SimplifyResult> {
  const applied: string[] = [];

  const SCRIPT = `(() => {
    const el = document.getElementById(${JSON.stringify(SIMPLIFY_STYLE_ID)});
    if (el) el.remove();
    // Clean up sash markers
    document.querySelectorAll('.monaco-sash[data-ag-sash]').forEach(sa => sa.removeAttribute('data-ag-sash'));
    return { ok: true, removed: !!el };
  })()`;

  for (const ctx of cdp.contexts) {
    try {
      const result: any = await cdp.call("Runtime.evaluate", {
        expression: SCRIPT,
        returnByValue: true,
        contextId: ctx.id
      });
      if (result.result?.value?.removed) {
        applied.push(`context-${ctx.id}`);
      }
    } catch {
      // ignore
    }
  }

  return { ok: true, applied };
}

/**
 * Check if simplification is currently active on any context.
 */
export async function isSimplified(cdp: CDPConnection): Promise<boolean> {
  const SCRIPT = `(() => !!document.getElementById(${JSON.stringify(SIMPLIFY_STYLE_ID)}))()`;

  for (const ctx of cdp.contexts) {
    try {
      const result: any = await cdp.call("Runtime.evaluate", {
        expression: SCRIPT,
        returnByValue: true,
        contextId: ctx.id
      });
      if (result.result?.value === true) return true;
    } catch {
      // ignore
    }
  }
  return false;
}
