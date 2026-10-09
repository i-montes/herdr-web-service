import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "slrun-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const INPUT = JSON.stringify({
  session_id: "abcdef12-3456",
  context_window: { used_percentage: 62.4 },
  rate_limits: { five_hour: { used_percentage: 34 }, seven_day: { used_percentage: 12 } },
});

async function run(previous?: string): Promise<{ out: string; ms: number }> {
  if (previous !== undefined) {
    writeFileSync(join(dir, "claude-statusline.json"), JSON.stringify({ previous: { type: "command", command: previous } }));
  }
  const started = Date.now();
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "statusline.ts"), join(dir, "state"), dir], {
    stdin: new Blob([INPUT]),
    stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return { out, ms: Date.now() - started };
}

test("alone: prints our segments and saves the status for the web", async () => {
  expect((await run()).out).toBe("ctx 62% · 5h 34% · sem 12%");
  expect(existsSync(join(dir, "state", "claude-status", "abcdef12-3456.json"))).toBe(true);
});

test("chained: the previous status line gets the same input and goes first", async () => {
  const { out } = await run(`printf 'mine:'; grep -o abcdef12 ; echo`);
  expect(out).toBe("mine:abcdef12 · ctx 62% · 5h 34% · sem 12%");
});

test("a failing previous status line is skipped", async () => {
  expect((await run("echo broken >&2; exit 3")).out).toBe("ctx 62% · 5h 34% · sem 12%");
});

test("a hung previous status line is cut off after 2 s", async () => {
  const { out, ms } = await run("sleep 10; echo late");
  expect(out).toBe("ctx 62% · 5h 34% · sem 12%");
  expect(ms).toBeLessThan(4000);
});
