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
import { getStepCount, rpcForConversation, discovery, rpc } from "./routing";
import { conversationSignals } from "./signals";
import { cascadeStore } from "../store/cascades";
import { cascadeMap } from "../store/cascadeMap";

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

      /**
       * The incoming cascadeId is a CDP hash (e.g. "-xaveo6").
       * RPC needs the real conversation UUID.
       * Use cascadeMap (pre-built in discovery loop) for the mapping.
       */
      let realCascadeId: string | null = null;

      async function discoverRealId(): Promise<string | null> {
        // Step 1: Check pre-built mapping
        const mapping = cascadeMap.getByCascade(cascadeId);
        if (mapping) return mapping.conversationId;

        // Step 2: Trigger on-demand enrich (e.g. WS connected before discovery loop ran)
        const entry = cascadeStore.get(cascadeId);
        if (entry) {
          const result = await cascadeMap.enrich(cascadeId, entry.metadata.windowTitle);
          if (result) return result.conversationId;
        }

        // Step 3: Truly unknown — will retry in heartbeat
        return null;
      }

      let lastStepCount = 0;
      // 一旦证明某个 offset 之前存在“毒数据”，则不再 overlap 到它之前
      let minFetchOffset = 0;
      let destroyed = false;
      let explored = false;
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
        if (!realCascadeId) return false;
        const fetchOffset = getFetchOffset(lastStepCount, minFetchOffset, withOverlap);

        const data = (await rpcForConversation(
          "GetCascadeTrajectorySteps",
          realCascadeId,
          { cascadeId: realCascadeId, stepOffset: fetchOffset },
          undefined,
          true,
        )) as { steps?: TrajectoryStep[] };

        const rawData = data as Record<string, unknown>;
        const rawSteps = (rawData.steps ?? rawData.trajectorySteps ?? []) as Record<string, unknown>[];
        if (rawSteps.length === 0) return false;

        // Transform protobuf oneof steps into normalized TrajectoryStep with content.text
        const steps: TrajectoryStep[] = rawSteps.map((raw) => {
          const type = (raw.type as string ?? "").replace(/^CORTEX_STEP_TYPE_/, "");
          const status = (raw.status as string ?? "").replace(/^CORTEX_STEP_STATUS_/, "");
          const metadata = raw.metadata as Record<string, unknown> | undefined;

          let text = "";
          let toolOnly = false;
          switch (type) {
            case "PLANNER_RESPONSE": {
              const pr = raw.plannerResponse as Record<string, unknown> | undefined;
              if (pr) {
                // plannerResponse has rawText or toolCalls
                if (typeof pr.rawText === "string") {
                  text = pr.rawText;
                } else if (typeof pr.message === "string") {
                  text = pr.message;
                } else if (Array.isArray(pr.toolCalls) && pr.toolCalls.length > 0) {
                  text = pr.toolCalls
                    .map((tc: Record<string, unknown>) => tc.name || "tool")
                    .join(", ");
                  toolOnly = true;
                }
              }
              break;
            }
            case "USER_INPUT": {
              const ui = raw.userInput as Record<string, unknown> | undefined;
              if (ui) {
                // LS uses userResponse as the main text, with items[0].text as backup
                if (typeof ui.userResponse === "string") {
                  text = ui.userResponse;
                } else if (Array.isArray(ui.items) && ui.items.length > 0) {
                  const first = (ui.items as Record<string, unknown>[])[0];
                  text = (first?.text ?? "") as string;
                } else {
                  text = (ui.text ?? ui.message ?? ui.rawText ?? "") as string;
                }
              }
              break;
            }
            case "ERROR_MESSAGE": {
              const em = raw.errorMessage as Record<string, unknown> | undefined;
              if (em) {
                text = (em.errorMessage ?? em.message ?? em.text ?? "") as string;
              }
              break;
            }
            case "RUN_COMMAND":
            case "COMMAND_STATUS": {
              const rc = (raw.runCommand ?? raw.commandStatus) as Record<string, unknown> | undefined;
              if (rc) {
                text = (rc.commandLine ?? rc.proposedCommandLine ?? rc.command ?? "") as string;
              }
              break;
            }
            case "CODE_ACTION": {
              const ca = raw.codeAction as Record<string, unknown> | undefined;
              if (ca) {
                const file = (ca.filePath ?? ca.targetFile ?? "") as string;
                const desc = (ca.description ?? "") as string;
                text = file ? `${file}${desc ? ` — ${desc}` : ""}` : desc;
              }
              break;
            }
            case "VIEW_FILE": {
              const vf = raw.viewFile as Record<string, unknown> | undefined;
              if (vf) {
                text = (vf.filePath ?? vf.absolutePath ?? "") as string;
              }
              break;
            }
            case "GREP_SEARCH":
            case "FIND": {
              const gs = (raw.grepSearch ?? raw.find) as Record<string, unknown> | undefined;
              if (gs) {
                text = (gs.query ?? gs.pattern ?? "") as string;
              }
              break;
            }
            case "MCP_TOOL": {
              const mt = raw.mcpTool as Record<string, unknown> | undefined;
              if (mt) {
                text = (mt.toolName ?? mt.name ?? "") as string;
              }
              break;
            }
            default: {
              // Try generic content fields
              const content = raw.content as Record<string, unknown> | undefined;
              if (content && typeof content.text === "string") {
                text = content.text;
              }
              break;
            }
          }

          return {
            stepId: (metadata?.executionId as string) ?? `step-${fetchOffset}`,
            type,
            status,
            content: text ? { text } : undefined,
            ...(toolOnly ? { toolOnly: true } : {}),
          };
        });

        const nextEnd = fetchOffset + steps.length;
        const grew = nextEnd > lastStepCount;

        sendJson({ type: "steps", offset: fetchOffset, steps });

        lastStepCount = Math.max(lastStepCount, nextEnd);

        // Content enrichment: GetCascadeTrajectory has full text (response/modifiedResponse)
        // while GetCascadeTrajectorySteps only has skeleton (type/status/toolCalls).
        // Fetch full trajectory once, then periodically refresh to get new step content.
        if (!explored && realCascadeId) {
          explored = true;
          try {
            const traj = (await rpcForConversation(
              "GetCascadeTrajectory",
              realCascadeId,
              { cascadeId: realCascadeId },
              undefined,
              true,
            )) as Record<string, unknown>;

            const trajectory = traj.trajectory as Record<string, unknown> | undefined;
            if (trajectory?.steps && Array.isArray(trajectory.steps)) {
              const fullSteps = trajectory.steps as Record<string, unknown>[];
              console.log(`[ws:${shortId}] enriching ${fullSteps.length} steps with full content`);

              // Build enriched normalized steps from full trajectory
              const enrichedSteps: TrajectoryStep[] = fullSteps.map((raw, idx) => {
                const type = (raw.type as string ?? "").replace(/^CORTEX_STEP_TYPE_/, "");
                const status = (raw.status as string ?? "").replace(/^CORTEX_STEP_STATUS_/, "");
                const metadata = raw.metadata as Record<string, unknown> | undefined;

                let text = "";
                let toolOnly = false;
                switch (type) {
                  case "PLANNER_RESPONSE": {
                    const pr = raw.plannerResponse as Record<string, unknown> | undefined;
                    if (pr) {
                      // Full trajectory has response/modifiedResponse with actual text!
                      if (typeof pr.response === "string" && pr.response) {
                        text = pr.response;
                      } else if (typeof pr.modifiedResponse === "string" && pr.modifiedResponse) {
                        text = pr.modifiedResponse;
                      } else if (Array.isArray(pr.toolCalls) && pr.toolCalls.length > 0) {
                        // No prose text, only tool calls — mark as tool-only
                        text = pr.toolCalls
                          .map((tc: Record<string, unknown>) => tc.name || "tool")
                          .join(", ");
                        toolOnly = true;
                      }
                    }
                    break;
                  }
                  case "USER_INPUT": {
                    const ui = raw.userInput as Record<string, unknown> | undefined;
                    if (ui) {
                      if (typeof ui.userResponse === "string") {
                        text = ui.userResponse;
                      } else if (Array.isArray(ui.items) && ui.items.length > 0) {
                        const first = (ui.items as Record<string, unknown>[])[0];
                        text = (first?.text ?? "") as string;
                      }
                    }
                    break;
                  }
                  case "ERROR_MESSAGE": {
                    const em = raw.errorMessage as Record<string, unknown> | undefined;
                    if (em) {
                      text = (em.errorMessage ?? em.message ?? em.text ?? em.response ?? "") as string;
                    }
                    break;
                  }
                  case "RUN_COMMAND":
                  case "COMMAND_STATUS": {
                    const rc = (raw.runCommand ?? raw.commandStatus) as Record<string, unknown> | undefined;
                    if (rc) {
                      text = (rc.commandLine ?? rc.proposedCommandLine ?? "") as string;
                    }
                    break;
                  }
                  case "CODE_ACTION": {
                    const ca = raw.codeAction as Record<string, unknown> | undefined;
                    if (ca) {
                      const file = (ca.filePath ?? ca.targetFile ?? "") as string;
                      const desc = (ca.description ?? "") as string;
                      text = file ? `${file}${desc ? ` — ${desc}` : ""}` : desc;
                    }
                    break;
                  }
                  case "VIEW_FILE": {
                    const vf = raw.viewFile as Record<string, unknown> | undefined;
                    if (vf) text = (vf.filePath ?? vf.absolutePath ?? "") as string;
                    break;
                  }
                  case "GREP_SEARCH":
                  case "FIND": {
                    const gs = (raw.grepSearch ?? raw.find) as Record<string, unknown> | undefined;
                    if (gs) text = (gs.query ?? gs.pattern ?? "") as string;
                    break;
                  }
                  case "MCP_TOOL": {
                    const mt = raw.mcpTool as Record<string, unknown> | undefined;
                    if (mt) text = (mt.toolName ?? mt.name ?? "") as string;
                    break;
                  }
                  default: break;
                }

                return {
                  stepId: (metadata?.executionId as string) ?? `step-${idx}`,
                  type,
                  status,
                  content: text ? { text } : undefined,
                  ...(toolOnly ? { toolOnly: true } : {}),
                };
              });

              // Push full enriched steps (replaces skeleton)
              sendJson({ type: "steps", offset: 0, steps: enrichedSteps, enriched: true });
            }
          } catch (err) {
            console.log(`[ws:${shortId}] content enrichment failed: ${(err as Error).message?.slice(0, 80)}`);
          }
        }

        return grew;
      };

      const isDefinitelyDone = async (): Promise<boolean> => {
        if (!realCascadeId) return false;
        try {
          const data = (await rpcForConversation(
            "GetCascadeTrajectory",
            realCascadeId,
            { cascadeId: realCascadeId },
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
            if (!realCascadeId) {
              // Try to discover again in case LS became available
              realCascadeId = await discoverRealId();
              if (!realCascadeId) {
                if (!destroyed && pollState === "idle") scheduleHeartbeat();
                return;
              }
              console.log(`[ws:${shortId}] late resolve → ${realCascadeId.slice(0, 12)}…`);
            }
            const data = (await rpcForConversation(
              "GetCascadeTrajectory",
              realCascadeId,
              { cascadeId: realCascadeId },
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
        // Discover real conversation UUID
        realCascadeId = await discoverRealId();
        if (!realCascadeId) {
          console.log(`[ws:${shortId}] no real cascadeId found, staying idle`);
          pushReady(0);
          enterIdle();
          return;
        }
        console.log(`[ws:${shortId}] resolved → ${realCascadeId.slice(0, 12)}…`);

        let status = "";
        try {
          const data = (await rpcForConversation(
            "GetCascadeTrajectory",
            realCascadeId,
            { cascadeId: realCascadeId },
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
        // Client control messages: sync, refresh, switchTo
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "sync" && typeof msg.fromOffset === "number") {
            lastStepCount = msg.fromOffset;
            await fetchAndPush(false);
          } else if (msg.type === "refresh") {
            lastStepCount = 0;
            minFetchOffset = 0;
            explored = false;
            // 刷新强制进入 ACTIVE，确保立即补齐
            enterActive();
          } else if (msg.type === "switchTo" && typeof msg.conversationId === "string") {
            // Switch to a specific conversation UUID
            console.log(`[ws:${shortId}] switchTo → ${msg.conversationId.slice(0, 12)}…`);
            realCascadeId = msg.conversationId;
            lastStepCount = 0;
            minFetchOffset = 0;
            explored = false;
            pushReady(0);
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
