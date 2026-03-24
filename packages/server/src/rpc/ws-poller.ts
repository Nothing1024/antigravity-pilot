/**
 * WebSocket delta polling — 用于把 RPC TrajectoryStep[] 近实时推送给前端。
 *
 * 两个状态：
 * - IDLE：低频心跳（5s）检查是否 RUNNING / 是否有新步骤（外部触发）
 * - ACTIVE：高频轮询（50ms），并带 20 步重叠窗口用于捕获“原地更新”
 *
 * 设计来源：porta 的 ws.ts（delta polling 状态机）。
 */

import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import type { TrajectoryStep } from "@ag/shared";
import { WebSocket, WebSocketServer } from "ws";

import { config } from "../config";
import { getStepCount, rpcForConversation } from "./routing";
import { conversationSignals } from "./signals";

type PollState = "idle" | "active";

/** ACTIVE 模式重叠窗口（步数）。 */
const ACTIVE_OVERLAP = 20;

/** 连续空轮询次数阈值（用于判定是否可回到 IDLE）。 */
const EMPTY_THRESHOLD = 3;
/** ACTIVE 模式最短保护期（ms），防止过早去激活。 */
const MIN_ACTIVE_MS = 5000;

const TERMINAL_STATUSES = new Set([
  "CASCADE_RUN_STATUS_IDLE",
  "CASCADE_RUN_STATUS_ERROR",
  "CASCADE_RUN_STATUS_UNLOADED",
]);

function unrefTimer(
  timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>,
): void {
  timer.unref?.();
}

function getFetchOffset(
  lastStepCount: number,
  minFetchOffset: number,
  withOverlap: boolean,
): number {
  if (!withOverlap || lastStepCount <= 0) {
    return Math.max(lastStepCount, minFetchOffset);
  }
  // ⚠️ 不能小于 minFetchOffset（损坏步骤跳过点）
  return Math.max(minFetchOffset, lastStepCount - ACTIVE_OVERLAP);
}

function shouldActivateIdlePolling(
  lastStepCount: number,
  status?: string,
  totalStepCount?: number,
): boolean {
  return (
    status === "CASCADE_RUN_STATUS_RUNNING" ||
    (totalStepCount ?? 0) > lastStepCount
  );
}

function parseCascadeId(reqUrl: string | undefined, port: number): string | null {
  const url = new URL(reqUrl ?? "", `http://127.0.0.1:${port}`);
  const match = url.pathname.match(/^\/api\/conversations\/([^/]+)\/ws$/);
  return match ? match[1] : null;
}

/**
 * 在 HTTP server 上注册 upgrade 处理，支持：
 * `ws://host:port/api/conversations/:cascadeId/ws`
 */
export function setupConversationWebSocket(
  server: HttpServer,
  port: number,
): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const cascadeId = parseCascadeId(req.url, port);
    if (!cascadeId) {
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, cascadeId);
    });
  });

  wss.on(
    "connection",
    (ws: WebSocket, _req: IncomingMessage, cascadeId: string) => {
      const shortId = cascadeId.slice(0, 8);
      console.log(`[ws:${shortId}] connected`);

      if (!config.rpc.enabled) {
        ws.close(1008, "RPC disabled");
        return;
      }

      let lastStepCount = 0;
      // 一旦证明某个 offset 之前存在“毒数据”，则不再 overlap 到它之前
      let minFetchOffset = 0;
      let destroyed = false;
      let pollState: PollState = "idle";
      let pendingTimer: ReturnType<typeof setTimeout> | null = null;
      let emptyCount = 0;
      let minActiveUntil = 0;

      // ── Helpers ──

      const cancelTimer = () => {
        if (pendingTimer !== null) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
      };

      const sendJson = (msg: unknown) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      };

      const pushReady = (stepCount: number) => {
        sendJson({ type: "ready", stepCount });
      };

      const pushStatus = (running: boolean) => {
        sendJson({ type: "status", running });
      };

      // ── State transitions ──

      const enterActive = (guard = true) => {
        if (destroyed) return;
        // 5s 保护期：避免“收到激活→LS 仍暂时 IDLE”时过早退回 IDLE
        if (guard) {
          minActiveUntil = Date.now() + MIN_ACTIVE_MS;
        } else if (pollState !== "active") {
          minActiveUntil = 0;
        }

        if (pollState === "active") return;
        pollState = "active";
        emptyCount = 0;
        console.log(`[ws:${shortId}] → ACTIVE`);
        pushStatus(true);
        cancelTimer();
        scheduleNext(0);
      };

      const enterIdle = () => {
        if (destroyed) return;
        const wasActive = pollState === "active";
        pollState = "idle";
        emptyCount = 0;
        minActiveUntil = 0;
        cancelTimer();
        if (wasActive) {
          console.log(`[ws:${shortId}] → IDLE`);
          pushStatus(false);
        }
        scheduleHeartbeat();
      };

      // ── Core: fetch & push ──

      const fetchAndPush = async (withOverlap = false): Promise<boolean> => {
        if (destroyed) return false;
        const fetchOffset = getFetchOffset(lastStepCount, minFetchOffset, withOverlap);

        const data = (await rpcForConversation(
          "GetCascadeTrajectorySteps",
          cascadeId,
          { cascadeId, stepOffset: fetchOffset },
          undefined,
          true,
        )) as { steps?: TrajectoryStep[] };

        const steps = data.steps ?? [];
        if (steps.length === 0) return false;

        const nextEnd = fetchOffset + steps.length;
        const grew = nextEnd > lastStepCount;

        sendJson({ type: "steps", offset: fetchOffset, steps });

        lastStepCount = Math.max(lastStepCount, nextEnd);
        return grew;
      };

      const isDefinitelyDone = async (): Promise<boolean> => {
        try {
          const data = (await rpcForConversation(
            "GetCascadeTrajectory",
            cascadeId,
            { cascadeId },
            undefined,
            true,
          )) as { status?: string };
          return TERMINAL_STATUSES.has(data.status ?? "");
        } catch {
          return false;
        }
      };

      // ── Polling loop ──

      const scheduleNext = (delay: number) => {
        if (destroyed) return;

        pendingTimer = setTimeout(async () => {
          pendingTimer = null;
          if (destroyed || pollState !== "active") return;

          let grew = false;
          try {
            // ACTIVE 模式必须 overlap（抓取尾部 20 步）捕获“原地更新”
            grew = await fetchAndPush(true);
          } catch {
            // 轮询期允许失败：下一个 tick 会重试；minFetchOffset 相关恢复逻辑在后续任务中补齐
          }

          emptyCount = grew ? 0 : emptyCount + 1;

          if (emptyCount >= EMPTY_THRESHOLD) {
            if (Date.now() < minActiveUntil) {
              emptyCount = 0;
            } else if (await isDefinitelyDone()) {
              enterIdle();
              return;
            } else {
              emptyCount = 0;
            }
          }

          if (!destroyed && pollState === "active") {
            scheduleNext(config.rpc.activePollInterval);
          }
        }, delay);

        unrefTimer(pendingTimer);
      };

      const scheduleHeartbeat = () => {
        if (destroyed || pollState !== "idle" || pendingTimer !== null) return;

        pendingTimer = setTimeout(async () => {
          pendingTimer = null;
          if (destroyed || pollState !== "idle") return;

          try {
            const data = (await rpcForConversation(
              "GetCascadeTrajectory",
              cascadeId,
              { cascadeId },
              undefined,
              true,
            )) as { status?: string; numTotalSteps?: number };

            if (
              shouldActivateIdlePolling(
                lastStepCount,
                data.status,
                data.numTotalSteps,
              )
            ) {
              enterActive(false);
              return;
            }
          } catch {
            // LS unreachable — stay idle and retry later
          }

          if (!destroyed && pollState === "idle") {
            scheduleHeartbeat();
          }
        }, config.rpc.idlePollInterval);

        unrefTimer(pendingTimer);
      };

      // ── Cross-module activation (REST → WS) ──

      const onActivate = (id: string) => {
        if (destroyed || id !== cascadeId) return;
        enterActive();
      };
      conversationSignals.on("activate", onActivate);

      // ── Connection lifecycle ──

      const onConnect = async () => {
        let status = "";
        try {
          const data = (await rpcForConversation(
            "GetCascadeTrajectory",
            cascadeId,
            { cascadeId },
            undefined,
            true,
          )) as { numTotalSteps?: number; status?: string };

          lastStepCount = data.numTotalSteps ?? 0;
          status = data.status ?? "";
          console.log(`[ws:${shortId}] ready stepCount=${lastStepCount} status=${status}`);
          pushReady(lastStepCount);
        } catch {
          pushReady(0);
        }

        if (status === "CASCADE_RUN_STATUS_RUNNING") enterActive();
        else enterIdle();
      };

      ws.on("message", async (raw) => {
        // 预留：sync/refresh 等客户端控制消息
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "sync" && typeof msg.fromOffset === "number") {
            lastStepCount = msg.fromOffset;
            await fetchAndPush(false);
          } else if (msg.type === "refresh") {
            lastStepCount = 0;
            minFetchOffset = 0;
            // 刷新强制进入 ACTIVE，确保立即补齐
            enterActive();
          }
        } catch {}
      });

      const cleanup = () => {
        destroyed = true;
        cancelTimer();
        conversationSignals.off("activate", onActivate);
      };

      ws.on("close", () => {
        console.log(`[ws:${shortId}] closed`);
        cleanup();
      });
      ws.on("error", cleanup);

      // Initial bootstrap: stepCount + state
      onConnect();

      // Ensure stepCount starts reasonable even if trajectory endpoint fails.
      void getStepCount(cascadeId, undefined, true).catch(() => {});
    },
  );
}
