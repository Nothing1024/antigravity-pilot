import { apiUrl } from "./api";

/**
 * Trigger a new conversation in the specified cascade instance.
 * Sends POST /new-conversation/:id to the backend.
 */
export async function switchConversation(cascadeId: string): Promise<void> {
  try {
    const res = await fetch(
      apiUrl(`/new-conversation/${encodeURIComponent(cascadeId)}`),
      { method: "POST" }
    );
    if (!res.ok) {
      console.warn("[cascadeService] switch-conversation failed", res.status);
    }
  } catch (err) {
    console.warn("[cascadeService] switch-conversation error", err);
  }
}
