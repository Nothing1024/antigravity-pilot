import { create } from "zustand";

import { apiUrl } from "../services/api";

export type ThemeMode = "light" | "dark" | "follow";
export type SendMode = "enter" | "ctrl+enter";
export type Locale = "en" | "zh-CN";

export type AutoActionState = {
  autoAcceptAll: boolean;
  autoRetry: boolean;
  retryBackoff: boolean;
};

const THEME_STORAGE_KEY = "snapshot-theme";
const SEND_MODE_STORAGE_KEY = "ag-send-mode";
const AUTO_ACTIONS_STORAGE_KEY = "ag-auto-actions";
const LOCALE_STORAGE_KEY = "ag-locale";

const THEME_COLORS: Record<string, string> = {
  light: "#ffffff",
  dark: "#0d1117"
};

function normalizeThemeMode(raw: string | null): ThemeMode {
  if (raw === "light" || raw === "dark" || raw === "follow") return raw;
  return "follow";
}

function normalizeSendMode(raw: string | null): SendMode {
  if (raw === "enter" || raw === "ctrl+enter") return raw;
  return "ctrl+enter";
}

function detectLocale(raw: string | null): Locale {
  if (raw === "en" || raw === "zh-CN") return raw;
  // Auto-detect from browser language
  try {
    const lang = navigator.language || "";
    if (lang.startsWith("zh")) return "zh-CN";
  } catch { /* ignore */ }
  return "en";
}

const DEFAULT_AUTO_ACTIONS: AutoActionState = {
  autoAcceptAll: false,
  autoRetry: false,
  retryBackoff: true,
};

function loadAutoActions(): AutoActionState {
  try {
    const raw = localStorage.getItem(AUTO_ACTIONS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        autoAcceptAll: typeof parsed.autoAcceptAll === "boolean" ? parsed.autoAcceptAll : DEFAULT_AUTO_ACTIONS.autoAcceptAll,
        autoRetry: typeof parsed.autoRetry === "boolean" ? parsed.autoRetry : DEFAULT_AUTO_ACTIONS.autoRetry,
        retryBackoff: typeof parsed.retryBackoff === "boolean" ? parsed.retryBackoff : DEFAULT_AUTO_ACTIONS.retryBackoff,
      };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_AUTO_ACTIONS };
}

function saveAutoActions(state: AutoActionState): void {
  try {
    localStorage.setItem(AUTO_ACTIONS_STORAGE_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

function getSystemTheme(): "light" | "dark" {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

function resolveTheme(mode: ThemeMode): "light" | "dark" {
  return mode === "follow" ? getSystemTheme() : mode;
}

function applyToDocument(effective: "light" | "dark"): void {
  document.documentElement.setAttribute("data-theme", effective);
  document.documentElement.style.colorScheme = effective;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", THEME_COLORS[effective] || THEME_COLORS.light);
  }
}

export type ToastItem = {
  id: string;
  message: string;
  type: "info" | "success" | "warning" | "error";
  duration?: number;
};

type UIState = {
  // Theme
  themeMode: ThemeMode;
  effectiveTheme: "light" | "dark";
  setThemeMode: (mode: ThemeMode) => void;
  syncSystemTheme: () => void;

  // Send mode
  sendMode: SendMode;
  setSendMode: (mode: SendMode) => void;

  // Locale
  locale: Locale;
  setLocale: (locale: Locale) => void;

  // Auto actions (localStorage + server sync)
  autoActions: AutoActionState;
  setAutoAction: (key: keyof AutoActionState, value: boolean) => void;
  pushAutoActionsToServer: () => void;

  // Toast
  toasts: ToastItem[];
  addToast: (toast: Omit<ToastItem, "id">) => void;
  removeToast: (id: string) => void;
};

const stored = normalizeThemeMode(
  typeof localStorage !== "undefined"
    ? localStorage.getItem(THEME_STORAGE_KEY)
    : null
);
const initialEffective = resolveTheme(stored);

const storedSendMode = normalizeSendMode(
  typeof localStorage !== "undefined"
    ? localStorage.getItem(SEND_MODE_STORAGE_KEY)
    : null
);

const initialAutoActions = typeof localStorage !== "undefined"
  ? loadAutoActions()
  : { ...DEFAULT_AUTO_ACTIONS };

const storedLocale = detectLocale(
  typeof localStorage !== "undefined"
    ? localStorage.getItem(LOCALE_STORAGE_KEY)
    : null
);

let toastSeq = 0;

export const useUIStore = create<UIState>((set, get) => ({
  themeMode: stored,
  effectiveTheme: initialEffective,

  sendMode: storedSendMode,
  setSendMode: (mode) => {
    localStorage.setItem(SEND_MODE_STORAGE_KEY, mode);
    set({ sendMode: mode });
  },

  locale: storedLocale,
  setLocale: (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    set({ locale });
  },

  setThemeMode: (mode) => {
    const effective = resolveTheme(mode);
    localStorage.setItem(THEME_STORAGE_KEY, mode);
    applyToDocument(effective);
    set({ themeMode: mode, effectiveTheme: effective });
  },

  syncSystemTheme: () => {
    const mode = get().themeMode;
    if (mode !== "follow") return;
    const effective = resolveTheme(mode);
    applyToDocument(effective);
    set({ effectiveTheme: effective });
  },

  // Auto actions
  autoActions: initialAutoActions,

  setAutoAction: (key, value) => {
    const updated = { ...get().autoActions, [key]: value };
    saveAutoActions(updated);
    set({ autoActions: updated });

    // Sync to server in background (server needs these for auto-action execution)
    fetch(apiUrl("/api/auto-actions"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(updated),
    }).catch(() => { /* ignore network errors */ });
  },

  pushAutoActionsToServer: () => {
    const current = get().autoActions;
    fetch(apiUrl("/api/auto-actions"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(current),
    }).catch(() => { /* ignore */ });
  },

  toasts: [],

  addToast: (toast) => {
    const id = `toast-${++toastSeq}`;
    const item: ToastItem = { ...toast, id };
    set((s) => ({ toasts: [...s.toasts, item] }));

    const duration = toast.duration ?? 4000;
    if (duration > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, duration);
    }
  },

  removeToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}));

// Apply theme on load
applyToDocument(initialEffective);

