import { injectMessage, type InjectMessageResult } from "../cdp/inject";
import { config } from "../config";
import { cascadeStore } from "../store/cascades";

import { rpcForConversation } from "./routing";

/**
 * 消息发送：优先走 RPC（结构化 API），失败时降级到 CDP 注入。
 *
 * 注意：该函数以 cascadeId 为唯一入参之一，因此 CDP 降级需要从 cascadeStore
 * 里取出对应的 CDPConnection。
 */
export async function sendMessageWithFallback(
  cascadeId: string,
  content: string,
): Promise<InjectMessageResult> {
  if (config.rpc.enabled) {
    try {
      console.log(`[rpc] SendMessage via RPC: ${cascadeId.slice(0, 8)}…`);

      await rpcForConversation("SendUserCascadeMessage", cascadeId, {
        cascadeId,
        userMessage: {
          parts: [{ text: content }],
        },
      });

      console.log(`[rpc] ✅ SendMessage success via RPC`);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!config.rpc.fallbackToCDP || !config.cdp.enabled) {
        console.log(`[rpc] ❌ SendMessage failed, no fallback available: ${message}`);
        return { ok: false, reason: `RPC send failed: ${message}` };
      }
      console.warn(`[rpc] ⚠️ SendMessage failed, falling back to CDP: ${message}`);
    }
  } else {
    console.log(`[cdp] RPC disabled, using CDP for SendMessage: ${cascadeId.slice(0, 8)}…`);
  }

  if (!config.cdp.enabled) {
    return { ok: false, reason: "CDP disabled" };
  }

  const cascade = cascadeStore.get(cascadeId);
  if (!cascade) return { ok: false, reason: "Cascade not found" };
  return injectMessage(cascade.cdp, content);
}
