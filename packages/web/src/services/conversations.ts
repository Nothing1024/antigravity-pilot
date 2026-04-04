import { apiUrl } from "./api";

export async function createConversationRpc(
  workspaceFolderAbsoluteUri?: string,
): Promise<string> {
  const body =
    typeof workspaceFolderAbsoluteUri === "string" &&
    workspaceFolderAbsoluteUri.length > 0
      ? { workspaceFolderAbsoluteUri }
      : {};

  const res = await fetch(apiUrl("/api/conversations"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const data = (await res.json()) as { cascadeId?: string };
  if (!data.cascadeId) {
    throw new Error("Missing cascadeId");
  }

  return data.cascadeId;
}
