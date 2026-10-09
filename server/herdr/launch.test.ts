import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Roster } from "../../shared/protocol.ts";
import { _resetPrompts, agentName, launchSession, parseNewSession, readyPrompts, type Requester } from "./launch.ts";
import { uploadDir } from "../uploads.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "hw-launch-")));
mkdirSync(join(home, "p/app"), { recursive: true });
const roster: Roster = { workspaces: [{ workspace_id: "w1", number: 1, label: "app", path: "~/p/app", focused: false }], panes: [] };

function fake(): Requester & { calls: [string, Record<string, unknown>][] } {
  const calls: [string, Record<string, unknown>][] = [];
  return {
    calls,
    async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push([method, params]);
      if (method === "tab.create") return { root_pane: { pane_id: "w1:p9" } } as T;
      if (method === "workspace.create") return { root_pane: { pane_id: "w5:p1", tab_id: "w5:t1" } } as T;
      return { type: "ok" } as T;
    },
  };
}

beforeEach(() => _resetPrompts());

test("parse: defaults, trimming and refusals", () => {
  expect(parseNewSession({ cwd: "~/p/app", kind: "claude" }, home)).toEqual({ ok: true, value: { cwd: join(home, "p/app"), kind: "claude", name: "app-claude", message: "", command: "", permission: "ask" } });
  expect(parseNewSession({ cwd: "~/p/app", kind: "shell", name: "  dev  ", command: " npm run dev " }, home)).toMatchObject({ ok: true, value: { name: "dev", command: "npm run dev" } });
  expect(parseNewSession({ cwd: "/etc", kind: "shell" }, home).ok).toBe(false);
  expect(parseNewSession({ cwd: "~/p/app", kind: "rm -rf" }, home).ok).toBe(false);
  expect(parseNewSession({ cwd: "~/p/app", kind: "claude", permission: "yolo" }, home).ok).toBe(false);
  expect(parseNewSession({ cwd: "~/p/app", kind: "shell", command: "a\nb" }, home).ok).toBe(false);
  expect(parseNewSession(null, home).ok).toBe(false);
});

test("a folder that already has a workspace gets a new tab there", async () => {
  const h = fake();
  const parsed = parseNewSession({ cwd: "~/p/app", kind: "shell", command: "npm test" }, home);
  if (!parsed.ok) throw new Error(parsed.error);
  expect(await launchSession(h, parsed.value, roster, home)).toEqual({ pane_id: "w1:p9" });
  expect(h.calls).toEqual([
    ["tab.create", { cwd: join(home, "p/app"), workspace_id: "w1", label: "app-shell", focus: false }],
    ["pane.send_text", { pane_id: "w1:p9", text: "npm test\n" }],
  ]);
});

test("a new folder gets a new workspace; an agent starts with its permission mode and its message waits", async () => {
  const h = fake();
  mkdirSync(join(home, "p/other"), { recursive: true });
  const parsed = parseNewSession({ cwd: "~/p/other", kind: "claude", name: "x", message: "hola", permission: "plan" }, home);
  if (!parsed.ok) throw new Error(parsed.error);
  await launchSession(h, parsed.value, roster, home);
  expect(h.calls).toEqual([
    ["workspace.create", { cwd: join(home, "p/other"), label: "other", focus: false }],
    ["tab.rename", { tab_id: "w5:t1", label: "x" }],
    ["agent.start", { name: "x", kind: "claude", pane_id: "w5:p1", args: ["--permission-mode", "plan", "--add-dir", uploadDir()] }],
  ]);
  const pane = (status: "blocked" | "idle", agent: string | null = "claude") => ({ pane_id: "w5:p1", workspace_id: "w5", tab_id: "t", agent, status, title: null, label: null, cwd: "", focused: false, changed_at: null });
  expect(readyPrompts({ workspaces: [], panes: [pane("blocked")] })).toEqual([]);
  expect(readyPrompts({ workspaces: [], panes: [pane("idle")] })).toEqual([{ pane_id: "w5:p1", text: "hola" }]);
  expect(readyPrompts({ workspaces: [], panes: [pane("idle")] })).toEqual([]);
});

test("asking is explicit for Claude, whatever its default mode", async () => {
  const { agentArgs } = await import("./launch.ts");
  expect(agentArgs("claude", "ask", "/tmp/i")).toEqual(["--permission-mode", "default", "--add-dir", "/tmp/i"]);
  expect(agentArgs("claude", "edits", "/tmp/i")).toEqual(["--permission-mode", "acceptEdits", "--add-dir", "/tmp/i"]);
  expect(agentArgs("opencode", "ask")).toEqual([]);
});

test("bypass skips every permission check: Claude and OpenCode each with their own flag", async () => {
  const { agentArgs } = await import("./launch.ts");
  expect(agentArgs("claude", "bypass", "/tmp/i")).toEqual(["--dangerously-skip-permissions", "--add-dir", "/tmp/i"]);
  expect(agentArgs("opencode", "bypass")).toEqual(["--auto"]);
});

test("each agent only takes the permissions it has", () => {
  const ok = (kind: string, permission: string) => parseNewSession({ cwd: "~/p/app", kind, permission }, home).ok;
  expect(["ask", "edits", "plan", "bypass"].map((p) => ok("claude", p))).toEqual([true, true, true, true]);
  expect(["ask", "edits", "plan", "bypass"].map((p) => ok("opencode", p))).toEqual([true, false, false, true]);
  expect(["ask", "edits", "plan", "bypass"].map((p) => ok("codex", p))).toEqual([true, false, false, false]);
  expect(ok("shell", "bypass")).toBe(false);
});

test("other agents get no permission flags", async () => {
  const h = fake();
  const parsed = parseNewSession({ cwd: "~/p/app", kind: "codex" }, home);
  if (!parsed.ok) throw new Error(parsed.error);
  await launchSession(h, parsed.value, roster, home);
  expect(h.calls[1]).toEqual(["agent.start", { name: "app-codex", kind: "codex", pane_id: "w1:p9", args: [] }]);
});

test("a pending message is dropped when its pane closes", () => {
  const h = fake();
  const parsed = parseNewSession({ cwd: "~/p/app", kind: "claude", message: "hola" }, home);
  if (!parsed.ok) throw new Error(parsed.error);
  return launchSession(h, parsed.value, roster, home).then(() => {
    expect(readyPrompts({ workspaces: [], panes: [] })).toEqual([]);
    expect(readyPrompts({ workspaces: [], panes: [{ pane_id: "w1:p9", workspace_id: "w1", tab_id: "t", agent: "claude", status: "idle", title: null, label: null, cwd: "", focused: false, changed_at: null }] })).toEqual([]);
  });
});

/** a fake Herdr whose new pane takes `notReady` agent.start attempts to have a shell (a slow VPS) */
function slowShell(notReady: number, error = "agent target pane w1:p9 is not an available shell") {
  const h = fake();
  let refused = 0;
  const request = h.request.bind(h);
  h.request = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (method === "agent.start" && refused < notReady) {
      refused++;
      h.calls.push([method, params]);
      throw new Error(error);
    }
    return request<T>(method, params);
  };
  return h;
}

const noWait = { wait: async () => {}, timeoutMs: 10_000 };

test("an agent waits for the new pane's shell to be ready", async () => {
  const h = slowShell(2);
  const parsed = parseNewSession({ cwd: "~/p/app", kind: "claude" }, home);
  if (!parsed.ok) throw new Error(parsed.error);
  expect(await launchSession(h, parsed.value, roster, home, noWait)).toEqual({ pane_id: "w1:p9" });
  expect(h.calls.filter(([m]) => m === "agent.start")).toHaveLength(3);
});

test("any other agent.start error fails at once", async () => {
  const h = slowShell(5, "unknown agent kind");
  const parsed = parseNewSession({ cwd: "~/p/app", kind: "claude" }, home);
  if (!parsed.ok) throw new Error(parsed.error);
  await expect(launchSession(h, parsed.value, roster, home, noWait)).rejects.toThrow("unknown agent kind");
  expect(h.calls.filter(([m]) => m === "agent.start")).toHaveLength(1);
});

test("a shell that never gets ready gives up after the timeout", async () => {
  const h = slowShell(Infinity);
  const parsed = parseNewSession({ cwd: "~/p/app", kind: "claude" }, home);
  if (!parsed.ok) throw new Error(parsed.error);
  await expect(launchSession(h, parsed.value, roster, home, { wait: () => Bun.sleep(5), timeoutMs: 50 })).rejects.toThrow("not an available shell");
});

test("agent names follow Herdr's rule: lowercase letter first, [a-z0-9_-], at most 32", () => {
  expect(agentName("~-claude", "claude")).toBe("claude");
  expect(agentName("Mi Proyecto Ñandú", "claude")).toBe("mi-proyecto-nandu");
  expect(agentName("api.v2 (prod)", "opencode")).toBe("api-v2-prod");
  expect(agentName("123", "opencode")).toBe("opencode");
  expect(agentName("a".repeat(40) + "-x", "claude")).toBe("a".repeat(32));
  for (const n of ["~-claude", "Mi Proyecto Ñandú", "a".repeat(50), "---", "ok_name-1"]) expect(agentName(n, "claude")).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
});

test("the tab keeps the typed name; the agent gets a valid one", async () => {
  const h = fake();
  const parsed = parseNewSession({ cwd: "~/p/app", kind: "claude", name: "~ Mi sesión" }, home);
  if (!parsed.ok) throw new Error(parsed.error);
  await launchSession(h, parsed.value, roster, home, noWait);
  expect(h.calls.find(([m]) => m === "tab.create")?.[1]).toMatchObject({ label: "~ Mi sesión" });
  expect(h.calls.find(([m]) => m === "agent.start")?.[1]).toMatchObject({ name: "mi-sesion" });
});

test("a name already in use gets a numeric suffix", async () => {
  const h = slowShell(2, "agent name app-claude is already used; candidates: pane_id=w1:p1");
  const parsed = parseNewSession({ cwd: "~/p/app", kind: "claude" }, home);
  if (!parsed.ok) throw new Error(parsed.error);
  await launchSession(h, parsed.value, roster, home, noWait);
  expect(h.calls.filter(([m]) => m === "agent.start").map(([, p]) => p["name"])).toEqual(["app-claude", "app-claude-2", "app-claude-3"]);
});

test("a pane whose agent cannot start is closed again, not left as an empty shell", async () => {
  const h = slowShell(5, "unknown agent kind");
  const parsed = parseNewSession({ cwd: "~/p/app", kind: "claude" }, home);
  if (!parsed.ok) throw new Error(parsed.error);
  await expect(launchSession(h, parsed.value, roster, home, noWait)).rejects.toThrow("unknown agent kind");
  expect(h.calls.at(-1)).toEqual(["pane.close", { pane_id: "w1:p9" }]);
});
