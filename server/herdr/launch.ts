/**
 * "New session": opens a pane in the chosen folder and starts a shell command or an agent in it.
 *
 * A folder that already has a workspace gets a new tab there; any other folder gets its own
 * workspace. An agent's first message is held here and sent once the agent reports `idle`:
 * sent earlier it would land in whatever the agent shows first (Claude's folder-trust prompt).
 */
import { basename } from "node:path";
import type { Roster } from "../../shared/protocol.ts";
import { expandHome, folderInHome } from "../fsbrowse.ts";
import { uploadDir } from "../uploads.ts";

export const SESSION_KINDS = ["shell", "claude", "codex", "opencode"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];
export const PERMISSIONS = ["ask", "edits", "plan", "bypass"] as const;
export type Permission = (typeof PERMISSIONS)[number];
/** what each kind can start with; "bypass" skips every permission check */
export const KIND_PERMISSIONS: Record<SessionKind, readonly Permission[]> = {
  shell: ["ask"],
  claude: ["ask", "edits", "plan", "bypass"],
  codex: ["ask"],
  opencode: ["ask", "bypass"],
};

export interface NewSession {
  /** absolute, real folder inside home */
  cwd: string;
  kind: SessionKind;
  name: string;
  message: string;
  command: string;
  permission: Permission;
}

export interface Requester {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

const MAX_NAME = 60;
const MAX_TEXT = 20_000;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseNewSession(body: unknown, home: string): { ok: true; value: NewSession } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const cwd = folderInHome(text(b["cwd"]), home);
  if (!cwd) return { ok: false, error: "cwd must be a folder inside home" };
  const kind = b["kind"] as SessionKind;
  if (!SESSION_KINDS.includes(kind)) return { ok: false, error: "unknown kind" };
  const permission = (b["permission"] ?? "ask") as Permission;
  if (!PERMISSIONS.includes(permission)) return { ok: false, error: "unknown permission" };
  if (!KIND_PERMISSIONS[kind].includes(permission)) return { ok: false, error: `${kind} cannot start with permission ${permission}` };
  const command = text(b["command"]);
  if (/[\r\n]/.test(command)) return { ok: false, error: "command must be one line" };
  const message = text(b["message"]);
  if (message.length > MAX_TEXT || command.length > MAX_TEXT) return { ok: false, error: "text too long" };
  const name = text(b["name"]).slice(0, MAX_NAME) || `${basename(cwd)}-${kind}`;
  return { ok: true, value: { cwd, kind, name, message, command, permission } };
}

/**
 * Claude Code's --permission-mode, always explicit: "ask" must ask even when the user's settings
 * default to auto mode; bypass is --dangerously-skip-permissions. Plus --add-dir for the chat's
 * image folder, so reading a pasted image does not ask each time. OpenCode's bypass is --auto
 * (approves what its config does not deny); otherwise agents start with their own defaults.
 */
export function agentArgs(kind: SessionKind, permission: Permission, imageDir = uploadDir()): string[] {
  if (kind === "opencode") return permission === "bypass" ? ["--auto"] : [];
  if (kind !== "claude") return [];
  const mode = { ask: ["--permission-mode", "default"], edits: ["--permission-mode", "acceptEdits"], plan: ["--permission-mode", "plan"], bypass: ["--dangerously-skip-permissions"] };
  return [...mode[permission], "--add-dir", imageDir];
}

/** pane_id → first message waiting for its agent to be ready */
const pendingPrompts = new Map<string, string>();

/** how long a new pane may take to have a shell an agent can start in (slow shells on a VPS) */
const SHELL_READY_MS = 10_000;

const AGENT_NAME_MAX = 32;

/**
 * Herdr's agent names: a lowercase letter first, then [a-z0-9_-], 1–32 characters, unique among
 * live agents. The session's own name (any text) stays on its tab.
 */
export function agentName(name: string, kind: SessionKind): string {
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-{2,}/g, "-")
    .slice(0, AGENT_NAME_MAX)
    .replace(/[-_]+$/, "");
  return slug || kind;
}

const withSuffix = (base: string, n: number) => (n < 2 ? base : `${base.slice(0, AGENT_NAME_MAX - String(n).length - 1).replace(/[-_]+$/, "")}-${n}`);

/**
 * `agent.start` on a pane created a moment ago. Two refusals are retried: the pane's shell is not
 * up yet ("is not an available shell", ~0.5 s on a small VPS), and the name is taken by another
 * live agent ("is already used": the next one gets -2, -3...).
 */
async function startAgent(herdr: Requester, params: { name: string } & Record<string, unknown>, opts: LaunchOptions): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  let suffix = 1;
  for (;;) {
    try {
      await herdr.request("agent.start", { ...params, name: withSuffix(params.name, suffix) });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("is already used") && suffix < 50) {
        suffix++;
        continue;
      }
      if (!message.includes("not an available shell") || Date.now() >= deadline) throw error;
      await opts.wait(200);
    }
  }
}

export interface LaunchOptions {
  wait: (ms: number) => Promise<void>;
  timeoutMs: number;
}

export async function launchSession(
  herdr: Requester,
  input: NewSession,
  roster: Roster,
  home: string,
  opts: LaunchOptions = { wait: (ms) => Bun.sleep(ms), timeoutMs: SHELL_READY_MS },
): Promise<{ pane_id: string }> {
  const workspace = roster.workspaces.find((w) => w.path && expandHome(w.path, home) === input.cwd);
  type Created = { root_pane: { pane_id: string; tab_id: string } };
  let created: Created;
  if (workspace) {
    created = await herdr.request<Created>("tab.create", { cwd: input.cwd, workspace_id: workspace.workspace_id, label: input.name, focus: false });
  } else {
    created = await herdr.request<Created>("workspace.create", { cwd: input.cwd, label: basename(input.cwd), focus: false });
    // a new workspace's first tab is named "1": give it the session's name
    await herdr.request("tab.rename", { tab_id: created.root_pane.tab_id, label: input.name });
  }
  const pane_id = created.root_pane.pane_id;
  if (input.kind === "shell") {
    if (input.command) await herdr.request("pane.send_text", { pane_id, text: input.command + "\n" });
  } else {
    try {
      await startAgent(herdr, { name: agentName(input.name, input.kind), kind: input.kind, pane_id, args: agentArgs(input.kind, input.permission) }, opts);
    } catch (error) {
      // the tab was made for this agent: do not leave an empty shell behind
      await herdr.request("pane.close", { pane_id }).catch(() => {});
      throw error;
    }
    if (input.message) pendingPrompts.set(pane_id, input.message);
  }
  return { pane_id };
}

/** the held messages whose agent is now idle (each returned once); closed panes drop theirs */
export function readyPrompts(roster: Roster): { pane_id: string; text: string }[] {
  const ready: { pane_id: string; text: string }[] = [];
  for (const [pane_id, text] of pendingPrompts) {
    const pane = roster.panes.find((p) => p.pane_id === pane_id);
    if (!pane) pendingPrompts.delete(pane_id);
    else if (pane.agent && pane.status === "idle") {
      pendingPrompts.delete(pane_id);
      ready.push({ pane_id, text });
    }
  }
  return ready;
}

/**
 * Sends a held first message. An agent can report idle a moment (~1–2 s) before its input is
 * really ready, and what it gets then is lost in one of two ways: OpenCode drops the text (the
 * box stays empty), Claude Code keeps the text but not the Enter. So when the agent shows no sign
 * of the send (no state change within `settleMs`) the screen decides: our text still in the box
 * gets an Enter, a vanished one is sent again. Herdr's state_change_seq, not "working", is the
 * sign: an answer quick enough to be idle again by the check still moves it.
 */
export async function deliverFirstPrompt(herdr: Requester, pane_id: string, text: string, opts = { attempts: 4, settleMs: 5000, pollMs: 250, wait: (ms: number) => Bun.sleep(ms) }): Promise<void> {
  type Agent = { agent?: { state_change_seq?: number } };
  const seq = async () => (await herdr.request<Agent>("agent.get", { target: pane_id })).agent?.state_change_seq ?? 0;
  const squash = (s: string) => s.replace(/\s+/g, " ").trim();
  // short, so a box that wraps the message does not split it
  const probe = squash(text).slice(0, 16);
  for (let attempt = 1; ; attempt++) {
    const before = await seq();
    if (attempt === 1) {
      await herdr.request("agent.prompt", { target: pane_id, text });
    } else {
      const screen = await herdr.request<{ read: { text: string } }>("pane.read", { pane_id, source: "visible", strip_ansi: true });
      if (squash(screen.read.text).includes(probe)) await herdr.request("pane.send_keys", { pane_id, keys: ["enter"] });
      else await herdr.request("agent.prompt", { target: pane_id, text });
    }
    for (let waited = 0; waited < opts.settleMs; waited += opts.pollMs) {
      await opts.wait(opts.pollMs);
      if ((await seq()) !== before) return;
    }
    if (attempt >= opts.attempts) throw new Error(`the agent in ${pane_id} did not take its first message`);
  }
}

export function _resetPrompts(): void {
  pendingPrompts.clear();
}
