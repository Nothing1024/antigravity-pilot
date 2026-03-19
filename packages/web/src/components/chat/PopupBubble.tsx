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
    <div className="px-2 pt-1.5 pb-0.5 text-[10px] uppercase font-semibold tracking-wider text-[var(--text-muted)] opacity-70">
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

      // Always pop above the trigger point (like a native dropdown)
      let top: number | undefined;
      let bottom: number | undefined;
      bottom = clamp(vh - anchor.y + 8, 12, vh - 12);

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
    <>
      {/* Transparent click-away dismissal layer — no backdrop */}
      <div
        className="fixed inset-0 z-[var(--z-modal)]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={cardRef}
        className={[
          "fixed z-[var(--z-modal)] w-[min(260px,calc(100vw-32px))] overflow-hidden rounded-xl",
          "border border-border/20 bg-background/95 text-foreground shadow-lg backdrop-blur-xl",
          anchor ? "" : "left-1/2 top-4 -translate-x-1/2"
        ].join(" ")}
        style={cardStyle}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {title ? (
          <div className="flex items-center gap-2 border-b border-border/10 px-3 py-2 bg-muted/20">
            <div className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
              {title}
            </div>
            <button
              type="button"
              className="grid h-6 w-6 place-items-center rounded-md text-xs hover:bg-muted/50 transition-colors"
              onClick={onClose}
              aria-label="Close"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
              </svg>
            </button>
          </div>
        ) : null}

        <div className="max-h-[min(60dvh,400px)] overflow-auto p-1">
          {rows.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground text-center">
              No options
            </div>
          ) : null}

          {rows.map(({ item, header }, idx) => (
            <div key={`${item.title}-${idx}`}>
              {header ? <Header>{header}</Header> : null}
              <button
                type="button"
                className={[
                  "flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs rounded-md",
                  "hover:bg-muted/50 active:bg-muted/70",
                  "transition-colors"
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
                            className="rounded-[4px] bg-[hsl(var(--primary)_/_0.1)] px-1.5 py-[1px] text-[9px] font-medium text-[hsl(var(--primary))] uppercase"
                          >
                            {b}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  {item.description ? (
                    <div className="mt-0.5 line-clamp-1 text-[10px] text-muted-foreground/80">
                      {item.description}
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center justify-center w-4 h-4 text-primary">
                  {item.checked ? (
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6 9 17l-5-5"/>
                    </svg>
                  ) : ""}
                </div>
              </button>
            </div>
          ))}
        </div>
      </div>
    </>,
    document.body
  );
}

