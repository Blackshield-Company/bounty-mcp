# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-24

### Added

- MCP server over stdio with three tools:
  - `search_github_bounties`: open GitHub issues labelled `bounty` or `💎 Bounty`,
    with optional language, keywords, minimum amount and limit.
  - `search_opire_rewards`: rewards from the public Opire API, filtered locally
    by keywords and minimum amount, sorted by amount (unknown last) then newest
    first before the limit is applied.
  - `search_bounties`: both sources queried concurrently, deduped by normalized
    URL, sorted by amount (unknown last) then newest first, with per-source
    warnings when one source fails. Each source returns its full candidate set
    (GitHub: one page of 100), and the amount minimum, sort and limit are
    applied after dedupe, so merged items keep labels and sources from both.
- GitHub searches are restricted to public repositories (`is:public`), and
  items flagged private in the response are dropped, so a token with private
  access never surfaces private issues.
- Heuristic USD amount parsing from issue titles, labels and bodies. `US$` is
  read as USD; other letter-prefixed dollars (`CA$`, `AU$`, `HK$`, `C$`, …) and
  space-separated thousands (`1 500 USD`, `$1 500`) give no amount.
- Client-side sliding-window rate limiter for GitHub search (10/min without a
  token, 25/min with `GITHUB_TOKEN`), plus clear messages for GitHub 401, 403,
  422 and 429 responses.
- Upstream GitHub rate-limit cooldown: after a 429 or rate-limit 403, searches
  fail locally until the reset time from `Retry-After` (seconds or HTTP-date)
  or `x-ratelimit-reset`.
- Request timeouts (15s GitHub, 20s Opire).
- `--selftest`, `--help` and `--version` command-line flags.
