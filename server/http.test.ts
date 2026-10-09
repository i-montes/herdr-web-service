import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRegularFile } from "./http.ts";

test("isRegularFile accepts files only", () => {
  const dir = mkdtempSync(join(tmpdir(), "static-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html>");
  expect(isRegularFile(join(dir, "index.html"))).toBe(true);
  expect(isRegularFile(join(dir, "assets"))).toBe(false);
  expect(isRegularFile(join(dir, "missing.js"))).toBe(false);
});
