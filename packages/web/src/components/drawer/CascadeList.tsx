import { useCallback } from "react";

import { useI18n } from "../../i18n";
import { switchConversation } from "../../services/cascadeService";
import { useCascadeStore } from "../../stores/cascadeStore";

type Props = {
  onSelect?: () => void;
};

export function CascadeList({ onSelect }: Props) {
  const t = useI18n();
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
        <span className="text-xs">{t("cascadeList.empty")}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {cascades.map((c) => {
        const active = c.id === currentId;
        return (
          <button
            key={c.id}
            type="button"
            className={[
              "group relative flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors duration-200",
              active
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            ].join(" ")}
            onClick={() => onPick(c.id)}
          >
            <div className={["truncate text-[13px] leading-tight pr-6", active ? "font-semibold" : "font-medium"].join(" ")}>
              {c.title || t("cascadeList.untitled")}
            </div>
            {c.window && (
              <div className={["truncate text-[11px] pr-6", active ? "text-primary/70" : "text-muted-foreground/50"].join(" ")}>
                {c.window}
              </div>
            )}

            {/* Switch session icon — visible on hover */}
            <span
              role="button"
              tabIndex={-1}
              title={t("drawer.newConversation")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-70 hover:!opacity-100 hover:bg-muted/80"
              onClick={(e) => {
                e.stopPropagation();
                void switchConversation(c.id);
              }}
              // Empty handler required: a11y lint requires onKeyDown when role="button"
              onKeyDown={() => {}}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                <path d="M12 7v6" />
                <path d="M9 10h6" />
              </svg>
            </span>
          </button>
        );
      })}
    </div>
  );
}
