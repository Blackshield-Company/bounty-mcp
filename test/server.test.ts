import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ServerDeps } from "../src/server.js";
import { runSelftest } from "../src/selftest.js";
import type { Bounty } from "../src/types.js";
import { VERSION } from "../src/version.js";
import { fixtureFetch, jsonResponse, mockFetch } from "./helpers.js";

let client: Client | undefined;

async function connect(deps: ServerDeps): Promise<Client> {
  const server = createServer({ githubToken: "", ...deps });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

afterEach(async () => {
  await client?.close();
  client = undefined;
});

interface Payload {
  count: number;
  results: Bounty[];
  warnings?: string[];
}

function payload(res: Awaited<ReturnType<Client["callTool"]>>): Payload {
  const content = res.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text) as Payload;
}

function text(res: Awaited<ReturnType<Client["callTool"]>>): string {
  return (res.content as { text: string }[])[0]!.text;
}

const githubDown = () =>
  mockFetch((url) =>
    url.startsWith("https://api.opire.dev/")
      ? fixtureFetch().fetch(url)
      : jsonResponse({ message: "Bad credentials" }, 401),
  );

describe("MCP server", () => {
  it("version matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });

  it("lists the three tools", async () => {
    const c = await connect({ fetch: fixtureFetch().fetch });
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "search_bounties",
      "search_github_bounties",
      "search_opire_rewards",
    ]);
    const gh = tools.find((t) => t.name === "search_github_bounties");
    expect(Object.keys(gh?.inputSchema.properties ?? {}).sort()).toEqual([
      "keywords",
      "language",
      "limit",
      "min_amount_usd",
    ]);
  });

  it("search_github_bounties returns JSON text and structuredContent", async () => {
    const c = await connect({ fetch: fixtureFetch().fetch });
    const res = await c.callTool({ name: "search_github_bounties", arguments: { limit: 2 } });
    expect(res.isError).toBeFalsy();
    const p = payload(res);
    expect(p.count).toBe(2);
    expect(p.results[0]?.source).toBe("github");
    expect(res.structuredContent).toEqual(p);
  });

  it("search_opire_rewards filters by keywords", async () => {
    const c = await connect({ fetch: fixtureFetch().fetch });
    const res = await c.callTool({ name: "search_opire_rewards", arguments: { keywords: "rencfs" } });
    expect(payload(res).results.map((r) => r.repo)).toEqual(["radumarias/rencfs"]);
  });

  it("search_bounties merges both sources sorted by amount", async () => {
    const c = await connect({ fetch: fixtureFetch().fetch });
    const res = await c.callTool({ name: "search_bounties", arguments: {} });
    const p = payload(res);
    expect(p.warnings).toBeUndefined();
    expect(p.count).toBe(6);
    expect(p.results.map((r) => r.amount_usd)).toEqual([100, 100, 100, 42, 20, null]);
    expect(new Set(p.results.map((r) => r.source))).toEqual(new Set(["github", "opire"]));
  });

  it("search_bounties respects sources and min_amount_usd", async () => {
    const m = fixtureFetch();
    const c = await connect({ fetch: m.fetch });
    const res = await c.callTool({
      name: "search_bounties",
      arguments: { sources: ["opire"], min_amount_usd: 30 },
    });
    expect(payload(res).results.map((r) => r.amount_usd)).toEqual([100, 42]);
    expect(m.calls.every((call) => call.url.startsWith("https://api.opire.dev/"))).toBe(true);
  });

  it("search_bounties fetches full candidate sets so the limit applies after sorting", async () => {
    const issue = (n: number, title: string, created_at: string) => ({
      title,
      html_url: `https://github.com/o/r/issues/${n}`,
      labels: ["bounty"],
      created_at,
    });
    // Newest first, as GitHub returns them; the biggest bounty is the oldest.
    const ghItems = [
      issue(1, "small $10", "2026-10-03T00:00:00Z"),
      issue(2, "no amount", "2026-10-02T00:00:00Z"),
      issue(3, "big $900", "2026-10-01T00:00:00Z"),
    ];
    const reward = (n: number, cents: number, createdAt: number) => ({
      title: `reward ${n}`,
      url: `https://github.com/p/q/issues/${n}`,
      createdAt,
      pendingPrice: { value: cents, unit: "USD_CENT" },
    });
    const m = mockFetch((url) => {
      if (url.startsWith("https://api.opire.dev/")) {
        return jsonResponse([reward(1, 500, 3_000), reward(2, 50_000, 1_000)]);
      }
      const perPage = Number(new URL(url).searchParams.get("per_page"));
      return jsonResponse({ items: ghItems.slice(0, perPage) });
    });
    const c = await connect({ fetch: m.fetch });
    const res = await c.callTool({ name: "search_bounties", arguments: { limit: 2 } });
    expect(payload(res).results.map((r) => r.title)).toEqual(["big $900", "reward 2"]);
    const gh = m.calls.find((call) => call.url.startsWith("https://api.github.com/"));
    expect(new URL(gh!.url).searchParams.get("per_page")).toBe("100");
  });

  it("search_bounties applies min_amount_usd after dedupe, keeping provenance", async () => {
    const url = "https://github.com/o/r/issues/7";
    const m = mockFetch((u) =>
      u.startsWith("https://api.opire.dev/")
        ? jsonResponse([
            { title: "Port it", url, createdAt: 1_000, pendingPrice: { value: 20_000, unit: "USD_CENT" } },
          ])
        : jsonResponse({
            items: [{ title: "Port it", html_url: url, labels: ["bounty", "help wanted"], created_at: "2026-01-01T00:00:00Z" }],
          }),
    );
    const c = await connect({ fetch: m.fetch });
    const res = await c.callTool({ name: "search_bounties", arguments: { min_amount_usd: 50 } });
    const [item, ...rest] = payload(res).results;
    expect(rest).toHaveLength(0);
    expect(item?.amount_usd).toBe(200);
    expect(item?.sources?.sort()).toEqual(["github", "opire"]);
    expect(item?.labels).toEqual(expect.arrayContaining(["bounty", "help wanted", "opire"]));
  });

  it("search_opire_rewards sorts by amount before the limit", async () => {
    const c = await connect({ fetch: fixtureFetch().fetch });
    const res = await c.callTool({ name: "search_opire_rewards", arguments: { limit: 2 } });
    expect(payload(res).results.map((r) => r.amount_usd)).toEqual([100, 42]);
  });

  it("search_bounties returns partial results with a warning when one source fails", async () => {
    const c = await connect({ fetch: githubDown().fetch });
    const res = await c.callTool({ name: "search_bounties", arguments: {} });
    expect(res.isError).toBeFalsy();
    const p = payload(res);
    expect(p.results.every((r) => r.source === "opire")).toBe(true);
    expect(p.warnings).toEqual([expect.stringContaining("github: GitHub rejected the credentials (401)")]);
  });

  it("search_bounties is an error only when all sources fail", async () => {
    const c = await connect({ fetch: mockFetch(() => jsonResponse({}, 500)).fetch });
    const res = await c.callTool({ name: "search_bounties", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("all sources failed");
    expect(text(res)).toContain("github: GitHub API error 500");
    expect(text(res)).toContain("opire: Opire API error 500");
  });

  it("tool errors come back as isError results", async () => {
    const c = await connect({ fetch: githubDown().fetch });
    const res = await c.callTool({ name: "search_github_bounties", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("search_github_bounties failed: GitHub rejected the credentials (401)");
  });

  it("rejects invalid arguments", async () => {
    const c = await connect({ fetch: fixtureFetch().fetch });
    const res = await c.callTool({ name: "search_github_bounties", arguments: { limit: 500 } });
    expect(res.isError).toBe(true);
  });
});

describe("runSelftest", () => {
  it("reports each source and exits 0 when one succeeds", async () => {
    const lines: string[] = [];
    const code = await runSelftest({ fetch: githubDown().fetch, githubToken: "", write: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines[0]).toMatch(/^github: FAILED: GitHub rejected the credentials/);
    expect(lines[1]).toMatch(/^opire: OK 3 results \(first: c1work https:\/\/github\.com\/rodrigompy\/bugb\/issues\/1\)$/);
    expect(lines[2]).toBe("selftest: 1/2 sources OK");
  });

  it("exits 1 when every source fails", async () => {
    const lines: string[] = [];
    const code = await runSelftest({
      fetch: mockFetch(() => jsonResponse({}, 500)).fetch,
      githubToken: "",
      write: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines.at(-1)).toBe("selftest: 0/2 sources OK");
  });
});
