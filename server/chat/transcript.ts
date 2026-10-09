/**
 * Claude Code transcript (JSONL, one event per line) → the chat items the web app draws.
 *
 * Fed line by line so a growing file is parsed once: tool calls are remembered by id and
 * completed when their result arrives in a later line. Internal lines (thinking, reminders,
 * local commands, subagent sidechains, meta and compact summaries) are left out.
 */
import type { ChatItem, ChatSnapshot, PlanStatus, ToolDetail } from "../../shared/protocol.ts";
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
  return [summary || "Tarea en segundo plano", status && status !== "completed" ? `(${status})` : ""].filter(Boolean).join(" ");
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
      .map((b) => (typeof b === "object" && b && (b as Raw)["type"] === "text" ? str((b as Raw)["text"]) : (b as Raw)?.["type"] === "image" ? "[imagen]" : ""))
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
      this.items.push({ kind: "divider", id, text: "Conversación compactada" });
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
      const notice = typeof content === "string" ? taskNotice(content) : null;
      if (notice || (o["origin"] as Raw | undefined)?.["kind"] === "task-notification") {
        this.items.push({ kind: "divider", id, text: `Tarea en segundo plano: ${notice ?? "terminó"}` });
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
        this.toolUse(str(block["id"]) || blockId, str(block["name"]), (block["input"] ?? {}) as Raw);
      }
    });
  }

  /**
   * Claude Code's message queue. A dequeued message comes back as a user line, so it just leaves
   * the queue; one absorbed into the running turn never does, so it becomes a user item here.
   */
  private queue(id: string, operation: string, content: string, reason: string, at: string | null): void {
    if (operation === "enqueue") {
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
      if (notice) this.items.push({ kind: "divider", id, text: `Tarea en segundo plano: ${notice}` });
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

  private toolUse(toolId: string, name: string, input: Raw): void {
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

  /** the last `limit` items; earlier plans give way to the latest one */
  snapshot(limit: number, version = ""): Omit<ChatSnapshot, "source"> {
    let lastPlan = -1;
    this.items.forEach((item, i) => item.kind === "plan" && (lastPlan = i));
    const visible = this.items.filter((item, i) => item.kind !== "plan" || i === lastPlan);
    const start = Math.max(0, visible.length - limit);
    return { version, items: visible.slice(start), hidden: start, model: this.model, queued: [...this.queued] };
  }
}
