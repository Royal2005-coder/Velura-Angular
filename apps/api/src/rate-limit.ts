import type { RateLimiter, RateLimitResult } from "./types.js";

/**
 * Create an in-memory fixed-window limiter for mutation and chat routes.
 */
export function createFixedWindowLimiter({
  limit,
  windowMs
}: {
  limit: number;
  windowMs: number;
}): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return {
    consume(key: string, now = Date.now()): RateLimitResult {
      const bucketKey = String(key || "anonymous");
      const current = buckets.get(bucketKey);
      if (!current || now >= current.resetAt) {
        buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
        cleanup(now);
        return { allowed: true, remaining: Math.max(0, limit - 1), resetAt: now + windowMs };
      }
      current.count += 1;
      return {
        allowed: current.count <= limit,
        remaining: Math.max(0, limit - current.count),
        resetAt: current.resetAt
      };
    }
  };

  function cleanup(now: number): void {
    if (buckets.size < 1000) return;
    for (const [key, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(key);
    }
  }
}
