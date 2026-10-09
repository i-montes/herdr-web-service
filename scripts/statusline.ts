#!/usr/bin/env bun
/**
 * Claude Code status line. Claude Code runs this on every status update with a JSON description
 * of the session on stdin (model, context window, plan rate limits). It is saved per session for
 * the web chat (`<state dir>/claude-status/<session_id>.json`) and a short line is printed for
 * the terminal: `ctx 62% · 5h 34% · sem 12%`.
 *
 * Usage (settings.json → statusLine.command): bun <plugin>/scripts/statusline.ts <state dir>
 * Never fails loudly: a broken status line must not disturb Claude Code.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Raw = Record<string, unknown>;

const stateDir = process.argv[2];
let input: Raw = {};
try {
  input = JSON.parse(await Bun.stdin.text()) as Raw;
} catch {
  /* nothing usable: print nothing */
}

const sessionId = typeof input["session_id"] === "string" ? input["session_id"] : "";
if (stateDir && /^[A-Za-z0-9-]{8,80}$/.test(sessionId)) {
  try {
    const dir = join(stateDir, "claude-status");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${sessionId}.json`);
    writeFileSync(file + ".tmp", JSON.stringify({ saved_at: Date.now(), status: input }), { mode: 0o600 });
    renameSync(file + ".tmp", file);
  } catch {
    /* the web view just goes without */
  }
}

const pct = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? `${Math.round(v)}%` : null);
const ctx = (input["context_window"] ?? {}) as Raw;
const limits = (input["rate_limits"] ?? {}) as Raw;
const parts = [
  pct(ctx["used_percentage"]) && `ctx ${pct(ctx["used_percentage"])}`,
  pct((limits["five_hour"] as Raw | undefined)?.["used_percentage"]) && `5h ${pct((limits["five_hour"] as Raw)["used_percentage"])}`,
  pct((limits["seven_day"] as Raw | undefined)?.["used_percentage"]) && `sem ${pct((limits["seven_day"] as Raw)["used_percentage"])}`,
].filter(Boolean);
process.stdout.write(parts.join(" · "));
