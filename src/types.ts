export type BountySource = "github" | "opire";

export const ALL_SOURCES: readonly BountySource[] = ["github", "opire"];

/** Common result shape returned by every tool. */
export interface Bounty {
  title: string;
  /** "owner/name" */
  repo: string;
  url: string;
  labels: string[];
  /** ISO 8601 timestamp */
  created_at: string;
  /** Parsed or reported amount in whole USD; null when unknown. */
  amount_usd: number | null;
  source: BountySource;
  /** Raw amount when it could not be converted to USD (e.g. "500 EUR_CENT"). */
  currency_raw?: string;
  /** Programming languages, when the source reports them. */
  languages?: string[];
  /** All sources the item was found in (set by search_bounties). */
  sources?: BountySource[];
}

/** Minimal fetch signature, so tests can inject a mock. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Error with a message that is safe and useful to show to the caller. */
export class SourceError extends Error {
  override name = "SourceError";
}
