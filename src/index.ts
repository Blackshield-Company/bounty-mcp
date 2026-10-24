#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runSelftest } from "./selftest.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

const USAGE = `bounty-mcp ${VERSION}
MCP server (stdio) for searching paid open-source bounties on GitHub and Opire.

Usage:
  bounty-mcp              Start the MCP server on stdin/stdout
  bounty-mcp --selftest   Run one live query per source and report the results
  bounty-mcp --help       Show this help
  bounty-mcp --version    Show the version

Tools:
  search_github_bounties  GitHub issues labelled "bounty" or "💎 Bounty"
  search_opire_rewards    Rewards listed on Opire
  search_bounties         Both sources, deduped and sorted by amount

Environment:
  GITHUB_TOKEN  Optional GitHub token. Raises the GitHub search limit from
                10 to 30 requests/minute (the client-side limiter allows 25).
`;

async function main(argv: string[]): Promise<number | null> {
  const [arg, ...rest] = argv;
  if (arg === "--help" || arg === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (arg === "--version" || arg === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (arg === "--selftest") {
    return runSelftest();
  }
  if (arg !== undefined || rest.length > 0) {
    process.stderr.write(`Unknown argument: ${arg}\n\n${USAGE}`);
    return 2;
  }
  const server = createServer();
  await server.connect(new StdioServerTransport());
  // stdout carries the MCP protocol; diagnostics go to stderr only.
  console.error(`bounty-mcp ${VERSION} running on stdio`);
  return null;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== null) process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  },
);
