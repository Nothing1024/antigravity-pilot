import { useUIStore } from "../../stores/uiStore";
import type { ToastItem } from "../../stores/uiStore";
import type { ReactNode } from "react";

function ToastIcon({ type }: { type: ToastItem["type"] }): ReactNode {
  switch (type) {
    case "success":
      return (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-500">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
          <path d="m9 11 3 3L22 4"/>
        </svg>
      );
    case "warning":
      return (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-500">
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
          <path d="M12 9v4"/>
          <path d="M12 17h.01"/>
        </svg>
      );
    case "error":
      return (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-destructive">
          <circle cx="12" cy="12" r="10"/>
          <path d="m15 9-6 6"/>
          <path d="m9 9 6 6"/>
        </svg>
      );
    case "info":
    default:
      return (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-500">
          <circle cx="12" cy="12" r="10"/>
          <path d="M12 16v-4"/>
          <path d="M12 8h.01"/>
        </svg>
      );
  }
}

export function Toast() {
  const toasts = useUIStore((s) => s.toasts);
  const removeToast = useUIStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[var(--z-toast)] flex flex-col items-center gap-2 px-4"
      style={{ paddingTop: "calc(var(--safe-area-top, 0px) + 8px)" }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={[
            "pointer-events-auto flex w-full max-w-[min(380px,calc(100vw-32px))] items-center gap-3 rounded-lg px-4 py-3 cursor-pointer",
            "border border-border/40 bg-background/95 text-foreground shadow-lg backdrop-blur-md",
            "transition-all hover:bg-muted/50"
          ].join(" ")}
          onClick={() => removeToast(t.id)}
        >
          <div className="flex items-center justify-center shrink-0">
            <ToastIcon type={t.type} />
          </div>
          <span className="min-w-0 flex-1 text-sm font-medium leading-snug">{t.message}</span>
        </div>
      ))}
    </div>
  );
}
