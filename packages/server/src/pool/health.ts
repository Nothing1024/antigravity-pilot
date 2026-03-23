/**
 * Connection Pool (F1) — Health checking, auto-reconnection, and
 * connection state management for CDP connections.
 *
 * States: CONNECTING → CONNECTED ⇄ UNHEALTHY → RECONNECTING → CONNECTED
 *                                                           → DISCONNECTED
 */

import WebSocket from "ws";

import { ConnectionState } from "@ag/shared";

import { connectCDP } from "../cdp/connection";
import { extractMetadata } from "../cdp/metadata";
import { config } from "../config";
import { eventBus } from "../events/bus";
import { cascadeStore } from "../store/cascades";

// --- Configuration Defaults ---

export interface ConnectionPoolConfig {
  healthCheckInterval: number;
  healthCheckTimeout: number;
  reconnectDelay: number;
  reconnectMaxDelay: number;
  reconnectMaxAttempts: number;
  maxConnections: number;
}

const DEFAULT_POOL_CONFIG: ConnectionPoolConfig = {
  healthCheckInterval: 30_000,
  healthCheckTimeout: 5_000,
  reconnectDelay: 1_000,
  reconnectMaxDelay: 60_000,
  reconnectMaxAttempts: 0, // 0 = unlimited
  maxConnections: 8,
};

function getPoolConfig(): ConnectionPoolConfig {
  const userConfig = (config as any).connectionPool || {};
  return {
    ...DEFAULT_POOL_CONFIG,
    ...userConfig,
  };
}

// --- Health Check ---

const HEALTH_CHECK_SCRIPT = `(() => {
  return { ok: true, timestamp: Date.now() };
})()`;

/**
 * Perform health check on a single cascade's CDP connection.
 */
async function healthCheck(cascadeId: string): Promise<boolean> {
  const c = cascadeStore.get(cascadeId);
  if (!c) return false;

  // Check WebSocket state first
  if (c.cdp.ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  const poolConfig = getPoolConfig();

  try {
    // Try a simple Runtime.evaluate with timeout
    const result = await Promise.race([
      c.cdp.call("Runtime.evaluate", {
        expression: HEALTH_CHECK_SCRIPT,
        returnByValue: true,
      }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("health check timeout")),
          poolConfig.healthCheckTimeout
        )
      ),
    ]) as any;

    return result?.result?.value?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Transition a cascade's connection state and emit events.
 */
function transitionState(cascadeId: string, newState: ConnectionState): void {
  const c = cascadeStore.get(cascadeId);
  if (!c) return;

  const oldState = c.connectionState;
  if (oldState === newState) return;

  c.connectionState = newState;

  console.log(
    `🔗 Connection state for "${c.metadata.chatTitle}": ${oldState} → ${newState}`
  );

  eventBus.emit("connection_state", {
    cascadeId,
    state: newState,
    previousState: oldState,
    timestamp: Date.now(),
  });
}

/**
 * Attempt to reconnect a disconnected cascade.
 */
async function attemptReconnect(cascadeId: string): Promise<boolean> {
  const c = cascadeStore.get(cascadeId);
  if (!c || !c.reconnectTarget) return false;

  const poolConfig = getPoolConfig();

  // Check max attempts
  if (
    poolConfig.reconnectMaxAttempts > 0 &&
    c.reconnectAttempts >= poolConfig.reconnectMaxAttempts
  ) {
    console.log(
      `❌ Max reconnect attempts (${poolConfig.reconnectMaxAttempts}) reached for "${c.metadata.chatTitle}"`
    );
    transitionState(cascadeId, ConnectionState.DISCONNECTED);
    return false;
  }

  transitionState(cascadeId, ConnectionState.RECONNECTING);
  c.reconnectAttempts++;

  // Exponential backoff: delay * 2^(attempts-1), capped at maxDelay
  const delay = Math.min(
    poolConfig.reconnectDelay * Math.pow(2, c.reconnectAttempts - 1),
    poolConfig.reconnectMaxDelay
  );

  console.log(
    `🔄 Reconnect attempt #${c.reconnectAttempts} for "${c.metadata.chatTitle}" (delay: ${delay}ms)`
  );

  await new Promise((r) => setTimeout(r, delay));

  try {
    // Close old WebSocket if still lingering
    try {
      c.cdp.ws.close();
    } catch {
      // ignore
    }

    const cdp = await connectCDP(c.reconnectTarget.webSocketDebuggerUrl);
    const meta = await extractMetadata(cdp);

    if (meta) {
      if (meta.contextId) cdp.rootContextId = meta.contextId;

      // Update cascade entry with new connection
      c.cdp = cdp;
      c.connectedAt = Date.now();
      c.consecutiveFailures = 0;
      c.reconnectAttempts = 0;
      c.lastHealthCheck = Date.now();

      transitionState(cascadeId, ConnectionState.CONNECTED);
      console.log(`✅ Reconnected "${c.metadata.chatTitle}"`);
      return true;
    } else {
      cdp.ws.close();
      return false;
    }
  } catch (e: any) {
    console.warn(
      `⚠️ Reconnect failed for "${c.metadata.chatTitle}": ${e.message}`
    );
    return false;
  }
}

/**
 * Run health checks for all connected cascades.
 * Mark unhealthy connections and trigger reconnection.
 */
export async function runHealthChecks(): Promise<void> {
  const cascades = cascadeStore.getAll();

  await Promise.all(
    cascades.map(async (c) => {
      // Skip disconnected or already reconnecting
      if (
        c.connectionState === ConnectionState.DISCONNECTED ||
        c.connectionState === ConnectionState.RECONNECTING
      ) {
        return;
      }

      const healthy = await healthCheck(c.id);
      c.lastHealthCheck = Date.now();

      if (healthy) {
        c.consecutiveFailures = 0;
        if (c.connectionState === ConnectionState.UNHEALTHY) {
          transitionState(c.id, ConnectionState.CONNECTED);
        }
      } else {
        c.consecutiveFailures++;

        if (c.consecutiveFailures >= 2) {
          // 2+ consecutive failures → mark unhealthy and try reconnect
          transitionState(c.id, ConnectionState.UNHEALTHY);

          // Attempt reconnect in background
          attemptReconnect(c.id).catch(() => {});
        }
      }
    })
  );
}

/**
 * Get connection pool statistics for the status API.
 */
export function getPoolStats() {
  const poolConfig = getPoolConfig();
  const cascades = cascadeStore.getAll();

  return {
    active: cascades.filter(
      (c) => c.connectionState === ConnectionState.CONNECTED
    ).length,
    unhealthy: cascades.filter(
      (c) => c.connectionState === ConnectionState.UNHEALTHY
    ).length,
    reconnecting: cascades.filter(
      (c) => c.connectionState === ConnectionState.RECONNECTING
    ).length,
    disconnected: cascades.filter(
      (c) => c.connectionState === ConnectionState.DISCONNECTED
    ).length,
    maxConnections: poolConfig.maxConnections,
  };
}
