/**
 * Claude Code transcript (JSONL, one event per line) → the chat items the web app draws.
 *
 * Fed line by line so a growing file is parsed once: tool calls are remembered by id and
 * completed when their result arrives in a later line. Internal lines (thinking, reminders,
 * local commands, subagent sidechains, meta and compact summaries) are left out.
 */
import type { ChatItem, ChatSnapshot, PlanStatus, RunningTask, ToolDetail } from "../../shared/protocol.ts";
import { tildePath } from "../herdr/roster.ts";

const MAX_OUTPUT = 6000;
const MAX_DIFF_LINES = 120;

type Raw = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function clip(text: string, max = MAX_OUTPUT): string {
  return text.length > max ? text.slice(0, max) + "\n…" : text;
}

/** a slash command typed into Claude Code, or what one printed, as the transcript records them */
function localCommand(text: string): { command: string } | { output: string } | null {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (name) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
    return { command: [name[1]!.trim(), args].filter(Boolean).join(" ") };
  }
  const out = /<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/.exec(text);
  if (out) return { output: out[1]!.trim() };
  return null;
}

/** a background task's completion notice: its summary (and status), or null */
function taskNotice(text: string): string | null {
  if (!/^\s*<task-notification>/.test(text)) return null;
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim();
  const status = /<status>([^<]*)<\/status>/.exec(text)?.[1]?.trim();
  // a monitor sends one notice per event, all with the same summary: the event tells them apart
  const event = /<event>([\s\S]*?)<\/event>/.exec(text)?.[1]?.trim();
  return [summary || "Background task", event ? `— ${clip(event, 200)}` : "", status && status !== "completed" ? `(${status})` : ""].filter(Boolean).join(" ");
}

/**
 * A task notice's task id, whether it ends the task (only final notices carry a <status>; a
 * monitor also sends one per event, without it) and the event a monitor reported.
 */
function taskNotification(text: string): { id: string; done: boolean; event: string | null } | null {
  if (!/^\s*<task-notification>/.test(text)) return null;
  const id = /<task-id>([^<]*)<\/task-id>/.exec(text)?.[1]?.trim();
  if (!id) return null;
  return { id, done: /<status>/.test(text), event: /<event>([\s\S]*?)<\/event>/.exec(text)?.[1]?.trim() ?? null };
}

const truthy = (value: unknown) => value === true || value === "true";

/**
 * A command line's gist for a name: setup steps (`cd …`, `VAR=…`) dropped, the step that does the
 * work kept. `S=/tmp/x; cd ~/app && PORT=1 bun server.ts` → `bun server.ts`.
 */
export function commandGist(command: string): string {
  const line = command.split("\n")[0] ?? "";
  const steps = line.split(/\s*(?:&&|;)\s*/).map((step) => step.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*)+/, "").trim());
  return steps.filter((step) => step && !/^cd(?:\s|$)/.test(step)).pop() ?? line.trim();
}

/** what a user string shows: reminders stripped, pasted blocks unwrapped; null for Claude Code's own bookkeeping */
function userText(text: string): string | null {
  if (/^\s*<(command-name|command-message|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification)>/.test(text)) return null;
  const cleaned = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<pasted_content[^>]*>\n?([\s\S]*?)\n?<\/pasted_content[^>]*>/g, "$1")
    .trim();
  return cleaned || null;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "object" && b && (b as Raw)["type"] === "text" ? str((b as Raw)["text"]) : (b as Raw)?.["type"] === "image" ? "[image]" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Claude Code's own patch for an edit (`toolUseResult.structuredPatch`): hunks of " ", "+", "-" lines */
function diffOfPatch(path: string, hunks: Raw[]): ToolDetail {
  const lines: { op: "+" | "-" | " " | "@"; text: string }[] = [];
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    lines.push({ op: "@", text: String(hunk["newStart"] ?? "") });
    for (const raw of Array.isArray(hunk["lines"]) ? (hunk["lines"] as unknown[]) : []) {
      const line = str(raw);
      const op = line[0] === "+" || line[0] === "-" ? line[0] : " ";
      if (op === "+") added++;
      if (op === "-") removed++;
      lines.push({ op, text: line.slice(1) });
    }
  }
  return { type: "diff", path, lines: lines.slice(0, MAX_DIFF_LINES), added, removed, truncated: lines.length > MAX_DIFF_LINES };
}

export function diffOf(path: string, pairs: { old: string; new: string }[]): ToolDetail {
  const lines: { op: "+" | "-" | " " | "@"; text: string }[] = [];
  let added = 0;
  let removed = 0;
  for (const pair of pairs) {
    const before = pair.old ? pair.old.split("\n") : [];
    const after = pair.new ? pair.new.split("\n") : [];
    removed += before.length;
    added += after.length;
    for (const text of before) lines.push({ op: "-", text });
    for (const text of after) lines.push({ op: "+", text });
  }
  return { type: "diff", path, lines: lines.slice(0, MAX_DIFF_LINES), added, removed, truncated: lines.length > MAX_DIFF_LINES };
}

export class Transcript {
  private items: ChatItem[] = [];
  private tools = new Map<string, number>();
  private model: string | null = null;
  private queued: string[] = [];
  /** what is still running, by task id (a tool_use id until a background launch reports its own) */
  private running = new Map<string, RunningTask>();
  /** finished subagents: a SendMessage to one resumes it */
  private finished = new Map<string, RunningTask>();
  /** TaskStop calls waiting for their result: tool_use id → the task it stops */
  private stops = new Map<string, string>();

  constructor(private readonly home: string) {}

  feed(line: string): void {
    let o: Raw;
    try {
      o = JSON.parse(line) as Raw;
    } catch {
      return;
    }
    if (typeof o !== "object" || o === null || o["isSidechain"] === true) return;
    const type = o["type"];
    const id = str(o["uuid"]) || `l${this.items.length}`;
    const at = str(o["timestamp"]) || null;

    if (type === "system" && o["subtype"] === "compact_boundary") {
      this.items.push({ kind: "divider", id, text: "Conversation compacted" });
      return;
    }
    if (type === "system" && o["subtype"] === "local_command") {
      this.command(id, str(o["content"]));
      return;
    }
    if (type === "queue-operation") {
      this.queue(id, str(o["operation"]), str(o["content"]), str(o["reason"]), at);
      return;
    }
    if (type !== "user" && type !== "assistant") return;
    if (o["isMeta"] === true || o["isCompactSummary"] === true) return;
    const message = (o["message"] ?? {}) as Raw;
    const content = message["content"];

    if (type === "user") {
      // Claude Code records a background task's completion as a user line: it is a notice
      if (typeof content === "string") this.notified(content);
      const notice = typeof content === "string" ? taskNotice(content) : null;
      if (notice || (o["origin"] as Raw | undefined)?.["kind"] === "task-notification") {
        this.items.push({ kind: "divider", id, text: `Background task: ${notice ?? "finished"}` });
        return;
      }
      if (typeof content === "string") {
        if (this.command(id, content)) return;
        const text = userText(content);
        if (text) {
          this.items.push({ kind: "user", id, text, at });
          this.unqueue(content);
        }
        return;
      }
      if (!Array.isArray(content)) return;
      const texts: string[] = [];
      const results = (content as Raw[]).filter((b) => b["type"] === "tool_result").length;
      for (const block of content as Raw[]) {
        // the line's toolUseResult belongs to its tool_result only when there is just one
        if (block["type"] === "tool_result") this.complete(str(block["tool_use_id"]), block, results === 1 ? o["toolUseResult"] : undefined);
        else if (block["type"] === "text") {
          const text = userText(str(block["text"]));
          if (text) texts.push(text);
        }
      }
      if (texts.length) {
        this.items.push({ kind: "user", id, text: texts.join("\n\n"), at });
        for (const block of content as Raw[]) if (block["type"] === "text") this.unqueue(str(block["text"]));
      }
      return;
    }

    if (typeof message["model"] === "string" && !message["model"].startsWith("<")) this.model = message["model"];
    if (!Array.isArray(content)) return;
    (content as Raw[]).forEach((block, i) => {
      const blockId = `${id}:${i}`;
      if (block["type"] === "text") {
        const text = str(block["text"]).trim();
        if (text) this.items.push({ kind: "assistant", id: blockId, text, at });
      } else if (block["type"] === "tool_use") {
        this.toolUse(str(block["id"]) || blockId, str(block["name"]), (block["input"] ?? {}) as Raw, at);
      }
    });
  }

  /**
   * Claude Code's message queue. A dequeued message comes back as a user line, so it just leaves
   * the queue; one absorbed into the running turn never does, so it becomes a user item here.
   */
  private queue(id: string, operation: string, content: string, reason: string, at: string | null): void {
    if (operation === "enqueue") {
      // a task notice is queued the moment it arrives, often well before it reaches the conversation
      this.notified(content);
      // only what the person typed waits in the visible queue, not task notices
      if (userText(content)) this.queued.push(content);
      return;
    }
    if (operation === "dequeue") {
      return;
    }
    if (operation === "remove") {
      const index = this.queued.indexOf(content);
      if (index >= 0) this.queued.splice(index, 1);
      if (reason !== "absorbed_mid_turn") return;
      const notice = taskNotice(content);
      const text = userText(content);
      if (notice) this.items.push({ kind: "divider", id, text: `Background task: ${notice}` });
      else if (text) this.items.push({ kind: "user", id, text, at });
    }
  }

  /** a queued message reached the conversation: it no longer waits */
  private unqueue(content: string): void {
    const index = this.queued.indexOf(content);
    if (index >= 0) this.queued.splice(index, 1);
  }

  /** a command line or its output: the output joins the last command still without one */
  private command(id: string, text: string): boolean {
    const found = localCommand(text);
    if (!found) return false;
    if ("command" in found) {
      this.items.push({ kind: "command", id, command: found.command, output: null });
      return true;
    }
    for (let i = this.items.length - 1; i >= Math.max(0, this.items.length - 3); i--) {
      const item = this.items[i]!;
      if (item.kind === "command" && item.output === null) {
        this.items[i] = { ...item, output: clip(found.output, 4000) };
        return true;
      }
    }
    return true;
  }

  private toolUse(toolId: string, name: string, input: Raw, at: string | null): void {
    this.track(toolId, name, input, at);
    if (name === "TodoWrite") {
      const todos = Array.isArray(input["todos"]) ? (input["todos"] as Raw[]) : [];
      const items = todos.map((t) => ({
        text: str(t["content"]),
        status: (["pending", "in_progress", "completed"].includes(str(t["status"])) ? t["status"] : "pending") as PlanStatus,
      }));
      this.tools.set(toolId, this.items.length);
      this.items.push({ kind: "plan", id: toolId, items });
      return;
    }
    if (name === "AskUserQuestion") {
      const questions = (Array.isArray(input["questions"]) ? (input["questions"] as Raw[]) : []).map((q) => ({
        question: str(q["question"]),
        options: (Array.isArray(q["options"]) ? (q["options"] as Raw[]) : []).map((o) => ({ label: str(o["label"]), description: str(o["description"]) })),
      }));
      this.tools.set(toolId, this.items.length);
      this.items.push({ kind: "question", id: toolId, questions, answer: null });
      return;
    }
    const path = (key: string) => tildePath(str(input[key]), this.home);
    let summary = "";
    let detail: ToolDetail | null = null;
    switch (name) {
      case "Bash": {
        const command = str(input["command"]);
        summary = command.split("\n")[0] ?? "";
        detail = { type: "command", command };
        break;
      }
      case "Edit":
        summary = path("file_path");
        detail = diffOf(summary, [{ old: str(input["old_string"]), new: str(input["new_string"]) }]);
        break;
      case "MultiEdit":
        summary = path("file_path");
        detail = diffOf(summary, (Array.isArray(input["edits"]) ? (input["edits"] as Raw[]) : []).map((e) => ({ old: str(e["old_string"]), new: str(e["new_string"]) })));
        break;
      case "Write":
        summary = path("file_path");
        detail = diffOf(summary, [{ old: "", new: str(input["content"]) }]);
        break;
      case "Read":
      case "NotebookEdit":
        summary = path("file_path") || path("notebook_path");
        break;
      case "Grep":
      case "Glob":
        summary = str(input["pattern"]);
        break;
      case "WebFetch":
        summary = str(input["url"]);
        break;
      case "WebSearch":
        summary = str(input["query"]);
        break;
      case "Task":
      case "Agent":
        summary = str(input["description"]);
        break;
      default:
        summary = str(Object.values(input).find((v) => typeof v === "string"));
    }
    this.tools.set(toolId, this.items.length);
    this.items.push({ kind: "tool", id: toolId, name, summary: summary.slice(0, 300), detail, state: "running", output: null });
  }

  private complete(toolId: string, block: Raw, result: unknown): void {
    const index = this.tools.get(toolId);
    const tool = index === undefined ? undefined : this.items[index];
    this.settle(toolId, block["is_error"] === true, result, tool?.kind === "tool" ? tool.summary : "");
    if (index === undefined) return;
    const item = this.items[index]!;
    const text = resultText(block["content"]);
    if (item.kind === "tool") {
      // an edit's real patch replaces the guess made from its input (Write over an existing file)
      const patch = typeof result === "object" && result !== null ? (result as Raw)["structuredPatch"] : undefined;
      const detail = item.detail?.type === "diff" && Array.isArray(patch) && patch.length > 0 ? diffOfPatch(item.detail.path, patch as Raw[]) : item.detail;
      this.items[index] = { ...item, detail, state: block["is_error"] === true ? "error" : "done", output: clip(text) };
    }
    else if (item.kind === "question") this.items[index] = { ...item, answer: clip(text, 1000) };
  }

  /** a tool call that starts something lasting: subagents and monitors from the call itself */
  private track(toolId: string, name: string, input: Raw, at: string | null): void {
    if (name === "TaskStop") {
      const id = str(input["task_id"]) || str(input["shell_id"]);
      if (id) this.stops.set(toolId, id);
      return;
    }
    if (name === "SendMessage") {
      const resumed = this.finished.get(str(input["to"]));
      if (resumed) {
        this.finished.delete(resumed.id);
        this.running.set(resumed.id, { ...resumed, started_at: at });
      }
      return;
    }
    const base = { id: toolId, started_at: at, last_event: null };
    const command = (str(input["command"]).split("\n")[0] ?? "").slice(0, 300) || null;
    if (name === "Agent" || name === "Task") this.running.set(toolId, { ...base, kind: "agent", label: str(input["description"]) || "Subagent", detail: str(input["subagent_type"]) || null, background: truthy(input["run_in_background"]) });
    else if (name === "Monitor") this.running.set(toolId, { ...base, kind: "monitor", label: str(input["description"]) || "Monitor", detail: command, background: true });
    else if (name === "Bash" && truthy(input["run_in_background"])) this.running.set(toolId, { ...base, kind: "command", label: str(input["description"]) || commandGist(str(input["command"])) || "Background command", detail: command, background: true });
  }

  /**
   * A tool result: a foreground subagent is done, a background launch moves to the task id it
   * reports (a command sent to the background with ctrl+b reports one too), a TaskStop ends its task.
   */
  private settle(toolId: string, error: boolean, result: unknown, summary: string): void {
    const stop = this.stops.get(toolId);
    if (stop !== undefined) {
      this.stops.delete(toolId);
      if (!error) this.end(stop);
      return;
    }
    const launched = this.running.get(toolId);
    if (launched) this.running.delete(toolId);
    if (error) return;
    const r = (typeof result === "object" && result !== null ? result : {}) as Raw;
    const taskId = (truthy(r["isAsync"]) && str(r["agentId"])) || str(r["backgroundTaskId"]) || str(r["taskId"]);
    if (!taskId) return;
    // a command sent to the background with ctrl+b was not launched as one: its card names it
    const task: RunningTask = launched ?? { id: taskId, kind: "command", label: commandGist(summary) || "Background command", detail: summary || null, background: true, started_at: null, last_event: null };
    this.running.set(taskId, { ...task, id: taskId, background: true });
  }

  /** a task notice: a final one ends its task, a monitor's event becomes its latest */
  private notified(text: string): void {
    const notice = taskNotification(text);
    if (!notice) return;
    if (notice.done) this.end(notice.id);
    else if (notice.event) {
      const task = this.running.get(notice.id);
      if (task) this.running.set(notice.id, { ...task, last_event: clip(notice.event, 300) });
    }
  }

  private end(id: string): void {
    const task = this.running.get(id);
    if (!task) return;
    this.running.delete(id);
    if (task.kind === "agent") this.finished.set(id, task);
  }

  /** the last `limit` items; earlier plans give way to the latest one */
  snapshot(limit: number, version = ""): Omit<ChatSnapshot, "source"> {
    let lastPlan = -1;
    this.items.forEach((item, i) => item.kind === "plan" && (lastPlan = i));
    const visible = this.items.filter((item, i) => item.kind !== "plan" || i === lastPlan);
    const start = Math.max(0, visible.length - limit);
    return { version, items: visible.slice(start), hidden: start, model: this.model, queued: [...this.queued], tasks: [...this.running.values()] };
  }
}
