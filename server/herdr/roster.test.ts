import { expect, test } from "bun:test";
import { buildRoster, type StatusMemory } from "./roster.ts";

const HOME = "/Users/ana";

const snapshot = {
  workspaces: [
    { workspace_id: "w1", number: 1, label: "recoba", focused: true },
    { workspace_id: "w2", number: 2, label: "empty", focused: false },
  ],
  tabs: [
    { tab_id: "w1:t1", label: "1" },
    { tab_id: "w1:t2", label: "dev-server" },
  ],
  panes: [
    { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "claude", agent_status: "blocked", terminal_title_stripped: "Migraciones", cwd: "/Users/ana/p/recoba", focused: true },
    { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t2", agent_status: "unknown", cwd: "/Users/ana/p/recoba/api", focused: false },
    { pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t2", agent: "codex", agent_status: "weird", cwd: "/Users/ana/p/recoba", focused: false },
  ],
};

test("maps workspaces and panes, shells have no agent, unknown statuses become unknown", () => {
  const roster = buildRoster(snapshot, new Map(), 1000, HOME);
  expect(roster.workspaces.map((w) => [w.workspace_id, w.label, w.path])).toEqual([["w1", "recoba", "~/p/recoba"], ["w2", "empty", ""]]);
  expect(roster.panes[0]).toEqual({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "claude", status: "blocked", title: "Migraciones", label: null, cwd: "~/p/recoba", focused: true, changed_at: null });
  expect(roster.panes[1]!.label).toBe("dev-server");
  expect(roster.panes[1]!.agent).toBeNull();
  expect(roster.panes[1]!.title).toBeNull();
  expect(roster.panes[2]!.status).toBe("unknown");
});

test("changed_at is set when a status changes and kept while it stays", () => {
  const memory: StatusMemory = new Map();
  buildRoster(snapshot, memory, 1000, HOME);
  const next = structuredClone(snapshot);
  next.panes[0]!.agent_status = "working";
  expect(buildRoster(next, memory, 2000, HOME).panes[0]!.changed_at).toBe(2000);
  expect(buildRoster(next, memory, 3000, HOME).panes[0]!.changed_at).toBe(2000);
  expect(buildRoster(next, memory, 3000, HOME).panes[1]!.changed_at).toBeNull();
});

test("closed panes are forgotten", () => {
  const memory: StatusMemory = new Map();
  buildRoster(snapshot, memory, 1000, HOME);
  buildRoster({ ...snapshot, panes: snapshot.panes.slice(0, 1) }, memory, 2000, HOME);
  expect([...memory.keys()]).toEqual(["w1:p1"]);
});

test("a path outside home stays absolute and home itself is ~", () => {
  const roster = buildRoster({ workspaces: snapshot.workspaces, panes: [{ ...snapshot.panes[0]!, cwd: "/srv/app" }, { ...snapshot.panes[1]!, cwd: HOME }] }, new Map(), 0, HOME);
  expect(roster.panes.map((p) => p.cwd)).toEqual(["/srv/app", "~"]);
});
