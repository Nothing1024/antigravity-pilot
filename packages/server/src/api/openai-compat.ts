/**
 * OpenAI-Compatible API (F4)
 *
 * Exposes /v1/chat/completions and /v1/models endpoints that conform to
 * the OpenAI Chat Completions API specification. This allows any OpenAI SDK
 * client, LangChain, Dify, n8n, or OpenClaw to directly interact with
 * Antigravity IDE through Pilot.
 *
 * Flow:
 *   POST /v1/chat/completions
 *     → Extract last user message
 *     → Route to target cascade (auto-select or explicit)
 *     → Send message via RPC (fallback to CDP)
 *     → Poll trajectory steps via RPC (PLANNER_RESPONSE)
 *     → Stream or return final response
 */

import { randomBytes } from "node:crypto";

import express from "express";

import { ResponsePhase, type TrajectoryStep } from "@ag/shared";

import { config } from "../config";
import { sendMessageWithFallback } from "../rpc/fallback";
import { rpcForConversation } from "../rpc/routing";
import { cascadeStore } from "../store/cascades";

export const openaiRouter: express.Router = express.Router();

// --- Helper: Generate completion IDs ---
function makeCompletionId(): string {
  return `chatcmpl-${randomBytes(12).toString("hex")}`;
}

// --- GET /v1/models ---
openaiRouter.get("/v1/models", (_req, res) => {
  const cascades = cascadeStore.getAll();

  const models = cascades.map((c: any) => ({
    id: c.id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "antigravity",
    permission: [],
    root: c.id,
    parent: null,
  }));

  // Always include a default model
  if (!models.find((m: any) => m.id === "antigravity")) {
    models.unshift({
      id: "antigravity",
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "antigravity",
      permission: [],
      root: "antigravity",
      parent: null,
    });
  }

  res.json({
    object: "list",
    data: models,
  });
});

// --- POST /v1/chat/completions ---
openaiRouter.post("/v1/chat/completions", async (req, res) => {
  const { messages, model, stream } = req.body;

  // Validate messages
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: {
        message: "messages is required and must be a non-empty array",
        type: "invalid_request_error",
        code: "invalid_messages",
      },
    });
  }

  // Find the last user message
  const lastUserMessage = [...messages].reverse().find((m: any) => m.role === "user");
  if (!lastUserMessage) {
    return res.status(400).json({
      error: {
        message: "At least one user message is required",
        type: "invalid_request_error",
        code: "no_user_message",
      },
    });
  }

  // Route to cascade
  const requestedCascadeId =
    typeof model === "string" && model !== "antigravity"
      ? // Support "cascade:<id>" syntax from CLI, or raw cascade ID
        model.startsWith("cascade:") ? model.slice(8) : model
      : null;

  const targetCascade = requestedCascadeId
    ? cascadeStore.get(requestedCascadeId)
    : cascadeStore.getAll()[0];

  // Allow RPC-only operation when model explicitly specifies cascadeId,
  // even if there's no active CDP session tracked in cascadeStore.
  const cascadeId = targetCascade?.id ?? requestedCascadeId;

  if (!cascadeId) {
    return res.status(503).json({
      error: {
        message: "No active Antigravity IDE sessions found",
        type: "server_error",
        code: "no_cascades",
      },
    });
  }

  const completionId = makeCompletionId();
  const created = Math.floor(Date.now() / 1000);

  // Inject system message as context prefix if present
  const systemMessages = messages.filter((m: any) => m.role === "system");
  let prompt = lastUserMessage.content;
  if (systemMessages.length > 0) {
    const systemContext = systemMessages.map((m: any) => m.content).join("\n");
    prompt = `[System Context: ${systemContext}]\n\n${prompt}`;
  }

  // ── CDP-only mode ──
  // When rpc.enabled=false we must avoid any RPC calls and rely on the CDP phase monitor.
  if (!config.rpc.enabled) {
    if (!config.cdp.enabled) {
      return res.status(503).json({
        error: {
          message: "Both RPC and CDP are disabled",
          type: "server_error",
          code: "no_backend",
        },
      });
    }

    if (!targetCascade) {
      return res.status(503).json({
        error: {
          message: "No active Antigravity IDE sessions found",
          type: "server_error",
          code: "no_cascades",
        },
      });
    }

    // Reset previous response buffer to avoid leaking history.
    const c = cascadeStore.get(targetCascade.id);
    if (c) c.responseText = "";

    const injected = await sendMessageWithFallback(targetCascade.id, prompt);
    if (!injected?.ok) {
      return res.status(500).json({
        error: {
          message: "Failed to send message into Antigravity IDE",
          type: "server_error",
          code: "injection_failed",
        },
      });
    }

    const completionId = makeCompletionId();
    const created = Math.floor(Date.now() / 1000);

    const isTerminalPhase = (phase: ResponsePhase | undefined): boolean =>
      phase === ResponsePhase.COMPLETED ||
      phase === ResponsePhase.IDLE ||
      phase === ResponsePhase.ERROR ||
      phase === ResponsePhase.QUOTA_ERROR;

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      const sendChunk = (delta: any, finishReason: string | null = null) => {
        if (res.writableEnded) return;
        const chunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: model || "antigravity",
          choices: [
            {
              index: 0,
              delta,
              finish_reason: finishReason,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      };

      sendChunk({ role: "assistant", content: "" });

      let sentLength = 0;
      let stableCount = 0;
      let completed = false;
      const startTime = Date.now();
      const TIMEOUT = 600_000; // 10 minutes
      const POLL_INTERVAL = 250;

      const cleanup = () => {
        completed = true;
      };
      req.on("close", cleanup);

      const poll = async () => {
        if (completed || res.writableEnded) return;

        if (Date.now() - startTime > TIMEOUT) {
          completed = true;
          sendChunk({ content: "\n\n[Timeout exceeded]" }, "error");
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        const cur = cascadeStore.get(targetCascade.id);
        const text = cur?.responseText ?? "";
        const phase = cur?.phase;

        if (text.length > sentLength) {
          sendChunk({ content: text.slice(sentLength) });
          sentLength = text.length;
          stableCount = 0;
        } else {
          stableCount++;
        }

        if (isTerminalPhase(phase) && sentLength > 0 && stableCount >= 4) {
          completed = true;
          sendChunk({}, "stop");
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        setTimeout(poll, POLL_INTERVAL);
      };

      setTimeout(poll, POLL_INTERVAL);
      return;
    }

    // Non-streaming (CDP-only)
    const startTime = Date.now();
    const TIMEOUT = 600_000; // 10 minutes
    const POLL_INTERVAL = 250;
    let stableCount = 0;
    let lastLen = 0;
    let responseText = "";

    while (true) {
      if (Date.now() - startTime > TIMEOUT) {
        return res.status(500).json({
          error: {
            message: "Agent timeout or error: timeout",
            type: "server_error",
            code: "timeout",
          },
        });
      }

      const cur = cascadeStore.get(targetCascade.id);
      const phase = cur?.phase;
      responseText = cur?.responseText ?? "";

      if (responseText.length === lastLen) stableCount++;
      else {
        stableCount = 0;
        lastLen = responseText.length;
      }

      if (isTerminalPhase(phase) && responseText.length > 0 && stableCount >= 4) {
        break;
      }

      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }

    res.json({
      id: completionId,
      object: "chat.completion",
      created,
      model: model || "antigravity",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: responseText.trim(),
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });
    return;
  }

  const RUNNING_STATUS = "CASCADE_RUN_STATUS_RUNNING";
  const IDLE_STATUS = "CASCADE_RUN_STATUS_IDLE";
  const OVERLAP_STEPS = 20;

  type TrajectoryInfo = { status?: string; numTotalSteps?: number };
  type StepsInfo = { steps?: TrajectoryStep[] };

  // Baseline step count BEFORE send — prevents leaking prior conversation text.
  let baselineStepCount = 0;
  try {
    const baseline = (await rpcForConversation(
      "GetCascadeTrajectory",
      cascadeId,
      { cascadeId },
      undefined,
      true,
    )) as TrajectoryInfo;
    baselineStepCount = baseline.numTotalSteps ?? 0;
  } catch {
    baselineStepCount = 0;
  }

  // --- Send message into Antigravity (RPC → fallback CDP) ---
  const injected = await sendMessageWithFallback(cascadeId, prompt);
  if (!injected?.ok) {
    return res.status(500).json({
      error: {
        message: "Failed to send message into Antigravity IDE",
        type: "server_error",
        code: "injection_failed",
      },
    });
  }

  // Give LS a moment to materialize new steps after the send.
  await new Promise((r) => setTimeout(r, 150));

  const baseOffset = baselineStepCount;
  const bufferedSteps: Array<TrajectoryStep | undefined> = [];
  let lastKnownEnd = baselineStepCount;

  const mergeSteps = (stepOffset: number, steps: TrajectoryStep[]) => {
    const start = stepOffset - baseOffset;
    if (start < 0) return;
    for (let i = 0; i < steps.length; i++) {
      bufferedSteps[start + i] = steps[i];
    }
    lastKnownEnd = Math.max(lastKnownEnd, stepOffset + steps.length);
  };

  const buildPlannerText = (): string => {
    const parts: string[] = [];
    for (const step of bufferedSteps) {
      if (!step) continue;
      if (step.type !== "PLANNER_RESPONSE") continue;
      const text = step.content?.text;
      if (typeof text === "string" && text.length > 0) {
        parts.push(text);
      }
    }
    return parts.join("\n\n");
  };

  const fetchSnapshot = async (): Promise<{
    status: string;
    numTotalSteps: number;
    text: string;
  }> => {
    const traj = (await rpcForConversation(
      "GetCascadeTrajectory",
      cascadeId,
      { cascadeId },
      undefined,
      true,
    )) as TrajectoryInfo;

    const status = traj.status ?? "";
    const numTotalSteps = traj.numTotalSteps ?? lastKnownEnd;

    const fetchOffset = Math.max(
      baseOffset,
      Math.max(lastKnownEnd, numTotalSteps) - OVERLAP_STEPS,
    );
    const data = (await rpcForConversation(
      "GetCascadeTrajectorySteps",
      cascadeId,
      { cascadeId, stepOffset: fetchOffset },
      undefined,
      true,
    )) as StepsInfo;

    const steps = data.steps ?? [];
    if (steps.length > 0) {
      mergeSteps(fetchOffset, steps);
    }

    lastKnownEnd = Math.max(lastKnownEnd, numTotalSteps);
    return { status, numTotalSteps, text: buildPlannerText() };
  };

  if (stream) {
    // --- Streaming SSE Response (Trajectory steps diff) ---
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const sendChunk = (delta: any, finishReason: string | null = null) => {
      if (res.writableEnded) return;
      const chunk = {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: model || "antigravity",
        choices: [
          {
            index: 0,
            delta,
            finish_reason: finishReason,
          },
        ],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    // Send role
    sendChunk({ role: "assistant", content: "" });

    let sentLength = 0; // how much of the NEW content we've sent
    let completed = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let stableTextCount = 0; // polls with no new text (content stability)
    let stableStepCount = 0; // polls with no new steps (step-count stability)
    let lastNumTotalSteps = baselineStepCount;
    let hasStarted = false;

    const cleanup = () => {
      completed = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
    req.on("close", cleanup);

    // --- Active polling loop ---
    const POLL_INTERVAL = 150;
    const TIMEOUT = 600_000; // 10 minutes
    const startTime = Date.now();

    const pollForText = async () => {
      if (completed || res.writableEnded) return;

      if (Date.now() - startTime > TIMEOUT) {
        completed = true;
        sendChunk({ content: "\n\n[Timeout exceeded]" }, "error");
        res.write("data: [DONE]\n\n");
        cleanup();
        res.end();
        return;
      }

      let status = "";
      let numTotalSteps = lastNumTotalSteps;
      let newContent = "";
      try {
        const snap = await fetchSnapshot();
        status = snap.status;
        numTotalSteps = snap.numTotalSteps;
        newContent = snap.text;
      } catch {
        // allow transient failures
      }

      if (
        status === RUNNING_STATUS ||
        numTotalSteps > baselineStepCount ||
        newContent.length > 0
      ) {
        hasStarted = true;
      }

      // Send delta (only the part we haven't sent yet)
      if (newContent.length > sentLength) {
        const delta = newContent.slice(sentLength);
        sendChunk({ content: delta });
        sentLength = newContent.length;
        stableTextCount = 0;
      } else {
        stableTextCount++;
      }

      // Also update cascade's responseText (for /api/status consumers)
      const c = cascadeStore.get(cascadeId);

      if (c) {
        c.responseText = newContent;
      }

      // Step-count stability (for completion detection)
      if (numTotalSteps === lastNumTotalSteps) {
        stableStepCount++;
      } else {
        stableStepCount = 0;
        lastNumTotalSteps = numTotalSteps;
      }

      // Completion: IDLE + no new steps + no new text
      if (
        hasStarted &&
        status === IDLE_STATUS &&
        stableStepCount >= 2 &&
        stableTextCount >= 2
      ) {
        completed = true;
        sendChunk({}, "stop");
        res.write("data: [DONE]\n\n");
        cleanup();
        res.end();
        return;
      }

      pollTimer = setTimeout(pollForText, POLL_INTERVAL);
    };

    // Start polling after short delay for agent to begin
    pollTimer = setTimeout(pollForText, 1000);
  } else {
    // --- Non-Streaming Response ---
    const TIMEOUT = 600_000; // 10 minutes

    try {
      const startTime = Date.now();
      const POLL_INTERVAL = 150;
      let stableTextCount = 0;
      let stableStepCount = 0;
      let lastNumTotalSteps = baselineStepCount;
      let lastTextLength = 0;
      let hasStarted = false;

      let responseText = "";
      let status = "";

      while (true) {
        if (Date.now() - startTime > TIMEOUT) {
          throw new Error("timeout");
        }

        try {
          const snap = await fetchSnapshot();
          status = snap.status;
          responseText = snap.text;

          if (
            status === RUNNING_STATUS ||
            snap.numTotalSteps > baselineStepCount ||
            responseText.length > 0
          ) {
            hasStarted = true;
          }

          // text stability
          if (responseText.length === lastTextLength) {
            stableTextCount++;
          } else {
            stableTextCount = 0;
            lastTextLength = responseText.length;
          }

          // step-count stability
          if (snap.numTotalSteps === lastNumTotalSteps) {
            stableStepCount++;
          } else {
            stableStepCount = 0;
            lastNumTotalSteps = snap.numTotalSteps;
          }
        } catch {
          // transient RPC failure — keep polling until timeout
        }

        if (
          hasStarted &&
          status === IDLE_STATUS &&
          stableStepCount >= 2 &&
          stableTextCount >= 2
        ) {
          break;
        }

        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      }

      responseText = responseText.trim();
      if (!responseText) {
        const finalCascade = cascadeStore.get(cascadeId);
        responseText = finalCascade?.responseText || "Agent completed (no text captured)";
      }

      res.json({
        id: completionId,
        object: "chat.completion",
        created,
        model: model || "antigravity",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: responseText,
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      });
    } catch (e: any) {
      res.status(500).json({
        error: {
          message: `Agent timeout or error: ${e.message}`,
          type: "server_error",
          code: "timeout",
        },
      });
    }
  }
});

export default openaiRouter;
