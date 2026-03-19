import { useCallback, useRef, useState } from "react";

import { useCascadeStore } from "../../stores/cascadeStore";
import { useUIStore } from "../../stores/uiStore";
import { apiUrl } from "../../services/api";
import { ChatViewport } from "./ChatViewport";
import { MessageInput } from "./MessageInput";

export function ChatView() {
  const cascades = useCascadeStore((s) => s.cascades);
  const currentId = useCascadeStore((s) => s.currentId);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [launching, setLaunching] = useState(false);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, []);

  const launch = useCallback(async () => {
    if (launching) return;
    setLaunching(true);
    try {
      const res = await fetch(apiUrl("/api/launch"), { method: "POST", credentials: "include" });
      if (res.ok) {
        useUIStore.getState().addToast({ message: "Launching Antigravity…", type: "info", duration: 3000 });
      } else {
        useUIStore.getState().addToast({ message: "Failed to launch Antigravity", type: "error" });
      }
    } catch {
      useUIStore.getState().addToast({ message: "Connection error", type: "error" });
    } finally {
      setLaunching(false);
    }
  }, [launching]);

  // Empty state
  if (cascades.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-center">
        <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-muted">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground">
            <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
            <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
            <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
          </svg>
        </div>

        <h2 className="mb-1 text-lg font-semibold tracking-tight">No Active Sessions</h2>
        <p className="mb-6 max-w-[280px] text-sm text-muted-foreground">
          Connect to an Antigravity IDE instance to start remote monitoring.
        </p>

        <button
          type="button"
          className={[
            "inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
            launching ? "opacity-70" : ""
          ].join(" ")}
          onClick={() => void launch()}
          disabled={launching}
        >
          {launching ? (
            <>
              <svg className="mr-2 h-4 w-4 animate-spin" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Launching…
            </>
          ) : (
            "Launch Antigravity"
          )}
        </button>

        <div className="mt-8 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-orange-500" />
          </span>
          Scanning CDP channels…
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      <div ref={scrollRef} className="flex-1 overflow-y-auto w-full">
        <div className="max-w-4xl mx-auto min-h-full px-4 sm:px-6">
          <ChatViewport cascadeId={currentId} onContentUpdate={scrollToBottom} />
        </div>
      </div>
      <MessageInput cascadeId={currentId} />
    </div>
  );
}
