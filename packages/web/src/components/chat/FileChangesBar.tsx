import React, { useState } from "react";

import { apiUrl } from "../../services/api";
import type { ToolbarButton } from "./ToolbarButtonsBar";

export type FileChange = {
  name: string;
  added: number;
  removed: number;
};

type Props = {
  cascadeId: string | null;
  files: FileChange[];
  actions: ToolbarButton[];
};

async function clickAction(cascadeId: string, index: number) {
  try {
    await fetch(apiUrl(`/click/${encodeURIComponent(cascadeId)}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index }),
    });
  } catch (err) {
    console.warn("[FileChangesBar] clickAction failed:", err);
  }
}

/* ─── Icon SVGs matching the IDE toolbar ─── */
const ICONS: Record<string, React.ReactNode> = {
  changesOverview: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </svg>
  ),
  terminal: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      <path d="m7 11 2-2-2-2" /><path d="M11 13h4" />
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
    </svg>
  ),
  artifacts: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" strokeWidth="1" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m7.875 14.25 1.214 1.942a2.25 2.25 0 0 0 1.908 1.058h2.006c.776 0 1.497-.4 1.908-1.058l1.214-1.942M2.41 9h4.636a2.25 2.25 0 0 1 1.872 1.002l.164.246a2.25 2.25 0 0 0 1.872 1.002h2.092a2.25 2.25 0 0 0 1.872-1.002l.164-.246A2.25 2.25 0 0 1 16.954 9h4.636M2.41 9a2.25 2.25 0 0 0-.16.832V12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 12V9.832c0-.287-.055-.57-.16-.832M2.41 9a2.25 2.25 0 0 1 .382-.632l3.285-3.832a2.25 2.25 0 0 1 1.708-.786h8.43c.657 0 1.281.287 1.709.786l3.284 3.832c.163.19.291.404.382.632M4.5 20.25h15A2.25 2.25 0 0 0 21.75 18v-2.625c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125V18a2.25 2.25 0 0 0 2.25 2.25Z" />
    </svg>
  ),
  browser: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.88 21.94 15.46 14" /><path d="M21.17 8H12" />
      <path d="M3.95 6.06 8.54 14" />
      <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="4" />
    </svg>
  ),
};

export function FileChangesBar({ cascadeId, files, actions }: Props) {
  const [expanded, setExpanded] = useState(false);

  // Split actions into icon buttons (left) and text buttons (right)
  const iconActions = actions.filter((a) => a.icon && ICONS[a.icon]);
  const textActions = actions.filter((a) => !a.icon && a.label);

  // Identify special actions for styling
  const acceptAction = textActions.find((a) => /accept\s*all/i.test(a.label));
  const rejectAction = textActions.find((a) => /reject\s*all/i.test(a.label));
  const otherTextActions = textActions.filter((a) => a !== acceptAction && a !== rejectAction);

  // Don't render an empty bar
  if (iconActions.length === 0 && files.length === 0 && textActions.length === 0) return null;

  return (
    <div className="px-3 sm:px-5">
      <div className="max-w-2xl mx-auto">
        {/* Expanded file list */}
        {expanded && files.length > 0 && (
          <div className="border border-b-0 border-border/20 rounded-t-lg bg-muted/10 max-h-48 overflow-y-auto">
            {files.map((f) => (
              <div
                key={f.name}
                className="flex items-center gap-2 px-3 py-1 text-xs hover:bg-muted/20 transition-colors"
              >
                <span className="text-green-500 font-mono min-w-[28px] text-right">+{f.added}</span>
                <span className="text-red-500 font-mono min-w-[28px] text-right">-{f.removed}</span>
                <span className="text-foreground/80 truncate">{f.name}</span>
              </div>
            ))}
          </div>
        )}

        {/* Toolbar bar — matches IDE .outline-solid layout */}
        <div
          className={[
            "flex items-center justify-between gap-2 px-2 py-1 border border-border/20 bg-muted/30 text-muted-foreground transition-colors",
            expanded && files.length > 0 ? "rounded-b-lg" : "rounded-lg",
          ].join(" ")}
        >
          {/* Left: icon buttons + file count */}
          <div className="flex items-center gap-1">
            {iconActions.map((a) => (
              <button
                key={a.cdpIndex}
                type="button"
                title={a.icon}
                onClick={() => cascadeId && void clickAction(cascadeId, a.cdpIndex)}
                className="p-[2px] rounded hover:bg-muted/60 transition-colors opacity-60 hover:opacity-100"
              >
                {ICONS[a.icon!]}
              </button>
            ))}
            {files.length > 0 && (
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-1 ml-1 text-xs font-medium hover:text-foreground transition-colors"
              >
                <span>{files.length} File{files.length !== 1 ? "s" : ""} With Changes</span>
                <svg
                  xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  className={`transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
                >
                  <path d="m18 15-6-6-6 6" />
                </svg>
              </button>
            )}
          </div>

          {/* Right: text action buttons */}
          <div className="flex items-center gap-1.5">
            {otherTextActions.map((a) => (
              <button
                key={a.cdpIndex}
                type="button"
                onClick={() => cascadeId && void clickAction(cascadeId, a.cdpIndex)}
                className="px-2 py-0.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              >
                {a.label}
              </button>
            ))}
            {rejectAction && cascadeId && (
              <button
                type="button"
                onClick={() => void clickAction(cascadeId, rejectAction.cdpIndex)}
                className="px-2 py-0.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              >
                {rejectAction.label}
              </button>
            )}
            {acceptAction && cascadeId && (
              <button
                type="button"
                onClick={() => void clickAction(cascadeId, acceptAction.cdpIndex)}
                className="px-2.5 py-0.5 rounded text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                {acceptAction.label}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
