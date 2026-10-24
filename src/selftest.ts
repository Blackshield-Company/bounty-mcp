import { createClients, type ServerDeps } from "./server.js";
import type { Bounty } from "./types.js";

export interface SelftestOptions extends ServerDeps {
  /** Where to write report lines (default: stdout). */
  write?: (line: string) => void;
}

function describe(results: Bounty[]): string {
  const first = results[0];
  const n = `${results.length} result${results.length === 1 ? "" : "s"}`;
  return first ? `${n} (first: ${first.title} ${first.url})` : n;
}

/** One live query per source. Resolves to the process exit code. */
export async function runSelftest(opts: SelftestOptions = {}): Promise<number> {
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const clients = createClients(opts);
  const checks: [string, () => Promise<Bounty[]>][] = [
    ["github", () => clients.github.search({ limit: 5 })],
    ["opire", () => clients.opire.search({ limit: 5 })],
  ];
  let passed = 0;
  for (const [name, run] of checks) {
    try {
      const results = await run();
      passed++;
      write(`${name}: OK ${describe(results)}`);
    } catch (err) {
      write(`${name}: FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  write(`selftest: ${passed}/${checks.length} sources OK`);
  return passed > 0 ? 0 : 1;
}
