import { test, expect } from "bun:test";
import { versionAtLeast } from "./preflight.ts";

test("versionAtLeast compares numerically", () => {
  expect(versionAtLeast("0.9.3", "0.9.0")).toBe(true);
  expect(versionAtLeast("0.9.0", "0.9.0")).toBe(true);
  expect(versionAtLeast("0.10.0", "0.9.3")).toBe(true);
  expect(versionAtLeast("0.8.9", "0.9.0")).toBe(false);
  expect(versionAtLeast("1.2", "1.2.1")).toBe(false);
});

test("versionAtLeast tolerates a prefix", () => {
  expect(versionAtLeast("herdr 0.9.3", "0.9.0")).toBe(true);
  expect(versionAtLeast("herdr 0.8.0", "0.9.0")).toBe(false);
});

test("versionAtLeast is false when there is no version", () => {
  expect(versionAtLeast("", "0.9.0")).toBe(false);
});
