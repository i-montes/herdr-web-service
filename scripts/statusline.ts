#!/usr/bin/env bun
/**
 * Claude Code status line. Claude Code runs this on every status update with a JSON description
 * of the session on stdin (model, context window, plan rate limits). It is saved per session for
 * the web chat (`<state dir>/claude-status/<session_id>.json`) and a short line is printed for
 * the terminal: `ctx 62% · 5h 34% · sem 12%`. A status line that was there before (saved by
 * `setup` in `<config dir>/claude-statusline.json`) runs first with the same input and its output
 * leads the line.
 *
 * Usage (settings.json → statusLine.command): bun <plugin>/scripts/statusline.ts <state dir> <config dir>
 * Never fails loudly: a broken status line must not disturb Claude Code.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Raw = Record<string, unknown>;

const [stateDir, configDir] = process.argv.slice(2);
/** the chained status line gets this long before it is left out */
const PREVIOUS_TIMEOUT_MS = 2000;

const raw = await Bun.stdin.text();
let input: Raw = {};
try {
  input = JSON.parse(raw) as Raw;
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

/** Output of the chained status line, "" when there is none or it fails or hangs. */
async function previous(): Promise<string> {
  if (!configDir) return "";
  let command: unknown;
  try {
    const saved = JSON.parse(readFileSync(join(configDir, "claude-statusline.json"), "utf8")) as { previous?: Raw };
    command = saved.previous?.["command"];
  } catch {
    return "";
  }
  if (typeof command !== "string" || !command.trim()) return "";
  try {
    const proc = Bun.spawn(["sh", "-c", command], { stdin: new Blob([raw]), stdout: "pipe", stderr: "ignore" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), PREVIOUS_TIMEOUT_MS)));
    const done = Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const result = await Promise.race([done, timeout]);
    clearTimeout(timer);
    if (!result) {
      proc.kill("SIGKILL");
      return "";
    }
    return result[1] === 0 ? result[0].trimEnd() : "";
  } catch {
    return "";
  }
}

const theirs = await previous();
await Bun.write(Bun.stdout, [theirs, parts.join(" · ")].filter(Boolean).join(" · "));
// a killed chained command may leave a grandchild holding a pipe open: do not wait for it
process.exit(0);
