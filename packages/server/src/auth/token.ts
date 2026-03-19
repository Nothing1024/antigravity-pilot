import { createHmac } from "node:crypto";

import { config } from "../config";

export function makeToken(): string {
  const payload = Date.now().toString();
  const sig = createHmac("sha256", config.authSecret).update(payload).digest("hex");
  return payload + "." + sig;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = createHmac("sha256", config.authSecret).update(payload).digest("hex");
  return sig === expected;
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(";").forEach((c: string) => {
    const [k, ...v] = c.trim().split("=");
    if (k) cookies[k] = v.join("=");
  });
  return cookies;
}
