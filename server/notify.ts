/**
 * Which roster changes are worth a notice: a session that starts waiting for the person
 * (permission, question) and one that stops working. Pure, so it is tested without Herdr.
 */
import type { AgentStatus, Notice, Roster } from "../shared/protocol.ts";
import { agentLabel, sessionName } from "../shared/names.ts";

export class NoticeWatch {
  private last = new Map<string, AgentStatus>();
  private primed = false;

  /**
   * The notices this roster brings, against the previous one fed here. The first roster only
   * sets the baseline: a server that restarts does not announce what was already so.
   */
  next(roster: Roster, now: number): Notice[] {
    const notices: Notice[] = [];
    const seen = new Set<string>();
    for (const pane of roster.panes) {
      seen.add(pane.pane_id);
      const before = this.last.get(pane.pane_id);
      this.last.set(pane.pane_id, pane.status);
      if (!this.primed || before === undefined || !pane.agent) continue;
      const kind = pane.status === "blocked" && before !== "blocked" ? "blocked" : before === "working" && (pane.status === "done" || pane.status === "idle") ? "finished" : null;
      if (!kind) continue;
      const name = sessionName(pane);
      const where = roster.workspaces.find((w) => w.workspace_id === pane.workspace_id)?.label || pane.cwd;
      notices.push({
        id: `${pane.pane_id}:${now}`,
        pane_id: pane.pane_id,
        kind,
        title: kind === "blocked" ? `${name} needs you` : `${name} finished`,
        body: [agentLabel(pane.agent), where].filter(Boolean).join(" · "),
        at: now,
      });
    }
    for (const id of this.last.keys()) if (!seen.has(id)) this.last.delete(id);
    this.primed = true;
    return notices;
  }
}
