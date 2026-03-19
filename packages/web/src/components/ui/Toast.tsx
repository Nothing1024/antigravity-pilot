import { useUIStore } from "../../stores/uiStore";
import type { ToastItem } from "../../stores/uiStore";

function toastIcon(type: ToastItem["type"]): string {
  switch (type) {
    case "success": return "✓";
    case "warning": return "⚠";
    case "error": return "✕";
    case "info":
    default: return "ℹ";
  }
}

function toastStyle(type: ToastItem["type"]): string {
  switch (type) {
    case "success": return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    case "warning": return "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400";
    case "error": return "border-destructive/30 bg-destructive/10 text-destructive";
    case "info":
    default: return "border-border bg-card text-card-foreground";
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
            "pointer-events-auto flex w-full max-w-sm items-center gap-2.5 rounded-md border px-4 py-3 text-sm shadow-lg cursor-pointer transition-opacity hover:opacity-90",
            toastStyle(t.type)
          ].join(" ")}
          onClick={() => removeToast(t.id)}
        >
          <span className="text-xs font-bold shrink-0">{toastIcon(t.type)}</span>
          <span className="min-w-0 flex-1 font-medium">{t.message}</span>
        </div>
      ))}
    </div>
  );
}
