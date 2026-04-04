import { ResponsePhase } from "@ag/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { create } from "zustand";

import { apiUrl } from "../services/api";

type ConversationSummaryRecord = {
  summary?: string;
  status?: string;
  stepCount?: number;
  numTotalSteps?: number;
  workspaces?: { workspaceFolderAbsoluteUri?: string }[];
  lastModifiedTime?: string;
  createdTime?: string;
  _diskOnly?: boolean;
};

type ConversationsResponse = {
  trajectorySummaries?: Record<string, ConversationSummaryRecord>;
};

export type ConversationRPC = {
  id: string;
  title: string;
  status: string;
  phase: ResponsePhase;
  numTotalSteps: number;
  workspace?: string;
  workspaceUri?: string;
  lastModifiedTime?: string;
  createdTime?: string;
  diskOnly: boolean;
};

type ConversationsStore = {
  conversations: ConversationRPC[];
  selectedConversationId: string | null;
  setConversations: (next: ConversationRPC[]) => void;
  selectConversation: (id: string | null) => void;
};

const useConversationsStore = create<ConversationsStore>((set, get) => ({
  conversations: [],
  selectedConversationId: null,
  setConversations: (next) => {
    const current = get().selectedConversationId;
    const hasCurrent = current && next.some((conversation) => conversation.id === current);
    set({
      conversations: next,
      selectedConversationId: hasCurrent ? current : next[0]?.id ?? null,
    });
  },
  selectConversation: (id) => set({ selectedConversationId: id }),
}));

function normalizeConversation(
  id: string,
  summary: ConversationSummaryRecord,
): ConversationRPC {
  const workspaceUri = summary.workspaces?.[0]?.workspaceFolderAbsoluteUri;
  const title = summary.summary?.trim();
  return {
    id,
    title: title || `${id.slice(0, 8)}...`,
    status: summary.status || "CASCADE_RUN_STATUS_UNKNOWN",
    phase: mapStatusToPhase(summary.status),
    numTotalSteps: summary.numTotalSteps ?? summary.stepCount ?? 0,
    workspace: workspaceUri,
    workspaceUri,
    lastModifiedTime: summary.lastModifiedTime,
    createdTime: summary.createdTime,
    diskOnly: summary._diskOnly === true,
  };
}

function mapStatusToPhase(status?: string): ResponsePhase {
  switch (status) {
    case "CASCADE_RUN_STATUS_RUNNING":
      return ResponsePhase.GENERATING;
    case "CASCADE_RUN_STATUS_ERROR":
      return ResponsePhase.ERROR;
    default:
      return ResponsePhase.IDLE;
  }
}

function sortConversations(a: ConversationRPC, b: ConversationRPC): number {
  const aRunning = a.status === "CASCADE_RUN_STATUS_RUNNING" ? 1 : 0;
  const bRunning = b.status === "CASCADE_RUN_STATUS_RUNNING" ? 1 : 0;
  if (aRunning !== bRunning) return bRunning - aRunning;

  const aTime = Date.parse(a.lastModifiedTime || a.createdTime || "") || 0;
  const bTime = Date.parse(b.lastModifiedTime || b.createdTime || "") || 0;
  if (aTime !== bTime) return bTime - aTime;

  return b.numTotalSteps - a.numTotalSteps;
}

export function useConversations() {
  const conversations = useConversationsStore((s) => s.conversations);
  const selectedConversationId = useConversationsStore(
    (s) => s.selectedConversationId,
  );
  const setConversations = useConversationsStore((s) => s.setConversations);
  const selectConversation = useConversationsStore((s) => s.selectConversation);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshConversations = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl("/api/conversations"), {
        credentials: "include",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = (await res.json()) as ConversationsResponse;
      const next = Object.entries(data.trajectorySummaries ?? {})
        .map(([id, summary]) => normalizeConversation(id, summary))
        .sort(sortConversations);

      setConversations(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [setConversations]);

  useEffect(() => {
    void refreshConversations();
    const timer = window.setInterval(() => {
      void refreshConversations();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refreshConversations]);

  const currentConversationId = selectedConversationId ?? conversations[0]?.id ?? null;
  const currentConversation = useMemo(() => {
    if (!currentConversationId) {
      return null;
    }
    return (
      conversations.find(
        (conversation) => conversation.id === currentConversationId,
      ) ?? null
    );
  }, [conversations, currentConversationId]);

  return {
    conversations,
    currentConversation,
    currentConversationId,
    loading,
    error,
    refreshConversations,
    selectConversation,
  };
}
