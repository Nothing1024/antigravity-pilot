import { useSyncExternalStore } from "react";

import type { CascadeEntry } from "../stores/cascadeStore";
import { cascadeStoreApi } from "../stores/cascadeStore";

function getSnapshot() {
  return cascadeStoreApi.getState();
}

export function useLegacyCascadeState() {
  const state = useSyncExternalStore(
    cascadeStoreApi.subscribe,
    getSnapshot,
    getSnapshot,
  );

  const currentLegacyCascade = state.currentId
    ? state.cascades.find((cascade) => cascade.id === state.currentId) ?? null
    : null;

  const getLegacyCascadeById = (id: string | null): CascadeEntry | null => {
    if (!id) {
      return null;
    }
    return state.cascades.find((cascade) => cascade.id === id) ?? null;
  };

  return {
    legacyCascades: state.cascades,
    currentLegacyId: state.currentId,
    currentLegacyCascade,
    getLegacyCascadeById,
  };
}
