import { useCallback } from "react";

import { useCascadeStore } from "../../stores/cascadeStore";

type Props = {
  onSelect?: () => void;
};

export function CascadeList({ onSelect }: Props) {
  const cascades = useCascadeStore((s) => s.cascades);
  const currentId = useCascadeStore((s) => s.currentId);
  const selectCascade = useCascadeStore((s) => s.selectCascade);

  const onPick = useCallback(
    (id: string) => {
      selectCascade(id);
      onSelect?.();
    },
    [onSelect, selectCascade]
  );

  if (cascades.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mb-2 opacity-50"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>
        <span className="text-xs">No sessions</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-px">
      {cascades.map((c) => {
        const active = c.id === currentId;
        return (
          <button
            key={c.id}
            type="button"
            className={[
              "w-full rounded-lg px-3 py-2 text-left transition-all duration-150",
              active
                ? "bg-accent text-accent-foreground border-l-2 border-primary"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground border-l-2 border-transparent"
            ].join(" ")}
            onClick={() => onPick(c.id)}
          >
            <div className={["truncate text-[13px] leading-tight", active ? "font-medium" : ""].join(" ")}>
              {c.title || "Untitled Session"}
            </div>
            {c.window && (
              <div className="mt-0.5 truncate text-[11px] opacity-50">
                {c.window}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
