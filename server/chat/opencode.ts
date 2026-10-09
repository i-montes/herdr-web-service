/**
 * OpenCode conversations → chat items. OpenCode keeps every session in a SQLite database
 * (`~/.local/share/opencode/opencode.db`): `message` rows carry the role and model, `part` rows
 * the content (text, tool calls with their state, plan, questions, compaction marks). The
 * database is opened read-only; OpenCode writes it in WAL mode, so reading never blocks it.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChatItem, ChatSnapshot, PlanStatus, ToolDetail } from "../../shared/protocol.ts";
import { tildePath } from "../herdr/roster.ts";
import type { PaneSessionRef } from "./store.ts";
import { CHAT_LIMIT } from "./store.ts";
import { clip, diffOf } from "./transcript.ts";

type Raw = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parse(json: string): Raw {
  try {
    const value = JSON.parse(json) as unknown;
    return typeof value === "object" && value !== null ? (value as Raw) : {};
  } catch {
    return {};
  }
}

let shared: { path: string; db: Database } | null = null;

/** the user's OpenCode database, opened read-only once; null when OpenCode never ran */
export function opencodeDb(home: string): Database | null {
  const path = join(home, ".local", "share", "opencode", "opencode.db");
  if (shared?.path === path) return shared.db;
  if (!existsSync(path)) return null;
  try {
    shared = { path, db: new Database(path, { readonly: true }) };
    return shared.db;
  } catch {
    return null;
  }
}

/** Herdr's report (`ses_…`) when it names an existing session; else the folder's newest top-level session */
export function locateOpencodeSession(db: Database, ref: PaneSessionRef): { id: string; source: "herdr" | "guess" } | null {
  if (ref.session?.value) {
    const hit = db.query("select id from session where id = ?").get(ref.session.value) as { id: string } | null;
    if (hit) return { id: hit.id, source: "herdr" };
  }
  const guess = db.query("select id from session where directory = ? and parent_id is null and time_archived is null order by time_updated desc limit 1").get(ref.cwd) as { id: string } | null;
  return guess ? { id: guess.id, source: "guess" } : null;
}

const TOOL_NAMES: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  multiedit: "MultiEdit",
  patch: "Patch",
  grep: "Grep",
  glob: "Glob",
  list: "LS",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  task: "Task",
};

function toolItem(id: string, tool: string, state: Raw, home: string): ChatItem {
  const input = (state["input"] ?? {}) as Raw;
  const status = str(state["status"]);
  const path = (key: string) => tildePath(str(input[key]), home);

  if (tool === "todowrite") {
    const todos = Array.isArray(input["todos"]) ? (input["todos"] as Raw[]) : [];
    return {
      kind: "plan",
      id,
      items: todos.map((t) => ({
        text: str(t["content"]),
        status: (["pending", "in_progress", "completed"].includes(str(t["status"])) ? t["status"] : "pending") as PlanStatus,
      })),
    };
  }
  if (tool === "question") {
    const questions = (Array.isArray(input["questions"]) ? (input["questions"] as Raw[]) : []).map((q) => ({
      question: str(q["question"]),
      options: (Array.isArray(q["options"]) ? (q["options"] as Raw[]) : []).map((o) => ({ label: str(o["label"]), description: str(o["description"]) })),
    }));
    return { kind: "question", id, questions, answer: status === "completed" ? clip(str(state["output"]), 1000) : null };
  }

  let summary = "";
  let detail: ToolDetail | null = null;
  switch (tool) {
    case "bash": {
      const command = str(input["command"]);
      summary = command.split("\n")[0] ?? "";
      detail = { type: "command", command };
      break;
    }
    case "edit":
      summary = path("filePath");
      detail = diffOf(summary, [{ old: str(input["oldString"]), new: str(input["newString"]) }]);
      break;
    case "multiedit":
      summary = path("filePath");
      detail = diffOf(summary, (Array.isArray(input["edits"]) ? (input["edits"] as Raw[]) : []).map((e) => ({ old: str(e["oldString"]), new: str(e["newString"]) })));
      break;
    case "write":
      summary = path("filePath");
      detail = diffOf(summary, [{ old: "", new: str(input["content"]) }]);
      break;
    case "read":
      summary = path("filePath");
      break;
    case "grep":
    case "glob":
      summary = str(input["pattern"]);
      break;
    case "list":
      summary = path("path");
      break;
    case "webfetch":
      summary = str(input["url"]);
      break;
    case "websearch":
      summary = str(input["query"]);
      break;
    case "task":
      summary = str(input["description"]);
      break;
    default:
      summary = str(state["title"]) || str(Object.values(input).find((v) => typeof v === "string"));
  }
  const output = status === "error" ? str(state["error"]) : str(state["output"]);
  return {
    kind: "tool",
    id,
    name: TOOL_NAMES[tool] ?? tool,
    summary: summary.slice(0, 300),
    detail,
    state: status === "completed" ? "done" : status === "error" ? "error" : "running",
    output: output ? clip(output.replace(/<shell_metadata>[\s\S]*?<\/shell_metadata>/g, "").trim()) : null,
  };
}

export function readOpencodeChat(db: Database, sessionId: string, home: string): Omit<ChatSnapshot, "source"> {
  // the version moves with any new or updated row of the session
  const stamp = db.query("select (select count(*) from message where session_id = $s) m, (select count(*) from part where session_id = $s) p, (select coalesce(max(time_updated), 0) from part where session_id = $s) u").get({ $s: sessionId }) as { m: number; p: number; u: number };
  const version = `oc:${sessionId}:${stamp.m}:${stamp.p}:${stamp.u}`;

  const messages = db.query("select id, time_created, data from message where session_id = ? order by time_created, id").all(sessionId) as { id: string; time_created: number; data: string }[];
  const parts = db.query("select id, message_id, data from part where session_id = ? order by time_created, id").all(sessionId) as { id: string; message_id: string; data: string }[];
  const byMessage = new Map<string, { id: string; data: Raw }[]>();
  for (const p of parts) {
    const list = byMessage.get(p.message_id) ?? [];
    list.push({ id: p.id, data: parse(p.data) });
    byMessage.set(p.message_id, list);
  }

  const items: ChatItem[] = [];
  let model: string | null = null;
  for (const m of messages) {
    const data = parse(m.data);
    const at = new Date(m.time_created).toISOString();
    const content = byMessage.get(m.id) ?? [];
    if (data["role"] === "user") {
      const text = content
        .filter((p) => p.data["type"] === "text" && p.data["synthetic"] !== true && p.data["ignored"] !== true)
        .map((p) => str(p.data["text"]).trim())
        .filter(Boolean)
        .join("\n\n");
      if (text) items.push({ kind: "user", id: m.id, text, at });
      continue;
    }
    if (typeof data["modelID"] === "string") model = data["modelID"];
    for (const p of content) {
      const type = p.data["type"];
      if (type === "text") {
        const text = str(p.data["text"]).trim();
        if (text && p.data["synthetic"] !== true) items.push({ kind: "assistant", id: p.id, text, at });
      } else if (type === "tool") {
        items.push(toolItem(p.id, str(p.data["tool"]), (p.data["state"] ?? {}) as Raw, home));
      } else if (type === "compaction") {
        items.push({ kind: "divider", id: p.id, text: "Conversación compactada" });
      }
    }
  }

  // like Claude's: only the latest plan stays
  let lastPlan = -1;
  items.forEach((item, i) => item.kind === "plan" && (lastPlan = i));
  const visible = items.filter((item, i) => item.kind !== "plan" || i === lastPlan);
  const start = Math.max(0, visible.length - CHAT_LIMIT);
  return { version, items: visible.slice(start), hidden: start, model, queued: [] };
}
