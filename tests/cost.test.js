import { describe, it, expect } from "vitest";
import { TOKENS_PER_TOOL, coldEstTokens, countColdTools, formatTokens, injectTokens, savedTokens } from "../lib/cost.js";

describe("cost", () => {
  it("counts tool lines and skips Goal/Recall", () => {
    expect(
      countColdTools([
        { t: "Goal", prompt: "x" },
        { t: "Recall", hit: "a" },
        { t: "Grep", target: "r2" },
        { t: "Write", target: "a.ts" },
        { t: "Bash", target: "tsc" },
      ]),
    ).toBe(3);
  });

  it("estimates cold tokens from tool count", () => {
    expect(coldEstTokens(8, 2)).toBe(8 * TOKENS_PER_TOOL);
    expect(coldEstTokens(0, 3)).toBe(3 * TOKENS_PER_TOOL);
  });

  it("saved tokens is cold minus injected recipe", () => {
    const node = { cold_est_tokens: 4800, steps: [{ t: "Bash", target: "x" }] };
    const inject = "abcd"; // 1 token
    expect(injectTokens(inject)).toBe(1);
    expect(savedTokens(node, inject)).toBe(4799);
  });

  it("falls back to step count when no cold stamp", () => {
    expect(savedTokens({ steps: [{ t: "A", target: "1" }, { t: "B", target: "2" }] }, "")).toBe(1200);
  });

  it("formats token totals like the UI", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(900)).toBe("900");
    expect(formatTokens(1100)).toBe("1.1k");
    expect(formatTokens(6200)).toBe("6.2k");
    expect(formatTokens(82000)).toBe("82k");
  });
});
