import { useCallback, useEffect, useState } from "react";

import { useTheme } from "../../hooks/useTheme";
import type { ThemeMode } from "../../hooks/useTheme";
import { apiUrl } from "../../services/api";

type Props = {
  visible: boolean;
};

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "follow", label: "System" }
];

type AutoActionState = {
  autoAcceptAll: boolean;
  autoRetry: boolean;
  retryBackoff: boolean;
};

export function SettingsView({ visible }: Props) {
  const { themeMode, setThemeMode } = useTheme();
  const [pushSupported, setPushSupported] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);

  // Auto-action settings
  const [autoActions, setAutoActions] = useState<AutoActionState>({
    autoAcceptAll: false,
    autoRetry: false,
    retryBackoff: true
  });

  // Fetch auto-action settings from server on mount
  useEffect(() => {
    fetch(apiUrl("/api/auto-actions"), { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        if (data && typeof data.autoAcceptAll === "boolean") {
          setAutoActions(data);
        }
      })
      .catch(() => {});
  }, []);

  const toggleAutoAction = useCallback(
    async (key: keyof AutoActionState) => {
      const updated = { ...autoActions, [key]: !autoActions[key] };
      setAutoActions(updated);
      try {
        await fetch(apiUrl("/api/auto-actions"), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify(updated)
        });
      } catch (err) {
        console.error("Auto-action toggle error:", err);
        // revert on failure
        setAutoActions(autoActions);
      }
    },
    [autoActions]
  );

  useEffect(() => {
    const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    setPushSupported(supported);
    if (supported && Notification.permission === "granted") {
      navigator.serviceWorker.ready
        .then((reg) => reg.pushManager.getSubscription())
        .then((sub) => setPushEnabled(!!sub))
        .catch(() => {});
    }
  }, []);

  const togglePush = useCallback(async () => {
    if (pushLoading) return;
    setPushLoading(true);
    try {
      if (pushEnabled) {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await fetch(apiUrl("/api/push/unsubscribe"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ endpoint: sub.endpoint })
          });
          await sub.unsubscribe();
        }
        setPushEnabled(false);
      } else {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") return;
        const vapidRes = await fetch(apiUrl("/api/push/vapid-key"), { credentials: "include" });
        if (!vapidRes.ok) throw new Error("Failed to get VAPID key");
        const { key: vapidKey } = (await vapidRes.json()) as { key: string };
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey });
        await fetch(apiUrl("/api/push/subscribe"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify(sub)
        });
        setPushEnabled(true);
      }
    } catch (err) {
      console.error("Push toggle error:", err);
    } finally {
      setPushLoading(false);
    }
  }, [pushEnabled, pushLoading]);

  if (!visible) return null;

  return (
    <div className="flex h-full flex-col overflow-y-auto px-4 py-6 sm:px-6">
      <div className="mx-auto w-full max-w-lg space-y-6">
        {/* Theme */}
        <div className="rounded-lg border border-border bg-card shadow-sm">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-medium">Appearance</h2>
            <p className="text-xs text-muted-foreground">Choose your preferred theme.</p>
          </div>
          <div className="flex gap-2 p-4">
            {THEME_OPTIONS.map((opt) => {
              const active = themeMode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  className={[
                    "flex-1 inline-flex flex-col items-center gap-2 rounded-md border p-3 text-xs font-medium transition-colors",
                    active
                      ? "border-ring bg-accent text-accent-foreground"
                      : "border-transparent hover:bg-accent hover:text-accent-foreground text-muted-foreground"
                  ].join(" ")}
                  onClick={() => setThemeMode(opt.value)}
                >
                  {opt.value === "light" && (
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
                  )}
                  {opt.value === "dark" && (
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
                  )}
                  {opt.value === "follow" && (
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                  )}
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Automation */}
        <div className="rounded-lg border border-border bg-card shadow-sm">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-medium">Automation</h2>
            <p className="text-xs text-muted-foreground">Automatic actions to reduce manual intervention.</p>
          </div>
          <div className="divide-y divide-border">
            {/* Auto Accept All */}
            <div className="flex items-center justify-between px-4 py-3">
              <div className="space-y-0.5 pr-4">
                <div className="text-sm font-medium">Auto Accept All</div>
                <div className="text-xs text-muted-foreground">
                  Automatically click "Accept all" when it appears in the chat.
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoActions.autoAcceptAll}
                className={[
                  "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  autoActions.autoAcceptAll ? "bg-primary" : "bg-input"
                ].join(" ")}
                onClick={() => void toggleAutoAction("autoAcceptAll")}
              >
                <span
                  className={[
                    "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform",
                    autoActions.autoAcceptAll ? "translate-x-4" : "translate-x-0"
                  ].join(" ")}
                />
              </button>
            </div>
            {/* Auto Retry */}
            <div className="flex items-center justify-between px-4 py-3">
              <div className="space-y-0.5 pr-4">
                <div className="text-sm font-medium">Auto Retry on Error</div>
                <div className="text-xs text-muted-foreground">
                  Automatically click "Retry" when "Agent terminated due to error" appears.
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoActions.autoRetry}
                className={[
                  "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  autoActions.autoRetry ? "bg-primary" : "bg-input"
                ].join(" ")}
                onClick={() => void toggleAutoAction("autoRetry")}
              >
                <span
                  className={[
                    "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform",
                    autoActions.autoRetry ? "translate-x-4" : "translate-x-0"
                  ].join(" ")}
                />
              </button>
            </div>
            {/* Retry Backoff (sub-option, only visible when autoRetry is on) */}
            {autoActions.autoRetry && (
              <div className="flex items-center justify-between px-4 py-3 pl-8 bg-muted/20">
                <div className="space-y-0.5 pr-4">
                  <div className="text-sm font-medium">Exponential Backoff</div>
                  <div className="text-xs text-muted-foreground">
                    Increase delay between retries (10s → 30s → 60s → 120s).
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoActions.retryBackoff}
                  className={[
                    "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    autoActions.retryBackoff ? "bg-primary" : "bg-input"
                  ].join(" ")}
                  onClick={() => void toggleAutoAction("retryBackoff")}
                >
                  <span
                    className={[
                      "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform",
                      autoActions.retryBackoff ? "translate-x-4" : "translate-x-0"
                    ].join(" ")}
                  />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Notifications */}
        <div className="rounded-lg border border-border bg-card shadow-sm">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-medium">Notifications</h2>
            <p className="text-xs text-muted-foreground">Get notified when AI tasks complete.</p>
          </div>
          <div className="p-4">
            {pushSupported ? (
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">Push Notifications</div>
                  <div className="text-xs text-muted-foreground">
                    {pushEnabled ? "Notifications are enabled" : "Notifications are disabled"}
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={pushEnabled}
                  className={[
                    "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
                    pushEnabled ? "bg-primary" : "bg-input"
                  ].join(" ")}
                  onClick={() => void togglePush()}
                  disabled={pushLoading}
                >
                  <span
                    className={[
                      "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform",
                      pushEnabled ? "translate-x-4" : "translate-x-0"
                    ].join(" ")}
                  />
                </button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Push notifications are not supported in this browser.</p>
            )}
          </div>
        </div>

        {/* System Info */}
        <div className="rounded-lg border border-border bg-card shadow-sm">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-medium">About</h2>
          </div>
          <div className="divide-y divide-border text-sm">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-muted-foreground">Version</span>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">3.0.0</code>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-muted-foreground">Stack</span>
              <span className="text-xs font-medium">Node + React</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
