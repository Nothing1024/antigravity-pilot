import type { ReactNode } from "react";
import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";

import { marked } from "marked";
import hljs from "highlight.js";
import "highlight.js/styles/github.css";

type FilePayload = {
  type: "file";
  filename: string;
  ext: string;
  path: string;
  content: string;
};

type ArtifactPayload = {
  type: "artifact";
  name: string;
  html: string;
};

export type FilePreviewPayload = FilePayload | ArtifactPayload;

type Props = {
  open: boolean;
  payload: FilePreviewPayload | null;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
};

function Header({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--border-light)] px-4 py-3">
      <div className="min-w-0 flex-1 truncate text-sm font-semibold">
        {children}
      </div>
    </div>
  );
}

function renderCode(content: string): string {
  const escaped = content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const highlighted = hljs.highlightAuto(content).value;
  if (highlighted && highlighted !== escaped) return `<pre><code class="hljs">${highlighted}</code></pre>`;
  return `<pre><code>${escaped}</code></pre>`;
}

export function FilePreview({
  open,
  payload,
  loading = false,
  error = null,
  onClose
}: Props) {
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const title = payload?.type === "artifact" ? payload.name : payload?.filename;

  const html = useMemo(() => {
    if (!payload) return "";
    if (payload.type === "artifact") return payload.html || "";
    if ((payload.ext || "").toLowerCase() === "md") return marked.parse(payload.content || "");
    return renderCode(payload.content || "");
  }, [payload]);

  useEffect(() => {
    if (!open) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = 0;
  }, [open, title]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[var(--z-modal)] bg-[var(--bg-overlay)]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={[
          "fixed left-1/2 top-1/2 h-[min(80dvh,760px)] w-[min(900px,calc(100vw-32px))]",
          "-translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[var(--radius-lg)]",
          "border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-[var(--shadow-lg)]"
        ].join(" ")}
        onClick={(e) => e.stopPropagation()}
      >
        <Header>{title || "File preview"}</Header>

        <div className="flex items-center justify-between gap-3 px-4 py-2 text-xs text-[var(--text-muted)]">
          <div className="min-w-0 flex-1 truncate">
            {payload?.type === "file" ? payload.path : ""}
          </div>
          <button
            type="button"
            className="rounded-md px-2 py-1 active:bg-[var(--bg-secondary)]"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div
          ref={bodyRef}
          className="h-[calc(100%-96px)] overflow-auto px-4 pb-6 text-sm leading-[var(--leading-normal)]"
        >
          {loading ? (
            <div className="py-6 text-[var(--text-muted)]">Loading…</div>
          ) : error ? (
            <div className="py-6 text-[var(--danger)]">{error}</div>
          ) : (
            <div dangerouslySetInnerHTML={{ __html: html }} />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
