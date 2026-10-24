/**
 * Heuristic USD amount extraction from free text.
 *
 * Only two forms are recognised, to avoid guessing at bare numbers:
 *   - a dollar sign next to a number: "$100", "US$100", "$1,500", "$2.5k", "100$"
 *   - a number next to a currency word: "100 USD", "USD 100", "100 USDC",
 *     "100 USDT", "100 dollars"
 * Thousands separators must be commas in groups of three; "$1 500" is not
 * read as 1500 (it is rejected rather than misread as 1), and neither is
 * "1 500 USD". A "k" suffix multiplies by 1000. Zero amounts are ignored.
 * Other dollars written with a letter prefix ("CA$500", "AU$500", "HK$",
 * "C$", "A$", ...) are not USD and give no amount; only "US$" is accepted.
 */

const NUM = String.raw`((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)`;
const K = String.raw`(?:\s?([kK])(?![a-zA-Z]))?`;
// The number must not continue (e.g. "$1 500", "$1.5.3"), so a partial match is rejected.
const END = String.raw`(?!\d|[.,]\d|\s\d)`;
// The number must not be the tail of a longer token ("v2", "1.100") or of a
// space-separated number ("1 500").
const START = String.raw`(?<![\w.,])(?<!\d\s)`;

const PATTERNS: RegExp[] = [
  // $100, US$ 100, $2.5k; letters other than "US" right before "$" (CA$, AU$, C$) disqualify it
  new RegExp(String.raw`(?<![a-zA-Z])(?:[uU][sS])?\$\s?${NUM}${K}${END}`, "g"),
  // 100$, 2.5k $
  new RegExp(String.raw`${START}${NUM}${K}\s?\$`, "g"),
  // 100 USD, 100 USDC, 100 US dollars, 100 dollars
  new RegExp(String.raw`${START}${NUM}${K}\s?(?:USD[CT]?|US\s?dollars?|dollars?)(?![a-zA-Z])`, "gi"),
  // USD 100, USDC 1,000
  new RegExp(String.raw`(?<![a-zA-Z])USD[CT]?\s?${NUM}${K}${END}`, "gi"),
];

export interface AmountMatch {
  value: number;
  index: number;
}

function toValue(num: string, k: string | undefined): number {
  const n = Number(num.replace(/,/g, ""));
  return k ? n * 1000 : n;
}

/** All amounts found in `text`, ordered by position. */
export function findAmounts(text: string): AmountMatch[] {
  const found: AmountMatch[] = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const value = toValue(m[1] ?? "", m[2]);
      if (Number.isFinite(value) && value > 0) found.push({ value, index: m.index ?? 0 });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/** Largest amount in `text` (so "$100–$200" gives 200), or null. */
export function parseAmountUsd(text: string): number | null {
  const amounts = findAmounts(text);
  if (amounts.length === 0) return null;
  return Math.max(...amounts.map((a) => a.value));
}

const KEYWORD = /\b(?:bounty|bounties|reward|rewards|prize|paid|payout)\b/gi;
const KEYWORD_WINDOW = 80;

/**
 * Amount in a longer body of text: the first amount within a short window
 * after a bounty/reward/prize/paid keyword, otherwise the first amount.
 */
export function parseBodyAmount(text: string): number | null {
  const amounts = findAmounts(text);
  if (amounts.length === 0) return null;
  for (const kw of text.matchAll(KEYWORD)) {
    const start = (kw.index ?? 0) + kw[0].length;
    const hit = amounts.find((a) => a.index >= start && a.index <= start + KEYWORD_WINDOW);
    if (hit) return hit.value;
  }
  return amounts[0]?.value ?? null;
}

export interface AmountFields {
  title?: string | null;
  labels?: readonly string[] | null;
  body?: string | null;
}

/** Title first, then labels (largest), then body. */
export function parseAmountFromFields({ title, labels, body }: AmountFields): number | null {
  const fromTitle = title ? parseAmountUsd(title) : null;
  if (fromTitle !== null) return fromTitle;
  const fromLabels = (labels ?? [])
    .map((l) => parseAmountUsd(l))
    .filter((v): v is number => v !== null);
  if (fromLabels.length > 0) return Math.max(...fromLabels);
  return body ? parseBodyAmount(body) : null;
}
