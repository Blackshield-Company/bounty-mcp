import { getText, parseJson, repoFromGithubUrl } from "./http.js";
import { applyMinAmount } from "./merge.js";
import { parseAmountFromFields } from "./parse.js";
import { createGithubLimiter, type RateLimiter } from "./ratelimit.js";
import { SourceError, type Bounty, type FetchLike } from "./types.js";
import { VERSION } from "./version.js";

export const GITHUB_SEARCH_URL = "https://api.github.com/search/issues";

/**
 * Plain "bounty" label plus Algora's "💎 Bounty" label. Comma-separated
 * values inside one label: qualifier are ORed. Only the value containing a
 * space is quoted: quoting the whole list (label:"bounty,💎 Bounty") makes
 * GitHub look for a single label with that literal name and returns nothing.
 */
export const BOUNTY_LABEL_QUALIFIER = 'label:bounty,"💎 Bounty"';

export const GITHUB_TIMEOUT_MS = 15_000;
export const MAX_LIMIT = 50;
/** GitHub's per_page cap for search. */
export const GITHUB_MAX_PER_PAGE = 100;

export interface GithubSearchParams {
  language?: string;
  keywords?: string;
  min_amount_usd?: number;
  limit?: number;
}

export interface GithubClientOptions {
  fetch?: FetchLike;
  token?: string;
  limiter?: RateLimiter;
  timeoutMs?: number;
  now?: () => number;
}

export interface SearchOptions {
  /**
   * Return every candidate for merging: no min_amount_usd filter and no
   * limit. GitHub fetches a full page (GITHUB_MAX_PER_PAGE) in this mode.
   */
  candidates?: boolean;
}

function qualifierValue(v: string): string {
  const clean = v.trim().replace(/"/g, "");
  return /\s/.test(clean) ? `"${clean}"` : clean;
}

export function buildGithubQuery(p: GithubSearchParams): string {
  // is:public: a token that can see private repositories must not surface them.
  const parts = ["is:issue", "is:open", "is:public", BOUNTY_LABEL_QUALIFIER];
  if (p.language?.trim()) parts.push(`language:${qualifierValue(p.language)}`);
  if (p.keywords?.trim()) parts.push(p.keywords.trim());
  return parts.join(" ");
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 20;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/** Over-fetch when filtering by amount, since many issues have no parseable amount. */
export function perPageFor(p: GithubSearchParams): number {
  const limit = clampLimit(p.limit);
  return (p.min_amount_usd ?? 0) > 0 ? Math.min(GITHUB_MAX_PER_PAGE, limit * 2) : limit;
}

export function buildGithubUrl(p: GithubSearchParams, perPage = perPageFor(p)): string {
  const qs = new URLSearchParams({
    q: buildGithubQuery(p),
    sort: "created",
    order: "desc",
    per_page: String(perPage),
  });
  return `${GITHUB_SEARCH_URL}?${qs.toString()}`;
}

export function buildGithubHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": `bounty-mcp/${VERSION}`,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

interface GithubIssue {
  title?: unknown;
  html_url?: unknown;
  repository_url?: unknown;
  labels?: unknown;
  created_at?: unknown;
  body?: unknown;
  repository?: unknown;
}

/** True when the item carries repository info marking it as not public. */
export function isPrivateItem(item: GithubIssue): boolean {
  const repo = item.repository as { private?: unknown; visibility?: unknown } | null | undefined;
  if (!repo || typeof repo !== "object") return false;
  return repo.private === true || (typeof repo.visibility === "string" && repo.visibility !== "public");
}

function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((l) => (typeof l === "string" ? l : (l as { name?: unknown } | null)?.name))
    .filter((n): n is string => typeof n === "string");
}

export function mapGithubItem(item: GithubIssue, language?: string): Bounty | null {
  if (typeof item.title !== "string" || typeof item.html_url !== "string") return null;
  const labels = labelNames(item.labels);
  const repo =
    repoFromGithubUrl(typeof item.repository_url === "string" ? item.repository_url : null) ??
    repoFromGithubUrl(item.html_url) ??
    "";
  const body = typeof item.body === "string" ? item.body : null;
  const bounty: Bounty = {
    title: item.title,
    repo,
    url: item.html_url,
    labels,
    created_at: typeof item.created_at === "string" ? item.created_at : "",
    amount_usd: parseAmountFromFields({ title: item.title, labels, body }),
    source: "github",
  };
  // Issue search's language: qualifier matches the repository language.
  if (language?.trim()) bounty.languages = [language.trim()];
  return bounty;
}

function apiMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { message?: unknown; errors?: { message?: unknown }[] };
    const extra = Array.isArray(j.errors)
      ? j.errors.map((e) => e?.message).filter((m) => typeof m === "string")
      : [];
    const msg = typeof j.message === "string" ? j.message : "";
    return [msg, ...extra].filter(Boolean).join(": ");
  } catch {
    return body.slice(0, 200).trim();
  }
}

/**
 * When the rate limit resets, in epoch ms, or null if the headers do not say.
 * Retry-After may be delta-seconds or an HTTP-date; x-ratelimit-reset is
 * epoch seconds.
 */
export function rateLimitResetAt(headers: Headers, now: number): number | null {
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    // Checked before Date.parse, which reads "30" as the year 2030.
    if (/^\d+(?:\.\d+)?$/.test(retryAfter)) return now + Number(retryAfter) * 1000;
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return date;
  }
  const reset = headers.get("x-ratelimit-reset")?.trim();
  if (reset && /^\d+$/.test(reset)) return Number(reset) * 1000;
  return null;
}

export function isRateLimitResponse(status: number, headers: Headers, body: string): boolean {
  return (
    status === 429 ||
    (status === 403 &&
      (headers.get("x-ratelimit-remaining") === "0" ||
        headers.get("retry-after") !== null ||
        /rate limit/i.test(apiMessage(body))))
  );
}

function rateLimitMessage(resetAt: number | null, hasToken: boolean): string {
  const hint = hasToken
    ? "authenticated limit reached, wait before retrying"
    : "set GITHUB_TOKEN to raise the limit";
  const when = resetAt === null ? "an unknown time" : new Date(resetAt).toISOString();
  return `GitHub rate limit hit; resets at ${when}; ${hint}`;
}

export function githubErrorMessage(
  status: number,
  headers: Headers,
  body: string,
  hasToken: boolean,
  now: number,
): string {
  if (isRateLimitResponse(status, headers, body)) {
    return rateLimitMessage(rateLimitResetAt(headers, now), hasToken);
  }
  const msg = apiMessage(body);
  const detail = msg ? `: ${msg}` : "";
  switch (status) {
    case 401:
      return `GitHub rejected the credentials (401)${detail}; GITHUB_TOKEN is invalid or expired`;
    case 403:
      return hasToken
        ? `GitHub refused the request (403)${detail}; check that GITHUB_TOKEN is valid and allowed to search`
        : `GitHub refused the request (403)${detail}`;
    case 422:
      return `GitHub rejected the search query (422)${detail}; check the language and keywords`;
    default:
      return `GitHub API error ${status}${detail}`;
  }
}

export class GithubClient {
  private readonly fetchImpl: FetchLike;
  private readonly token?: string;
  readonly limiter: RateLimiter;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  /** Epoch ms until which GitHub asked us to back off; searches fail locally until then. */
  private cooldownUntil = 0;

  constructor(opts: GithubClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.token = opts.token || undefined;
    this.now = opts.now ?? Date.now;
    this.limiter = opts.limiter ?? createGithubLimiter(Boolean(this.token), this.now);
    this.timeoutMs = opts.timeoutMs ?? GITHUB_TIMEOUT_MS;
  }

  /**
   * Newest first, filtered by min_amount_usd and cut to limit. With
   * `candidates`, a full page is fetched and returned without either.
   */
  async search(p: GithubSearchParams, opts: SearchOptions = {}): Promise<Bounty[]> {
    if (this.now() < this.cooldownUntil) {
      throw new SourceError(
        `${rateLimitMessage(this.cooldownUntil, Boolean(this.token))} (cooling down, request not sent)`,
      );
    }
    this.limiter.acquire();
    const res = await getText(
      this.fetchImpl,
      buildGithubUrl(p, opts.candidates ? GITHUB_MAX_PER_PAGE : perPageFor(p)),
      buildGithubHeaders(this.token),
      this.timeoutMs,
      "GitHub",
    );
    if (!res.ok) {
      if (isRateLimitResponse(res.status, res.headers, res.body)) {
        const resetAt = rateLimitResetAt(res.headers, this.now());
        if (resetAt !== null) this.cooldownUntil = Math.max(this.cooldownUntil, resetAt);
      }
      throw new SourceError(
        githubErrorMessage(res.status, res.headers, res.body, Boolean(this.token), this.now()),
      );
    }
    const json = parseJson(res.body, "GitHub") as { items?: unknown };
    if (!json || !Array.isArray(json.items)) {
      throw new SourceError("GitHub returned an unexpected response (no items array)");
    }
    const items = json.items
      .map((i) =>
        i && typeof i === "object" && !isPrivateItem(i as GithubIssue)
          ? mapGithubItem(i as GithubIssue, p.language)
          : null,
      )
      .filter((b): b is Bounty => b !== null);
    if (opts.candidates) return items;
    return applyMinAmount(items, p.min_amount_usd).slice(0, clampLimit(p.limit));
  }
}
