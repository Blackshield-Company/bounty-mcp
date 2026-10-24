import { SourceError, type FetchLike } from "./types.js";

export interface HttpResult {
  status: number;
  ok: boolean;
  headers: Headers;
  body: string;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}

/**
 * GET `url` and read the whole body, aborting after `timeoutMs`.
 * Network failures and timeouts become SourceErrors prefixed with `label`.
 */
export async function getText(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  label: string,
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
    const body = await res.text();
    return { status: res.status, ok: res.ok, headers: res.headers, body };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new SourceError(`${label} request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new SourceError(`${label} request failed: ${describe(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

export function parseJson(body: string, label: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new SourceError(`${label} returned invalid JSON`);
  }
}

/** "owner/name" from a github.com or api.github.com/repos URL, or null. */
export function repoFromGithubUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "api.github.com" && parts[0] === "repos" && parts.length >= 3) {
    return `${parts[1]}/${parts[2]}`;
  }
  if (host === "github.com" && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return null;
}
