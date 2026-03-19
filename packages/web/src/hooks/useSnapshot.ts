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

  // WS push: receive snapshot data directly — no second HTTP fetch needed
  useEffect(() => {
    if (!cascadeId) return;

    const off = wsManager.onMessage((msg) => {
      if (msg.type !== "snapshot_update") return;
      if (msg.cascadeId !== cascadeId) return;
      // P0 optimization: snapshot data is now included in the WS message
      setSnapshot(msg.snapshot);
      setError(null);
    });
    return () => off();
  }, [cascadeId]);

  const refresh = useCallback(() => {
    if (!cascadeId) return;
    fetchSnapshot(cascadeId);
  }, [cascadeId, fetchSnapshot]);

  return { snapshot, loading, error, refresh };
}
