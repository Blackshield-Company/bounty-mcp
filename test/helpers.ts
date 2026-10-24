import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "../src/types.js";

export function fixtureText(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(fixtureText(name)) as T;
}

export interface Call {
  url: string;
  init?: RequestInit;
}

export interface MockFetch {
  fetch: FetchLike;
  calls: Call[];
}

type Responder = (url: string, init?: RequestInit) => Response | Promise<Response>;

export function mockFetch(respond: Responder): MockFetch {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    },
  };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Routes api.github.com and api.opire.dev to the recorded fixtures. */
export function fixtureFetch(): MockFetch {
  return mockFetch((url) => {
    if (url.startsWith("https://api.github.com/")) return jsonResponse(fixtureText("github-search.json"));
    if (url.startsWith("https://api.opire.dev/")) return jsonResponse(fixtureText("opire-rewards.json"));
    return jsonResponse({ message: "not found" }, 404);
  });
}

export function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}
