import { useCallback } from "react";

import { ResponsePhase } from "@ag/shared";
import { useConversations } from "../../hooks/useConversations";
import { useI18n } from "../../i18n";
import { createConversationRpc } from "../../services/conversations";

type Props = {
  onSelect?: () => void;
};

function PhaseIndicator({ phase }: { phase?: ResponsePhase }) {
  if (!phase || phase === ResponsePhase.IDLE || phase === ResponsePhase.COMPLETED) {
    return (
      <span className="relative flex h-2 w-2 shrink-0" title="Idle">
        <span className="relative inline-flex h-2 w-2 rounded-full bg-muted-foreground/30" />
      </span>
    );
  }
  if (phase === ResponsePhase.GENERATING || phase === ResponsePhase.THINKING || phase === ResponsePhase.TOOL_RUNNING) {
    return (
      <span className="relative flex h-2 w-2 shrink-0" title="Running">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
      </span>
    );
  }
  if (phase === ResponsePhase.APPROVAL_PENDING) {
    return (
      <span className="relative flex h-2 w-2 shrink-0" title="Awaiting Approval">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-yellow-500" />
      </span>
    );
  }
  if (phase === ResponsePhase.ERROR || phase === ResponsePhase.QUOTA_ERROR) {
    return (
      <span className="relative flex h-2 w-2 shrink-0" title="Error">
        <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
      </span>
    );
  }
  return null;
}

export function CascadeList({ onSelect }: Props) {
  const t = useI18n();
  const {
    conversations,
    currentConversationId,
    refreshConversations,
    selectConversation,
  } = useConversations();

  const onPick = useCallback(
    (id: string) => {
      selectConversation(id);
      onSelect?.();
    },
    [onSelect, selectConversation]
  );

  const createConversation = useCallback(
    async (workspaceUri?: string) => {
      try {
        const conversationId = await createConversationRpc(workspaceUri);
        selectConversation(conversationId);
        await refreshConversations();
        onSelect?.();
      } catch {
        // ignore
      }
    },
    [onSelect, refreshConversations, selectConversation],
  );

  if (conversations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mb-2 opacity-50"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>
        <span className="text-xs">{t("cascadeList.empty")}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {conversations.map((conversation) => {
        const active = conversation.id === currentConversationId;
        const isRunning =
          conversation.phase === ResponsePhase.GENERATING ||
          conversation.phase === ResponsePhase.THINKING ||
          conversation.phase === ResponsePhase.TOOL_RUNNING;
        return (
          <button
            key={conversation.id}
            type="button"
            className={[
              "group relative flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors duration-200",
              active
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              isRunning ? "ring-1 ring-green-500/20" : "",
            ].join(" ")}
            onClick={() => onPick(conversation.id)}
          >
            <div className="flex items-center gap-2">
              <PhaseIndicator phase={conversation.phase} />
              <div className={["truncate text-[13px] leading-tight flex-1 pr-6", active ? "font-semibold" : "font-medium"].join(" ")}>
                {conversation.title || t("cascadeList.untitled")}
              </div>
            </div>
            {conversation.workspace && (
              <div className={["truncate text-[11px] pl-4 pr-6", active ? "text-primary/70" : "text-muted-foreground/50"].join(" ")}>
                {conversation.workspace}
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
                void createConversation(conversation.workspaceUri);
              }}
              // Empty handler required: a11y lint requires onKeyDown when role="button"
              onKeyDown={() => {}}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                <path d="M16 16h5v5" />
              </svg>
            </span>
          </button>
        );
      })}
    </div>
  );
}
