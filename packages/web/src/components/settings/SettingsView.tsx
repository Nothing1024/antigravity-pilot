import { useCallback, useEffect, useState } from "react";

import { useTheme } from "../../hooks/useTheme";
import { useI18n, ALL_LOCALES, LOCALE_LABELS } from "../../i18n";
import { apiUrl } from "../../services/api";
import { useUIStore } from "../../stores/uiStore";
import { useCapabilitiesStore } from "../../stores/capabilitiesStore";

type SimplifyMode = "off" | "light" | "full";

type Props = {
  visible: boolean;
};

export function SettingsView({ visible }: Props) {
  const t = useI18n();
  const { themeMode, setThemeMode } = useTheme();
  const sendMode = useUIStore((s) => s.sendMode);
  const setSendMode = useUIStore((s) => s.setSendMode);
  const locale = useUIStore((s) => s.locale);
  const setLocale = useUIStore((s) => s.setLocale);
  const autoActions = useUIStore((s) => s.autoActions);
  const setAutoAction = useUIStore((s) => s.setAutoAction);
  const pushAutoActionsToServer = useUIStore((s) => s.pushAutoActionsToServer);
  const capabilities = useCapabilitiesStore((s) => s.capabilities);
  const [pushSupported, setPushSupported] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [simplifyMode, setSimplifyModeState] = useState<SimplifyMode>(
    () => (localStorage.getItem("ag-simplify-mode") as SimplifyMode) || "off"
  );
  const [simplifyLoading, setSimplifyLoading] = useState(false);

  const applySimplify = useCallback(async (mode: SimplifyMode) => {
    setSimplifyLoading(true);
    setSimplifyModeState(mode);
    localStorage.setItem("ag-simplify-mode", mode);
    try {
      if (mode === "off") {
        await fetch(apiUrl("/api/simplify-all"), { method: "DELETE", credentials: "include" });
      } else {
        await fetch(apiUrl("/api/simplify-all"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ mode })
        });
      }
    } catch (err) {
      console.error("Simplify toggle error:", err);
    } finally {
      setSimplifyLoading(false);
    }
  }, []);

  // Push localStorage state to server on mount (recovers server state after restart)
  useEffect(() => {
    pushAutoActionsToServer();
  }, [pushAutoActionsToServer]);

  // Sync simplify mode from server on mount
  // (server is authoritative — it auto-applies to new sessions via discovery)
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(apiUrl("/api/simplify-mode"), { credentials: "include" });
        if (!res.ok) return;
        const { mode } = await res.json() as { mode: SimplifyMode };
        const localMode = (localStorage.getItem("ag-simplify-mode") as SimplifyMode) || "off";

        if (mode !== "off") {
          // Server has active mode → adopt it
          setSimplifyModeState(mode);
          localStorage.setItem("ag-simplify-mode", mode);
        } else if (localMode !== "off") {
          // Server forgot (restarted) but localStorage remembers → push to server
          void applySimplify(localMode);
        }
      } catch {
        // Server unreachable, keep localStorage value
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  const themeOptions: { value: "light" | "dark" | "follow"; labelKey: "settings.theme.light" | "settings.theme.dark" | "settings.theme.system" }[] = [
    { value: "light", labelKey: "settings.theme.light" },
    { value: "dark", labelKey: "settings.theme.dark" },
    { value: "follow", labelKey: "settings.theme.system" },
  ];

  const sendOptions: { value: "enter" | "ctrl+enter"; labelKey: "settings.sendMode.enter" | "settings.sendMode.ctrlEnter"; descKey: "settings.sendMode.enter.desc" | "settings.sendMode.ctrlEnter.desc" }[] = [
    { value: "enter", labelKey: "settings.sendMode.enter", descKey: "settings.sendMode.enter.desc" },
    { value: "ctrl+enter", labelKey: "settings.sendMode.ctrlEnter", descKey: "settings.sendMode.ctrlEnter.desc" },
  ];

  return (
    <div className="flex h-full flex-col overflow-y-auto px-4 py-6 sm:px-6">
      <div className="mx-auto w-full max-w-lg space-y-6">
        {/* Theme */}
        <div className="rounded-lg border border-border bg-card shadow-sm">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-medium">{t("settings.appearance")}</h2>
            <p className="text-xs text-muted-foreground">{t("settings.appearance.desc")}</p>
          </div>
          <div className="flex gap-2 p-4">
            {themeOptions.map((opt) => {
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
                  {t(opt.labelKey)}
                </button>
              );
            })}
          </div>
        </div>

        {/* Language */}
        <div className="rounded-lg border border-border bg-card shadow-sm">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-medium">{t("settings.language")}</h2>
            <p className="text-xs text-muted-foreground">{t("settings.language.desc")}</p>
          </div>
          <div className="flex gap-2 p-4">
            {ALL_LOCALES.map((loc) => {
              const active = locale === loc;
              return (
                <button
                  key={loc}
                  type="button"
                  className={[
                    "flex-1 inline-flex flex-col items-center gap-1 rounded-md border p-3 text-xs font-medium transition-colors",
                    active
                      ? "border-ring bg-accent text-accent-foreground"
                      : "border-transparent hover:bg-accent hover:text-accent-foreground text-muted-foreground"
                  ].join(" ")}
                  onClick={() => setLocale(loc)}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
                  {LOCALE_LABELS[loc]}
                </button>
              );
            })}
          </div>
        </div>

        {/* Send Mode */}
        <div className="rounded-lg border border-border bg-card shadow-sm">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-medium">{t("settings.sendMode")}</h2>
            <p className="text-xs text-muted-foreground">{t("settings.sendMode.desc")}</p>
          </div>
          <div className="flex gap-2 p-4">
            {sendOptions.map((opt) => {
              const active = sendMode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  className={[
                    "flex-1 inline-flex flex-col items-center gap-1 rounded-md border p-3 text-xs font-medium transition-colors",
                    active
                      ? "border-ring bg-accent text-accent-foreground"
                      : "border-transparent hover:bg-accent hover:text-accent-foreground text-muted-foreground"
                  ].join(" ")}
                  onClick={() => setSendMode(opt.value)}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
                  </svg>
                  <span>{t(opt.labelKey)}</span>
                  <span className="text-[10px] font-normal text-muted-foreground">{t(opt.descKey)}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Automation */}
        <div className="rounded-lg border border-border bg-card shadow-sm">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-medium">{t("settings.automation")}</h2>
            <p className="text-xs text-muted-foreground">{t("settings.automation.desc")}</p>
          </div>
          <div className="divide-y divide-border">
            {/* Auto Accept All */}
            <div className="flex items-center justify-between px-4 py-3">
              <div className="space-y-0.5 pr-4">
                <div className="text-sm font-medium">{t("settings.autoAccept")}</div>
                <div className="text-xs text-muted-foreground">{t("settings.autoAccept.desc")}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoActions.autoAcceptAll}
                className={[
                  "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  autoActions.autoAcceptAll ? "bg-primary" : "bg-input"
                ].join(" ")}
                onClick={() => setAutoAction("autoAcceptAll", !autoActions.autoAcceptAll)}
              >
                <span className={["pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform", autoActions.autoAcceptAll ? "translate-x-4" : "translate-x-0"].join(" ")} />
              </button>
            </div>
            {/* Auto Retry */}
            <div className="flex items-center justify-between px-4 py-3">
              <div className="space-y-0.5 pr-4">
                <div className="text-sm font-medium">{t("settings.autoRetry")}</div>
                <div className="text-xs text-muted-foreground">{t("settings.autoRetry.desc")}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoActions.autoRetry}
                className={[
                  "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  autoActions.autoRetry ? "bg-primary" : "bg-input"
                ].join(" ")}
                onClick={() => setAutoAction("autoRetry", !autoActions.autoRetry)}
              >
                <span className={["pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform", autoActions.autoRetry ? "translate-x-4" : "translate-x-0"].join(" ")} />
              </button>
            </div>
            {/* Retry Backoff */}
            {autoActions.autoRetry && (
              <div className="flex items-center justify-between px-4 py-3 pl-8 bg-muted/20">
                <div className="space-y-0.5 pr-4">
                  <div className="text-sm font-medium">{t("settings.backoff")}</div>
                  <div className="text-xs text-muted-foreground">{t("settings.backoff.desc")}</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoActions.retryBackoff}
                  className={[
                    "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    autoActions.retryBackoff ? "bg-primary" : "bg-input"
                  ].join(" ")}
                  onClick={() => setAutoAction("retryBackoff", !autoActions.retryBackoff)}
                >
                  <span className={["pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform", autoActions.retryBackoff ? "translate-x-4" : "translate-x-0"].join(" ")} />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Notifications */}
        <div className="rounded-lg border border-border bg-card shadow-sm">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-medium">{t("settings.notifications")}</h2>
            <p className="text-xs text-muted-foreground">{t("settings.notifications.desc")}</p>
          </div>
          <div className="p-4">
            {pushSupported ? (
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">{t("settings.push")}</div>
                  <div className="text-xs text-muted-foreground">
                    {pushEnabled ? t("settings.push.enabled") : t("settings.push.disabled")}
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
                  <span className={["pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform", pushEnabled ? "translate-x-4" : "translate-x-0"].join(" ")} />
                </button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("settings.push.unsupported")}</p>
            )}
          </div>
        </div>

        {/* IDE GPU Simplification — only shown when CDP is enabled */}
        {capabilities.features.simplify && (
          <div className="rounded-lg border border-border bg-card shadow-sm">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-medium">{t("settings.simplify")}</h2>
              <p className="text-xs text-muted-foreground">{t("settings.simplify.desc")}</p>
            </div>
            <div className="flex gap-2 p-4">
              {([
                { value: "off" as SimplifyMode, labelKey: "settings.simplify.off" as const, descKey: "settings.simplify.off.desc" as const },
                { value: "light" as SimplifyMode, labelKey: "settings.simplify.light" as const, descKey: "settings.simplify.light.desc" as const },
                { value: "full" as SimplifyMode, labelKey: "settings.simplify.full" as const, descKey: "settings.simplify.full.desc" as const },
              ]).map((opt) => {
                const active = simplifyMode === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    disabled={simplifyLoading}
                    className={[
                      "flex-1 inline-flex flex-col items-center gap-1 rounded-md border p-3 text-xs font-medium transition-colors disabled:opacity-50",
                      active
                        ? "border-ring bg-accent text-accent-foreground"
                        : "border-transparent hover:bg-accent hover:text-accent-foreground text-muted-foreground"
                    ].join(" ")}
                    onClick={() => void applySimplify(opt.value)}
                  >
                    {opt.value === "off" && (
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                    )}
                    {opt.value === "light" && (
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
                    )}
                    {opt.value === "full" && (
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                    )}
                    <span>{simplifyLoading && active ? t("settings.simplify.applying") : t(opt.labelKey)}</span>
                    <span className="text-[10px] font-normal text-muted-foreground">{t(opt.descKey)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* System Info */}
        <div className="rounded-lg border border-border bg-card shadow-sm">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-medium">{t("settings.about")}</h2>
          </div>
          <div className="divide-y divide-border text-sm">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-muted-foreground">{t("settings.version")}</span>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">3.0.0</code>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-muted-foreground">{t("settings.stack")}</span>
              <span className="text-xs font-medium">Node + React</span>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-muted-foreground">Mode</span>
              <span className={[
                "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                capabilities.mode === "hybrid"
                  ? "bg-green-500/10 text-green-500 ring-1 ring-inset ring-green-500/20"
                  : capabilities.mode === "rpc-only"
                    ? "bg-blue-500/10 text-blue-500 ring-1 ring-inset ring-blue-500/20"
                    : capabilities.mode === "cdp-only"
                      ? "bg-amber-500/10 text-amber-500 ring-1 ring-inset ring-amber-500/20"
                      : "bg-red-500/10 text-red-500 ring-1 ring-inset ring-red-500/20"
              ].join(" ")}>
                <span className="relative flex h-1.5 w-1.5">
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
                </span>
                {capabilities.mode}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
