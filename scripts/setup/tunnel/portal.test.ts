import { expect, test } from "bun:test";
import { exposeArgs, portalName, readyUrlFrom } from "./portal.ts";

test("portalName uses the short hostname, lowercased", () => {
  expect(portalName("Box.local")).toBe("herdr-box");
  expect(portalName("vps1")).toBe("herdr-vps1");
});

test("exposeArgs", () => {
  expect(exposeArgs("herdr-box", 7340)).toEqual([
    "expose", "--name", "herdr-box", "--http-route", "/=http://127.0.0.1:7340", "--discovery=false",
  ]);
});

test("readyUrlFrom", () => {
  expect(readyUrlFrom("service ready at https://herdr-box-ab12.relay.example:443")).toBe(
    "https://herdr-box-ab12.relay.example:443",
  );
  expect(readyUrlFrom("connecting...")).toBeNull();
});

import { isValidName, ensureInstalled } from "./portal.ts";
import type { Runner } from "./run.ts";

test("portalName sanitizes to a DNS label", () => {
  expect(portalName("My_Mac Book.local")).toBe("herdr-my-mac-book");
  expect(portalName("")).toBe("herdr-web");
  const long = portalName("a".repeat(100));
  expect(long.length).toBeLessThanOrEqual(63);
  expect(long.endsWith("-")).toBe(false);
  expect(portalName("Iván's Mac")).toMatch(/^[a-z0-9-]+$/);
  expect(portalName("a".repeat(56) + "-b")).not.toMatch(/-$/);
});

test("isValidName", () => {
  for (const bad of ["a b", "-x", "x\n", "", "x-", "A"]) expect(isValidName(bad)).toBe(false);
  expect(isValidName("herdr-box")).toBe(true);
});

test("ensureInstalled fails when the installer fails", async () => {
  const run: Runner = async (argv) =>
    argv[0] === "bash" ? { code: 1, stdout: "", stderr: "" } : { code: 127, stdout: "", stderr: "" };
  await expect(ensureInstalled(run)).rejects.toThrow("installation failed");
});

test("ensureInstalled fails when the binary is still missing", async () => {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push(argv);
    return argv[0] === "bash" ? { code: 0, stdout: "", stderr: "" } : { code: 127, stdout: "", stderr: "" };
  };
  await expect(ensureInstalled(run)).rejects.toThrow("cannot be found");
  expect(calls.find((c) => c[0] === "bash")?.[2]).toContain("set -o pipefail");
});

test("ensureInstalled returns the absolute path found after install", async () => {
  let installed = false;
  const run: Runner = async (argv) => {
    if (argv[0] === "bash") { installed = true; return { code: 0, stdout: "", stderr: "" }; }
    const ok = installed && argv[0]!.endsWith("/.local/bin/portal");
    return { code: ok ? 0 : 127, stdout: "", stderr: "" };
  };
  expect(await ensureInstalled(run)).toMatch(/\/\.local\/bin\/portal$/);
});
