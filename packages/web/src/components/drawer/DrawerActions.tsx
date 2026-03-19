import { useCallback } from "react";

import { apiUrl } from "../../services/api";
import { useCascadeStore } from "../../stores/cascadeStore";

type Props = {
  onOpenProject?: () => void;
  onDone?: () => void;
};

async function post(pathname: string): Promise<void> {
  const res = await fetch(apiUrl(pathname), { method: "POST" });
  if (res.ok) return;
  throw new Error(`HTTP ${res.status}`);
}

export function DrawerActions({ onOpenProject, onDone }: Props) {
  const currentId = useCascadeStore((s) => s.currentId);

  const newConversation = useCallback(async () => {
    if (!currentId) return;
    try {
      await post(`/new-conversation/${encodeURIComponent(currentId)}`);
      onDone?.();
    } catch {
      // ignore
    }
  }, [currentId, onDone]);

  const killAll = useCallback(async () => {
    try {
      await post("/api/kill-all");
      onDone?.();
    } catch {
      // ignore
    }
  }, [onDone]);

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        className="inline-flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:pointer-events-none"
        onClick={() => void newConversation()}
        disabled={!currentId}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
        New Conversation
      </button>
      
      <button
        type="button"
        className="inline-flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        onClick={() => {
          onOpenProject?.();
          onDone?.();
        }}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" /></svg>
        Open Project
      </button>

      <button
        type="button"
        className="inline-flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10"
        onClick={() => void killAll()}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
        Terminate All
      </button>
    </div>
  );
}
