import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { env } from "./env.mjs";

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10; // 10 requests per minute

// Initialize Upstash Redis client
const redis = new Redis({
  url: env.UPSTASH_REDIS_REST_URL,
  token: env.UPSTASH_REDIS_REST_TOKEN,
});

export function getClientIP(req: NextRequest): string {
  // Check various headers for real IP (handles proxies/load balancers)
  const forwarded = req.headers.get("x-forwarded-for");
  const realIP = req.headers.get("x-real-ip");

  if (forwarded) return forwarded.split(",")[0].trim();
  if (realIP) return realIP;

  // Fallback: try to get IP from request URL or headers
  const url = new URL(req.url);
  return url.hostname || "unknown";
}

export async function checkRateLimit(ip: string): Promise<{
  allowed: boolean;
  remaining: number;
  resetAt: number;
}> {
  const now = Date.now();
  const key = `rate_limit:${ip}`;

  try {
    // Get current count and reset time
    const stored = await redis.get<{ count: number; resetAt: number }>(key);

    if (!stored || stored.resetAt < now) {
      // New window or expired
      const resetAt = now + RATE_LIMIT_WINDOW_MS;
      await redis.set(key, { count: 1, resetAt }, { px: RATE_LIMIT_WINDOW_MS });
      return {
        allowed: true,
        remaining: RATE_LIMIT_MAX_REQUESTS - 1,
        resetAt,
      };
    }

    if (stored.count >= RATE_LIMIT_MAX_REQUESTS) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: stored.resetAt,
      };
    }

    // Increment count
    const newCount = stored.count + 1;
    await redis.set(
      key,
      { count: newCount, resetAt: stored.resetAt },
      { px: RATE_LIMIT_WINDOW_MS }
    );

    return {
      allowed: true,
      remaining: RATE_LIMIT_MAX_REQUESTS - newCount,
      resetAt: stored.resetAt,
    };
  } catch (error) {
    // If Redis fails, allow the request (fail open)
    console.error("Rate limit check failed:", error);
    return {
      allowed: true,
      remaining: RATE_LIMIT_MAX_REQUESTS,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    };
  }
}

export async function validateRequest(
  req: NextRequest
): Promise<NextResponse | null> {
  const ip = getClientIP(req);

  // Check rate limit
  const rateLimit = await checkRateLimit(ip);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: "Rate limit exceeded",
        retryAfter: Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
      },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": String(RATE_LIMIT_MAX_REQUESTS),
          "X-RateLimit-Remaining": String(rateLimit.remaining),
          "X-RateLimit-Reset": String(rateLimit.resetAt),
          "Retry-After": String(
            Math.ceil((rateLimit.resetAt - Date.now()) / 1000)
          ),
        },
      }
    );
  }

  return null; // Request is valid
}
