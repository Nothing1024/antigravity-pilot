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
 *     → Inject via CDP
 *     → Monitor phase transitions (THINKING → GENERATING → COMPLETED)
 *     → Stream or return final response
 */

import { randomBytes } from "node:crypto";

import express from "express";

import { ResponsePhase } from "@ag/shared";

import { injectMessage } from "../cdp/inject";
import { CHAT_TEXT_SCRIPT } from "../cdp/chat-text-script";
import { eventBus } from "../events/bus";
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
  let targetCascade: any = null;

  if (model && model !== "antigravity") {
    // Support "cascade:<id>" syntax from CLI, or raw cascade ID
    const cascadeId = model.startsWith("cascade:") ? model.slice(8) : model;
    targetCascade = cascadeStore.get(cascadeId);
  }
  if (!targetCascade) {
    const allCascades = cascadeStore.getAll();
    if (allCascades.length > 0) {
      targetCascade = allCascades[0];
    }
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

  // Skip if no CDP connection
  if (!targetCascade.cdp) {
    return res.status(503).json({
      error: {
        message: "Cascade has no active CDP connection",
        type: "server_error",
        code: "no_cdp",
      },
    });
  }

  const completionId = makeCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const cascadeId = targetCascade.id;

  // Inject system message as context prefix if present
  const systemMessages = messages.filter((m: any) => m.role === "system");
  let prompt = lastUserMessage.content;
  if (systemMessages.length > 0) {
    const systemContext = systemMessages.map((m: any) => m.content).join("\n");
    prompt = `[System Context: ${systemContext}]\n\n${prompt}`;
  }

  /**
   * Grab all chat text via CDP using the imported script.
   */
  async function getChatText(cascade: any): Promise<string> {
    const ctx = cascade.cdp.rootContextId;
    if (!ctx) return "";
    try {
      const result: any = await cascade.cdp.call("Runtime.evaluate", {
        expression: CHAT_TEXT_SCRIPT,
        returnByValue: true,
        contextId: ctx,
      });
      return (result.result?.value?.text || "").trim();
    } catch {
      return "";
    }
  }

  // --- Inject message into Antigravity ---
  try {
    const injected = await injectMessage(targetCascade.cdp, prompt);
    if (!injected?.ok) {
      return res.status(500).json({
        error: {
          message: "Failed to inject message into Antigravity IDE",
          type: "server_error",
          code: "injection_failed",
        },
      });
    }
  } catch (e: any) {
    return res.status(500).json({
      error: {
        message: `CDP injection error: ${e.message}`,
        type: "server_error",
        code: "cdp_error",
      },
    });
  }

  // Wait for DOM to settle after injection (user message appears)
  await new Promise((r) => setTimeout(r, 1500));

  // --- Capture baseline AFTER injection ---
  // Now baseline includes history + user's message, diff = agent's response only
  let baselineText = "";
  try {
    baselineText = await getChatText(targetCascade);
  } catch {}

  if (stream) {
    // --- Streaming SSE Response (Baseline-Diff Strategy) ---
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
    let stableCount = 0; // count polls with no new content (to detect completion)
    let firstContentAt = 0; // timestamp when first content was detected

    const cleanup = () => {
      completed = true;
      if (pollTimer) clearTimeout(pollTimer);
      eventBus.off("phase_change", onPhaseChange);
    };
    req.on("close", cleanup);

    const onPhaseChange = (ev: any) => {
      if (ev.cascadeId !== cascadeId || completed) return;
      // Terminal phases will be detected in poll loop
    };
    eventBus.on("phase_change", onPhaseChange);

    // --- Active polling loop: diff against baseline ---
    const POLL_INTERVAL = 500;
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

      // Poll: get full chat text and diff against baseline
      const fullText = await getChatText(targetCascade);

      // New content = everything after the baseline
      let newContent = "";
      if (fullText.length > baselineText.length && fullText.startsWith(baselineText)) {
        // Simple case: new text appended to baseline
        newContent = fullText.slice(baselineText.length).trim();
      } else if (fullText.length > baselineText.length) {
        // Text restructured — try to find the diff
        const overlapLen = Math.min(baselineText.length, 200);
        const tail = baselineText.slice(-overlapLen);
        const idx = fullText.lastIndexOf(tail);
        if (idx >= 0) {
          newContent = fullText.slice(idx + tail.length).trim();
        } else {
          // Can't find overlap — just use the trailing portion
          newContent = fullText.slice(baselineText.length).trim();
        }
      }

      // Send delta (only the part we haven't sent yet)
      if (newContent.length > sentLength) {
        const delta = newContent.slice(sentLength);
        sendChunk({ content: delta });
        sentLength = newContent.length;
        stableCount = 0;
        if (!firstContentAt) firstContentAt = Date.now();
      } else {
        stableCount++;
      }

      // Also update cascade's responseText
      const c = cascadeStore.get(cascadeId);

      // Check if complete: phase is terminal AND text is stable
      if (c) {
        c.responseText = newContent;

        const isTerminal =
          c.phase === ResponsePhase.COMPLETED ||
          c.phase === ResponsePhase.IDLE ||
          c.phase === ResponsePhase.ERROR ||
          c.phase === ResponsePhase.QUOTA_ERROR;

        if (isTerminal && sentLength > 0) {
          const sinceFirstContent = firstContentAt ? Date.now() - firstContentAt : 0;

          // Tiered completion detection:
          // - 6 stable polls (3s) after terminal phase as default
          // - Short responses (<500 chars): 4 polls (2s) is enough
          // - Must have at least 2s since first content appeared
          const stableThreshold = sentLength < 500 ? 4 : 6;
          if (stableCount >= stableThreshold && sinceFirstContent > 2000) {
            completed = true;
            sendChunk({}, "stop");
            res.write("data: [DONE]\n\n");
            cleanup();
            res.end();
            return;
          }
        }
      }

      pollTimer = setTimeout(pollForText, POLL_INTERVAL);
    };

    // Start polling after short delay for agent to begin
    pollTimer = setTimeout(pollForText, 1000);
  } else {
    // --- Non-Streaming Response ---
    const TIMEOUT = 600_000; // 10 minutes

    try {
      // Wait for completion
      await eventBus.waitFor(
        "phase_change",
        (ev) =>
          ev.cascadeId === cascadeId &&
          (ev.phase === ResponsePhase.COMPLETED ||
           ev.phase === ResponsePhase.IDLE ||
           ev.phase === ResponsePhase.ERROR ||
           ev.phase === ResponsePhase.QUOTA_ERROR),
        TIMEOUT
      );

      // Wait a moment for final DOM render, then extract text using the same
      // Markdown conversion as streaming mode for consistent output
      await new Promise((r) => setTimeout(r, 1500));

      let responseText = "";
      try {
        responseText = await getChatText(targetCascade);
        // Extract only the new content (after baseline)
        if (responseText.length > baselineText.length && responseText.startsWith(baselineText)) {
          responseText = responseText.slice(baselineText.length).trim();
        } else if (responseText.length > baselineText.length) {
          responseText = responseText.slice(baselineText.length).trim();
        }
      } catch {}

      // Fallback to phase monitor's text if getChatText failed
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
