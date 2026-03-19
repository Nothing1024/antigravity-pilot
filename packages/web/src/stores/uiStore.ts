import { create } from "zustand";

export type ThemeMode = "light" | "dark" | "follow";

const THEME_STORAGE_KEY = "snapshot-theme";
const THEME_COLORS: Record<string, string> = {
  light: "#ffffff",
  dark: "#0d1117"
};

function normalizeThemeMode(raw: string | null): ThemeMode {
  if (raw === "light" || raw === "dark" || raw === "follow") return raw;
  return "follow";
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

let toastSeq = 0;

export const useUIStore = create<UIState>((set, get) => ({
  themeMode: stored,
  effectiveTheme: initialEffective,

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
