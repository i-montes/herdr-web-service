import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnv, writeEnv } from "./env.ts";

test("writeEnv creates the file with mode 600 and the keys", () => {
  const path = join(mkdtempSync(join(tmpdir(), "env-")), ".env");
  writeEnv(path, { HOST: "127.0.0.1", PORT: "7340" });
  expect(readEnv(path)).toEqual({ HOST: "127.0.0.1", PORT: "7340" });
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("writeEnv keeps comments and other keys, replaces and deletes", () => {
  const path = join(mkdtempSync(join(tmpdir(), "env-")), ".env");
  writeFileSync(path, "# mine\nFOO=1\nPUBLIC_URL=http://a\n");
  writeEnv(path, { PUBLIC_URL: "https://b", FOO: null, TUNNEL: "portal" });
  expect(readFileSync(path, "utf8")).toBe("# mine\nPUBLIC_URL=https://b\nTUNNEL=portal\n");
});

test("writeEnv replaces a duplicated key with exactly one line", () => {
  const path = join(mkdtempSync(join(tmpdir(), "env-")), ".env");
  writeFileSync(path, "A=1\nB=2\nA=2\n");
  writeEnv(path, { A: "x" });
  expect(readFileSync(path, "utf8")).toBe("A=x\nB=2\n");
  expect(readEnv(path).A).toBe("x");
});

test("writeEnv deletes every occurrence of a duplicated key", () => {
  const path = join(mkdtempSync(join(tmpdir(), "env-")), ".env");
  writeFileSync(path, "A=1\nB=2\nA=2\n");
  writeEnv(path, { A: null });
  expect(readFileSync(path, "utf8")).toBe("B=2\n");
  expect(readEnv(path)).toEqual({ B: "2" });
});

test("readEnv on a missing file returns an empty object", () => {
  expect(readEnv(join(mkdtempSync(join(tmpdir(), "env-")), "nope"))).toEqual({});
});
