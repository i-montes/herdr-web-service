/** What the Inicio screen shows, derived from Herdr's roster. Pure: no React, no DOM. */
import type { AgentStatus, Roster, RosterPane, RosterWorkspace } from "../../shared/protocol.ts";

/** the four states the design draws; Herdr has no error state, so "Con error" is not offered */
export type Bucket = "waiting" | "working" | "idle";
export type Filter = "all" | Bucket;

export const BUCKET_OF: Record<AgentStatus, Bucket> = { blocked: "waiting", working: "working", done: "idle", idle: "idle", unknown: "idle" };

export const STATUS_LABEL: Record<AgentStatus, string> = {
  blocked: "Te espera",
  working: "Trabajando",
  done: "Terminó",
  idle: "Inactiva",
  unknown: "Inactiva",
};

export const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Todas" },
  { id: "waiting", label: "Te esperan" },
  { id: "working", label: "Trabajando" },
  { id: "idle", label: "Inactivas" },
];

export interface AgentLook {
  label: string;
  initial: string;
  /** Tailwind classes for the agent's tile */
  tile: string;
}

const KNOWN: Record<string, AgentLook> = {
  claude: { label: "Claude Code", initial: "C", tile: "bg-claude text-claude-ink" },
  codex: { label: "Codex", initial: "X", tile: "bg-codex text-codex-ink" },
  opencode: { label: "OpenCode", initial: "O", tile: "bg-opencode text-opencode-ink" },
};

export function agentLook(agent: string | null): AgentLook {
  if (!agent) return { label: "Shell", initial: "$", tile: "bg-inverse text-inverse-ink" };
  return KNOWN[agent] ?? { label: agent[0]!.toUpperCase() + agent.slice(1), initial: agent[0]!.toUpperCase(), tile: "bg-inverse text-inverse-ink" };
}

/** the name a session goes by: the name it was given, the agent's terminal title, the agent, the folder */
export function sessionName(pane: RosterPane): string {
  if (pane.label) return pane.label;
  if (pane.title) return pane.title;
  if (pane.agent) return agentLook(pane.agent).label;
  return pane.cwd.split("/").filter(Boolean).pop() || pane.cwd || "shell";
}

export function ago(at: number | null, now: number): string | null {
  if (at === null) return null;
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return "ahora";
  if (s < 60) return `hace ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "ayer" : `hace ${d} días`;
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
