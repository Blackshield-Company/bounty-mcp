import type { Bounty } from "./types.js";

/**
 * Key used for dedupe: lowercased host (without "www.") and path, no
 * scheme, query, fragment or trailing slash. So
 * "https://www.GitHub.com/o/r/issues/1/?x#y" and "http://github.com/o/r/issues/1"
 * are the same item.
 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.toLowerCase().replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return url.trim().toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

function union<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): T[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

function combine(a: Bounty, b: Bounty): Bounty {
  // Prefer the entry with a known amount; if both have one, prefer Opire's
  // (reported by the platform) over an amount guessed from GitHub issue text.
  let swap = false;
  if (a.amount_usd === null && b.amount_usd !== null) swap = true;
  else if (a.amount_usd !== null && b.amount_usd !== null && a.source !== "opire" && b.source === "opire") swap = true;
  const [base, other] = swap ? [b, a] : [a, b];
  const merged: Bounty = {
    ...base,
    labels: union(base.labels, other.labels),
    sources: union(base.sources ?? [base.source], other.sources ?? [other.source]),
  };
  const languages = union(base.languages, other.languages);
  if (languages.length > 0) merged.languages = languages;
  if (merged.currency_raw === undefined && other.currency_raw !== undefined) {
    merged.currency_raw = other.currency_raw;
  }
  return merged;
}

/** Merge duplicates (by normalized URL), preserving first-seen order. */
export function dedupeBounties(items: readonly Bounty[]): Bounty[] {
  const byKey = new Map<string, Bounty>();
  for (const item of items) {
    const key = normalizeUrl(item.url);
    const seen = byKey.get(key);
    byKey.set(key, seen ? combine(seen, item) : { ...item, sources: item.sources ?? [item.source] });
  }
  return [...byKey.values()];
}

function time(b: Bounty): number {
  const t = Date.parse(b.created_at);
  return Number.isNaN(t) ? -Infinity : t;
}

/** Amount descending (null last), then newest first. Stable. */
export function sortBounties(items: readonly Bounty[]): Bounty[] {
  return [...items].sort((a, b) => {
    if (a.amount_usd !== b.amount_usd) {
      if (a.amount_usd === null) return 1;
      if (b.amount_usd === null) return -1;
      return b.amount_usd - a.amount_usd;
    }
    const ta = time(a);
    const tb = time(b);
    return ta === tb ? 0 : tb > ta ? 1 : -1;
  });
}

/** With a positive minimum, items without a known amount are dropped. */
export function applyMinAmount(items: readonly Bounty[], min: number | undefined): Bounty[] {
  if (min === undefined || !(min > 0)) return [...items];
  return items.filter((b) => b.amount_usd !== null && b.amount_usd >= min);
}

export interface MergeOptions {
  min_amount_usd?: number;
  limit: number;
}

/** Dedupe first, then sort, then min_amount_usd, then limit. */
export function mergeBounties(lists: readonly (readonly Bounty[])[], opts: MergeOptions): Bounty[] {
  const merged = dedupeBounties(lists.flat());
  return applyMinAmount(sortBounties(merged), opts.min_amount_usd).slice(0, opts.limit);
}
