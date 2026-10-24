import { describe, expect, it } from "vitest";
import { applyMinAmount, dedupeBounties, mergeBounties, normalizeUrl, sortBounties } from "../src/merge.js";
import type { Bounty } from "../src/types.js";

function b(over: Partial<Bounty>): Bounty {
  return {
    title: "t",
    repo: "o/r",
    url: "https://github.com/o/r/issues/1",
    labels: [],
    created_at: "2026-01-01T00:00:00Z",
    amount_usd: null,
    source: "github",
    ...over,
  };
}

describe("normalizeUrl", () => {
  it("ignores scheme, case, www, trailing slash, query and fragment", () => {
    const want = "github.com/o/r/issues/1";
    expect(normalizeUrl("https://github.com/o/r/issues/1")).toBe(want);
    expect(normalizeUrl("https://www.GitHub.com/O/R/issues/1/")).toBe(want);
    expect(normalizeUrl("http://github.com/o/r/issues/1?foo=bar#issuecomment-9")).toBe(want);
  });

  it("does not throw on garbage", () => {
    expect(normalizeUrl("  Not A URL/?x ")).toBe("not a url");
  });
});

describe("dedupeBounties", () => {
  it("merges the same issue from both sources", () => {
    const gh = b({ url: "https://github.com/o/r/issues/1", labels: ["bounty"], amount_usd: null });
    const op = b({
      url: "https://www.github.com/O/r/issues/1/",
      labels: ["opire", "Rust"],
      amount_usd: 42,
      source: "opire",
      languages: ["Rust"],
    });
    const [m, ...rest] = dedupeBounties([gh, op]);
    expect(rest).toHaveLength(0);
    expect(m?.amount_usd).toBe(42);
    expect(m?.source).toBe("opire");
    expect(m?.url).toBe(op.url);
    expect(m?.labels.sort()).toEqual(["Rust", "bounty", "opire"]);
    expect(m?.sources?.sort()).toEqual(["github", "opire"]);
    expect(m?.languages).toEqual(["Rust"]);
  });

  it("keeps the first entry when both or neither have an amount", () => {
    const [m] = dedupeBounties([b({ amount_usd: 10, title: "first" }), b({ amount_usd: 99, title: "second" })]);
    expect(m?.title).toBe("first");
    const [n] = dedupeBounties([b({ title: "first" }), b({ title: "second", source: "opire" })]);
    expect(n?.title).toBe("first");
    expect(n?.sources).toEqual(["github", "opire"]);
  });

  it("sets sources on single items", () => {
    expect(dedupeBounties([b({ source: "opire" })])[0]?.sources).toEqual(["opire"]);
  });
});

describe("sortBounties", () => {
  it("sorts by amount desc, nulls last, then newest first, stably", () => {
    const items = [
      b({ title: "null-old", created_at: "2026-01-01T00:00:00Z" }),
      b({ title: "50-old", amount_usd: 50, created_at: "2026-01-01T00:00:00Z" }),
      b({ title: "null-new", created_at: "2026-06-01T00:00:00Z" }),
      b({ title: "200", amount_usd: 200 }),
      b({ title: "50-new", amount_usd: 50, created_at: "2026-06-01T00:00:00Z" }),
      b({ title: "50-old-2", amount_usd: 50, created_at: "2026-01-01T00:00:00Z" }),
      b({ title: "null-baddate", created_at: "" }),
    ];
    expect(sortBounties(items).map((i) => i.title)).toEqual([
      "200",
      "50-new",
      "50-old",
      "50-old-2",
      "null-new",
      "null-old",
      "null-baddate",
    ]);
  });
});

describe("applyMinAmount / mergeBounties", () => {
  const items = [
    b({ url: "https://github.com/a/a/issues/1", amount_usd: 10 }),
    b({ url: "https://github.com/a/a/issues/2", amount_usd: 100 }),
    b({ url: "https://github.com/a/a/issues/3", amount_usd: null }),
    b({ url: "https://github.com/a/a/issues/4", amount_usd: 50 }),
  ];

  it("excludes null amounts only when the minimum is positive", () => {
    expect(applyMinAmount(items, 0)).toHaveLength(4);
    expect(applyMinAmount(items, undefined)).toHaveLength(4);
    expect(applyMinAmount(items, 50).map((i) => i.amount_usd)).toEqual([100, 50]);
  });

  it("dedupes across lists, sorts, filters and limits", () => {
    const opire = [b({ url: "https://github.com/a/a/issues/3/", amount_usd: 75, source: "opire" })];
    expect(mergeBounties([items, opire], { limit: 10 }).map((i) => i.amount_usd)).toEqual([100, 75, 50, 10]);
    expect(mergeBounties([items, opire], { limit: 2 }).map((i) => i.amount_usd)).toEqual([100, 75]);
    expect(mergeBounties([items, opire], { limit: 10, min_amount_usd: 60 }).map((i) => i.amount_usd)).toEqual([
      100, 75,
    ]);
    expect(mergeBounties([items], { limit: 10 }).at(-1)?.amount_usd).toBeNull();
  });
});

describe("dedupe amount preference", () => {
  it("prefers the Opire amount over a parsed GitHub amount", () => {
    const url = "https://github.com/o/r/issues/1";
    const gh = { title: "t", repo: "o/r", url, labels: ["bounty"], created_at: "2026-01-01T00:00:00.000Z", amount_usd: 5, source: "github" as const };
    const op = { ...gh, labels: ["opire"], amount_usd: 100, source: "opire" as const };
    const out = dedupeBounties([gh, op]);
    expect(out).toHaveLength(1);
    expect(out[0].amount_usd).toBe(100);
    expect(out[0].labels).toEqual(expect.arrayContaining(["bounty", "opire"]));
  });
});
