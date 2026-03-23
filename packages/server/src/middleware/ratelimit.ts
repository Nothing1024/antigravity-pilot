/**
 * Rate Limiter (F7) — Sliding window rate limiting for API endpoints.
 *
 * Stores request timestamps in memory (no external dependency).
 * Configurable per-endpoint limits via config.api.rateLimit.
 */

import type { RequestHandler } from "express";

import { config } from "../config";

// --- Sliding Window Rate Limiter ---

interface RateLimitBucket {
  timestamps: number[];
}

class SlidingWindowLimiter {
  private buckets = new Map<string, RateLimitBucket>();
  private windowMs: number;
  private maxRequests: number;

  constructor(maxRequests: number, windowMs: number = 60_000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;

    // Periodic cleanup of stale buckets
    setInterval(() => this.cleanup(), windowMs * 2).unref();
  }

  /**
   * Check if a request should be allowed.
   * @returns remaining requests or -1 if rate limited
   */
  check(key: string): { allowed: boolean; remaining: number; resetMs: number } {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    const bucket = this.buckets.get(key) || { timestamps: [] };

    // Remove timestamps outside the window
    bucket.timestamps = bucket.timestamps.filter((ts) => ts > windowStart);

    if (bucket.timestamps.length >= this.maxRequests) {
      // Rate limited
      const oldestInWindow = bucket.timestamps[0];
      const resetMs = oldestInWindow + this.windowMs - now;

      return { allowed: false, remaining: 0, resetMs };
    }

    // Allow and record
    bucket.timestamps.push(now);
    this.buckets.set(key, bucket);

    return {
      allowed: true,
      remaining: this.maxRequests - bucket.timestamps.length,
      resetMs: this.windowMs,
    };
  }

  private cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    for (const [key, bucket] of this.buckets.entries()) {
      bucket.timestamps = bucket.timestamps.filter((ts) => ts > windowStart);
      if (bucket.timestamps.length === 0) {
        this.buckets.delete(key);
      }
    }
  }
}

// --- Rate Limiter Instances ---

let globalLimiter: SlidingWindowLimiter | null = null;
let completionsLimiter: SlidingWindowLimiter | null = null;

function getGlobalLimiter(): SlidingWindowLimiter {
  if (!globalLimiter) {
    globalLimiter = new SlidingWindowLimiter(config.api.rateLimit.global, 60_000);
  }
  return globalLimiter;
}

function getCompletionsLimiter(): SlidingWindowLimiter {
  if (!completionsLimiter) {
    completionsLimiter = new SlidingWindowLimiter(
      config.api.rateLimit.completions,
      60_000
    );
  }
  return completionsLimiter;
}

/**
 * Extract client identifier for rate limiting.
 * Uses API key name if present, falls back to IP.
 */
function getClientKey(req: any): string {
  // Check if authenticated with API key
  const auth = req.headers.authorization || "";
  const bearer = auth.match(/^Bearer\s+(\S+)$/i)?.[1];

  if (bearer) {
    const apiKeys = config.apiKeys || [];
    const key = apiKeys.find((k) => k.key === bearer);
    if (key) return `apikey:${key.name}`;
  }

  // Fall back to IP
  return `ip:${req.ip || req.socket.remoteAddress}`;
}

// --- Middleware Factory ---

/**
 * Create a rate limiting middleware.
 * @param type - 'global' for all endpoints, 'completions' for /v1/chat/completions
 */
export function rateLimitMiddleware(
  type: "global" | "completions" = "global"
): RequestHandler {
  return (req, res, next) => {
    // Exempt health check from rate limiting (load balancers poll this)
    if (req.path === "/api/health") return next();

    const limiter =
      type === "completions" ? getCompletionsLimiter() : getGlobalLimiter();
    const key = getClientKey(req);

    const result = limiter.check(key);

    // Always set rate limit headers (like OpenAI)
    const limit =
      type === "completions"
        ? config.api.rateLimit.completions
        : config.api.rateLimit.global;

    res.setHeader("X-RateLimit-Limit", limit);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, result.remaining));
    res.setHeader(
      "X-RateLimit-Reset",
      new Date(Date.now() + result.resetMs).toISOString()
    );

    if (!result.allowed) {
      const retryAfter = Math.ceil(result.resetMs / 1000);
      res.setHeader("Retry-After", retryAfter);

      // OpenAI-style error for /v1/* paths
      if (req.path.startsWith("/v1/")) {
        return res.status(429).json({
          error: {
            message: `Rate limit exceeded. Try again in ${retryAfter}s.`,
            type: "rate_limit_exceeded",
            code: "rate_limit_exceeded",
          },
        });
      }

      return res
        .status(429)
        .json({ error: `Rate limit exceeded. Retry after ${retryAfter}s.` });
    }

    next();
  };
}

/**
 * Global rate limit middleware - applies to all API routes.
 */
export const globalRateLimit: RequestHandler = rateLimitMiddleware("global");

/**
 * Completions-specific rate limit middleware - stricter limit for /v1/chat/completions.
 */
export const completionsRateLimit: RequestHandler = rateLimitMiddleware("completions");
