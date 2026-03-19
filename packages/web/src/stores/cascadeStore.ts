import type { QuotaInfo } from "@ag/shared";
import { create } from "zustand";

export type CascadeEntry = {
  id: string;
  title: string;
  window?: string;
  active: boolean;
  quota: QuotaInfo | null;
};

type State = {
  cascades: CascadeEntry[];
  currentId: string | null;
  setCascades: (next: CascadeEntry[]) => void;
  selectCascade: (id: string) => void;
  setQuota: (cascadeId: string, quota: QuotaInfo) => void;
};

export const useCascadeStore = create<State>((set, get) => ({
  cascades: [],
  currentId: null,

  setCascades: (next) => {
    const cur = get().currentId;
    const hasCur = cur && next.some((c) => c.id === cur);
    const nextCur = hasCur ? cur : next[0]?.id ?? null;
    set({ cascades: next, currentId: nextCur });
  },

  selectCascade: (id) => set({ currentId: id }),

  setQuota: (cascadeId, quota) =>
    set((s) => ({
      cascades: s.cascades.map((c) =>
        c.id === cascadeId ? { ...c, quota } : c
      )
    }))
}));

