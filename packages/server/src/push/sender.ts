import { existsSync, readFileSync, writeFileSync } from "node:fs";

import webpush, { type PushSubscription } from "web-push";

import { config } from "../config";

let pushSubscriptions: PushSubscription[] = [];

export function loadSubscriptions(): PushSubscription[] {
  if (!existsSync(config.pushSubsPath)) {
    pushSubscriptions = [];
    return pushSubscriptions;
  }

  try {
    const raw = readFileSync(config.pushSubsPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    pushSubscriptions = Array.isArray(parsed) ? (parsed as PushSubscription[]) : [];
  } catch {
    pushSubscriptions = [];
  }

  return pushSubscriptions;
}

// Keep v2 behavior: load persisted subscriptions at startup.
loadSubscriptions();

export function saveSubscriptions(): void {
  try {
    writeFileSync(config.pushSubsPath, JSON.stringify(pushSubscriptions));
  } catch {
    // Best-effort only.
  }
}

export function addSubscription(sub: PushSubscription): void {
  if (!sub?.endpoint) return;
  if (!pushSubscriptions.find((s) => s.endpoint === sub.endpoint)) {
    pushSubscriptions.push(sub);
    saveSubscriptions();
    console.log(
      `🔔 Push subscription added (total: ${pushSubscriptions.length})`
    );
  }
}

export function removeSubscription(endpoint: string): void {
  pushSubscriptions = pushSubscriptions.filter((s) => s.endpoint !== endpoint);
  saveSubscriptions();
  console.log(
    `🔕 Push subscription removed (total: ${pushSubscriptions.length})`
  );
}

export async function sendPushNotification(
  title: string,
  cascadeId?: string
): Promise<void> {
  if (pushSubscriptions.length === 0) return;

  const payload = JSON.stringify({
    title: `⚡ SIGNAL :: ${title}`,
    body: "「Neural link complete」— AI transmission received",
    cascadeId: cascadeId || null
  });

  console.log(
    `📤 Sending push to ${pushSubscriptions.length} subscriber(s) for "${title}"`
  );

  const results = await Promise.allSettled(
    pushSubscriptions.map((sub) => webpush.sendNotification(sub, payload))
  );

  const failed: string[] = [];
  results.forEach((r, i) => {
    const endpoint = pushSubscriptions[i]?.endpoint || "unknown";
    const shortEndpoint = endpoint.substring(0, 60) + "...";

    if (r.status === "fulfilled") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const statusCode = (r.value as any)?.statusCode || "OK";
      console.log(`  ✅ [${i}] ${shortEndpoint} → HTTP ${statusCode}`);
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reason: any = r.reason;
    const code = reason?.statusCode || "N/A";
    const body = reason?.body || reason?.message || "unknown error";
    console.error(`  ❌ [${i}] ${shortEndpoint} → HTTP ${code}: ${body}`);
    if (code === 410 || code === 404) failed.push(endpoint);
  });

  if (failed.length) {
    pushSubscriptions = pushSubscriptions.filter((s) => !failed.includes(s.endpoint));
    saveSubscriptions();
    console.log(`🧹 Cleaned up ${failed.length} expired push subscription(s)`);
  }
}
