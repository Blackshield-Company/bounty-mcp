import { describe, expect, it } from "vitest";
import {
  BOUNTY_LABEL_QUALIFIER,
  buildGithubQuery,
  buildGithubUrl,
  GITHUB_MAX_PER_PAGE,
  GithubClient,
  isPrivateItem,
  mapGithubItem,
  perPageFor,
  rateLimitResetAt,
} from "../src/github.js";
import { RateLimiter } from "../src/ratelimit.js";
import { fixtureFetch, fixtureText, headerOf, jsonResponse, mockFetch } from "./helpers.js";

const NOW = Date.parse("2026-10-24T12:00:00Z");

describe("query building", () => {
  it("includes both bounty labels in one OR qualifier", () => {
    expect(BOUNTY_LABEL_QUALIFIER).toBe('label:bounty,"💎 Bounty"');
    expect(buildGithubQuery({})).toBe('is:issue is:open is:public label:bounty,"💎 Bounty"');
  });

  it("adds language and keywords", () => {
    expect(buildGithubQuery({ language: "Rust", keywords: "  wasm parser " })).toBe(
      'is:issue is:open is:public label:bounty,"💎 Bounty" language:Rust wasm parser',
    );
    expect(buildGithubQuery({ language: "Jupyter Notebook" })).toContain('language:"Jupyter Notebook"');
  });

  it("builds the URL with sort, order and per_page", () => {
    const u = new URL(buildGithubUrl({ language: "Go", limit: 10 }));
    expect(u.origin + u.pathname).toBe("https://api.github.com/search/issues");
    expect(u.searchParams.get("q")).toBe('is:issue is:open is:public label:bounty,"💎 Bounty" language:Go');
    expect(u.searchParams.get("sort")).toBe("created");
    expect(u.searchParams.get("order")).toBe("desc");
    expect(u.searchParams.get("per_page")).toBe("10");
    expect(new URL(buildGithubUrl({ limit: 10 }, 100)).searchParams.get("per_page")).toBe("100");
  });

  it("keeps is:public even when keywords try to widen the search", () => {
    expect(buildGithubQuery({ keywords: "is:private" })).toContain("is:public");
  });

  it("over-fetches when filtering by amount", () => {
    expect(perPageFor({ limit: 20 })).toBe(20);
    expect(perPageFor({ limit: 20, min_amount_usd: 50 })).toBe(40);
    expect(perPageFor({ limit: 50, min_amount_usd: 50 })).toBe(100);
    expect(perPageFor({})).toBe(20);
    expect(perPageFor({ limit: 500 })).toBe(50);
  });
});

describe("mapping", () => {
  const items = (JSON.parse(fixtureText("github-search.json")) as { items: Record<string, unknown>[] }).items;

  it("maps the recorded fixture", () => {
    const [a, b, c] = items.map((i) => mapGithubItem(i));
    expect(a).toEqual({
      title: "[Bounty] USDC-quoted pairs not having the correct marketcap displayed in tools",
      repo: "zhangjiayang6835-cyber/bounty-plaza",
      url: "https://github.com/zhangjiayang6835-cyber/bounty-plaza/issues/4107",
      labels: ["bounty", "real"],
      created_at: "2026-10-23T20:20:52Z",
      amount_usd: 100,
      source: "github",
    });
    expect(b?.repo).toBe("blake-guthrie/GLASS");
    expect(b?.amount_usd).toBe(100);
    expect(c?.repo).toBe("XHToken/Spark-X2.6");
    expect(c?.labels).toContain("reward");
    expect(c?.amount_usd).toBeNull();
  });

  it("falls back to html_url for the repo and skips malformed items", () => {
    const m = mapGithubItem({ title: "t", html_url: "https://github.com/o/r/issues/2", labels: ["$40"] });
    expect(m?.repo).toBe("o/r");
    expect(m?.amount_usd).toBe(40);
    expect(mapGithubItem({ title: 1 })).toBeNull();
  });

  it("records the requested language", () => {
    expect(mapGithubItem(items[0]!, "TypeScript")?.languages).toEqual(["TypeScript"]);
  });
});

describe("GithubClient.search", () => {
  it("returns mapped fixture results with the right headers", async () => {
    const m = fixtureFetch();
    const results = await new GithubClient({ fetch: m.fetch }).search({ limit: 2 });
    expect(results).toHaveLength(2);
    expect(m.calls).toHaveLength(1);
    const init = m.calls[0]!.init;
    expect(headerOf(init, "accept")).toBe("application/vnd.github+json");
    expect(headerOf(init, "x-github-api-version")).toBe("2022-11-28");
    expect(headerOf(init, "user-agent")).toMatch(/^bounty-mcp\/\d+\.\d+\.\d+$/);
    expect(headerOf(init, "authorization")).toBeNull();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends Authorization only when a token is set", async () => {
    const m = fixtureFetch();
    await new GithubClient({ fetch: m.fetch, token: "ghp_test" }).search({});
    expect(headerOf(m.calls[0]!.init, "authorization")).toBe("Bearer ghp_test");
    const empty = fixtureFetch();
    await new GithubClient({ fetch: empty.fetch, token: "" }).search({});
    expect(headerOf(empty.calls[0]!.init, "authorization")).toBeNull();
  });

  it("applies min_amount_usd client-side", async () => {
    const results = await new GithubClient({ fetch: fixtureFetch().fetch }).search({ min_amount_usd: 50 });
    expect(results.map((r) => r.amount_usd)).toEqual([100, 100]);
    const none = await new GithubClient({ fetch: fixtureFetch().fetch }).search({ min_amount_usd: 500 });
    expect(none).toEqual([]);
  });

  it("reports a 403 rate limit with the reset time and token hint", async () => {
    const reset = Math.floor(NOW / 1000) + 42;
    const m = mockFetch(() =>
      jsonResponse({ message: "API rate limit exceeded for 1.2.3.4." }, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(reset),
      }),
    );
    await expect(new GithubClient({ fetch: m.fetch, now: () => NOW }).search({})).rejects.toThrow(
      `GitHub rate limit hit; resets at ${new Date(reset * 1000).toISOString()}; set GITHUB_TOKEN to raise the limit`,
    );
  });

  it("reports a 429 using retry-after", async () => {
    const m = mockFetch(() => jsonResponse({ message: "slow down" }, 429, { "retry-after": "30" }));
    await expect(new GithubClient({ fetch: m.fetch, now: () => NOW }).search({})).rejects.toThrow(
      `GitHub rate limit hit; resets at ${new Date(NOW + 30_000).toISOString()}`,
    );
  });

  it("drops the token hint when already authenticated", async () => {
    const m = mockFetch(() => jsonResponse({ message: "rate limit" }, 429));
    const err = await new GithubClient({ fetch: m.fetch, token: "t" }).search({}).catch((e: Error) => e);
    expect(String(err)).toContain("GitHub rate limit hit; resets at an unknown time");
    expect(String(err)).not.toContain("set GITHUB_TOKEN");
  });

  it("distinguishes a 403 that is not a rate limit", async () => {
    const m = mockFetch(() =>
      jsonResponse({ message: "Resource not accessible by personal access token" }, 403, {
        "x-ratelimit-remaining": "25",
      }),
    );
    const err = await new GithubClient({ fetch: m.fetch, token: "bad" }).search({}).catch((e: Error) => e);
    expect(String(err)).toContain("GitHub refused the request (403): Resource not accessible");
    expect(String(err)).toContain("check that GITHUB_TOKEN is valid");
    expect(String(err)).not.toContain("rate limit hit");
  });

  it("reports 401 as a bad token", async () => {
    const m = mockFetch(() => jsonResponse({ message: "Bad credentials" }, 401));
    await expect(new GithubClient({ fetch: m.fetch, token: "bad" }).search({})).rejects.toThrow(
      "GitHub rejected the credentials (401): Bad credentials; GITHUB_TOKEN is invalid or expired",
    );
  });

  it("reports 422 as a bad query", async () => {
    const m = mockFetch(() =>
      jsonResponse(
        { message: "Validation Failed", errors: [{ message: "The listed users cannot be searched" }] },
        422,
      ),
    );
    await expect(new GithubClient({ fetch: m.fetch }).search({ keywords: "user:nobody" })).rejects.toThrow(
      "GitHub rejected the search query (422): Validation Failed: The listed users cannot be searched",
    );
  });

  it("reports other errors, invalid JSON and network failures", async () => {
    await expect(
      new GithubClient({ fetch: mockFetch(() => new Response("oops", { status: 502 })).fetch }).search({}),
    ).rejects.toThrow("GitHub API error 502: oops");
    await expect(
      new GithubClient({ fetch: mockFetch(() => new Response("<html>")).fetch }).search({}),
    ).rejects.toThrow("GitHub returned invalid JSON");
    await expect(
      new GithubClient({
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      }).search({}),
    ).rejects.toThrow("GitHub request failed: fetch failed");
  });

  it("times out via AbortController", async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(new GithubClient({ fetch: hang, timeoutMs: 20 }).search({})).rejects.toThrow(
      "GitHub request timed out after 0s",
    );
  });

  it("fails fast when the client-side limiter is full", async () => {
    const m = fixtureFetch();
    const limiter = new RateLimiter({ limit: 1, now: () => NOW });
    const client = new GithubClient({ fetch: m.fetch, limiter });
    await client.search({});
    await expect(client.search({})).rejects.toThrow("rate limit: retry in 60s");
    expect(m.calls).toHaveLength(1);
  });

  it("drops items whose repository is flagged private", async () => {
    const item = (n: number, repository?: unknown) => ({
      title: `issue ${n}`,
      html_url: `https://github.com/o/r/issues/${n}`,
      labels: ["bounty"],
      repository,
    });
    const m = mockFetch(() =>
      jsonResponse({
        items: [
          item(1),
          item(2, { private: true }),
          item(3, { private: false, visibility: "public" }),
          item(4, { visibility: "private" }),
          item(5, { visibility: "internal" }),
        ],
      }),
    );
    const results = await new GithubClient({ fetch: m.fetch }).search({});
    expect(results.map((r) => r.title)).toEqual(["issue 1", "issue 3"]);
    expect(isPrivateItem({ repository: { private: true } })).toBe(true);
    expect(isPrivateItem({})).toBe(false);
  });

  it("candidates mode fetches a full page and skips the amount filter and limit", async () => {
    const m = fixtureFetch();
    const results = await new GithubClient({ fetch: m.fetch }).search(
      { limit: 1, min_amount_usd: 500 },
      { candidates: true },
    );
    expect(new URL(m.calls[0]!.url).searchParams.get("per_page")).toBe(String(GITHUB_MAX_PER_PAGE));
    expect(results.map((r) => r.amount_usd)).toEqual([100, 100, null]);
  });

  it("defaults the limiter to 10/min without a token and 25/min with one", () => {
    expect(new GithubClient({}).limiter.limit).toBe(10);
    expect(new GithubClient({ token: "t" }).limiter.limit).toBe(25);
  });
});

describe("rateLimitResetAt", () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it("reads Retry-After as delta-seconds", () => {
    expect(rateLimitResetAt(h({ "retry-after": "30" }), NOW)).toBe(NOW + 30_000);
    expect(rateLimitResetAt(h({ "retry-after": " 0 " }), NOW)).toBe(NOW);
  });

  it("reads Retry-After as an HTTP-date", () => {
    const at = NOW + 120_000;
    expect(rateLimitResetAt(h({ "retry-after": new Date(at).toUTCString() }), NOW)).toBe(at);
  });

  it("falls back to x-ratelimit-reset epoch seconds", () => {
    expect(rateLimitResetAt(h({ "x-ratelimit-reset": "1800000000" }), NOW)).toBe(1_800_000_000_000);
    expect(rateLimitResetAt(h({ "retry-after": "soon", "x-ratelimit-reset": "1800000000" }), NOW)).toBe(
      1_800_000_000_000,
    );
  });

  it("returns null when nothing usable is present", () => {
    expect(rateLimitResetAt(h({}), NOW)).toBeNull();
    expect(rateLimitResetAt(h({ "retry-after": "soon", "x-ratelimit-reset": "x" }), NOW)).toBeNull();
  });
});

describe("GitHub upstream cooldown", () => {
  function setup(first: Response) {
    let t = NOW;
    let calls = 0;
    const m = mockFetch(() => (calls++ === 0 ? first : jsonResponse(fixtureText("github-search.json"))));
    const client = new GithubClient({ fetch: m.fetch, now: () => t });
    return { m, client, advance: (ms: number) => (t += ms) };
  }

  it("fails fast locally until retry-after expires, then retries", async () => {
    const { m, client, advance } = setup(jsonResponse({ message: "slow down" }, 429, { "retry-after": "30" }));
    const resetIso = new Date(NOW + 30_000).toISOString();
    await expect(client.search({})).rejects.toThrow(`GitHub rate limit hit; resets at ${resetIso}`);
    const remaining = client.limiter.remaining();
    advance(10_000);
    await expect(client.search({})).rejects.toThrow(
      `GitHub rate limit hit; resets at ${resetIso}; set GITHUB_TOKEN to raise the limit (cooling down, request not sent)`,
    );
    expect(m.calls).toHaveLength(1);
    expect(client.limiter.remaining()).toBe(remaining);
    advance(20_000);
    await expect(client.search({})).resolves.toHaveLength(3);
    expect(m.calls).toHaveLength(2);
  });

  it("uses an HTTP-date Retry-After", async () => {
    const at = NOW + 90_000;
    const { m, client, advance } = setup(
      jsonResponse({ message: "API rate limit exceeded" }, 403, { "retry-after": new Date(at).toUTCString() }),
    );
    await expect(client.search({})).rejects.toThrow(`resets at ${new Date(at).toISOString()}`);
    advance(89_000);
    await expect(client.search({})).rejects.toThrow("cooling down, request not sent");
    advance(1_000);
    await client.search({});
    expect(m.calls).toHaveLength(2);
  });

  it("uses x-ratelimit-reset on a 403", async () => {
    const reset = Math.floor(NOW / 1000) + 45;
    const { m, client, advance } = setup(
      jsonResponse({ message: "API rate limit exceeded" }, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(reset),
      }),
    );
    await expect(client.search({})).rejects.toThrow("GitHub rate limit hit");
    advance(44_000);
    await expect(client.search({})).rejects.toThrow("cooling down");
    advance(1_000);
    await client.search({});
    expect(m.calls).toHaveLength(2);
  });

  it("does not cool down without a reset time or on other errors", async () => {
    const unknown = setup(jsonResponse({ message: "rate limit" }, 429));
    await expect(unknown.client.search({})).rejects.toThrow("resets at an unknown time");
    await unknown.client.search({});
    expect(unknown.m.calls).toHaveLength(2);

    const other = setup(jsonResponse({ message: "Bad credentials" }, 401, { "retry-after": "60" }));
    await expect(other.client.search({})).rejects.toThrow("401");
    await other.client.search({});
    expect(other.m.calls).toHaveLength(2);
  });
});
