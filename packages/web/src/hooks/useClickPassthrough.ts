import type { MutableRefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiUrl } from "../services/api";

export type PopupItem = {
  title: string;
  description?: string;
  badges?: string[];
  header?: string;
  selector?: string;
  checked?: boolean;
};

export type ActiveFileResponse =
  | {
      type: "file";
      content: string;
      filename: string;
      ext: string;
      path: string;
    }
  | {
      type: "artifact";
      name: string;
      html: string;
    }
  | { error: string };

type PopupState = {
  open: boolean;
  items: PopupItem[];
  triggerIndex: number | null;
  clickX: number | null;
  clickY: number | null;
};

type FilePreviewState = {
  open: boolean;
  loading: boolean;
  error: string | null;
  payload: ActiveFileResponse | null;
};

type Options = {
  cascadeId: string | null;
  shadowRef: MutableRefObject<ShadowRoot | null>;
};

type Result = {
  popup: PopupState;
  selectPopupItem: (item: PopupItem) => Promise<void>;
  dismissPopup: () => Promise<void>;
  filePreview: FilePreviewState;
  closeFilePreview: () => void;
};

async function postJson<T>(pathname: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(pathname), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = (await res.json()) as T;
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "error" in data ? String((data as any).error) : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

async function getJson<T>(pathname: string): Promise<T> {
  const res = await fetch(apiUrl(pathname));
  const data = (await res.json()) as T;
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "error" in data ? String((data as any).error) : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// Check if a CDP element is likely a popup trigger (dropdown, select, mode button)
// Originally from legacy public/js/chat.js (now deleted). This is the single source of truth.
function isPopupTrigger(el: Element) {
  const tag = el.tagName.toUpperCase();
  const role = el.getAttribute("role") || "";
  const cls = ((el as any).className || "").toLowerCase();
  const text = (el.textContent || "").trim();

  // Explicit dropdown/select elements
  if (tag === "SELECT" || tag === "VSCODE-DROPDOWN") return true;
  if (/combobox|listbox/.test(role)) return true;

  // Class-based detection
  if (
    /dropdown|picker|combobox|trigger/i.test(cls) ||
    (/\bselect\b/i.test(cls) && !/select-none|select-text|select-all|select-auto/i.test(cls))
  )
    return true;

  // Known model/mode text patterns (short text that matches known items)
  const knownTriggerTexts = /^(planning|fast|normal|gemini|claude|gpt|o1|o3|o4|always run|ask first|never)/i;

  // IDE bottom-bar: buttons with `select-none` class are typically model/mode selectors
  // BUT only when combined with stronger popup signals (aria-haspopup, known trigger text),
  // since many non-popup UI buttons also use `select-none` (e.g. "Expand all", "Collapse all")
  if (
    /select-none/i.test(cls) &&
    text.length < 50 &&
    (el.getAttribute("aria-haspopup") || knownTriggerTexts.test(text))
  )
    return true;

  if (text.length < 40 && knownTriggerTexts.test(text)) return true;

  // Check for headlessui listbox buttons or aria-haspopup (listbox, true, dialog)
  const haspopup = el.getAttribute("aria-haspopup");
  if (haspopup === "listbox" || haspopup === "true" || haspopup === "dialog") return true;
  if ((el as any).id && /headlessui-listbox-button/.test((el as any).id)) return true;

  // Walk up to parent button to check headlessui or aria attributes
  const parent = (el as any).parentElement;
  if (parent) {
    const parentHaspopup = parent.getAttribute("aria-haspopup");
    if (parentHaspopup === "listbox" || parentHaspopup === "true" || parentHaspopup === "dialog")
      return true;
    if (parent.id && /headlessui-listbox-button/.test(parent.id)) return true;
    if (/combobox|listbox/.test(parent.getAttribute("role") || "")) return true;
  }

  return false;
}

function nearestCdpClickable(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  return target.closest("[data-cdp-click]");
}

export function useClickPassthrough({ cascadeId, shadowRef }: Options): Result {
  const [popup, setPopup] = useState<PopupState>({
    open: false,
    items: [],
    triggerIndex: null,
    clickX: null,
    clickY: null
  });

  const [filePreview, setFilePreview] = useState<FilePreviewState>({
    open: false,
    loading: false,
    error: null,
    payload: null
  });

  const cascadeIdRef = useRef<string | null>(cascadeId);
  cascadeIdRef.current = cascadeId;

  const closeFilePreview = useCallback(() => {
    setFilePreview({ open: false, loading: false, error: null, payload: null });
  }, []);

  const dismissPopup = useCallback(async () => {
    const id = cascadeIdRef.current;
    setPopup({ open: false, items: [], triggerIndex: null, clickX: null, clickY: null });
    if (!id) return;
    try {
      await postJson(`/dismiss/${encodeURIComponent(id)}`, {});
    } catch {
      // ignore
    }
  }, []);

  const selectPopupItem = useCallback(
    async (item: PopupItem) => {
      const id = cascadeIdRef.current;
      const triggerIndex = popup.triggerIndex;
      if (!id || triggerIndex === null) return;
      if (!item?.title) return;

      try {
        await postJson(`/popup-click/${encodeURIComponent(id)}`, {
          title: item.title,
          selector: item.selector || null,
          triggerIndex
        });
        await dismissPopup();
      } catch {
        // Keep popup open for retry.
      }
    },
    [dismissPopup, popup.triggerIndex]
  );

  useEffect(() => {
    let stopped = false;
    let cleanup: (() => void) | null = null;
    let tries = 0;

    const onClick: EventListener = async (evt) => {
      const e = evt as MouseEvent;
      const id = cascadeIdRef.current;
      if (!id) return;

      const el = nearestCdpClickable(e.target);
      if (!el) return;

      const idxStr = el.getAttribute("data-cdp-click") || "";
      const index = Number.parseInt(idxStr, 10);
      if (!Number.isFinite(index)) return;

      e.preventDefault();
      e.stopPropagation();

      const clickX = e.clientX;
      const clickY = e.clientY;

      const fileName = el.getAttribute("data-file-name");
      if (!isPopupTrigger(el)) {
        try {
          await postJson(`/click/${encodeURIComponent(id)}`, { index });
        } catch {
          // ignore
        }

        // Detect undo button click — restore sent text to input
        if (el.closest("[data-tooltip-id^='undo-tooltip']")) {
          window.dispatchEvent(new CustomEvent("ag-undo", { detail: { cascadeId: id } }));
        }

        if (fileName) {
          setFilePreview({ open: true, loading: true, error: null, payload: null });
          try {
            await new Promise((r) => window.setTimeout(r, 250));
            let data: ActiveFileResponse;
            try {
              data = await getJson<ActiveFileResponse>(`/api/active-file/${encodeURIComponent(id)}`);
            } catch {
              await new Promise((r) => window.setTimeout(r, 250));
              data = await getJson<ActiveFileResponse>(`/api/active-file/${encodeURIComponent(id)}`);
            }
            if ("error" in data) {
              setFilePreview({ open: true, loading: false, error: data.error, payload: null });
            } else {
              setFilePreview({ open: true, loading: false, error: null, payload: data });
            }
          } catch (err) {
            setFilePreview({
              open: true,
              loading: false,
              error: err instanceof Error ? err.message : String(err),
              payload: null
            });
          }
        }
        return;
      }

      try {
        const data = await postJson<{ items?: PopupItem[] }>(`/popup/${encodeURIComponent(id)}`, { index });
        const items = Array.isArray(data?.items) ? data.items : [];
        setPopup({ open: true, items, triggerIndex: index, clickX, clickY });
      } catch {
        setPopup({ open: false, items: [], triggerIndex: null, clickX: null, clickY: null });
      }
    };

    const tick = () => {
      if (stopped) return;
      const root = shadowRef.current;
      if (root) {
        root.addEventListener("click", onClick);
        cleanup = () => root.removeEventListener("click", onClick);
        return;
      }
      tries++;
      if (tries >= 50) return; // ~5s
      window.setTimeout(tick, 100);
    };

    tick();

    return () => {
      stopped = true;
      if (cleanup) cleanup();
    };
  }, [shadowRef]);

  return { popup, selectPopupItem, dismissPopup, filePreview, closeFilePreview };
}
