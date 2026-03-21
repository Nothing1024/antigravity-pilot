import { useCallback, useEffect, useRef, useState } from "react";

import { apiUrl } from "../../services/api";
import { useI18n } from "../../i18n";
import { useUIStore } from "../../stores/uiStore";
import { ConfirmModal } from "../common/ConfirmModal";

type Props = {
  cascadeId: string | null;
};

async function postSend(cascadeId: string, message: string): Promise<void> {
  const res = await fetch(apiUrl(`/send/${encodeURIComponent(cascadeId)}`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message })
  });
  if (res.ok) return;
  let reason = `HTTP ${res.status}`;
  try {
    const data: any = await res.json();
    if (data?.error) reason = String(data.error);
    if (data?.reason) reason = String(data.reason);
  } catch {
    // ignore
  }
  throw new Error(reason);
}

/**
 * Per-cascade draft store — intentionally a module-level Map so that drafts
 * survive React re-mounts (e.g. view switches) but are cleared on full
 * page refresh.  This ephemeral lifetime is by design: long-lived drafts
 * should use localStorage/sessionStorage instead.
 */
const drafts = new Map<string, string>();

export function MessageInput({ cascadeId }: Props) {
  const t = useI18n();
  // Initialise from stored draft for this cascade
  const [text, setTextRaw] = useState(() => (cascadeId ? drafts.get(cascadeId) || "" : ""));
  const [sending, setSending] = useState(false);
  const [focused, setFocused] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sendMode = useUIStore((s) => s.sendMode);

  // Wrapper: update both local state and the draft map
  const setText = useCallback((value: string) => {
    setTextRaw(value);
    if (cascadeId) drafts.set(cascadeId, value);
  }, [cascadeId]);

  // When cascade switches, load the stored draft for the new cascade
  const prevCascadeRef = useRef(cascadeId);
  useEffect(() => {
    if (cascadeId !== prevCascadeRef.current) {
      prevCascadeRef.current = cascadeId;
      setTextRaw(cascadeId ? drafts.get(cascadeId) || "" : "");
      setShowClearConfirm(false);
    }
  }, [cascadeId]);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, 160);
    el.style.height = `${Math.max(42, next)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [text, resize]);

  const send = useCallback(async () => {
    if (!cascadeId) return;
    const msg = text.trim();
    if (!msg) return;
    if (sending) return;

    setSending(true);
    setText("");

    try {
      await postSend(cascadeId, msg);
    } catch {
      setText(msg);
    } finally {
      setSending(false);
    }
  }, [cascadeId, sending, text, setText]);

  const isMac = typeof window !== "undefined" && window.navigator.platform.includes("Mac");
  const canSend = !!cascadeId && !sending && !!text.trim();
  const showTrash = text.length >= 20;

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (sendMode === "enter") {
      // Enter sends, Shift+Enter inserts newline
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        void send();
      }
    } else {
      // Ctrl+Enter (or Cmd+Enter on Mac) sends
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void send();
      }
    }
  }, [send, sendMode]);

  const hintText = sendMode === "enter"
    ? "↵"
    : isMac ? "⌘↵" : "Ctrl+↵";

  return (
    <div className="border-t border-border/20 bg-gradient-to-t from-background via-background to-transparent px-3 sm:px-5 pt-1 pb-[calc(0.625rem+var(--safe-area-bottom))]">
      <div className="max-w-2xl mx-auto">
        <div
          className={[
            "relative flex items-end gap-1.5 rounded-2xl border bg-muted/20 transition-all duration-300",
            focused
              ? "border-primary/40 shadow-[0_0_0_1px_hsl(var(--primary)/0.15),0_2px_12px_-2px_hsl(var(--primary)/0.1)]"
              : "border-border/30 shadow-sm",
            !cascadeId ? "opacity-50" : ""
          ].join(" ")}
        >
          {/* Textarea */}
          <textarea
            ref={textareaRef}
            className="flex-1 min-h-[42px] max-h-[160px] bg-transparent px-4 py-2.5 text-sm leading-relaxed placeholder:text-muted-foreground/35 focus:outline-none resize-none disabled:cursor-not-allowed"
            rows={1}
            placeholder={cascadeId ? t("input.placeholder") : t("input.waiting")}
            value={text}
            disabled={!cascadeId || sending}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={handleKeyDown}
          />

          {/* Right side actions */}
          <div className="flex items-center gap-1 pr-2 pb-1.5">
            {/* Trash button — visible when text is long */}
            {showTrash && (
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/40 hover:text-destructive/80 hover:bg-destructive/10 transition-colors"
                title={t("input.clear")}
                onClick={() => setShowClearConfirm(true)}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                </svg>
              </button>
            )}

            {/* Shortcut hint */}
            <span
              className={[
                "hidden sm:inline-flex items-center text-[10px] font-mono text-muted-foreground/25 select-none transition-opacity duration-200 pr-0.5",
                focused ? "opacity-100" : "opacity-0"
              ].join(" ")}
            >
              {hintText}
            </span>

            {/* Send button */}
            <button
              type="button"
              className={[
                "inline-flex h-8 w-8 items-center justify-center rounded-xl transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                canSend
                  ? "bg-primary text-primary-foreground shadow-sm hover:shadow-md hover:scale-105 active:scale-95"
                  : "text-muted-foreground/30 cursor-default"
              ].join(" ")}
              onClick={() => void send()}
              disabled={!canSend}
              aria-label="Send"
            >
              {sending ? (
                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14" />
                  <path d="m12 5 7 7-7 7" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Clear confirmation modal */}
      {showClearConfirm && (
        <ConfirmModal
          message={t("input.clearConfirm")}
          confirmLabel={t("input.clearAction")}
          variant="destructive"
          onConfirm={() => {
            setText("");
            setShowClearConfirm(false);
            textareaRef.current?.focus();
          }}
          onCancel={() => setShowClearConfirm(false)}
        />
      )}
    </div>
  );
}
