import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { apiUrl } from "../../services/api";

type BrowseItem = { name: string; path: string };

type BrowseResponse =
  | {
      currentPath: string;
      parentPath: string | null;
      items: BrowseItem[];
    }
  | { error: string };

type WorkspaceRootResponse = { root: string } | { error: string };

type Props = {
  open: boolean;
  onClose: () => void;
};

async function getJson<T>(pathname: string): Promise<T> {
  const res = await fetch(apiUrl(pathname));
  const data = (await res.json()) as T;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return data;
}

async function postJson<T>(pathname: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(pathname), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = (await res.json()) as T;
  if (!res.ok) {
    const msg = data && typeof data === "object" && "error" in data ? String((data as any).error) : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function crumbs(p: string): Array<{ name: string; path: string }> {
  const sep = p.includes("\\") ? "\\" : "/";
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const out: Array<{ name: string; path: string }> = [];
  let cur = p.startsWith("/") ? "/" : "";
  for (const part of parts) {
    if (!cur) cur = part;
    else if (cur === "/") cur = `/${part}`;
    else if (cur.endsWith(":")) cur = `${cur}${sep}${part}`;
    else cur = `${cur}${sep}${part}`;
    out.push({ name: part, path: cur });
  }
  return out;
}

export function ProjectBrowser({ open, onClose }: Props) {
  const [path, setPath] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [items, setItems] = useState<BrowseItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const breadcrumb = useMemo(() => (path ? crumbs(path) : []), [path]);

  const load = useCallback(async (nextPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<BrowseResponse>(`/api/browse?path=${encodeURIComponent(nextPath)}`);
      if ("error" in data) throw new Error(data.error);
      setPath(data.currentPath);
      setParent(data.parentPath);
      setItems(data.items || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;

    setPath(null);
    setParent(null);
    setItems([]);
    setError(null);

    (async () => {
      try {
        const r = await getJson<WorkspaceRootResponse>("/api/workspace-root");
        const root = "root" in r ? r.root : null;
        await load(root || "/");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [open, load]);

  const openProject = useCallback(async () => {
    if (!path) return;
    try {
      await postJson("/api/open-project", { folder: path });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [onClose, path]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[var(--z-modal)] bg-black/40 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={[
          "fixed left-1/2 top-1/2 h-[min(80dvh,720px)] w-[min(720px,calc(100vw-32px))]",
          "-translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl",
          "border border-border/40 bg-background text-foreground shadow-2xl",
          "flex flex-col"
        ].join(" ")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border/20 px-4 py-3">
          <div className="min-w-0 flex-1 truncate text-sm font-semibold">Open Project</div>
          <button
            type="button"
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted/50 transition-colors"
            onClick={onClose}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
            </svg>
          </button>
        </div>

        <div className="border-b border-border/20 px-4 py-2 text-xs text-muted-foreground">
          {breadcrumb.length ? (
            <div className="flex flex-wrap gap-x-1 gap-y-1">
              <button
                type="button"
                className="rounded px-1 hover:bg-muted/50 transition-colors"
                onClick={() => load("/")}
              >
                /
              </button>
              {breadcrumb.map((c) => (
                <button
                  key={c.path}
                  type="button"
                  className="rounded px-1 hover:bg-muted/50 transition-colors"
                  onClick={() => load(c.path)}
                >
                  {c.name}
                </button>
              ))}
            </div>
          ) : (
            <div>Loading…</div>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-auto px-2 py-2">
          {loading ? (
            <div className="px-2 py-4 text-sm text-muted-foreground">Loading…</div>
          ) : error ? (
            <div className="px-2 py-4 text-sm text-destructive">{error}</div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {parent ? (
                <button
                  type="button"
                  className="rounded-md px-3 py-1.5 text-left text-sm hover:bg-muted/50 transition-colors"
                  onClick={() => load(parent)}
                >
                  ..
                </button>
              ) : null}
              {items.map((it) => (
                <button
                  key={it.path}
                  type="button"
                  className="rounded-md px-3 py-1.5 text-left text-sm hover:bg-muted/50 transition-colors"
                  onClick={() => load(it.path)}
                >
                  {it.name}
                </button>
              ))}
              {!parent && items.length === 0 ? (
                <div className="px-2 py-4 text-sm text-muted-foreground">No folders</div>
              ) : null}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/20 px-4 py-3">
          <button
            type="button"
            className="rounded-md border border-border/40 px-3 py-1.5 text-sm hover:bg-muted/50 transition-colors"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            onClick={() => void openProject()}
            disabled={!path || loading}
          >
            Open
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
