# bounty-mcp

An [MCP](https://modelcontextprotocol.io) server, over stdio, that gives agents tools to search
**paid open-source bounties**:

- **GitHub**: open issues labelled `bounty` or `💎 Bounty` (the label Algora uses), found through the
  GitHub issue search API.
- **Opire**: open rewards from the public Opire API (`https://api.opire.dev/rewards`).

Every tool returns the same result shape, so agents can compare bounties across sources.
No API keys are required. A GitHub token is optional: it raises the GitHub rate limit, and since it
is sent with every search it could also let GitHub return issues from private repositories the token
can read. To prevent that, every GitHub query includes `is:public`, and any returned item whose
repository is flagged private (`private: true` or a non-`public` `visibility`) is dropped.

Not affiliated with GitHub, Algora or Opire.

## Requirements

- Node.js 18 or newer (uses the built-in `fetch`)

## Install from source

```sh
git clone <this repository> bounty-mcp
cd bounty-mcp
npm install
npm run build
```

This creates `dist/index.js`. Start the server with:

```sh
node /absolute/path/to/bounty-mcp/dist/index.js
```

MCP clients start the server themselves, so you normally only put this command in the client config
(see below). If you install the package from a registry, `npx bounty-mcp` would start the
same server.

## Client configuration

### Claude Desktop

Add the server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bounty": {
      "command": "node",
      "args": ["/absolute/path/to/bounty-mcp/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_optional_token"
      }
    }
  }
}
```

### Cursor

Add it to `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for all projects):

```json
{
  "mcpServers": {
    "bounty": {
      "command": "node",
      "args": ["/absolute/path/to/bounty-mcp/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_optional_token"
      }
    }
  }
}
```

The `env` block is optional. Leave it out to use GitHub without a token.

### Environment

| Variable       | Required | Effect                                                                                       |
| -------------- | -------- | -------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN` | no       | Sent as `Authorization: Bearer …` to GitHub. Raises the search limit from 10 to 30 requests/min. |

A classic or fine-grained token with no extra scopes is enough to search public issues. Results are
limited to public repositories whatever the token can access (see `is:public` below).

## Result shape

Every tool returns a text block with JSON (pretty-printed) and the same object as
`structuredContent`:

```json
{
  "count": 1,
  "results": [
    {
      "title": "research implementation for Windows",
      "repo": "radumarias/rencfs",
      "url": "https://github.com/radumarias/rencfs/issues/3",
      "labels": ["opire", "Rust"],
      "created_at": "2024-07-30T17:46:26.532Z",
      "amount_usd": 42,
      "source": "opire",
      "languages": ["Rust"]
    }
  ]
}
```

| Field          | Type                    | Notes                                                                                  |
| -------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `title`        | string                  | Issue / reward title                                                                   |
| `repo`         | string                  | `owner/name`                                                                           |
| `url`          | string                  | Issue URL                                                                              |
| `labels`       | string[]                | GitHub label names; for Opire `"opire"` plus the reported programming languages         |
| `created_at`   | string                  | ISO 8601 timestamp                                                                     |
| `amount_usd`   | number \| null          | USD amount, `null` if unknown                                                          |
| `source`       | `"github"` \| `"opire"` | Where the item came from (for merged duplicates: the entry that was kept)              |
| `currency_raw` | string (optional)       | Raw Opire amount when its unit is not `USD_CENT`, e.g. `"500 EUR_CENT"`                |
| `languages`    | string[] (optional)     | Opire: reported languages. GitHub: the `language` you searched for, if any              |
| `sources`      | string[] (optional)     | `search_bounties` only: every source the item was found in                             |

On failure a tool returns `isError: true` with a text message explaining what went wrong.
Invalid arguments (for example `limit: 500`) are rejected the same way.

## Tools

### `search_github_bounties`

Searches open GitHub issues with the `bounty` or `💎 Bounty` label, newest first.

| Parameter        | Type    | Default | Description                                                                       |
| ---------------- | ------- | ------- | --------------------------------------------------------------------------------- |
| `language`       | string  | none    | Adds `language:<x>`. In issue search this matches the **repository** language.    |
| `keywords`       | string  | none    | Free text added to the GitHub query (GitHub search syntax applies)                 |
| `min_amount_usd` | number  | none    | Keep only issues with a parsed amount of at least this many USD (when > 0, issues without a parsed amount are dropped) |
| `limit`          | integer | 20      | 1–50                                                                              |

The query sent to `GET https://api.github.com/search/issues` is:

```
is:issue is:open is:public label:bounty,"💎 Bounty" [language:<x>] [keywords]
```

with `sort=created&order=desc`. `is:public` is always present, so private repositories never show up
even when `GITHUB_TOKEN` can read them; items flagged private in the response are dropped as well.
Comma-separated values in one `label:` qualifier are ORed. Only the value containing a space is
quoted: quoting the whole list (`label:"bounty,💎 Bounty"`) makes GitHub look for one label with that
literal name, and it returns nothing.

`per_page` equals `limit`. When `min_amount_usd` is set, it fetches `min(100, limit × 2)` issues,
filters them locally and returns up to `limit`. So you can get fewer than `limit` results even when
more matching issues exist further back. (`search_bounties` always fetches 100; see below.)

Example result item:

```json
{
  "title": "USDC-quoted pairs not having the correct marketcap displayed in tools",
  "repo": "blake-guthrie/GLASS",
  "url": "https://github.com/blake-guthrie/GLASS/issues/1",
  "labels": ["bounty"],
  "created_at": "2026-10-23T19:03:20Z",
  "amount_usd": 100,
  "source": "github"
}
```

### `search_opire_rewards`

Lists open rewards from Opire, sorted by `amount_usd` descending (unknown amounts last), then newest
first. The sort happens before `limit` is applied, so a small `limit` returns the largest rewards.

| Parameter        | Type    | Default | Description                                                                 |
| ---------------- | ------- | ------- | --------------------------------------------------------------------------- |
| `keywords`       | string  | none    | Every whitespace-separated term must appear (case-insensitive) in title, repo or labels |
| `min_amount_usd` | number  | none    | Keep only rewards worth at least this many USD                              |
| `limit`          | integer | 20      | 1–50                                                                        |

The Opire endpoint is public. It returns a small list and ignores query parameters, so all filtering
happens locally. The amount comes from Opire's `pendingPrice`: `USD_CENT` values are divided by
100. Any other unit gives `amount_usd: null` and the raw value in `currency_raw`. Malformed items
in the response are skipped.

### `search_bounties`

Queries the selected sources concurrently and merges the results.

| Parameter        | Type                             | Default              | Description                                                                 |
| ---------------- | -------------------------------- | -------------------- | --------------------------------------------------------------------------- |
| `language`       | string                           | none                 | GitHub: `language:` qualifier. Opire: case-insensitive exact match on the reported languages (rewards with no languages are excluded) |
| `keywords`       | string                           | none                 | GitHub: added to the search query. Opire: all terms must match locally     |
| `min_amount_usd` | number                           | none                 | Minimum USD amount, applied after dedupe                                    |
| `limit`          | integer                          | 20                   | 1–50, applied after merging                                                 |
| `sources`        | array of `"github"` \| `"opire"` | `["github","opire"]` | Sources to query                                                            |

- **Candidates**: each source returns its full candidate set, not cut to `limit` and not filtered by
  amount. GitHub fetches one page of 100 issues (its `per_page` maximum) whatever `limit` is; Opire
  returns every reward matching `keywords` and `language`. Dedupe, the amount minimum, the sort and
  `limit` then run on the combined set, in that order. So an older, larger GitHub bounty is not lost
  because newer ones filled the first `limit` slots, and an item whose amount only one source knows
  keeps the labels and `sources` from both.

- **Dedupe**: items are matched by normalized URL. The scheme, `www.`, letter case, trailing slashes,
  query string and fragment are ignored. That way the same `https://github.com/o/r/issues/N` found by
  both sources becomes one item. The entry with a known amount wins (Opire's reported amount over an amount parsed from GitHub text; otherwise the first one seen),
  labels are combined, and `sources` lists every source it came from.
- **Sort**: `amount_usd` descending, unknown amounts last, then `created_at` newest first.
- **Partial failure**: if one source fails, the other's results are still returned and the response
  gets a `warnings` array, e.g. `["github: GitHub rate limit hit; resets at …"]`. The tool returns
  `isError` only when every selected source fails.

## Rate limits and errors

The GitHub search API allows **10 requests/minute without a token** and **30/minute with one**. To
stay under that, the server runs its own sliding-window limiter (per process). It allows **10 GitHub
searches per 60s without `GITHUB_TOKEN` and 25 per 60s with it**. When the window is full, the call
fails right away (it does not wait) with:

```
rate limit: retry in 23s
```

Each GitHub search sent counts toward the limiter, including ones that GitHub then rejects.
`search_bounties` uses one GitHub search per call when GitHub is selected. Opire is not rate-limited
locally.

When GitHub itself answers with a rate limit (429, or a rate-limit 403) and says when it resets, the
client records that time and fails every GitHub search locally until then, without sending a
request or using a limiter slot:

```
GitHub rate limit hit; resets at <ISO time>; set GITHUB_TOKEN to raise the limit (cooling down, request not sent)
```

The cooldown is per process. If the response has no usable reset time, no cooldown is set.

GitHub error responses are turned into these messages:

| Response                                                                          | Message                                                                                  |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 429, or 403 with `x-ratelimit-remaining: 0` / `retry-after` / a rate-limit message | `GitHub rate limit hit; resets at <ISO time>; set GITHUB_TOKEN to raise the limit` (with a token: `…; authenticated limit reached, wait before retrying`) |
| other 403                                                                         | `GitHub refused the request (403): <message>` (with a token, it also asks you to check `GITHUB_TOKEN`) |
| 401                                                                               | `GitHub rejected the credentials (401): <message>; GITHUB_TOKEN is invalid or expired`   |
| 422                                                                               | `GitHub rejected the search query (422): <message>; check the language and keywords`     |
| other non-2xx                                                                     | `GitHub API error <status>: <message>`                                                   |

The reset time comes from `retry-after` if present (either delta-seconds, e.g. `30`, or an HTTP-date,
e.g. `Sat, 24 Oct 2026 12:01:30 GMT`), otherwise `x-ratelimit-reset` (epoch seconds). Timeouts are 15s
for GitHub and 20s for Opire (`… request timed out after Ns`). Network failures and invalid JSON are
reported too.

## Amount parsing (GitHub)

GitHub issues have no amount field, so `amount_usd` is a **heuristic** and may be wrong or missing.
It looks in this order:

1. **Title**: the largest amount found (so `$100–$200` gives 200).
2. **Labels**: the largest amount found in any label (e.g. `$50`, `bounty: $500`).
3. **Body**: the first amount within a short distance after the words *bounty*, *reward*, *prize*,
   *paid* or *payout*. Otherwise, the first amount in the body.

Only two forms count as amounts:

- a dollar sign next to a number: `$100`, `US$100`, `$1,500`, `$2.5k`, `$1.5K`, `💰 $250`, `[$50]`, `100$`
- a number next to a currency word: `100 USD`, `USD 100`, `100 USDC`, `100 USDT`, `100 dollars`

Bare numbers (`💰 500`, `reward-100-usd`) are not guessed. `$` followed by a non-digit is ignored.
Space-separated thousands (`$1 500`, `1 500 USD`, `USD 1 500`, `1 500$`) are rejected rather than
misread as 1 or 500. Dollar signs with a letter prefix other than `US` (`CA$500`, `AU$500`, `NZ$`,
`HK$`, `SG$`, `C$`, `A$`, …) are other currencies and give no amount; `US$` counts as USD. Crypto
amounts are taken at face value (`100 USDC` = 100).

## Self-test

```sh
node dist/index.js --selftest
```

Runs one live query per source (5 results each) and prints, for example:

```
github: OK 5 results (first: <title> <url>)
opire: OK 3 results (first: <title> <url>)
selftest: 2/2 sources OK
```

A failed source prints `github: FAILED: <message>`. The exit code is 0 if at least one source
succeeded, otherwise 1.

Other flags: `--help` (usage, including `GITHUB_TOKEN`) and `--version`. Without flags the MCP
server runs on stdin/stdout. Logs go to stderr only, because stdout carries the MCP protocol.

## Development

```sh
npm install
npm run build      # compiles src/ to dist/
npm test           # vitest; no network access, fetch is mocked with recorded fixtures
npm run typecheck  # type-checks src/ and test/
```

Layout:

```
src/index.ts      CLI entry (--selftest, --help, --version, or start the stdio server)
src/server.ts     createServer(): tool registration and search_bounties orchestration
src/github.ts     GitHub search client, query building, error mapping
src/opire.ts      Opire client, lenient parsing, local filtering
src/merge.ts      URL normalization, dedupe, sorting, amount filter
src/parse.ts      amount parsing heuristics
src/ratelimit.ts  sliding-window rate limiter
src/selftest.ts   --selftest
test/             vitest suites and recorded API fixtures
```

## License

[MIT](LICENSE) © 2026 synthalorian
