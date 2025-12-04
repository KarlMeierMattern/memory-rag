import { NextRequest, NextResponse } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { env } from "./env.mjs";

const redis = new Redis({
  url: env.UPSTASH_REDIS_REST_URL,
  token: env.UPSTASH_REDIS_REST_TOKEN,
});

const ratelimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, "1 h"), // 20 requests per hour
  analytics: true,
  prefix: "ratelimit",
});

export function getClientIP(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const realIP = req.headers.get("x-real-ip");

  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  if (realIP) {
    return realIP;
  }

  // Fallback: try to get IP from request URL or headers
  const url = new URL(req.url);
  return url.hostname || "unknown";
}

export async function validateRequest(
  req: NextRequest
): Promise<NextResponse | null> {
  const clientIP = getClientIP(req);

  try {
    const { success, limit, remaining, reset } = await ratelimiter.limit(
      clientIP
    );

    if (!success) {
      return NextResponse.json(
        {
          error: "Rate limit exceeded",
          limit,
          remaining: 0,
          resetTime: reset,
        },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": limit.toString(),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": reset.toString(),
            "Retry-After": String(Math.ceil((reset - Date.now()) / 1000)),
          },
        }
      );
    }

    // Request is valid - rate limit headers are available but not needed here
    // validateRequest returns null for valid requests
    return null;
  } catch (error) {
    // If Redis fails, allow the request (fail open)
    console.error("Rate limiting error:", error);
    return null;
  }
}
