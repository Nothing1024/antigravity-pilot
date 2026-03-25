import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../../i18n";
import { useUIStore } from "../../stores/uiStore";
import { CascadeList } from "../drawer/CascadeList";
import { DrawerActions } from "../drawer/DrawerActions";

type Props = {
  title: string;
  children: ReactNode;
  onOpenProject?: () => void;
  view: "chat" | "settings";
  onViewChange: (view: "chat" | "settings") => void;
};

/** Breakpoint: above this the sidebar is a fixed panel; below it's an overlay drawer */
const LG = 1024;

function useIsLargeScreen() {
  const [isLarge, setIsLarge] = useState(
    () => typeof window !== "undefined" && window.innerWidth >= LG
  );
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${LG}px)`);
    const h = (e: MediaQueryListEvent) => setIsLarge(e.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);
  return isLarge;
}

export function AppShell({ title, children, onOpenProject, view, onViewChange }: Props) {
  const isLarge = useIsLargeScreen();
  const pushAutoActionsToServer = useUIStore((s) => s.pushAutoActionsToServer);
  const t = useI18n();

  // On app startup, push localStorage settings to server (recovers from server restart)
  useEffect(() => { pushAutoActionsToServer(); }, [pushAutoActionsToServer]);
  // Desktop: persistent toggle (remembered)
  const [desktopOpen, setDesktopOpen] = useState(() => {
    try { return localStorage.getItem("ag-sidebar-open") !== "false"; } catch { return true; }
  });
  const toggleDesktop = useCallback(() => {
    setDesktopOpen(prev => {
      const next = !prev;
      try { localStorage.setItem("ag-sidebar-open", String(next)); } catch { /* */ }
      return next;
    });
  }, []);

  // Mobile: ephemeral overlay drawer
  const [mobileOpen, setMobileOpen] = useState(false);
  const openMobile = useCallback(() => setMobileOpen(true), []);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  // Close mobile drawer when switching to large screen
  useEffect(() => { if (isLarge) setMobileOpen(false); }, [isLarge]);

  // Sidebar is visible as a fixed layout panel?
  const sidebarFixed = isLarge && desktopOpen;

  // ── Shared sidebar content ──
  const sidebarContent = (closeFn?: () => void) => (
    <>
      {/* Sidebar Header */}
      <div className="flex h-[var(--topbar-height)] items-center gap-3 border-b border-border/40 px-4 bg-background/50 backdrop-blur-sm">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/80 text-primary-foreground shadow-sm ring-1 ring-primary/20">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
            <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
          </svg>
        </div>
        <span className="text-sm font-semibold tracking-tight">Antigravity</span>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            onClick={closeFn || toggleDesktop}
            aria-label={t("shell.hideSidebar")}
            title={t("shell.hideSidebar")}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>
              <path d="M9 3v18"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Sessions Label */}
      <div className="px-4 pt-4 pb-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">{t("shell.sessions")}</span>
      </div>

      {/* Cascade List */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <CascadeList onSelect={() => {
          onViewChange("chat");
          closeFn?.();
        }} />
      </div>

      {/* Sidebar Footer */}
      <div className="border-t border-border/40 p-3">
        <DrawerActions onOpenProject={onOpenProject} onDone={closeFn} view={view} onViewChange={onViewChange} />
      </div>
    </>
  );

  // Toggle button shown in the header
  const toggleButton = (
    <button
      type="button"
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
      onClick={isLarge ? toggleDesktop : openMobile}
      aria-label={t("shell.showSidebar")}
      title={t("shell.showSidebar")}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>
        <path d="M9 3v18"/>
      </svg>
    </button>
  );

  return (
    <div className="flex h-[100dvh] bg-background text-foreground font-sans overflow-hidden">
      {/* ═══ Desktop: Fixed Sidebar ═══ */}
      {sidebarFixed && (
        <aside className="shrink-0 w-[var(--drawer-width)] border-r border-border/40 bg-background flex flex-col z-20">
          {sidebarContent()}
        </aside>
      )}

      {/* ═══ Main Column ═══ */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {/* ─── Header ─── */}
        <header className="flex h-[var(--topbar-height)] shrink-0 items-center gap-3 border-b border-border/30 bg-background/80 backdrop-blur-md px-4 select-none z-10 transition-colors">
          {/* Show toggle when sidebar is hidden */}
          {(!isLarge || !desktopOpen) && toggleButton}

          <h1 className="truncate text-sm font-semibold text-foreground/90 tracking-tight">
            {title}
          </h1>
        </header>

        {/* ─── Main Content ─── */}
        <main className="relative min-h-0 flex-1 flex flex-col overflow-hidden">
          {children}
        </main>
      </div>

      {/* ═══ Mobile: Overlay Drawer ═══ */}
      {!isLarge && (
        <>
          {/* Backdrop */}
          <div
            className={[
              "fixed inset-0 z-[var(--z-overlay)] transition-opacity duration-250",
              mobileOpen
                ? "bg-black/50 backdrop-blur-[2px] opacity-100"
                : "pointer-events-none opacity-0"
            ].join(" ")}
            onClick={closeMobile}
            aria-hidden={!mobileOpen}
          />

          {/* Drawer panel */}
          <aside
            className={[
              "fixed top-0 bottom-0 left-0 z-[var(--z-drawer)] w-[var(--drawer-width)]",
              "border-r border-border/40 bg-background shadow-2xl",
              "transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
              "flex flex-col",
              mobileOpen ? "translate-x-0" : "-translate-x-full"
            ].join(" ")}
            aria-hidden={!mobileOpen}
          >
            {sidebarContent(closeMobile)}
          </aside>
        </>
      )}
    </div>
  );
}
