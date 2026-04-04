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
 *     → Poll trajectory steps via RPC (all step types)
 *     → Stream intermediate tool activity + final response
 */

import { randomBytes } from "node:crypto";

import express from "express";

import { ResponsePhase, type TrajectoryStep } from "@ag/shared";

import { config } from "../config";
import { sendMessageWithFallback } from "../rpc/fallback";
import { rpcForConversation, discovery, rpc } from "../rpc/routing";
import { cascadeStore } from "../store/cascades";

export const openaiRouter: express.Router = express.Router();

// --- Helper: Generate completion IDs ---
function makeCompletionId(): string {
  return `chatcmpl-${randomBytes(12).toString("hex")}`;
}

// --- Helper: Format a step for streaming output ---
const TOOL_STEP_TYPES = new Set([
  "VIEW_FILE", "RUN_COMMAND", "COMMAND_STATUS", "CODE_ACTION",
  "GREP_SEARCH", "FIND", "MCP_TOOL", "TOOL_USE", "TOOL_RESULT",
]);

const STEP_ICONS: Record<string, string> = {
  VIEW_FILE: "📄", RUN_COMMAND: "⚡", COMMAND_STATUS: "📟",
  CODE_ACTION: "✏️", GREP_SEARCH: "🔍", FIND: "🔍",
  MCP_TOOL: "🔧", TOOL_USE: "🔧", TOOL_RESULT: "📋",
};

const STEP_LABELS: Record<string, string> = {
  VIEW_FILE: "View File", RUN_COMMAND: "Run Command",
  COMMAND_STATUS: "Command Status", CODE_ACTION: "Code Edit",
  GREP_SEARCH: "Search", FIND: "Find",
  MCP_TOOL: "MCP Tool", TOOL_USE: "Tool", TOOL_RESULT: "Result",
};

function formatToolStep(step: TrajectoryStep): string {
  const icon = STEP_ICONS[step.type] ?? "🔧";
  const label = STEP_LABELS[step.type] ?? step.type;
  const text = step.content?.text ?? "";
  const status = step.status === "RUNNING" ? " ⟳" : step.status === "DONE" ? " ✓" : "";
  const detail = text ? `: ${text.length > 80 ? text.slice(0, 80) + "…" : text}` : "";
  return `${icon} ${label}${detail}${status}`;
}

// ── CDP phase-based polling (shared by CDP-only mode and RPC-CDP fallback) ──

const isTerminalPhase = (phase: ResponsePhase | undefined): boolean =>
  phase === ResponsePhase.COMPLETED ||
  phase === ResponsePhase.IDLE ||
  phase === ResponsePhase.ERROR ||
  phase === ResponsePhase.QUOTA_ERROR;

interface CdpPollingParams {
  cascadeId: string;
  completionId: string;
  created: number;
  model: string;
}

async function cdpStreamingResponse(
  req: express.Request,
  res: express.Response,
  params: CdpPollingParams,
): Promise<void> {
  const { cascadeId, completionId, created, model } = params;

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
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  sendChunk({ role: "assistant", content: "" });

  let sentLength = 0;
  let stableCount = 0;
  let completed = false;
  const startTime = Date.now();
  const TIMEOUT = 600_000;
  const POLL_INTERVAL = 250;
  let lastHeartbeat = Date.now();

  const cleanup = () => { completed = true; };
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

    const cur = cascadeStore.get(cascadeId);
    const text = cur?.responseText ?? "";
    const phase = cur?.phase;

    if (text.length > sentLength) {
      sendChunk({ content: text.slice(sentLength) });
      sentLength = text.length;
      stableCount = 0;
      lastHeartbeat = Date.now();
    } else {
      stableCount++;
      // Send SSE comment as keepalive every 5s when no content
      if (Date.now() - lastHeartbeat > 5000) {
        if (!res.writableEnded) res.write(`: keepalive\n\n`);
        lastHeartbeat = Date.now();
      }
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
}

async function cdpNonStreamingResponse(
  res: express.Response,
  params: CdpPollingParams,
): Promise<void> {
  const { cascadeId, completionId, created, model } = params;
  const startTime = Date.now();
  const TIMEOUT = 600_000;
  const POLL_INTERVAL = 250;
  let stableCount = 0;
  let lastLen = 0;
  let responseText = "";

  while (true) {
    if (Date.now() - startTime > TIMEOUT) {
      res.status(500).json({
        error: { message: "Agent timeout or error: timeout", type: "server_error", code: "timeout" },
      });
      return;
    }

    const cur = cascadeStore.get(cascadeId);
    const phase = cur?.phase;
    responseText = cur?.responseText ?? "";

    if (responseText.length === lastLen) stableCount++;
    else { stableCount = 0; lastLen = responseText.length; }

    if (isTerminalPhase(phase) && responseText.length > 0 && stableCount >= 4) break;

    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }

  res.json({
    id: completionId,
    object: "chat.completion",
    created,
    model: model || "antigravity",
    choices: [{
      index: 0,
      message: { role: "assistant", content: responseText.trim() },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
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

  const cdpParams: CdpPollingParams = { cascadeId, completionId, created, model };

  // ── CDP-only mode ──
  if (!config.rpc.enabled) {
    if (!config.cdp.enabled) {
      return res.status(503).json({
        error: { message: "Both RPC and CDP are disabled", type: "server_error", code: "no_backend" },
      });
    }

    if (!targetCascade) {
      return res.status(503).json({
        error: { message: "No active Antigravity IDE sessions found", type: "server_error", code: "no_cascades" },
      });
    }

    // Reset previous response buffer
    const c = cascadeStore.get(targetCascade.id);
    if (c) c.responseText = "";

    const injected = await sendMessageWithFallback(targetCascade.id, prompt);
    if (!injected?.ok) {
      return res.status(500).json({
        error: { message: "Failed to send message into Antigravity IDE", type: "server_error", code: "injection_failed" },
      });
    }

    if (stream) {
      await cdpStreamingResponse(req, res, cdpParams);
    } else {
      await cdpNonStreamingResponse(res, cdpParams);
    }
    return;
  }

  // ── RPC mode ──

  const RUNNING_STATUS = "CASCADE_RUN_STATUS_RUNNING";
  const IDLE_STATUS = "CASCADE_RUN_STATUS_IDLE";
  const OVERLAP_STEPS = 20;

  type TrajectoryInfo = { status?: string; numTotalSteps?: number };
  type StepsInfo = { steps?: TrajectoryStep[] };

  /**
   * Discover the real RPC conversation ID by scanning all LS instances.
   */
  async function discoverRealCascadeId(): Promise<string | null> {
    const instances = await discovery.getInstances();
    let bestId: string | null = null;
    let bestPriority = -1;

    await Promise.allSettled(
      instances.map(async (inst) => {
        try {
          const data = await rpc.call<{
            trajectorySummaries?: Record<string, {
              status?: string;
              numTotalSteps?: number;
            }>;
          }>("GetAllCascadeTrajectories", {}, inst);

          const summaries = data.trajectorySummaries;
          if (!summaries) return;

          for (const [realId, summary] of Object.entries(summaries)) {
            const status = summary.status ?? "";
            const steps = summary.numTotalSteps ?? 0;
            const priority = status === RUNNING_STATUS ? 100 : steps;
            if (priority > bestPriority) {
              bestId = realId;
              bestPriority = priority;
            }
          }
        } catch {
          // skip unreachable LS
        }
      }),
    );

    return bestId;
  }

  // --- Send message into Antigravity (RPC → fallback CDP) ---
  const injected = await sendMessageWithFallback(cascadeId, prompt);
  if (!injected?.ok) {
    return res.status(500).json({
      error: { message: "Failed to send message into Antigravity IDE", type: "server_error", code: "injection_failed" },
    });
  }

  // Discover the real conversation UUID for RPC polling.
  await new Promise((r) => setTimeout(r, 500));

  let rpcCascadeId: string | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    rpcCascadeId = await discoverRealCascadeId();
    if (rpcCascadeId) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!rpcCascadeId) {
    // Fallback: use CDP-only polling
    console.warn(`[openai] Could not discover real cascadeId, falling back to CDP polling`);
    if (stream) {
      await cdpStreamingResponse(req, res, cdpParams);
    } else {
      await cdpNonStreamingResponse(res, cdpParams);
    }
    return;
  }

  // --- RPC polling with the REAL conversation UUID ---
  console.log(`[openai] Using real cascadeId for RPC polling: ${rpcCascadeId.slice(0, 12)}…`);

  // Baseline step count BEFORE send
  let baselineStepCount = 0;
  try {
    const baseline = (await rpcForConversation(
      "GetCascadeTrajectory",
      rpcCascadeId,
      { cascadeId: rpcCascadeId },
      undefined,
      true,
    )) as TrajectoryInfo;
    baselineStepCount = baseline.numTotalSteps ?? 0;
  } catch {
    baselineStepCount = 0;
  }

  const baseOffset = baselineStepCount;
  const bufferedSteps: Array<TrajectoryStep | undefined> = [];
  let lastKnownEnd = baselineStepCount;

  // Track which tool steps we've already emitted status lines for
  const emittedToolStepIds = new Set<string>();

  const mergeSteps = (stepOffset: number, steps: TrajectoryStep[]) => {
    const start = stepOffset - baseOffset;
    if (start < 0) return;
    for (let i = 0; i < steps.length; i++) {
      bufferedSteps[start + i] = steps[i];
    }
    lastKnownEnd = Math.max(lastKnownEnd, stepOffset + steps.length);
  };

  /**
   * Build the full content text from all tracked steps.
   * - PLANNER_RESPONSE → prose text (main content)
   * - TOOL_USE / TOOL_RESULT / VIEW_FILE / RUN_COMMAND / etc → inline status lines
   */
  const buildFullContent = (): string => {
    const parts: string[] = [];
    for (const step of bufferedSteps) {
      if (!step) continue;

      if (step.type === "PLANNER_RESPONSE") {
        // Skip toolOnly planner responses (they just list tool names)
        if (step.toolOnly) continue;
        const text = step.content?.text;
        if (typeof text === "string" && text.length > 0) {
          parts.push(text);
        }
      } else if (TOOL_STEP_TYPES.has(step.type)) {
        // Include tool activity as inline status
        const stepKey = step.stepId || `${step.type}-${parts.length}`;
        if (!emittedToolStepIds.has(stepKey)) {
          emittedToolStepIds.add(stepKey);
        }
        // Always include current tool status for streaming
        parts.push(formatToolStep(step));
      } else if (step.type === "ERROR_MESSAGE") {
        const text = step.content?.text;
        if (typeof text === "string" && text.length > 0) {
          parts.push(`❌ Error: ${text}`);
        }
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
      rpcCascadeId!,
      { cascadeId: rpcCascadeId },
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
      rpcCascadeId!,
      { cascadeId: rpcCascadeId, stepOffset: fetchOffset },
      undefined,
      true,
    )) as StepsInfo;

    const steps = data.steps ?? [];
    if (steps.length > 0) {
      mergeSteps(fetchOffset, steps);
    }

    lastKnownEnd = Math.max(lastKnownEnd, numTotalSteps);
    return { status, numTotalSteps, text: buildFullContent() };
  };

  if (stream) {
    // --- Streaming SSE Response ---
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
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    // Send role
    sendChunk({ role: "assistant", content: "" });

    let sentLength = 0;
    let completed = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let stableTextCount = 0;
    let stableStepCount = 0;
    let lastNumTotalSteps = baselineStepCount;
    let hasStarted = false;
    let lastHeartbeat = Date.now();

    const cleanup = () => {
      completed = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
    req.on("close", cleanup);

    const POLL_INTERVAL = 150;
    const TIMEOUT = 600_000;
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

      // Send delta (only new content)
      if (newContent.length > sentLength) {
        const delta = newContent.slice(sentLength);
        sendChunk({ content: delta });
        sentLength = newContent.length;
        stableTextCount = 0;
        lastHeartbeat = Date.now();
      } else {
        stableTextCount++;
        // SSE keepalive comment every 5s to prevent proxy/client timeout
        if (Date.now() - lastHeartbeat > 5000) {
          if (!res.writableEnded) res.write(`: keepalive\n\n`);
          lastHeartbeat = Date.now();
        }
      }

      // Update cascade's responseText for /api/status consumers
      const c = cascadeStore.get(cascadeId);
      if (c) c.responseText = newContent;

      // Step-count stability
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

    // Start polling after short delay
    pollTimer = setTimeout(pollForText, 1000);
  } else {
    // --- Non-Streaming Response ---
    const TIMEOUT = 600_000;

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

          if (responseText.length === lastTextLength) stableTextCount++;
          else { stableTextCount = 0; lastTextLength = responseText.length; }

          if (snap.numTotalSteps === lastNumTotalSteps) stableStepCount++;
          else { stableStepCount = 0; lastNumTotalSteps = snap.numTotalSteps; }
        } catch {
          // transient RPC failure — keep polling
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
        choices: [{
          index: 0,
          message: { role: "assistant", content: responseText },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
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
