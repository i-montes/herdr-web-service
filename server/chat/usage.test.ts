import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeUsage, readClaudeStatus } from "./usage.ts";

const payload = {
  session_id: "19112c99-626e-45ea-b107-ac59b670c983",
  model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
  effort: { level: "medium" },
  context_window: { total_input_tokens: 53624, context_window_size: 1000000, current_usage: { input_tokens: 2, output_tokens: 4, cache_creation_input_tokens: 27869, cache_read_input_tokens: 25753 }, used_percentage: 5 },
  rate_limits: { five_hour: { used_percentage: 26, resets_at: 1791524400 }, seven_day: { used_percentage: 58, resets_at: 1791842400 } },
  cost: { total_cost_usd: 0.228 },
};

test("Claude's status line payload", () => {
  expect(claudeUsage(payload, 42)).toEqual({
    context: { percent: 5, used: 53624, size: 1000000 },
    fiveHour: { percent: 26, resetsAt: 1791524400000 },
    week: { percent: 58, resetsAt: 1791842400000 },
    model: "Opus 5.5",
    effort: "medium",
    costUsd: 0.228,
    updatedAt: 42,
  });
});

test("plans without rate limits still get the context; an empty payload gives nothing", () => {
  const { rate_limits: _, ...api } = payload;
  expect(claudeUsage(api, 1)).toMatchObject({ context: { percent: 5 }, fiveHour: null, week: null });
  expect(claudeUsage({}, 1)).toBeNull();
});

const dir = mkdtempSync(join(tmpdir(), "hw-usage-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("reads the saved file; bad ids and missing files give null", () => {
  mkdirSync(join(dir, "claude-status"));
  writeFileSync(join(dir, "claude-status", `${payload.session_id}.json`), JSON.stringify({ saved_at: 7, status: payload }));
  expect(readClaudeStatus(dir, payload.session_id)?.week?.percent).toBe(58);
  expect(readClaudeStatus(dir, "../../etc/passwd")).toBeNull();
  expect(readClaudeStatus(dir, "aaaaaaaa-0000")).toBeNull();
});
