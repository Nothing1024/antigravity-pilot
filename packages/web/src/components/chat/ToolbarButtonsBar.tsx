import React from "react";

import { apiUrl } from "../../services/api";

export type ToolbarButton = {
  label: string;
  cdpIndex: number;
  icon?: string;
};

type Props = {
  cascadeId: string | null;
  buttons: ToolbarButton[];
  onPopup?: (items: { title: string; selector?: string }[], triggerIndex: number, x: number, y: number) => void;
};

async function handleToolbarClick(
  cascadeId: string,
  index: number,
  e: React.MouseEvent,
  onPopup?: Props["onPopup"],
) {
  try {
    const res = await fetch(apiUrl(`/popup/${encodeURIComponent(cascadeId)}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index }),
    });
    if (res.ok && onPopup) {
      const data = await res.json() as { items?: { title: string; selector?: string }[] };
      const items = Array.isArray(data?.items) ? data.items : [];
      if (items.length > 0) {
        onPopup(items, index, e.clientX, e.clientY);
        return;
      }
    }
  } catch (err) {
    console.warn("[ToolbarButtonsBar] popup request failed, falling back to click:", err);
  }
  try {
    await fetch(apiUrl(`/click/${encodeURIComponent(cascadeId)}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index }),
    });
  } catch (err) {
    console.warn("[ToolbarButtonsBar] click failed:", err);
  }
}

function getIcon(label: string, icon?: string): React.ReactNode {
  if (icon === 'plus') {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12h14" /><path d="M12 5v14" />
      </svg>
    );
  }
  if (icon === 'credit') {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m12 14 4-4" /><path d="M3.34 19a10 10 0 1 1 17.32 0" />
      </svg>
    );
  }
  const lower = label.toLowerCase();
  if (lower.includes("planning") || lower.includes("normal") || lower.includes("fast")) {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m18 15-6-6-6 6" />
      </svg>
    );
  }
  if (/gemini|claude|gpt|model|o1|o3|o4/i.test(lower)) {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m18 15-6-6-6 6" />
      </svg>
    );
  }
  return null;
}

export function ToolbarButtonsBar({ cascadeId, buttons, onPopup }: Props) {
  if (buttons.length === 0 || !cascadeId) return null;

  // Split into: plus button | trigger buttons | credit info
  const plusBtn = buttons.find((b) => b.icon === 'plus');
  const creditBtn = buttons.find((b) => b.icon === 'credit');
  const triggerBtns = buttons.filter((b) => b.icon !== 'plus' && b.icon !== 'credit');

  return (
    <div className="px-3 sm:px-5">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-1 overflow-x-auto py-1 scrollbar-hide">
          {/* + button */}
          {plusBtn && (
            <button
              type="button"
              onClick={(e) => void handleToolbarClick(cascadeId, plusBtn.cdpIndex, e, onPopup)}
              className="p-1 rounded-full hover:bg-muted/50 transition-colors opacity-70 hover:opacity-100 shrink-0"
            >
              {getIcon('', 'plus')}
            </button>
          )}

          {/* Trigger buttons (Planning, Model) */}
          {triggerBtns.map((btn) => {
            const icon = getIcon(btn.label, btn.icon);
            return (
              <button
                key={btn.cdpIndex}
                type="button"
                onClick={(e) => void handleToolbarClick(cascadeId, btn.cdpIndex, e, onPopup)}
                className="inline-flex items-center gap-0.5 shrink-0 py-1 pl-[2px] pr-2 rounded-md text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground active:scale-[0.97] transition-all duration-150 select-none opacity-70 hover:opacity-100"
              >
                {icon && <span>{icon}</span>}
                <span className="truncate">{btn.label}</span>
              </button>
            );
          })}

          {/* Spacer */}
          <div className="flex-1 min-w-[8px]" />

          {/* Credit info (right-aligned) */}
          {creditBtn && (
            <div className="inline-flex items-center gap-1 shrink-0 text-xs text-muted-foreground opacity-70 truncate min-w-0">
              {getIcon('', 'credit')}
              <span className="truncate">{creditBtn.label}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
