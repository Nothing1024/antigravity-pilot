import type { GetStylesResponse, StylesResponse } from "@ag/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiUrl } from "../services/api";
import { wsManager } from "../services/ws";

type Result = {
  styles: StylesResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

function isErrorResponse(x: unknown): x is { error: string } {
  return !!x && typeof x === "object" && typeof (x as any).error === "string";
}

export function useCascadeStyles(cascadeId: string | null): Result {
  const [styles, setStyles] = useState<StylesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reqSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const fetchStyles = useCallback(async (id: string) => {
    const seq = ++reqSeq.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(apiUrl(`/styles/${encodeURIComponent(id)}`), {
        signal: ac.signal
      });
      if (!res.ok) {
        if (seq === reqSeq.current) setError(`HTTP ${res.status}`);
        return;
      }

      const data = (await res.json()) as GetStylesResponse;
      if (seq !== reqSeq.current) return;
      if (isErrorResponse(data)) {
        setError(data.error);
        return;
      }

      setStyles(data);
    } catch (e) {
      if (ac.signal.aborted) return;
      if (seq === reqSeq.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!cascadeId) {
      abortRef.current?.abort();
      setStyles(null);
      setLoading(false);
      setError(null);
      return;
    }

    fetchStyles(cascadeId);
    return () => abortRef.current?.abort();
  }, [cascadeId, fetchStyles]);

  useEffect(() => {
    if (!cascadeId) return;

    const off = wsManager.onMessage((msg) => {
      if (msg.type !== "css_update") return;
      if (msg.cascadeId !== cascadeId) return;
      fetchStyles(cascadeId);
    });
    return () => off();
  }, [cascadeId, fetchStyles]);

  const refresh = useCallback(() => {
    if (!cascadeId) return;
    fetchStyles(cascadeId);
  }, [cascadeId, fetchStyles]);

  return { styles, loading, error, refresh };
}
