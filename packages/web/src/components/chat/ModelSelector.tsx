import { useCallback, useEffect, useRef, useState } from "react";

import { apiUrl } from "../../services/api";

type ModelInfo = {
  name: string;
  selected: boolean;
};

type Props = {
  cascadeId: string | null;
};

export function ModelSelector({ cascadeId }: Props) {
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch current model on mount / cascade change
  useEffect(() => {
    if (!cascadeId) return;
    let cancelled = false;

    const fetchModel = async () => {
      try {
        const res = await fetch(apiUrl(`/api/model/${encodeURIComponent(cascadeId)}`), {
          credentials: "include",
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { model: string | null };
        if (!cancelled && data.model) {
          setCurrentModel(data.model);
        }
      } catch {
        // ignore
      }
    };

    void fetchModel();
    // Re-fetch periodically (model can change from IDE side)
    const interval = setInterval(fetchModel, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [cascadeId]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Fetch model list when dropdown opens
  const openDropdown = useCallback(async () => {
    if (!cascadeId || loading) return;

    if (open) {
      setOpen(false);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(apiUrl(`/api/models/${encodeURIComponent(cascadeId)}`), {
        credentials: "include",
      });
      if (res.ok) {
        const data = (await res.json()) as { current: string | null; models: ModelInfo[] };
        setModels(data.models || []);
        if (data.current) setCurrentModel(data.current);
        setOpen(true);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [cascadeId, loading, open]);

  // Switch model
  const switchModel = useCallback(async (modelName: string) => {
    if (!cascadeId || switching) return;
    setSwitching(true);
    setOpen(false);

    try {
      const res = await fetch(apiUrl(`/api/model/${encodeURIComponent(cascadeId)}`), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ model: modelName }),
      });
      if (res.ok) {
        const data = (await res.json()) as { model?: string };
        setCurrentModel(data.model || modelName);
      }
    } catch {
      // ignore
    } finally {
      setSwitching(false);
    }
  }, [cascadeId, switching]);

  if (!cascadeId) return null;

  // Abbreviate long model names
  const displayModel = currentModel
    ? currentModel.length > 24
      ? currentModel.slice(0, 22) + "…"
      : currentModel
    : null;

  return (
    <div ref={dropdownRef} className="relative">
      <button
        type="button"
        onClick={() => void openDropdown()}
        disabled={!cascadeId || switching}
        className={[
          "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-all duration-200",
          "bg-muted/40 hover:bg-muted/70 border border-border/20 hover:border-border/40",
          displayModel ? "text-muted-foreground" : "text-muted-foreground/40",
          switching ? "opacity-60" : "",
        ].join(" ")}
        title="切换模型"
      >
        {/* Model icon */}
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-60">
          <path d="M12 2 2 7l10 5 10-5-10-5Z" />
          <path d="m2 17 10 5 10-5" />
          <path d="m2 12 10 5 10-5" />
        </svg>

        <span className="truncate max-w-[120px]">
          {loading ? "…" : switching ? "切换中…" : displayModel || "模型"}
        </span>

        {/* Chevron */}
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-40">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && models.length > 0 && (
        <div className="absolute top-full left-0 mt-1 z-50 min-w-[180px] max-w-[280px] rounded-lg border border-border/40 bg-card shadow-xl backdrop-blur-lg animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 duration-150">
          <div className="p-1 max-h-[240px] overflow-y-auto">
            {models.map((m) => (
              <button
                key={m.name}
                type="button"
                className={[
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] transition-colors",
                  m.selected
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-foreground/80 hover:bg-muted/60",
                ].join(" ")}
                onClick={() => void switchModel(m.name)}
              >
                {m.selected && (
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-primary">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
                {!m.selected && <span className="w-3 shrink-0" />}
                <span className="truncate">{m.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
