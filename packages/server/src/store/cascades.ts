import type { CascadeId, CascadeMetadata, ComputedVars, QuotaInfo, Snapshot } from "@ag/shared";
import { ConnectionState, ResponsePhase } from "@ag/shared";

import type { CDPConnection } from "../cdp/types";

// 服务器内部的 cascade 条目（对应 server.js 中的 cascade 对象；字段必须完整保留）。
export interface CascadeEntry {
  id: CascadeId;
  cdp: CDPConnection;
  metadata: CascadeMetadata;

  snapshot: Snapshot | null;
  snapshotHash: string | null;
  // updateSnapshots() 会在首次成功捕获后设置；用于“短快照保护”。
  contentLength?: number;

  css: string | null;
  computedVars: ComputedVars;
  cssHash: string | null;
  cssRefreshCounter: number;

  quota: QuotaInfo | null;
  quotaHash: string | null;

  stableCount: number;
  lastFeedbackFingerprint: string | null;

  // F1: Connection Pool fields
  connectionState: ConnectionState;
  lastHealthCheck: number;
  consecutiveFailures: number;
  reconnectAttempts: number;
  connectedAt: number;
  reconnectTarget: {
    webSocketDebuggerUrl: string;
    port: number;
    title: string;
  };

  // F2: Response Monitor fields
  phase: ResponsePhase;
  responseText: string;
  lastPhaseChange: number;
}

class CascadeStore {
  private cascades = new Map<CascadeId, CascadeEntry>();

  get(id: CascadeId): CascadeEntry | undefined {
    return this.cascades.get(id);
  }

  set(id: CascadeId, value: CascadeEntry): void {
    this.cascades.set(id, value);
  }

  delete(id: CascadeId): boolean {
    return this.cascades.delete(id);
  }

  clear(): void {
    this.cascades.clear();
  }

  getAll(): CascadeEntry[] {
    return Array.from(this.cascades.values());
  }

  entries(): IterableIterator<[CascadeId, CascadeEntry]> {
    return this.cascades.entries();
  }
}

// 单例：所有路由/循环必须共享同一份状态。
export const cascadeStore = new CascadeStore();

