import { useCallback, useState } from "react";

import { useI18n } from "../../i18n";
import { apiUrl } from "../../services/api";
import { useCascadeStore } from "../../stores/cascadeStore";
import { ConfirmModal } from "../common/ConfirmModal";

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
  const t = useI18n();
  const currentId = useCascadeStore((s) => s.currentId);
  const [showKillConfirm, setShowKillConfirm] = useState(false);

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
      setShowKillConfirm(false);
      onDone?.();
    } catch {
      // ignore
    }
  }, [onDone]);

  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        className="group inline-flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-50 disabled:pointer-events-none"
        onClick={() => void newConversation()}
        disabled={!currentId}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-80 group-hover:opacity-100 transition-opacity"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
        {t("drawer.newConversation")}
      </button>
      
      <button
        type="button"
        className="group inline-flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        onClick={() => {
          onOpenProject?.();
          onDone?.();
        }}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-80 group-hover:opacity-100 transition-opacity"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" /></svg>
        {t("drawer.openProject")}
      </button>

      {/* Kill-all button */}
      <button
        type="button"
        className="group inline-flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] font-medium text-destructive/90 transition-colors hover:bg-destructive/10 hover:text-destructive"
        onClick={() => setShowKillConfirm(true)}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-80 group-hover:opacity-100 transition-opacity"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
        {t("drawer.terminateAll")}
      </button>

      {/* Confirmation modal */}
      {showKillConfirm && (
        <ConfirmModal
          header={
            <div className="flex items-center gap-2 text-destructive">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
              <span className="text-[14px] font-semibold">{t("drawer.terminateAll")}</span>
            </div>
          }
          message={t("drawer.terminateConfirm")}
          confirmLabel={t("drawer.confirm")}
          variant="destructive"
          onConfirm={() => void killAll()}
          onCancel={() => setShowKillConfirm(false)}
        />
      )}
    </div>
  );
}
