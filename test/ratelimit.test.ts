import { describe, expect, it } from "vitest";
import { createGithubLimiter, RateLimiter, RateLimitError } from "../src/ratelimit.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("RateLimiter", () => {
  it("allows up to the limit within the window", () => {
    const c = clock();
    const rl = new RateLimiter({ limit: 3, windowMs: 60_000, now: c.now });
    rl.acquire();
    rl.acquire();
    expect(rl.remaining()).toBe(1);
    rl.acquire();
    expect(rl.remaining()).toBe(0);
    expect(() => rl.acquire()).toThrow(RateLimitError);
  });

  it("reports when the oldest request leaves the window", () => {
    const c = clock();
    const rl = new RateLimiter({ limit: 2, windowMs: 60_000, now: c.now });
    rl.acquire();
    c.advance(10_000);
    rl.acquire();
    c.advance(5_500);
    expect(() => rl.acquire()).toThrow("rate limit: retry in 45s");
    try {
      rl.acquire();
    } catch (e) {
      expect((e as RateLimitError).retryAfterMs).toBe(44_500);
    }
  });

  it("slides: frees slots as old requests expire", () => {
    const c = clock();
    const rl = new RateLimiter({ limit: 2, windowMs: 1_000, now: c.now });
    rl.acquire();
    c.advance(600);
    rl.acquire();
    c.advance(400);
    rl.acquire(); // the first one has expired
    expect(() => rl.acquire()).toThrow("rate limit: retry in 1s");
    c.advance(600);
    expect(rl.remaining()).toBe(1);
  });

  it("does not count rejected calls", () => {
    const c = clock();
    const rl = new RateLimiter({ limit: 1, windowMs: 1_000, now: c.now });
    rl.acquire();
    expect(() => rl.acquire()).toThrow();
    expect(() => rl.acquire()).toThrow();
    c.advance(1_000);
    expect(() => rl.acquire()).not.toThrow();
  });

  it("uses GitHub-friendly defaults", () => {
    expect(createGithubLimiter(false).limit).toBe(10);
    expect(createGithubLimiter(true).limit).toBe(25);
    expect(createGithubLimiter(true).windowMs).toBe(60_000);
  });
});
