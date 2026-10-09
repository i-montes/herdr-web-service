/** Shapes shared by the Bun server and the browser client. */

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** One Herdr workspace; `path` is the folder most of its panes sit in, with the home dir as `~` */
export interface RosterWorkspace {
  workspace_id: string;
  number: number;
  label: string;
  path: string;
  focused: boolean;
}

/** One pane: an agent (`agent` set) or a plain shell (`agent` null) */
export interface RosterPane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent: string | null;
  status: AgentStatus;
  title: string | null;
  /** the tab's name when someone named it (Herdr numbers unnamed tabs) */
  label: string | null;
  cwd: string;
  focused: boolean;
  /** ms epoch of the last status change this server saw; null until it sees one */
  changed_at: number | null;
}

export interface Roster {
  workspaces: RosterWorkspace[];
  panes: RosterPane[];
}

export type AccessMode = "local" | "lan" | "remote";

export interface SessionInfo {
  authenticated: boolean;
  /** no password has been set yet: run the setup action in Herdr */
  setup_required: boolean;
  /** only present when signed in (H7) */
  herdr?: { connected: boolean };
  /** only present when signed in: how this server is reached */
  access?: { mode: AccessMode; url: string | null };
}

export interface ApiError {
  error: { code: string; message: string };
}

/** Server → browser frames on /ws */
export type ServerFrame =
  | { type: "roster"; roster: Roster }
  | { type: "herdr"; connected: boolean }
  | { type: "notify"; notice: Notice };

/**
 * Browser → server frames on /ws. `presence`: whether the tab is in view, and the push
 * subscription of its browser, if any; a browser in view gets the notice as a toast, not a push.
 */
export type ClientFrame = { type: "refresh" } | { type: "presence"; visible: boolean; push: string | null };

/** one sign-in in the devices list (`GET /api/auth/sessions`) */
export interface SignIn {
  /** the start of the token's hash: picks the sign-in to sign out */
  id: string;
  /** "Chrome on Linux", from its User-Agent */
  device: string;
  user_agent: string;
  address: string | null;
  created_at: number;
  last_seen_at: number;
  /** the browser asking */
  current: boolean;
  /** it gets push notifications */
  notifications: boolean;
}

/** something worth telling the person: a session needs them, or one stopped working */
export interface Notice {
  id: string;
  pane_id: string;
  kind: "blocked" | "finished";
  title: string;
  body: string;
  at: number;
}

// --- chat (Claude Code transcripts) ---------------------------------------------------------

export type ToolDetail =
  /** `op`: "+" added, "-" removed, " " context, "@" start of a hunk (`text` is its first line number) */
  | { type: "diff"; path: string; lines: { op: "+" | "-" | " " | "@"; text: string }[]; added: number; removed: number; truncated: boolean }
  | { type: "command"; command: string };

export type PlanStatus = "pending" | "in_progress" | "completed";

export type ChatItem =
  | { kind: "user"; id: string; text: string; at: string | null }
  | { kind: "assistant"; id: string; text: string; at: string | null }
  | { kind: "tool"; id: string; name: string; summary: string; detail: ToolDetail | null; state: "running" | "done" | "error"; output: string | null }
  | { kind: "plan"; id: string; items: { text: string; status: PlanStatus }[] }
  | { kind: "question"; id: string; questions: { question: string; options: { label: string; description: string }[] }[]; answer: string | null }
  /** a slash command typed into the agent (/model, /clear…) and what it printed */
  | { kind: "command"; id: string; command: string; output: string | null }
  | { kind: "divider"; id: string; text: string };

/** a plan limit window: how much is used and when it starts over */
export interface UsageWindow {
  percent: number;
  /** ms epoch */
  resetsAt: number | null;
}

/** what the agent reports about its context window and plan limits */
export interface AgentUsage {
  context: { percent: number; used: number; size: number } | null;
  /** Claude plans: the rolling 5-hour window and the week */
  fiveHour: UsageWindow | null;
  week: UsageWindow | null;
  model: string | null;
  effort: string | null;
  costUsd: number | null;
  /** OpenCode: what every session cost in the last 7 days */
  weekCostUsd?: number;
  /** ms epoch of the agent's last report */
  updatedAt: number;
}

export interface ChatSnapshot {
  /** changes whenever the transcript grows; send it back as `?v=` to skip unchanged reads */
  version: string;
  items: ChatItem[];
  /** messages typed while the agent was busy, waiting for their turn */
  queued: string[];
  /** older items left out of `items` */
  hidden: number;
  model: string | null;
  /** context and plan usage, when the agent reports it */
  usage?: AgentUsage | null;
  /** how the transcript was found: reported by Herdr's integration, or guessed from the folder */
  source: "herdr" | "guess";
  /** what the agent has running besides its own turn: subagents, background commands, monitors */
  tasks: RunningTask[];
}

/**
 * Something the agent started that has not finished yet: why it may say "working" while its own
 * turn is idle, or sit idle while work goes on.
 */
export interface RunningTask {
  id: string;
  kind: "agent" | "command" | "monitor";
  /** what it is for: the subagent's or the command's description, the monitor's */
  label: string;
  /** the command behind it, or the subagent's type */
  detail: string | null;
  /** launched in the background (the agent goes on); false: its turn waits for it */
  background: boolean;
  started_at: string | null;
  /** a monitor's latest event */
  last_event: string | null;
}

/** a choice the agent's terminal is waiting on (permission, question, trust prompt) */
export interface PanePrompt {
  title: string;
  options: string[];
  /** where the terminal's cursor is */
  selected: number;
  /** the option marked as the current setting (✔), when the menu shows one */
  current?: number;
  /** how the cursor moves between options */
  axis: "vertical" | "horizontal";
}

export interface ChatResponse {
  chat: ChatSnapshot | null;
  unchanged?: boolean;
  prompt: PanePrompt | null;
}
