/**
 * Context and plan usage for the chat header. Claude Code hands it to its status line
 * (scripts/statusline.ts saves it per session under `<state dir>/claude-status/`): context window
 * size and use, the 5-hour and weekly rate limits with their reset times, model, effort, cost.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentUsage, UsageWindow } from "../../shared/protocol.ts";

type Raw = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function window(raw: unknown): UsageWindow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const percent = num((raw as Raw)["used_percentage"]);
  if (percent === null) return null;
  const resets = num((raw as Raw)["resets_at"]);
  // Claude reports seconds; anything already in ms passes through
  return { percent, resetsAt: resets === null ? null : resets < 1e12 ? resets * 1000 : resets };
}

/** the status line payload Claude Code sent → usage; null when it carries nothing useful */
export function claudeUsage(status: Raw, savedAt: number): AgentUsage | null {
  const ctx = (status["context_window"] ?? {}) as Raw;
  const size = num(ctx["context_window_size"]);
  const percent = num(ctx["used_percentage"]);
  const current = (ctx["current_usage"] ?? {}) as Raw;
  const used = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].reduce((sum, k) => sum + (num(current[k]) ?? 0), 0);
  const limits = (status["rate_limits"] ?? {}) as Raw;
  const usage: AgentUsage = {
    context: size && percent !== null ? { percent, used, size } : null,
    fiveHour: window(limits["five_hour"]),
    week: window(limits["seven_day"]),
    model: typeof (status["model"] as Raw | undefined)?.["display_name"] === "string" ? ((status["model"] as Raw)["display_name"] as string) : null,
    effort: typeof (status["effort"] as Raw | undefined)?.["level"] === "string" ? ((status["effort"] as Raw)["level"] as string) : null,
    costUsd: num((status["cost"] as Raw | undefined)?.["total_cost_usd"]),
    updatedAt: savedAt,
  };
  return usage.context || usage.fiveHour || usage.week ? usage : null;
}

/** what the status line last saved for a Claude session; null when it never ran for it */
export function readClaudeStatus(stateDir: string, sessionId: string): AgentUsage | null {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(sessionId)) return null;
  try {
    const saved = JSON.parse(readFileSync(join(stateDir, "claude-status", `${sessionId}.json`), "utf8")) as { saved_at?: unknown; status?: unknown };
    if (typeof saved.status !== "object" || saved.status === null) return null;
    return claudeUsage(saved.status as Raw, num(saved.saved_at) ?? 0);
  } catch {
    return null;
  }
}
