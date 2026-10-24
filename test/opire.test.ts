import { describe, expect, it } from "vitest";
import { filterOpire, mapOpireRewards, OPIRE_REWARDS_URL, OpireClient } from "../src/opire.js";
import { fixture, fixtureFetch, jsonResponse, mockFetch } from "./helpers.js";

const raw = fixture<Record<string, unknown>[]>("opire-rewards.json");

describe("mapOpireRewards", () => {
  it("maps the recorded fixture", () => {
    const items = mapOpireRewards(raw);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      title: "c1work",
      repo: "rodrigompy/bugb",
      url: "https://github.com/rodrigompy/bugb/issues/1",
      labels: ["opire"],
      created_at: new Date(1780194646040).toISOString(),
      amount_usd: 100,
      source: "opire",
      languages: [],
    });
    expect(items[1]).toMatchObject({ repo: "radumarias/rencfs", labels: ["opire", "Rust"], amount_usd: 42 });
    expect(items[2]).toMatchObject({ repo: "flowese/UdioWrapper", labels: ["opire", "Python"], amount_usd: 20 });
  });

  it("converts cents to USD", () => {
    const [b] = mapOpireRewards([{ ...raw[0], pendingPrice: { value: 12345, unit: "USD_CENT" } }]);
    expect(b?.amount_usd).toBe(123.45);
    expect(b?.currency_raw).toBeUndefined();
  });

  it("keeps unknown units raw", () => {
    const [b] = mapOpireRewards([{ ...raw[0], pendingPrice: { value: 500, unit: "EUR_CENT" } }]);
    expect(b?.amount_usd).toBeNull();
    expect(b?.currency_raw).toBe("500 EUR_CENT");
  });

  it("skips invalid items and tolerates missing optional fields", () => {
    const items = mapOpireRewards([
      null,
      42,
      { title: "no url", createdAt: 1 },
      { title: "bad date", url: "https://github.com/a/b/issues/1", createdAt: "not a date" },
      {
        title: "minimal",
        url: "https://gitlab.com/x/y/-/issues/3",
        createdAt: "2026-01-02T03:04:05Z",
        pendingPrice: "weird",
        programmingLanguages: [1, 2],
        organization: { name: "org" },
        project: { name: "proj" },
      },
      raw[1],
    ]);
    expect(items.map((i) => i.title)).toEqual(["minimal", "research implementation for Windows"]);
    expect(items[0]).toMatchObject({
      repo: "org/proj",
      labels: ["opire"],
      amount_usd: null,
      created_at: "2026-01-02T03:04:05.000Z",
    });
  });

  it("rejects a non-array payload", () => {
    expect(() => mapOpireRewards({ items: [] })).toThrow("Opire returned an unexpected response");
  });
});

describe("filterOpire", () => {
  const items = mapOpireRewards(raw);

  it("requires every keyword term (case-insensitive) in title, repo or labels", () => {
    expect(filterOpire(items, { keywords: "windows RESEARCH" }).map((i) => i.repo)).toEqual(["radumarias/rencfs"]);
    expect(filterOpire(items, { keywords: "rust" }).map((i) => i.repo)).toEqual(["radumarias/rencfs"]);
    expect(filterOpire(items, { keywords: "udiowrapper" })).toHaveLength(1);
    expect(filterOpire(items, { keywords: "windows python" })).toHaveLength(0);
  });

  it("filters by minimum amount and language", () => {
    expect(filterOpire(items, { min_amount_usd: 40 }).map((i) => i.amount_usd)).toEqual([100, 42]);
    expect(filterOpire(items, { language: "python" }).map((i) => i.repo)).toEqual(["flowese/UdioWrapper"]);
    expect(filterOpire(items, { limit: 1 })).toHaveLength(1);
  });

  it("sorts by amount desc (unknown last), then newest, before applying the limit", () => {
    const at = (title: string, amount_usd: number | null, created_at: string) => ({
      ...items[0]!,
      title,
      url: `https://github.com/o/r/issues/${title}`,
      amount_usd,
      created_at,
    });
    const list = [
      at("new-small", 5, "2026-10-01T00:00:00.000Z"),
      at("old-unknown", null, "2026-01-01T00:00:00.000Z"),
      at("old-big", 500, "2025-01-01T00:00:00.000Z"),
      at("new-big", 500, "2026-06-01T00:00:00.000Z"),
    ];
    expect(filterOpire(list, { limit: 1 }).map((i) => i.title)).toEqual(["new-big"]);
    expect(filterOpire(list, {}).map((i) => i.title)).toEqual(["new-big", "old-big", "new-small", "old-unknown"]);
  });

  it("candidates mode keeps every match, sorted, ignoring min_amount_usd and limit", () => {
    const all = filterOpire(items, { min_amount_usd: 1000, limit: 1 }, { candidates: true });
    expect(all.map((i) => i.amount_usd)).toEqual([100, 42, 20]);
    expect(filterOpire(items, { keywords: "rust", limit: 1 }, { candidates: true })).toHaveLength(1);
  });
});

describe("OpireClient.search", () => {
  it("fetches the rewards endpoint", async () => {
    const m = fixtureFetch();
    const results = await new OpireClient({ fetch: m.fetch }).search({ keywords: "c1work" });
    expect(m.calls[0]?.url).toBe(OPIRE_REWARDS_URL);
    expect(results.map((r) => r.title)).toEqual(["c1work"]);
  });

  it("passes the candidates option through", async () => {
    const results = await new OpireClient({ fetch: fixtureFetch().fetch }).search(
      { min_amount_usd: 1000, limit: 1 },
      { candidates: true },
    );
    expect(results).toHaveLength(3);
  });

  it("reports invalid JSON and HTTP errors", async () => {
    await expect(
      new OpireClient({ fetch: mockFetch(() => new Response("{not json")).fetch }).search({}),
    ).rejects.toThrow("Opire returned invalid JSON");
    await expect(
      new OpireClient({ fetch: mockFetch(() => jsonResponse({ error: "down" }, 503)).fetch }).search({}),
    ).rejects.toThrow('Opire API error 503: {"error":"down"}');
  });

  it("times out", async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(new OpireClient({ fetch: hang, timeoutMs: 10 }).search({})).rejects.toThrow(
      "Opire request timed out",
    );
  });
});
