/**
 * Sliding-window rate limit.
 *
 * Zámerne za rozhraním `RateLimiter`, aby sa in-memory implementácia dala
 * pri viac-inštančnom nasadení nahradiť Redisom bez zmeny volajúceho kódu.
 */

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export interface RateLimiter {
  check(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
}

class MemoryRateLimiter implements RateLimiter {
  private hits = new Map<string, number[]>();
  private lastSweep = 0;

  async check(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    this.sweep(now, windowMs);

    const timestamps = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (timestamps.length >= limit) {
      const retryAfterSeconds = Math.ceil((windowMs - (now - timestamps[0])) / 1000);
      this.hits.set(key, timestamps);
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);
    return { allowed: true, remaining: limit - timestamps.length, retryAfterSeconds: 0 };
  }

  async reset(key: string): Promise<void> {
    this.hits.delete(key);
  }

  private sweep(now: number, windowMs: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, timestamps] of this.hits) {
      const fresh = timestamps.filter((t) => now - t < windowMs);
      if (fresh.length === 0) this.hits.delete(key);
      else this.hits.set(key, fresh);
    }
  }
}

const globalForLimiter = globalThis as typeof globalThis & { __crewRateLimiter?: RateLimiter };
export const rateLimiter: RateLimiter = (globalForLimiter.__crewRateLimiter ??= new MemoryRateLimiter());

export const RATE_LIMITS = {
  login: { limit: 8, windowMs: 10 * 60_000 },
  register: { limit: 5, windowMs: 60 * 60_000 },
  passwordReset: { limit: 5, windowMs: 60 * 60_000 },
  publicForm: { limit: 10, windowMs: 60 * 60_000 },
  checkIn: { limit: 20, windowMs: 5 * 60_000 },
  message: { limit: 60, windowMs: 60_000 },
} as const;

export async function enforceRateLimit(
  scope: keyof typeof RATE_LIMITS,
  identifier: string | null,
): Promise<RateLimitResult> {
  const { limit, windowMs } = RATE_LIMITS[scope];
  return rateLimiter.check(`${scope}:${identifier ?? "anonymous"}`, limit, windowMs);
}
