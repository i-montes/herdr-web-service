/**
 * Turns Herdr's `session.snapshot` into the roster the web app draws: workspaces with a display
 * path, and every pane (agent or shell) with its status. Herdr reports no times: the server
 * remembers the last status per pane and stamps changes it sees, and `opened` (lifetimes.ts) says
 * when each pane's shell started.
 */
import type { AgentStatus, Roster, RosterPane, RosterWorkspace } from "../../shared/protocol.ts";

/**
 * pane_id → last status seen and when it last changed. The terminal tells a reused pane id from
 * the same pane (Herdr numbers panes per workspace).
 */
export type StatusMemory = Map<string, { status: AgentStatus; changed_at: number | null; terminal_id: string }>;

type Raw = Record<string, unknown>;
const STATUSES: readonly AgentStatus[] = ["idle", "working", "blocked", "done", "unknown"];

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function tildePath(path: string, home: string): string {
  if (!home || !path) return path;
  if (path === home) return "~";
  return path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

/** the cwd shared by most of the workspace's panes */
function mostCommon(paths: string[]): string {
  const counts = new Map<string, number>();
  for (const p of paths) counts.set(p, (counts.get(p) ?? 0) + 1);
  let best = "";
  let max = 0;
  for (const [p, n] of counts) if (n > max) [best, max] = [p, n];
  return best;
}

/** the terminal behind a pane, as Herdr's snapshot names it */
export function terminalOf(pane: unknown): string {
  return str((pane as Raw | null)?.["terminal_id"]);
}

export function buildRoster(snapshot: { workspaces?: unknown; tabs?: unknown; panes?: unknown }, memory: StatusMemory, now: number, home: string, opened: ReadonlyMap<string, number | null> = new Map()): Roster {
  const rawPanes = Array.isArray(snapshot.panes) ? (snapshot.panes as Raw[]) : [];
  const tabLabels = new Map<string, string>();
  for (const t of Array.isArray(snapshot.tabs) ? (snapshot.tabs as Raw[]) : []) {
    const label = str(t["label"]).trim();
    if (label && !/^\d+$/.test(label)) tabLabels.set(str(t["tab_id"]), label);
  }
  const rawWorkspaces = Array.isArray(snapshot.workspaces) ? (snapshot.workspaces as Raw[]) : [];
  const seen = new Set<string>();

  const panes: RosterPane[] = rawPanes.map((p) => {
    const pane_id = str(p["pane_id"]);
    const status = STATUSES.includes(p["agent_status"] as AgentStatus) ? (p["agent_status"] as AgentStatus) : "unknown";
    const terminal_id = terminalOf(p);
    const remembered = memory.get(pane_id);
    const before = remembered?.terminal_id === terminal_id ? remembered : undefined;
    const changed_at = before && before.status !== status ? now : (before?.changed_at ?? null);
    memory.set(pane_id, { status, changed_at, terminal_id });
    seen.add(pane_id);
    const title = str(p["terminal_title_stripped"]).trim();
    return {
      pane_id,
      workspace_id: str(p["workspace_id"]),
      tab_id: str(p["tab_id"]),
      agent: typeof p["agent"] === "string" && p["agent"] ? (p["agent"] as string) : null,
      status,
      title: title || null,
      label: tabLabels.get(str(p["tab_id"])) ?? null,
      cwd: tildePath(str(p["foreground_cwd"] || p["cwd"]), home),
      focused: Boolean(p["focused"]),
      changed_at,
      opened_at: opened.get(terminal_id) ?? null,
    };
  });
  for (const id of memory.keys()) if (!seen.has(id)) memory.delete(id);

  const workspaces: RosterWorkspace[] = rawWorkspaces.map((w) => {
    const workspace_id = str(w["workspace_id"]);
    return {
      workspace_id,
      number: Number(w["number"] ?? 0),
      label: str(w["label"]) || workspace_id,
      path: mostCommon(panes.filter((p) => p.workspace_id === workspace_id).map((p) => p.cwd)),
      focused: Boolean(w["focused"]),
    };
  });
  return { workspaces, panes };
}
