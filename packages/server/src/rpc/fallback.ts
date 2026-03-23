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
  if (config.rpc.preferRpcForMessages) {
    try {
      console.log(`[rpc] Using RPC for message: ${cascadeId}`);

      await rpcForConversation("SendUserCascadeMessage", cascadeId, {
        cascadeId,
        userMessage: {
          parts: [{ text: content }],
        },
      });

      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[rpc] Fallback to CDP for message: ${cascadeId} (${message})`);
    }
  } else {
    console.log(`[rpc] RPC disabled for messages; using CDP: ${cascadeId}`);
  }

  const cascade = cascadeStore.get(cascadeId);
  if (!cascade) return { ok: false, reason: "Cascade not found" };
  return injectMessage(cascade.cdp, content);
}
