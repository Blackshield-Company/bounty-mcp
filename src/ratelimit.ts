import { SourceError } from "./types.js";

export interface RateLimiterOptions {
  /** Max requests per window. */
  limit: number;
  /** Window length in ms (default 60s). */
  windowMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export class RateLimitError extends SourceError {
  override name = "RateLimitError";
  constructor(public readonly retryAfterMs: number) {
    super(`rate limit: retry in ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s`);
  }
}

/**
 * Sliding-window limiter. It never waits: when the window is full,
 * acquire() throws a RateLimitError saying when to retry.
 */
export class RateLimiter {
  readonly limit: number;
  readonly windowMs: number;
  private readonly now: () => number;
  private stamps: number[] = [];

  constructor(opts: RateLimiterOptions) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  private prune(t: number): void {
    const cutoff = t - this.windowMs;
    while (this.stamps.length > 0 && (this.stamps[0] as number) <= cutoff) this.stamps.shift();
  }

  /** Requests still allowed in the current window. */
  remaining(): number {
    this.prune(this.now());
    return Math.max(0, this.limit - this.stamps.length);
  }

  /** Record a request, or throw RateLimitError if the window is full. */
  acquire(): void {
    const t = this.now();
    this.prune(t);
    if (this.stamps.length >= this.limit) {
      const oldest = this.stamps[0] as number;
      throw new RateLimitError(oldest + this.windowMs - t);
    }
    this.stamps.push(t);
  }
}

/** GitHub search allows 10/min unauthenticated and 30/min with a token; stay under. */
export const GITHUB_LIMIT_UNAUTHENTICATED = 10;
export const GITHUB_LIMIT_AUTHENTICATED = 25;

export function createGithubLimiter(hasToken: boolean, now?: () => number): RateLimiter {
  return new RateLimiter({
    limit: hasToken ? GITHUB_LIMIT_AUTHENTICATED : GITHUB_LIMIT_UNAUTHENTICATED,
    now,
  });
}
