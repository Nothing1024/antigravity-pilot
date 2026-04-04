import { create } from "zustand";

import type { CapabilitiesResponse, ServerMode } from "@ag/shared";
import { apiUrl } from "../services/api";

// Re-export for convenience
export type { CapabilitiesResponse as ServerCapabilities, ServerMode };

const DEFAULT_CAPABILITIES: CapabilitiesResponse = {
  mode: "disconnected",
  cdp: { enabled: false, snapshot: false, connected: false },
  rpc: { enabled: false, fallbackToCDP: false },
  features: {
    simplify: false,
    screenshot: false,
    clickPassthrough: false,
    scrollSync: false,
    filePreview: false,
    messaging: false,
    trajectory: false,
    conversationHistory: false,
    modelSwitch: false,
    sessionSwitch: false,
    autoActions: true,
    pushNotifications: true,
  },
};

type State = {
  capabilities: CapabilitiesResponse;
  loaded: boolean;
  fetchCapabilities: () => Promise<void>;
};

export const useCapabilitiesStore = create<State>((set) => ({
  capabilities: DEFAULT_CAPABILITIES,
  loaded: false,

  fetchCapabilities: async () => {
    try {
      const res = await fetch(apiUrl("/api/capabilities"), { credentials: "include" });
      if (!res.ok) return;
      const data = (await res.json()) as CapabilitiesResponse;
      set({ capabilities: data, loaded: true });
    } catch {
      // Server unreachable, keep defaults
    }
  },
}));
