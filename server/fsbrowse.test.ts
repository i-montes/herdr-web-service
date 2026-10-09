import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandHome, listDirs } from "./fsbrowse.ts";

const home = mkdtempSync(join(tmpdir(), "hw-home-"));
mkdirSync(join(home, "p/app/.git"), { recursive: true });
writeFileSync(join(home, "p/app/.git/HEAD"), "ref: refs/heads/develop\n");
mkdirSync(join(home, "p/zeta"));
mkdirSync(join(home, "p/.hidden"));
writeFileSync(join(home, "p/file.txt"), "x");
symlinkSync("/", join(home, "p/escape"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("lists visible subfolders sorted, with their git branch", () => {
  const r = listDirs("~/p", home);
  expect(r).toEqual({ ok: true, path: "~/p", dirs: [{ name: "app", git: "develop" }, { name: "zeta", git: null }] });
});

test("home itself and the default", () => {
  expect(listDirs("~", home)).toMatchObject({ ok: true, path: "~", dirs: [{ name: "p", git: null }] });
  expect(listDirs("", home)).toMatchObject({ ok: true, path: "~" });
});

test("refuses paths outside home, through .. or a symlink", () => {
  expect(listDirs("/etc", home).ok).toBe(false);
  expect(listDirs("~/../..", home).ok).toBe(false);
  expect(listDirs("~/p/escape", home).ok).toBe(false);
  expect(listDirs("~/p/file.txt", home).ok).toBe(false);
  expect(listDirs("~/nope", home).ok).toBe(false);
});

test("expandHome", () => {
  expect(expandHome("~", home)).toBe(home);
  expect(expandHome("~/p", home)).toBe(join(home, "p"));
  expect(expandHome("/abs", home)).toBe("/abs");
});
