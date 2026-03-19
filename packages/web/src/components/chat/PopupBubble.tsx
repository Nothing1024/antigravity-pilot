import type { ReactNode } from "react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type PopupItem = {
  title: string;
  description?: string;
  badges?: string[];
  header?: string;
  selector?: string;
  checked?: boolean;
};

type Props = {
  open: boolean;
  title?: string;
  items: PopupItem[];
  anchor?: { x: number; y: number } | null;
  onSelect: (item: PopupItem) => void;
  onClose: () => void;
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

type AnchoredPos = { left: number; top?: number; bottom?: number };

function Header({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pt-3 pb-2 text-xs font-semibold tracking-wide text-[var(--text-muted)]">
      {children}
    </div>
  );
}

export function PopupBubble({
  open,
  title,
  items,
  anchor,
  onSelect,
  onClose
}: Props) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [anchoredPos, setAnchoredPos] = useState<AnchoredPos | null>(null);

  const rows = useMemo(() => {
    let lastHeader: string | null = null;
    return items.map((item) => {
      const h = item.header?.trim() || null;
      const showHeader = !!h && h !== lastHeader;
      if (showHeader) lastHeader = h;
      return { item, header: showHeader ? h : null };
    });
  }, [items]);

  useLayoutEffect(() => {
    if (!open || !anchor) {
      setAnchoredPos(null);
      return;
    }

    const card = cardRef.current;
    if (!card) return;

    const frame = requestAnimationFrame(() => {
      const rect = card.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      let left = anchor.x - rect.width / 2;
      left = clamp(left, 16, Math.max(16, vw - rect.width - 16));

      const spaceBelow = vh - anchor.y;
      let top: number | undefined;
      let bottom: number | undefined;
      if (spaceBelow >= rect.height + 20) {
        top = anchor.y + 12;
      } else {
        bottom = clamp(vh - anchor.y + 12, 12, vh - 12);
      }

      setAnchoredPos({ left, top, bottom });
    });

    return () => cancelAnimationFrame(frame);
  }, [open, anchor?.x, anchor?.y, rows.length]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  const cardStyle: React.CSSProperties | undefined = anchor
    ? {
        left: anchoredPos?.left ?? clamp(anchor.x - 160, 16, window.innerWidth - 16),
        top: anchoredPos?.top,
        bottom: anchoredPos?.bottom
      }
    : undefined;

  return createPortal(
    <div
      className="fixed inset-0 z-[var(--z-modal)] bg-[var(--bg-overlay)]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        ref={cardRef}
        className={[
          "fixed w-[min(420px,calc(100vw-32px))] overflow-hidden rounded-[var(--radius-lg)]",
          "border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-[var(--shadow-lg)]",
          anchor ? "" : "left-1/2 bottom-4 -translate-x-1/2"
        ].join(" ")}
        style={cardStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {title ? (
          <div className="flex items-center gap-2 border-b border-[var(--border-light)] px-3 py-3">
            <div className="min-w-0 flex-1 truncate text-sm font-semibold">
              {title}
            </div>
            <button
              type="button"
              className="grid h-8 w-8 place-items-center rounded-md text-sm active:bg-[var(--bg-tertiary)]"
              onClick={onClose}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        ) : null}

        <div className="max-h-[min(60dvh,520px)] overflow-auto">
          {rows.length === 0 ? (
            <div className="px-3 py-4 text-sm text-[var(--text-muted)]">
              No options
            </div>
          ) : null}

          {rows.map(({ item, header }, idx) => (
            <div key={`${item.title}-${idx}`}>
              {header ? <Header>{header}</Header> : null}
              <button
                type="button"
                className={[
                  "flex w-full items-start gap-3 px-3 py-3 text-left text-sm",
                  "border-t border-[var(--border-light)] first:border-t-0",
                  "active:bg-[var(--bg-tertiary)]"
                ].join(" ")}
                onClick={() => onSelect(item)}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div className="truncate font-medium">{item.title}</div>
                    {item.badges?.length ? (
                      <div className="flex flex-wrap gap-1">
                        {item.badges.slice(0, 3).map((b) => (
                          <span
                            key={b}
                            className="rounded-full bg-[var(--accent-bg)] px-2 py-0.5 text-[11px] text-[var(--accent)]"
                          >
                            {b}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  {item.description ? (
                    <div className="mt-1 line-clamp-2 text-xs text-[var(--text-muted)]">
                      {item.description}
                    </div>
                  ) : null}
                </div>
                <div className="pt-0.5 text-sm text-[var(--text-muted)]">
                  {item.checked ? "✓" : ""}
                </div>
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}

