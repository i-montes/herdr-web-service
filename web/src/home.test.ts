import { expect, test } from "bun:test";
import type { Roster, RosterPane } from "../../shared/protocol.ts";
import { agentLook, ago, homeView, sessionName } from "./home.ts";

const pane = (over: Partial<RosterPane>): RosterPane => ({
  pane_id: "p", workspace_id: "w1", tab_id: "t", agent: "claude", status: "idle", title: null, label: null, cwd: "~/p/app", focused: false, changed_at: null, ...over,
});

const roster: Roster = {
  workspaces: [
    { workspace_id: "w1", number: 1, label: "recoba", path: "~/p/recoba", focused: true },
    { workspace_id: "w2", number: 2, label: "lumo", path: "~/p/lumo", focused: false },
  ],
  panes: [
    pane({ pane_id: "a", status: "blocked", title: "migraciones-db" }),
    pane({ pane_id: "b", status: "working", agent: "codex", title: "sdk" }),
    pane({ pane_id: "c", workspace_id: "w2", status: "done", agent: null, cwd: "~/p/lumo/web" }),
  ],
};

test("counts by bucket and lists who is waiting", () => {
  const view = homeView(roster, "all", "");
  expect(view.counts).toEqual({ all: 3, waiting: 1, working: 1, idle: 1 });
  expect(view.waiting.map((p) => p.pane_id)).toEqual(["a"]);
  expect(view.groups.map((g) => [g.workspace.label, g.shown.length, g.waiting])).toEqual([["recoba", 2, 1], ["lumo", 1, 0]]);
});

test("filter and search narrow the cards but not the sidebar", () => {
  const view = homeView(roster, "working", "");
  expect(view.groups[0]!.shown.map((p) => p.pane_id)).toEqual(["b"]);
  expect(view.groups[0]!.panes).toHaveLength(2);
  expect(homeView(roster, "all", "LUMO").groups.map((g) => g.shown.length)).toEqual([0, 1]);
  expect(homeView(roster, "all", "migra").groups.map((g) => g.shown.length)).toEqual([1, 0]);
});

test("session names fall back to the agent, then the folder", () => {
  expect(sessionName(pane({ title: "x" }))).toBe("x");
  expect(sessionName(pane({ title: "x", label: "my-session" }))).toBe("my-session");
  expect(sessionName(pane({ agent: "codex" }))).toBe("Codex");
  expect(sessionName(pane({ agent: null, cwd: "~/p/lumo/web" }))).toBe("web");
  expect(agentLook("gemini")).toMatchObject({ label: "Gemini", initial: "G" });
  expect(agentLook(null).initial).toBe("$");
});

test("ago", () => {
  const now = 10_000_000;
  expect(ago(null, now)).toBeNull();
  expect(ago(now - 3_000, now)).toBe("just now");
  expect(ago(now - 30_000, now)).toBe("30s ago");
  expect(ago(now - 120_000, now)).toBe("2 min ago");
  expect(ago(now - 3 * 3_600_000, now)).toBe("3h ago");
  expect(ago(now - 30 * 3_600_000, now)).toBe("yesterday");
});
