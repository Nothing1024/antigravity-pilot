import express from "express";
import type { RequestHandler } from "express";

import { config } from "../config";
import { makeToken, parseCookies, verifyToken } from "../auth/token";

export const authRouter: express.Router = express.Router();

authRouter.post("/api/login", (req, res) => {
  if (req.body?.password === config.password) {
    const token = makeToken();
    const xfProto = req.headers["x-forwarded-proto"];
    const isSecure = req.secure || xfProto === "https";
    res.cookie("auth", token, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: "lax",
      secure: isSecure
    });
    res.json({ success: true });
    return;
  }

  res.status(401).json({ error: "Wrong password" });
});

/**
 * Public auth probe (always 200).
 * Avoids noisy 401s during the web app's initial boot.
 */
authRouter.get("/api/auth-status", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const cookieAuthed = verifyToken(cookies.auth);

  const bearer = extractBearerToken(req.headers.authorization);
  const bearerAuthed = bearer ? (verifyApiKey(bearer) || verifyToken(bearer)) : false;

  res.json({ authenticated: cookieAuthed || bearerAuthed });
});

/**
 * Check if a Bearer token matches any configured API key.
 */
function verifyApiKey(bearerToken: string): boolean {
  const apiKeys = (config as any).apiKeys as Array<{ key: string; name: string }> | undefined;
  if (!apiKeys || apiKeys.length === 0) return false;
  return apiKeys.some((k) => k.key === bearerToken);
}

/**
 * Extract Bearer token from Authorization header.
 */
function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

// --- Paths that don't require authentication ---
const PUBLIC_PATHS = [
  "/api/login",
  "/api/health",
  "/v1/models",     // OpenAI-compat model list (read-only, low risk)
];

export const authMiddleware: RequestHandler = (req, res, next) => {
  // Public paths bypass auth
  if (PUBLIC_PATHS.includes(req.path)) return next();

  // 1. Check Cookie auth (existing Web UI flow)
  const cookies = parseCookies(req.headers.cookie);
  if (verifyToken(cookies.auth)) return next();

  // 2. Check Bearer token / API Key (new programmatic access)
  const bearer = extractBearerToken(req.headers.authorization);
  if (bearer) {
    // Check against API keys first
    if (verifyApiKey(bearer)) return next();

    // Also accept the auth secret as bearer token (for HMAC-based tokens)
    if (verifyToken(bearer)) return next();
  }

  // 3. Allow static frontend assets through so the login page can render
  const isStaticAsset =
    req.method === "GET" &&
    (req.path === "/" ||
     req.path.endsWith(".html") ||
     req.path.endsWith(".js") ||
     req.path.endsWith(".css") ||
     req.path.endsWith(".svg") ||
     req.path.endsWith(".png") ||
     req.path.endsWith(".ico") ||
     req.path.endsWith(".woff") ||
     req.path.endsWith(".woff2") ||
     req.path.endsWith(".webmanifest") ||
     req.path.endsWith(".json") ||
     req.path.startsWith("/assets/"));

  if (isStaticAsset) return next();

  // Return OpenAI-style error for /v1/* paths
  if (req.path.startsWith("/v1/")) {
    res.status(401).json({
      error: {
        message: "Invalid API key. Provide a valid key via 'Authorization: Bearer sk-xxx'.",
        type: "invalid_api_key",
        code: "invalid_api_key",
      },
    });
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
};
