import { expect, test } from "bun:test";
import { fitTerminal, isRule } from "./terminal.ts";

test("rules are recognised", () => {
  expect(isRule("────────────")).toBe(true);
  expect(isRule("  ━━━━━━  ")).toBe(true);
  expect(isRule("── title ──")).toBe(false);
  expect(isRule("--")).toBe(false);
});

test("a narrow screen keeps the largest font", () => {
  expect(fitTerminal(["ls", "file.txt"], 340)).toEqual({ fontPx: 14, wrap: false });
});

test("the font shrinks to fit, rules and trailing spaces do not count", () => {
  // 50 columns in 340px: 340 / (50 * 0.6) = 11.3
  expect(fitTerminal(["x".repeat(50) + "      ", "─".repeat(160)], 340)).toEqual({ fontPx: 11.3, wrap: false });
});

test("too wide even at the minimum: wrap", () => {
  expect(fitTerminal(["x".repeat(160)], 340)).toEqual({ fontPx: 10, wrap: true });
});
