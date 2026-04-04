import { useCallback, useEffect, useRef, useState } from "react";

import { useConversations } from "../../hooks/useConversations";
import { useLegacyCascadeState } from "../../hooks/useLegacyCascade";
import { useUIStore } from "../../stores/uiStore";
import { apiUrl } from "../../services/api";
import { ChatPanel } from "../ChatPanel";
import { MessageInput } from "./MessageInput";
import { FileChangesBar } from "./FileChangesBar";
import type { FileChange } from "./FileChangesBar";
import { ToolbarButtonsBar } from "./ToolbarButtonsBar";
import type { ToolbarButton } from "./ToolbarButtonsBar";
import { PopupBubble } from "./PopupBubble";
import type { PopupItem } from "./PopupBubble";
import { useCapabilitiesStore } from "../../stores/capabilitiesStore";

type ToolbarPopup = {
  open: boolean;
  items: PopupItem[];
  triggerIndex: number | null;
  anchor: { x: number; y: number } | null;
};

export function ChatView() {
  const { conversations, currentConversationId, loading } = useConversations();
  const { currentLegacyId } = useLegacyCascadeState();
  const debugCascadeId = import.meta.env.DEV
    ? ((import.meta.env.VITE_DEBUG_CASCADE_ID as string | undefined) ?? null)
    : null;
  const activeId = currentLegacyId || debugCascadeId;
  const hasRpcConversations =
    conversations.length > 0 || currentConversationId !== null;
  const serverMode = useCapabilitiesStore((s) => s.capabilities.mode);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [launching, setLaunching] = useState(false);
  const [fileChanges, setFileChanges] = useState<FileChange[]>([]);
  const [toolbarButtons, setToolbarButtons] = useState<ToolbarButton[]>([]);
  const [actionButtons, setActionButtons] = useState<ToolbarButton[]>([]);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [toolbarPopup, setToolbarPopup] = useState<ToolbarPopup>({
    open: false, items: [], triggerIndex: null, anchor: null,
  });

  // Track scroll position to show/hide "scroll to bottom" button
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollBtn(distanceFromBottom > 300);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [activeId]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  const scrollToBottomIfNeeded = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 150) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
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

  // Called by ToolbarButtonsBar when a popup trigger is clicked and returns items
  const handleToolbarPopup = useCallback(
    (items: { title: string; selector?: string }[], triggerIndex: number, x: number, y: number) => {
      setToolbarPopup({
        open: true,
        items: items.map((it) => ({ title: it.title, selector: it.selector })),
        triggerIndex,
        anchor: { x, y },
      });
    },
    []
  );

  const handleToolbarPopupSelect = useCallback(
    async (item: PopupItem) => {
      const id = activeId;
      const triggerIndex = toolbarPopup.triggerIndex;
      if (!id || triggerIndex === null) return;
      setToolbarPopup({ open: false, items: [], triggerIndex: null, anchor: null });
      try {
        await fetch(apiUrl(`/popup-click/${encodeURIComponent(id)}`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: item.title, selector: item.selector || null, triggerIndex }),
        });
      } catch {
        // ignore
      }
    },
    [activeId, toolbarPopup.triggerIndex]
  );

  const handleToolbarPopupClose = useCallback(async () => {
    const id = activeId;
    setToolbarPopup({ open: false, items: [], triggerIndex: null, anchor: null });
    if (!id) return;
    try {
      await fetch(apiUrl(`/dismiss/${encodeURIComponent(id)}`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
    } catch {
      // ignore
    }
  }, [activeId]);

  // Empty state
  if (!activeId) {
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
          {hasRpcConversations && !loading
            ? "Connect to an active Antigravity IDE instance to load the selected conversation."
            : "Connect to an Antigravity IDE instance to start remote monitoring."}
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
          {serverMode === "rpc-only"
            ? "Scanning RPC instances…"
            : serverMode === "cdp-only"
              ? "Scanning CDP channels…"
              : "Scanning CDP + RPC…"}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      <div ref={scrollRef} className="flex-1 overflow-y-auto w-full">
        <div className="max-w-4xl mx-auto min-h-full px-4 sm:px-6">
          <ChatPanel
            cascadeId={activeId}
            onContentUpdate={scrollToBottomIfNeeded}
            onFileChanges={setFileChanges}
            onToolbarButtons={setToolbarButtons}
            onActionButtons={setActionButtons}
          />
        </div>
      </div>

      {/* Scroll to bottom button */}
      {showScrollBtn && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute right-6 bottom-28 z-20 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card/90 text-muted-foreground shadow-lg backdrop-blur-sm transition-all hover:bg-accent hover:text-foreground hover:scale-110 active:scale-95"
          title="滚动到底部"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m7 13 5 5 5-5" />
            <path d="m7 6 5 5 5-5" />
          </svg>
        </button>
      )}

      <FileChangesBar cascadeId={activeId} files={fileChanges} actions={actionButtons} />
      <ToolbarButtonsBar cascadeId={activeId} buttons={toolbarButtons} onPopup={handleToolbarPopup} />
      <MessageInput cascadeId={activeId} />
      <PopupBubble
        open={toolbarPopup.open}
        items={toolbarPopup.items}
        anchor={toolbarPopup.anchor}
        onSelect={handleToolbarPopupSelect}
        onClose={() => void handleToolbarPopupClose()}
      />
    </div>
  );
}
