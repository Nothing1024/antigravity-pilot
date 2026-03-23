/**
 * Webhook Notification System (F6/Phase 3)
 *
 * Sends HTTP POST notifications to configured webhook URLs when
 * agent events occur (phase changes, completions, errors).
 * Used for OpenClaw integration and external automation.
 *
 * Supports:
 *  - Phase change notifications
 *  - Agent completion notifications with response text
 *  - Error/quota notifications
 *  - Configurable event filtering per webhook
 */

import { ResponsePhase } from "@ag/shared";

import { config } from "../config";
import { eventBus } from "../events/bus";
import { cascadeStore } from "../store/cascades";

// --- Types ---

export interface WebhookConfig {
  /** Target URL */
  url: string;
  /** Secret for HMAC signature (optional) */
  secret?: string;
  /** Name identifier */
  name: string;
  /** Events to subscribe to (empty = all) */
  events?: WebhookEventType[];
  /** Active flag */
  enabled?: boolean;
}

export type WebhookEventType =
  | "phase_change"
  | "agent_completed"
  | "agent_error"
  | "agent_started";

interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  cascade: {
    id: string;
    title: string;
  };
  data: Record<string, unknown>;
}

// --- Webhook Delivery ---

const pendingDeliveries = new Map<string, AbortController>();
const deliveryStats = {
  total: 0,
  success: 0,
  failures: 0,
  lastError: null as string | null,
};

/**
 * Send a webhook payload to a target URL.
 */
async function deliverWebhook(
  webhook: WebhookConfig,
  payload: WebhookPayload
): Promise<void> {
  if (webhook.enabled === false) return;

  // Check event filter
  if (
    webhook.events &&
    webhook.events.length > 0 &&
    !webhook.events.includes(payload.event)
  ) {
    return;
  }

  const body = JSON.stringify(payload);
  deliveryStats.total++;

  const controller = new AbortController();
  const deliveryId = `${webhook.name}:${Date.now()}`;
  pendingDeliveries.set(deliveryId, controller);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "Antigravity-Pilot/4.0",
      "X-Webhook-Event": payload.event,
    };

    // HMAC signature if secret is configured
    if (webhook.secret) {
      const crypto = await import("node:crypto");
      const signature = crypto
        .createHmac("sha256", webhook.secret)
        .update(body)
        .digest("hex");
      headers["X-Webhook-Signature"] = `sha256=${signature}`;
    }

    const response = await fetch(webhook.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    deliveryStats.success++;
  } catch (e: any) {
    if (e.name === "AbortError") return; // cancelled
    deliveryStats.failures++;
    deliveryStats.lastError = `${webhook.name}: ${e.message}`;
    console.warn(
      `⚠️ Webhook delivery failed to "${webhook.name}" (${webhook.url}): ${e.message}`
    );
  } finally {
    pendingDeliveries.delete(deliveryId);
  }
}

/**
 * Broadcast a webhook event to all configured webhooks.
 */
function broadcastWebhook(payload: WebhookPayload): void {
  const webhooks = getWebhooks();
  if (webhooks.length === 0) return;

  // Fire-and-forget all deliveries
  for (const webhook of webhooks) {
    deliverWebhook(webhook, payload).catch(() => {});
  }
}

/**
 * Get configured webhooks from config.
 */
function getWebhooks(): WebhookConfig[] {
  return (config.webhooks as WebhookConfig[] | undefined) || [];
}

// --- EventBus → Webhook Bridge ---

/**
 * Initialize webhook listeners on the EventBus.
 * Call once at server startup.
 */
export function initWebhooks(): void {
  const webhooks = getWebhooks();
  if (webhooks.length === 0) return;

  console.log(`🔔 Webhooks configured: ${webhooks.length} endpoint(s)`);

  eventBus.on("phase_change", (ev) => {
    const c = cascadeStore.get(ev.cascadeId);
    if (!c) return;

    const cascadeInfo = {
      id: ev.cascadeId,
      title: c.metadata.chatTitle,
    };

    // Agent started (transitioned to THINKING or GENERATING)
    if (
      ev.phase === ResponsePhase.THINKING &&
      ev.previousPhase === ResponsePhase.IDLE
    ) {
      broadcastWebhook({
        event: "agent_started",
        timestamp: new Date().toISOString(),
        cascade: cascadeInfo,
        data: {
          phase: ev.phase,
          previousPhase: ev.previousPhase,
        },
      });
    }

    // Agent completed
    if (ev.phase === ResponsePhase.COMPLETED) {
      broadcastWebhook({
        event: "agent_completed",
        timestamp: new Date().toISOString(),
        cascade: cascadeInfo,
        data: {
          phase: ev.phase,
          previousPhase: ev.previousPhase,
          responseText: c.responseText || "",
        },
      });
    }

    // Agent error or quota issue
    if (
      ev.phase === ResponsePhase.ERROR ||
      ev.phase === ResponsePhase.QUOTA_ERROR
    ) {
      broadcastWebhook({
        event: "agent_error",
        timestamp: new Date().toISOString(),
        cascade: cascadeInfo,
        data: {
          phase: ev.phase,
          previousPhase: ev.previousPhase,
          errorType:
            ev.phase === ResponsePhase.QUOTA_ERROR ? "quota" : "error",
        },
      });
    }

    // Generic phase change (always sent)
    broadcastWebhook({
      event: "phase_change",
      timestamp: new Date().toISOString(),
      cascade: cascadeInfo,
      data: {
        phase: ev.phase,
        previousPhase: ev.previousPhase,
      },
    });
  });
}

/**
 * Get webhook delivery statistics.
 */
export function getWebhookStats() {
  return {
    ...deliveryStats,
    pending: pendingDeliveries.size,
    configured: getWebhooks().length,
  };
}

/**
 * Cancel all pending webhook deliveries.
 */
export function cancelAllWebhooks(): void {
  for (const [, controller] of pendingDeliveries) {
    controller.abort();
  }
  pendingDeliveries.clear();
}
