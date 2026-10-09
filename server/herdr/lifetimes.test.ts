import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrClient } from "./client.ts";
import { PaneLifetimes, loadStatusMemory, parseEtime, parsePsStarts, saveStatusMemory } from "./lifetimes.ts";

test("ps elapsed times, with and without hours and days", () => {
  expect(parseEtime("00:07")).toBe(7);
  expect(parseEtime("12:34")).toBe(754);
  expect(parseEtime(" 06:31:45")).toBe(6 * 3600 + 31 * 60 + 45);
  expect(parseEtime("2-03:00:05")).toBe(2 * 86400 + 3 * 3600 + 5);
  expect(parseEtime("")).toBeNull();
  expect(parseEtime("soon")).toBeNull();
});

test("ps lines become start times, to the second", () => {
  const starts = parsePsStarts(" 345540    06:31:45\n 345850 00:10\n\n", 100_000_500);
  expect(starts.get(345540)).toBe((100_000 - 23_505) * 1000);
  expect(starts.get(345850)).toBe((100_000 - 10) * 1000);
  expect(starts.size).toBe(2);
});

test("each terminal's start is asked once, the closed ones forgotten", async () => {
  const asked: string[] = [];
  const herdr = {
    request: async (_method: string, params: { pane_id: string }) => {
      asked.push(params.pane_id);
      return { process_info: { shell_pid: params.pane_id === "w1:p1" ? process.pid : 999_999_999 } };
    },
  } as unknown as HerdrClient;
  const lifetimes = new PaneLifetimes();
  const now = Date.now();
  await lifetimes.update(herdr, [{ pane_id: "w1:p1", terminal_id: "t1" }, { pane_id: "w1:p2", terminal_id: "t2" }], now);
  const opened = lifetimes.opened.get("t1");
  expect(typeof opened).toBe("number");
  expect(opened!).toBeLessThanOrEqual(now);
  expect(lifetimes.opened.get("t2")).toBeNull(); // no such process
  await lifetimes.update(herdr, [{ pane_id: "w1:p1", terminal_id: "t1" }], now);
  expect(asked).toEqual(["w1:p1", "w1:p2"]);
  expect([...lifetimes.opened.keys()]).toEqual(["t1"]);
});

test("the status memory survives a restart, and only valid entries come back", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-web-panes-"));
  expect(loadStatusMemory(dir).size).toBe(0);
  saveStatusMemory(dir, new Map([["w1:p1", { status: "working", changed_at: 1000, terminal_id: "t1" }]]));
  expect(statSync(join(dir, "panes.json")).mode & 0o777).toBe(0o600);
  expect([...loadStatusMemory(dir)]).toEqual([["w1:p1", { status: "working", changed_at: 1000, terminal_id: "t1" }]]);
  writeFileSync(join(dir, "panes.json"), JSON.stringify({ a: { status: "weird", terminal_id: "t" }, b: { status: "idle" }, c: { status: "done", changed_at: "x", terminal_id: "t3" } }));
  expect([...loadStatusMemory(dir)]).toEqual([["c", { status: "done", changed_at: null, terminal_id: "t3" }]]);
  expect(existsSync(join(dir, "panes.json"))).toBe(true);
});
