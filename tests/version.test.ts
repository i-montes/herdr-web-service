import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };

// the marketplace shows the manifest's version, /api/health reports package.json's: one number
test("herdr-plugin.toml and package.json carry the same version", () => {
  const manifest = /^version = "([^"]+)"$/m.exec(readFileSync(new URL("../herdr-plugin.toml", import.meta.url), "utf8"))?.[1];
  expect(manifest).toBe(pkg.version);
});
