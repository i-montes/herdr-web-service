/** What the Home screen shows, derived from Herdr's roster. Pure: no React, no DOM. */
import type { AgentStatus, Roster, RosterPane, RosterWorkspace } from "../../shared/protocol.ts";
import { AGENT_LABELS, sessionName } from "../../shared/names.ts";

/** the four states the design draws; Herdr has no error state, so "With error" is not offered */
export type Bucket = "waiting" | "working" | "idle";
export type Filter = "all" | Bucket;

export const BUCKET_OF: Record<AgentStatus, Bucket> = { blocked: "waiting", working: "working", done: "idle", idle: "idle", unknown: "idle" };

export const STATUS_LABEL: Record<AgentStatus, string> = {
  blocked: "Needs you",
  working: "Working",
  done: "Done",
  idle: "Idle",
  unknown: "Idle",
};

export const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "waiting", label: "Needs you" },
  { id: "working", label: "Working" },
  { id: "idle", label: "Idle" },
];

export interface AgentLook {
  label: string;
  initial: string;
  /** Tailwind classes for the agent's tile */
  tile: string;
}

const KNOWN: Record<string, AgentLook> = {
  claude: { label: AGENT_LABELS["claude"]!, initial: "C", tile: "bg-claude text-claude-ink" },
  codex: { label: AGENT_LABELS["codex"]!, initial: "X", tile: "bg-codex text-codex-ink" },
  opencode: { label: AGENT_LABELS["opencode"]!, initial: "O", tile: "bg-opencode text-opencode-ink" },
};

export function agentLook(agent: string | null): AgentLook {
  if (!agent) return { label: "Shell", initial: "$", tile: "bg-inverse text-inverse-ink" };
  return KNOWN[agent] ?? { label: agent[0]!.toUpperCase() + agent.slice(1), initial: agent[0]!.toUpperCase(), tile: "bg-inverse text-inverse-ink" };
}

export { sessionName };

export function ago(at: number | null, now: number): string | null {
  if (at === null) return null;
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export interface WorkspaceGroup {
  workspace: RosterWorkspace;
  /** every pane of the workspace (sidebar) */
  panes: RosterPane[];
  /** the panes that pass the filter and the search (cards) */
  shown: RosterPane[];
  waiting: number;
}

export interface HomeView {
  groups: WorkspaceGroup[];
  waiting: RosterPane[];
  counts: Record<Filter, number>;
  sessions: number;
}

export function homeView(roster: Roster, filter: Filter, query: string): HomeView {
  const q = query.trim().toLowerCase();
  const byWorkspace = new Map(roster.workspaces.map((w) => [w.workspace_id, w]));
  const matches = (p: RosterPane) => {
    if (filter !== "all" && BUCKET_OF[p.status] !== filter) return false;
    if (!q) return true;
    const ws = byWorkspace.get(p.workspace_id)?.label ?? "";
    return sessionName(p).toLowerCase().includes(q) || ws.toLowerCase().includes(q);
  };
  const groups = roster.workspaces.map((workspace) => {
    const panes = roster.panes.filter((p) => p.workspace_id === workspace.workspace_id);
    return { workspace, panes, shown: panes.filter(matches), waiting: panes.filter((p) => p.status === "blocked").length };
  });
  const counts: Record<Filter, number> = { all: roster.panes.length, waiting: 0, working: 0, idle: 0 };
  for (const p of roster.panes) counts[BUCKET_OF[p.status]]++;
  return {
    groups,
    waiting: roster.panes.filter((p) => p.status === "blocked"),
    counts,
    sessions: roster.panes.length,
  };
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
