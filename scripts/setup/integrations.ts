/**
 * Herdr's agent integrations for the agents the web chat reads. Without one, Herdr does not know
 * which conversation runs in a pane and the chat picks the newest one in the folder (the wrong one
 * when there are several); with it, the agent reports its session to Herdr on start.
 *
 * `herdr integration status` prints one line per agent:
 *   claude: current (v10) (/home/u/.claude/hooks/herdr-agent-state.sh)
 *   opencode: not installed (/home/u/.config/opencode/plugins/herdr-agent-state.js)
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Runner } from "./tunnel/run.ts";

export type IntegrationId = "claude" | "opencode";

export const CHAT_INTEGRATIONS: { id: IntegrationId; label: string; what: string }[] = [
  { id: "claude", label: "Claude Code", what: "a SessionStart hook in ~/.claude/settings.json" },
  { id: "opencode", label: "OpenCode", what: "a plugin in ~/.config/opencode" },
];

export interface IntegrationState {
  id: IntegrationId;
  label: string;
  what: string;
  status: "current" | "missing" | "outdated";
  /** whether the agent is set up on this machine (its config folder exists): Herdr needs it */
  agentPresent: boolean;
}

/** agent id → its status text and the file the integration installs */
export function parseIntegrationStatus(stdout: string): Map<string, { status: string; target: string }> {
  const out = new Map<string, { status: string; target: string }>();
  for (const line of stdout.split("\n")) {
    const m = /^([\w-]+): (.+) \(([^()]+)\)\s*$/.exec(line.trim());
    if (m) out.set(m[1]!, { status: m[2]!.trim(), target: m[3]! });
  }
  return out;
}

export function herdrBin(): string {
  return process.env["HERDR_BIN_PATH"] || "herdr";
}

/** the chat's integrations and where each stands; throws when Herdr cannot tell */
export async function integrationStates(run: Runner, bin = herdrBin(), exists: (path: string) => boolean = existsSync): Promise<IntegrationState[]> {
  const result = await run([bin, "integration", "status"]);
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || `exit ${result.code}`);
  const parsed = parseIntegrationStatus(result.stdout);
  return CHAT_INTEGRATIONS.map(({ id, label, what }) => {
    const found = parsed.get(id);
    const status = !found || /^not installed/.test(found.status) ? "missing" : /^current\b/.test(found.status) ? "current" : "outdated";
    // the integration file sits one folder inside the agent's config folder (hooks/, plugins/)
    return { id, label, what, status, agentPresent: !!found && exists(dirname(dirname(found.target))) };
  });
}

export async function installIntegration(run: Runner, id: IntegrationId, bin = herdrBin()): Promise<{ ok: boolean; message: string }> {
  const result = await run([bin, "integration", "install", id]);
  return { ok: result.code === 0, message: (result.code === 0 ? result.stdout : result.stderr || result.stdout).trim() };
}
