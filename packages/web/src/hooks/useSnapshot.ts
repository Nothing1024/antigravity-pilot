import type { GetSnapshotResponse, Snapshot } from "@ag/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiUrl } from "../services/api";
import { wsManager } from "../services/ws";

type Result = {
  snapshot: Snapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

function isErrorResponse(x: unknown): x is { error: string } {
  return !!x && typeof x === "object" && typeof (x as any).error === "string";
}

export function useSnapshot(cascadeId: string | null): Result {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reqSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const fetchSnapshot = useCallback(async (id: string) => {
    const seq = ++reqSeq.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(apiUrl(`/snapshot/${encodeURIComponent(id)}`), {
        signal: ac.signal
      });
      if (!res.ok) {
        if (seq === reqSeq.current) setError(`HTTP ${res.status}`);
        return;
      }

      const data = (await res.json()) as GetSnapshotResponse;
      if (seq !== reqSeq.current) return;
      if (isErrorResponse(data)) {
        setError(data.error);
        return;
      }

      setSnapshot(data as unknown as Snapshot);
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
      setSnapshot(null);
      setLoading(false);
      setError(null);
      return;
    }

    fetchSnapshot(cascadeId);
    return () => abortRef.current?.abort();
  }, [cascadeId, fetchSnapshot]);

  // WS push: receive snapshot data directly 鈥?throttled to avoid excessive re-renders
  useEffect(() => {
    if (!cascadeId) return;

    let pending: Snapshot | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const THROTTLE_MS = 500;

    const flush = () => {
      if (pending) {
        setSnapshot(pending);
        setError(null);
        pending = null;
      }
      timer = null;
    };

    const off = wsManager.onMessage((msg) => {
      if (msg.type !== "snapshot_update") return;
      if (msg.cascadeId !== cascadeId) return;
      pending = msg.snapshot;
      if (!timer) timer = setTimeout(flush, THROTTLE_MS);
    });

    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [cascadeId]);

  const refresh = useCallback(() => {
    if (!cascadeId) return;
    fetchSnapshot(cascadeId);
  }, [cascadeId, fetchSnapshot]);

  return { snapshot, loading, error, refresh };
}
