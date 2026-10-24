import { z } from "zod";
import { clampLimit, type SearchOptions } from "./github.js";
import { getText, parseJson, repoFromGithubUrl } from "./http.js";
import { applyMinAmount, sortBounties } from "./merge.js";
import { SourceError, type Bounty, type FetchLike } from "./types.js";
import { VERSION } from "./version.js";

export const OPIRE_REWARDS_URL = "https://api.opire.dev/rewards";
export const OPIRE_TIMEOUT_MS = 20_000;

export interface OpireSearchParams {
  keywords?: string;
  language?: string;
  min_amount_usd?: number;
  limit?: number;
}

export interface OpireClientOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
}

const named = z.object({ name: z.string().optional() }).loose();

// Lenient: only title, url and createdAt are required; anything else that is
// missing or malformed falls back to a default instead of rejecting the item.
const RewardSchema = z.object({
  title: z.string(),
  url: z.string(),
  createdAt: z.union([z.number(), z.string()]),
  pendingPrice: z
    .object({ value: z.number(), unit: z.string() })
    .optional()
    .catch(undefined),
  programmingLanguages: z.array(z.string()).optional().catch(undefined),
  organization: named.optional().catch(undefined),
  project: named.optional().catch(undefined),
});

type Reward = z.infer<typeof RewardSchema>;

function toIso(createdAt: number | string): string | null {
  const d = new Date(createdAt);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function mapOpireReward(r: Reward): Bounty | null {
  const created_at = toIso(r.createdAt);
  if (!created_at) return null;
  const org = r.organization?.name;
  const proj = r.project?.name;
  const repo = repoFromGithubUrl(r.url) ?? (org && proj ? `${org}/${proj}` : (proj ?? org ?? ""));
  const languages = r.programmingLanguages ?? [];
  const bounty: Bounty = {
    title: r.title,
    repo,
    url: r.url,
    labels: ["opire", ...languages],
    created_at,
    amount_usd: null,
    source: "opire",
    languages,
  };
  const price = r.pendingPrice;
  if (price) {
    if (price.unit === "USD_CENT") bounty.amount_usd = price.value / 100;
    else bounty.currency_raw = `${price.value} ${price.unit}`;
  }
  return bounty;
}

/** Map a raw /rewards payload, skipping items that do not fit the schema. */
export function mapOpireRewards(json: unknown): Bounty[] {
  if (!Array.isArray(json)) {
    throw new SourceError("Opire returned an unexpected response (expected a JSON array)");
  }
  const out: Bounty[] = [];
  for (const item of json) {
    const parsed = RewardSchema.safeParse(item);
    if (!parsed.success) continue;
    const b = mapOpireReward(parsed.data);
    if (b) out.push(b);
  }
  return out;
}

/** Every whitespace-separated term must appear (case-insensitively) in title, repo or labels. */
export function matchesKeywords(b: Bounty, keywords: string | undefined): boolean {
  const terms = (keywords ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = [b.title, b.repo, ...b.labels].join("\n").toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export function matchesLanguage(b: Bounty, language: string | undefined): boolean {
  const want = language?.trim().toLowerCase();
  if (!want) return true;
  return (b.languages ?? []).some((l) => l.toLowerCase() === want);
}

/**
 * Keyword and language matches sorted by amount (unknown last), then newest
 * first; then min_amount_usd and limit, unless `candidates` is set.
 */
export function filterOpire(items: Bounty[], p: OpireSearchParams, opts: SearchOptions = {}): Bounty[] {
  const matched = items.filter((b) => matchesKeywords(b, p.keywords) && matchesLanguage(b, p.language));
  const sorted = sortBounties(matched);
  if (opts.candidates) return sorted;
  return applyMinAmount(sorted, p.min_amount_usd).slice(0, clampLimit(p.limit));
}

export class OpireClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: OpireClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? OPIRE_TIMEOUT_MS;
  }

  /** The endpoint ignores query parameters, so all filtering happens here. */
  async search(p: OpireSearchParams, opts: SearchOptions = {}): Promise<Bounty[]> {
    const res = await getText(
      this.fetchImpl,
      OPIRE_REWARDS_URL,
      { Accept: "application/json", "User-Agent": `bounty-mcp/${VERSION}` },
      this.timeoutMs,
      "Opire",
    );
    if (!res.ok) {
      const snippet = res.body.slice(0, 200).trim();
      throw new SourceError(`Opire API error ${res.status}${snippet ? `: ${snippet}` : ""}`);
    }
    return filterOpire(mapOpireRewards(parseJson(res.body, "Opire")), p, opts);
  }
}
