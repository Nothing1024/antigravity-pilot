import { useEffect } from "react";

import { useUIStore } from "../stores/uiStore";
import type { ThemeMode } from "../stores/uiStore";

export type { ThemeMode };

/**
 * Hook to manage theme state with system preference tracking.
 * Listens for prefers-color-scheme changes when in "follow" mode.
 */
export function useTheme() {
  const themeMode = useUIStore((s) => s.themeMode);
  const effectiveTheme = useUIStore((s) => s.effectiveTheme);
  const setThemeMode = useUIStore((s) => s.setThemeMode);
  const syncSystemTheme = useUIStore((s) => s.syncSystemTheme);

  // Listen for system theme changes
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");

    const onChange = () => syncSystemTheme();

    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    // Fallback for older browsers
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    mq.addListener(onChange);
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    return () => mq.removeListener(onChange);
  }, [syncSystemTheme]);

  // Listen for storage changes (multi-tab sync)
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "snapshot-theme") {
        const raw = e.newValue;
        if (raw === "light" || raw === "dark" || raw === "follow") {
          setThemeMode(raw);
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [setThemeMode]);

  return { themeMode, effectiveTheme, setThemeMode };
}
