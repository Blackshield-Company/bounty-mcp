import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { clampLimit, GithubClient, MAX_LIMIT } from "./github.js";
import { mergeBounties } from "./merge.js";
import { OpireClient } from "./opire.js";
import type { RateLimiter } from "./ratelimit.js";
import { ALL_SOURCES, type Bounty, type BountySource, type FetchLike } from "./types.js";
import { VERSION } from "./version.js";

export interface ServerDeps {
  fetch?: FetchLike;
  /** Defaults to process.env.GITHUB_TOKEN. */
  githubToken?: string;
  githubLimiter?: RateLimiter;
  now?: () => number;
}

export interface Clients {
  github: GithubClient;
  opire: OpireClient;
}

export function createClients(deps: ServerDeps = {}): Clients {
  const token = deps.githubToken ?? process.env.GITHUB_TOKEN ?? undefined;
  return {
    github: new GithubClient({ fetch: deps.fetch, token, limiter: deps.githubLimiter, now: deps.now }),
    opire: new OpireClient({ fetch: deps.fetch }),
  };
}

export interface CombinedParams {
  language?: string;
  keywords?: string;
  min_amount_usd?: number;
  limit?: number;
  sources?: BountySource[];
}

export interface CombinedResult {
  results: Bounty[];
  warnings: string[];
  /** True when every selected source failed. */
  allFailed: boolean;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function searchAllSources(clients: Clients, p: CombinedParams): Promise<CombinedResult> {
  const selected = [...new Set(p.sources && p.sources.length > 0 ? p.sources : ALL_SOURCES)];
  const limit = clampLimit(p.limit);
  // Sources return unlimited candidates without the amount filter, so that the
  // minimum, the sort and the limit apply to the deduped set.
  const candidates = { candidates: true };
  const settled = await Promise.allSettled(
    selected.map((s) =>
      s === "github" ? clients.github.search(p, candidates) : clients.opire.search(p, candidates),
    ),
  );
  const lists: Bounty[][] = [];
  const warnings: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") lists.push(r.value);
    else warnings.push(`${selected[i]}: ${message(r.reason)}`);
  });
  return {
    results: mergeBounties(lists, { min_amount_usd: p.min_amount_usd, limit }),
    warnings,
    allFailed: lists.length === 0,
  };
}

function ok(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function fail(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

const language = z
  .string()
  .optional()
  .describe("Repository / project programming language, e.g. \"TypeScript\"");
const keywords = z.string().optional().describe("Free-text keywords");
const minAmount = z
  .number()
  .min(0)
  .optional()
  .describe("Only return bounties worth at least this many USD (items with unknown amounts are excluded)");
const limit = z.number().int().min(1).max(MAX_LIMIT).default(20).describe(`Max results (1-${MAX_LIMIT}, default 20)`);

export function createServer(deps: ServerDeps = {}): McpServer {
  const clients = createClients(deps);
  const server = new McpServer({ name: "bounty-mcp", version: VERSION });

  server.registerTool(
    "search_github_bounties",
    {
      title: "Search GitHub bounty issues",
      description:
        'Search open GitHub issues labelled "bounty" or Algora\'s "💎 Bounty", newest first. ' +
        "Amounts are parsed heuristically from the title, labels and body and may be missing or wrong.",
      inputSchema: { language, keywords, min_amount_usd: minAmount, limit },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const results = await clients.github.search(args);
        return ok({ count: results.length, results });
      } catch (err) {
        return fail(`search_github_bounties failed: ${message(err)}`);
      }
    },
  );

  server.registerTool(
    "search_opire_rewards",
    {
      title: "Search Opire rewards",
      description:
        "List open rewards from Opire (api.opire.dev), sorted by amount (unknown amounts last), then " +
        "newest first. The API returns a small list and ignores query parameters, so keyword and amount " +
        "filtering is done locally.",
      inputSchema: { keywords, min_amount_usd: minAmount, limit },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const results = await clients.opire.search(args);
        return ok({ count: results.length, results });
      } catch (err) {
        return fail(`search_opire_rewards failed: ${message(err)}`);
      }
    },
  );

  server.registerTool(
    "search_bounties",
    {
      title: "Search all bounty sources",
      description:
        "Search GitHub and Opire concurrently, dedupe by URL, and sort by amount (unknown amounts last), " +
        "then newest first. If a source fails, results from the others are still returned with a warning.",
      inputSchema: {
        language,
        keywords,
        min_amount_usd: minAmount,
        limit,
        sources: z
          .array(z.enum(["github", "opire"]))
          .min(1)
          .optional()
          .describe('Sources to query (default: ["github", "opire"])'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const r = await searchAllSources(clients, args);
        if (r.allFailed) return fail(`search_bounties failed: all sources failed: ${r.warnings.join("; ")}`);
        const payload: Record<string, unknown> = { count: r.results.length, results: r.results };
        if (r.warnings.length > 0) payload.warnings = r.warnings;
        return ok(payload);
      } catch (err) {
        return fail(`search_bounties failed: ${message(err)}`);
      }
    },
  );

  return server;
}
