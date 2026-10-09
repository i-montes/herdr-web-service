import { expect, test } from "bun:test";
import type { AgentStatus, Roster, RosterPane } from "../shared/protocol.ts";
import { NoticeWatch } from "./notify.ts";

const pane = (pane_id: string, status: AgentStatus, extra: Partial<RosterPane> = {}): RosterPane => ({ pane_id, workspace_id: "w1", tab_id: "t", agent: "claude", status, title: null, label: "fix-discount", cwd: "~/shop", focused: false, changed_at: null, ...extra });
const roster = (...panes: RosterPane[]): Roster => ({ workspaces: [{ workspace_id: "w1", number: 1, label: "storefront", path: "~/shop", focused: false }], panes });

test("the first roster is only the baseline", () => {
  const w = new NoticeWatch();
  expect(w.next(roster(pane("p1", "blocked")), 1)).toEqual([]);
  expect(w.next(roster(pane("p1", "blocked")), 2)).toEqual([]);
});

test("a session that starts waiting, and one that stops working, are notices", () => {
  const w = new NoticeWatch();
  w.next(roster(pane("p1", "working"), pane("p2", "working")), 1);
  expect(w.next(roster(pane("p1", "blocked"), pane("p2", "done")), 2)).toEqual([
    { id: "p1:2", pane_id: "p1", kind: "blocked", title: "fix-discount needs you", body: "Claude Code · storefront", at: 2 },
    { id: "p2:2", pane_id: "p2", kind: "finished", title: "fix-discount finished", body: "Claude Code · storefront", at: 2 },
  ]);
});

test("no notice for what did not stop working, for new panes or for shells", () => {
  const w = new NoticeWatch();
  w.next(roster(pane("p1", "done"), pane("p2", "blocked"), pane("sh", "working", { agent: null })), 1);
  // done → idle (viewed), blocked → idle (answered or cancelled), a shell
  expect(w.next(roster(pane("p1", "idle"), pane("p2", "idle"), pane("sh", "idle", { agent: null }), pane("new", "blocked")), 2)).toEqual([]);
  // the new pane counts from now on
  expect(w.next(roster(pane("new", "working")), 3)).toEqual([]);
  expect(w.next(roster(pane("new", "idle")), 4).map((n) => n.kind)).toEqual(["finished"]);
});

test("a closed pane is forgotten: one with its id later starts fresh", () => {
  const w = new NoticeWatch();
  w.next(roster(pane("p1", "working")), 1);
  w.next(roster(), 2);
  expect(w.next(roster(pane("p1", "idle")), 3)).toEqual([]);
});
