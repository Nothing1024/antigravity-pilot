import { useCallback, useEffect, useState } from "react";

import { AppShell } from "./components/layout/AppShell";
import { LoginPage } from "./components/auth/LoginPage";
import { ChatView } from "./components/chat/ChatView";
import { ProjectBrowser } from "./components/modals/ProjectBrowser";
import { SettingsView } from "./components/settings/SettingsView";
import { Toast } from "./components/ui/Toast";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { useTheme } from "./hooks/useTheme";
import { useWebSocket } from "./hooks/useWebSocket";
import { useCascadeStore } from "./stores/cascadeStore";
import { apiUrl } from "./services/api";

type View = "chat" | "settings";
type AuthState = "checking" | "authenticated" | "unauthenticated";

function AuthenticatedApp() {
  useWebSocket();
  useTheme();

  const title = useCascadeStore((s) => {
    const cur = s.currentId ? s.cascades.find((c) => c.id === s.currentId) : null;
    return cur?.title || "Antigravity Pilot";
  });
  const [projectOpen, setProjectOpen] = useState(false);
  const openProject = useCallback(() => setProjectOpen(true), []);
  const closeProject = useCallback(() => setProjectOpen(false), []);
  const [view, setView] = useState<View>("chat");

  return (
    <>
      <AppShell
        title={title}
        onOpenProject={openProject}
        view={view}
        onViewChange={setView}
      >
        <div className="flex flex-1 flex-col overflow-hidden min-h-0">
          {view === "chat" && <ChatView />}
          <SettingsView visible={view === "settings"} />
        </div>
        <ProjectBrowser open={projectOpen} onClose={closeProject} />
      </AppShell>
      <Toast />
    </>
  );
}

function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");

  // Check if already authenticated by probing a protected endpoint
  useEffect(() => {
    fetch(apiUrl("/cascades"), { credentials: "include" })
      .then((res) => {
        setAuthState(res.ok ? "authenticated" : "unauthenticated");
      })
      .catch(() => {
        setAuthState("unauthenticated");
      });
  }, []);

  if (authState === "checking") {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <svg className="h-5 w-5 animate-spin text-muted-foreground" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span className="text-xs text-muted-foreground">Loading…</span>
        </div>
      </div>
    );
  }

  if (authState === "unauthenticated") {
    return <LoginPage onSuccess={() => setAuthState("authenticated")} />;
  }

  return (
    <ErrorBoundary>
      <AuthenticatedApp />
    </ErrorBoundary>
  );
}

export default App;
