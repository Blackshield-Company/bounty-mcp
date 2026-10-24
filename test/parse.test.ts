import { describe, expect, it } from "vitest";
import { findAmounts, parseAmountFromFields, parseAmountUsd, parseBodyAmount } from "../src/parse.js";

describe("parseAmountUsd", () => {
  it.each([
    ["$100", 100],
    ["Fix the bug for $1,500", 1500],
    ["$1,234,567", 1234567],
    ["$2.5k bounty", 2500],
    ["Reward $1.5K", 1500],
    ["$ 75", 75],
    ["US$300", 300],
    ["100 USD", 100],
    ["USD 100", 100],
    ["usd 40", 40],
    ["100 USDC", 100],
    ["250 USDT", 250],
    ["USDC 1,000", 1000],
    ["50 dollars", 50],
    ["20 US dollars", 20],
    ["💰 $250", 250],
    ["[$50] Add dark mode", 50],
    ["Bounty: 100$", 100],
    ["$100–$200", 200],
    ["$100-$200 depending on scope", 200],
    ["bounty: $500", 500],
    ["$12.50", 12.5],
    ["2k USD", 2000],
    ["US$ 1,500", 1500],
    ["us$40", 40],
    ["HK$500 or US$300", 300],
    ["1,500 USD", 1500],
    ["USD 1,500", 1500],
    ["paid 2 times, $40 each", 40],
  ])("%s -> %s", (text, expected) => {
    expect(parseAmountUsd(text)).toBe(expected);
  });

  it.each([
    [""],
    ["no amount here"],
    ["💰 500"],
    ["reward-100-usd"],
    ["$ fix the thing"],
    ["costs $$ to run"],
    ["$1 500"],
    ["$0"],
    ["USDC-quoted pairs not having the correct marketcap"],
    ["version 2.100 released"],
    ["issue #100"],
    ["the $HOME variable"],
    // Non-US dollars written with a letter prefix
    ["CA$500"],
    ["AU$500"],
    ["NZ$500"],
    ["HK$500"],
    ["SG$500"],
    ["C$500"],
    ["A$ 500"],
    ["R$1,000"],
    ["AUS$500"],
    ["Bounty: CA$2.5k"],
    // Space-separated thousands, in every form
    ["1 500 USD"],
    ["1 500 dollars"],
    ["1 500 USDC"],
    ["1 500$"],
    ["USD 1 500"],
    ["USDC 1 500"],
    ["US$1 500"],
  ])("%s -> null", (text) => {
    expect(parseAmountUsd(text)).toBeNull();
  });

  it("does not treat a following word starting with k as a multiplier", () => {
    expect(parseAmountUsd("$5 kids")).toBe(5);
  });

  it("takes the largest of several amounts", () => {
    expect(parseAmountUsd("$50 now, $300 on merge, $100 bonus")).toBe(300);
  });
});

describe("findAmounts", () => {
  it("orders matches by position", () => {
    const values = findAmounts("first $20 then 100 USD").map((a) => a.value);
    expect(values[0]).toBe(20);
    expect(values).toContain(100);
  });
});

describe("parseBodyAmount", () => {
  it("prefers the amount following a bounty keyword", () => {
    expect(parseBodyAmount("Server costs $20/month. Bounty: $400 for a fix.")).toBe(400);
    expect(parseBodyAmount("We spent $1,000 already; the reward is 150 USDC")).toBe(150);
    expect(parseBodyAmount("Fix this problem to get paid in fees of $100")).toBe(100);
  });

  it("falls back to the first amount", () => {
    expect(parseBodyAmount("Costs $20 to host and $5 to test")).toBe(20);
  });

  it("returns null without amounts", () => {
    expect(parseBodyAmount("This bounty has no amount yet")).toBeNull();
  });
});

describe("parseAmountFromFields", () => {
  it("uses the title first", () => {
    expect(parseAmountFromFields({ title: "[$300] Port to ARM", labels: ["$50"], body: "bounty $10" })).toBe(300);
  });

  it("then the largest label", () => {
    expect(parseAmountFromFields({ title: "Port to ARM", labels: ["bounty", "$50", "💎 Bounty", "$75"], body: "$10" })).toBe(75);
  });

  it("then the body", () => {
    expect(parseAmountFromFields({ title: "Port to ARM", labels: ["bounty"], body: "Reward: 80 USD" })).toBe(80);
  });

  it("returns null when nothing matches", () => {
    expect(parseAmountFromFields({ title: "Port to ARM", labels: [], body: null })).toBeNull();
    expect(parseAmountFromFields({})).toBeNull();
  });
});
