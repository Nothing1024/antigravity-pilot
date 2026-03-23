import type { LSInstance } from "./discovery";

export type TransportProtocol = "https" | "http";

type TransportTarget = Pick<LSInstance, "httpsPort" | "csrfToken">;

const transportHints = new Map<string, TransportProtocol>();

function transportKey(target: TransportTarget): string {
  return `${target.httpsPort}:${target.csrfToken}`;
}

export function getPreferredTransport(
  target: TransportTarget,
): TransportProtocol | undefined {
  return transportHints.get(transportKey(target));
}

export function getTransportOrder(
  target: TransportTarget,
): [TransportProtocol, TransportProtocol] {
  const preferred = getPreferredTransport(target);
  if (preferred === "http") return ["http", "https"];
  return ["https", "http"];
}

export function rememberSuccessfulTransport(
  target: TransportTarget,
  protocol: TransportProtocol,
): void {
  transportHints.set(transportKey(target), protocol);
}

export function forgetTransportHint(target: TransportTarget): void {
  transportHints.delete(transportKey(target));
}

export function clearTransportHints(): void {
  transportHints.clear();
}
