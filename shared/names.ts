/** How agents and sessions are named, the same in the web app and in the server's notifications. */
import type { RosterPane } from "./protocol.ts";

export const AGENT_LABELS: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };

export function agentLabel(agent: string | null): string {
  if (!agent) return "Shell";
  return AGENT_LABELS[agent] ?? agent[0]!.toUpperCase() + agent.slice(1);
}

/** the name a session goes by: the name it was given, the agent's terminal title, the agent, the folder */
export function sessionName(pane: Pick<RosterPane, "label" | "title" | "agent" | "cwd">): string {
  if (pane.label) return pane.label;
  if (pane.title) return pane.title;
  if (pane.agent) return agentLabel(pane.agent);
  return pane.cwd.split("/").filter(Boolean).pop() || pane.cwd || "shell";
}
