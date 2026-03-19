import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { CascadeList } from "../drawer/CascadeList";
import { DrawerActions } from "../drawer/DrawerActions";

type Props = {
  title: string;
  children: ReactNode;
  onOpenProject?: () => void;
  view: "chat" | "settings";
  onViewChange: (view: "chat" | "settings") => void;
};

/** Breakpoint at which we allow pinned sidebar mode */
const LG_BREAKPOINT = 1024;

function useIsLargeScreen() {
  const [isLarge, setIsLarge] = useState(
    () => typeof window !== "undefined" && window.innerWidth >= LG_BREAKPOINT
  );
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${LG_BREAKPOINT}px)`);
    const handler = (e: MediaQueryListEvent) => setIsLarge(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return isLarge;
}

export function AppShell({ title, children, onOpenProject, view, onViewChange }: Props) {
  const isLargeScreen = useIsLargeScreen();

  // Pinned = sidebar is always visible on large screens
  const [pinned, setPinned] = useState(() => {
    try { return localStorage.getItem("ag-sidebar-pinned") === "true"; } catch { return false; }
  });
  const togglePin = useCallback(() => {
    setPinned(prev => {
      const next = !prev;
      try { localStorage.setItem("ag-sidebar-pinned", String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Drawer state (for overlay mode — small screens & unpinned large screens)
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [hoverMode, setHoverMode] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isTouchDevice = typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0);

  // Is sidebar currently visible as a fixed panel?
  const sidebarFixed = isLargeScreen && pinned;

  const openDrawer = useCallback(() => {
    if (sidebarFixed) return; // no need, sidebar is always visible
    if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
    setDrawerOpen(true);
    setHoverMode(false);
  }, [sidebarFixed]);

  const closeDrawer = useCallback(() => {
    if (sidebarFixed) return;
    if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
    setDrawerOpen(false);
    setHoverMode(false);
  }, [sidebarFixed]);

  // Hover‑open (desktop only, non‑pinned)
  const handleHoverEnter = useCallback(() => {
    if (isTouchDevice || sidebarFixed) return;
    if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
    setDrawerOpen(true);
    setHoverMode(true);
  }, [isTouchDevice, sidebarFixed]);

  const handleDrawerEnter = useCallback(() => {
    if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
  }, []);

  const handleDrawerLeave = useCallback(() => {
    if (!hoverMode) return;
    closeTimerRef.current = setTimeout(() => {
      setDrawerOpen(false);
      setHoverMode(false);
    }, 300);
  }, [hoverMode]);

  useEffect(() => {
    return () => { if (closeTimerRef.current) clearTimeout(closeTimerRef.current); };
  }, []);

  // When switching to pinned, close any open drawer overlay
  useEffect(() => {
    if (sidebarFixed) { setDrawerOpen(false); setHoverMode(false); }
  }, [sidebarFixed]);

  // ── Shared sidebar content ──
  const sidebarContent = (
    <>
      {/* Sidebar Header */}
      <div className="flex h-[var(--topbar-height)] items-center gap-3 border-b border-border/40 px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
            <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
          </svg>
        </div>
        <span className="text-sm font-semibold tracking-tight">Antigravity</span>

        <div className="ml-auto flex items-center gap-1">
          {/* Pin / Unpin button — visible on large screens */}
          {isLargeScreen && (
            <button
              type="button"
              className={[
                "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors",
                pinned
                  ? "text-primary bg-primary/10 hover:bg-primary/20"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              ].join(" ")}
              onClick={togglePin}
              aria-label={pinned ? "Unpin sidebar" : "Pin sidebar"}
              title={pinned ? "Unpin sidebar" : "Pin sidebar"}
            >
              {/* Pin icon — rotated when unpinned */}
              <svg
                xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                className={pinned ? "" : "rotate-45 opacity-50"}
              >
                <line x1="12" y1="17" x2="12" y2="22" />
                <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
              </svg>
            </button>
          )}

          {/* Close button — only in overlay/drawer mode */}
          {!sidebarFixed && !hoverMode && (
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              onClick={closeDrawer}
              aria-label="Close menu"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Sessions Label */}
      <div className="px-4 pt-4 pb-2">
        <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/60">Sessions</span>
      </div>

      {/* Cascade List */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <CascadeList onSelect={sidebarFixed ? undefined : closeDrawer} />
      </div>

      {/* Sidebar Footer */}
      <div className="border-t border-border/40 p-3">
        <DrawerActions onOpenProject={onOpenProject} onDone={sidebarFixed ? undefined : closeDrawer} />
      </div>
    </>
  );

  return (
    <div className="flex h-[100dvh] bg-background text-foreground font-sans overflow-hidden">
      {/* ═══ Fixed Sidebar (large screen + pinned) ═══ */}
      {sidebarFixed && (
        <aside
          className="shrink-0 w-[var(--drawer-width)] border-r border-border/40 bg-background flex flex-col"
        >
          {sidebarContent}
        </aside>
      )}

      {/* ═══ Main Column ═══ */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {/* ─── Header ─── */}
        <header className="flex h-[var(--topbar-height)] shrink-0 items-center gap-3 border-b border-border/50 bg-background px-4">
          {/* Hamburger / sidebar toggle — hidden when sidebar is fixed */}
          {!sidebarFixed && (
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              onClick={openDrawer}
              aria-label="Open menu"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="6" x2="20" y2="6" />
                <line x1="4" y1="18" x2="20" y2="18" />
              </svg>
            </button>
          )}

          <div className="flex flex-1 items-center gap-3 min-w-0">
            <div className="flex flex-col min-w-0">
              <span className="text-[9px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/60">
                Monitor
              </span>
              <h1 className="truncate text-sm font-semibold leading-tight tracking-tight">
                {title}
              </h1>
            </div>
          </div>

          {/* View Switcher */}
          <div className="flex items-center rounded-lg bg-muted/40 p-0.5">
            <button
              onClick={() => onViewChange("chat")}
              className={[
                "inline-flex h-7 items-center justify-center rounded-md px-3 text-xs font-medium transition-all duration-200",
                view === "chat"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              ].join(" ")}
            >
              Chat
            </button>
            <button
              onClick={() => onViewChange("settings")}
              className={[
                "inline-flex h-7 items-center justify-center rounded-md px-3 text-xs font-medium transition-all duration-200",
                view === "settings"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              ].join(" ")}
            >
              Config
            </button>
          </div>

          <button
            onClick={onOpenProject}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            title="Open Project"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
            </svg>
          </button>
        </header>

        {/* ─── Main Content ─── */}
        <main className="relative min-h-0 flex-1 flex flex-col overflow-hidden">
          {children}
        </main>
      </div>

      {/* ═══ Overlay Drawer (small screen OR unpinned large screen) ═══ */}
      {!sidebarFixed && (
        <>
          {/* Hover Edge Zone (desktop, non-touch, drawer closed) */}
          {!isTouchDevice && !drawerOpen && (
            <div
              className="fixed top-0 bottom-0 left-0 z-[var(--z-drawer)] w-3 cursor-pointer"
              onMouseEnter={handleHoverEnter}
              aria-hidden
            />
          )}

          {/* Overlay backdrop (click-opened only, not hover) */}
          <div
            className={[
              "fixed inset-0 z-[var(--z-overlay)] transition-opacity duration-250",
              drawerOpen && !hoverMode
                ? "bg-black/60 backdrop-blur-[2px] opacity-100"
                : "pointer-events-none opacity-0"
            ].join(" ")}
            onClick={closeDrawer}
            aria-hidden={!drawerOpen || hoverMode}
          />

          {/* Drawer panel */}
          <aside
            className={[
              "fixed top-0 bottom-0 left-0 z-[var(--z-drawer)] w-[var(--drawer-width)]",
              "border-r border-border/40 bg-background shadow-2xl transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
              "flex flex-col",
              drawerOpen ? "translate-x-0" : "-translate-x-full"
            ].join(" ")}
            aria-hidden={!drawerOpen}
            onMouseEnter={handleDrawerEnter}
            onMouseLeave={handleDrawerLeave}
          >
            {sidebarContent}
          </aside>
        </>
      )}
    </div>
  );
}
