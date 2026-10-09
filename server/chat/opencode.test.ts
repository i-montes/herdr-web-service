import { beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { locateOpencodeSession, readOpencodeChat } from "./opencode.ts";

let db: Database;
let t = 1000;

beforeEach(() => {
  db = new Database(":memory:");
  db.run("create table session (id text primary key, directory text not null, parent_id text, time_updated integer not null, time_archived integer)");
  db.run("create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null)");
  db.run("create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null)");
  t = 1000;
});

const session = (id: string, directory: string, updated: number, parent: string | null = null) => db.run("insert into session values (?, ?, ?, ?, null)", [id, directory, parent, updated]);
const message = (id: string, sid: string, data: object) => db.run("insert into message values (?, ?, ?, ?, ?)", [id, sid, ++t, t, JSON.stringify(data)]);
const part = (id: string, mid: string, sid: string, data: object) => db.run("insert into part values (?, ?, ?, ?, ?, ?)", [id, mid, sid, ++t, t, JSON.stringify(data)]);

test("the reported session wins; otherwise the newest top-level session of the folder", () => {
  session("ses_a", "/Users/ana/p", 10);
  session("ses_b", "/Users/ana/p", 20);
  session("ses_child", "/Users/ana/p", 30, "ses_b");
  session("ses_other", "/Users/ana/q", 40);
  expect(locateOpencodeSession(db, { cwd: "/Users/ana/p", session: null })).toEqual({ id: "ses_b", source: "guess" });
  expect(locateOpencodeSession(db, { cwd: "/Users/ana/p", session: { kind: "id", value: "ses_a" } })).toEqual({ id: "ses_a", source: "herdr" });
  expect(locateOpencodeSession(db, { cwd: "/Users/ana/p", session: { kind: "id", value: "ses_missing" } })).toEqual({ id: "ses_b", source: "guess" });
  expect(locateOpencodeSession(db, { cwd: "/nowhere", session: null })).toBeNull();
});

test("messages, tools, plan, questions and compaction become chat items", () => {
  session("ses_1", "/Users/ana/p", 1);
  message("m1", "ses_1", { role: "user" });
  part("p1", "m1", "ses_1", { type: "text", text: "Review the project" });
  part("p1s", "m1", "ses_1", { type: "text", text: "contexto interno", synthetic: true });
  message("m2", "ses_1", { role: "assistant", modelID: "MiniMax-M3", providerID: "minimax" });
  part("p2", "m2", "ses_1", { type: "step-start" });
  part("p3", "m2", "ses_1", { type: "reasoning", text: "pensando" });
  part("p4", "m2", "ses_1", { type: "text", text: "Voy a mirar." });
  part("p5", "m2", "ses_1", { type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls -la\necho fin" }, output: "a\nb" } });
  part("p6", "m2", "ses_1", { type: "tool", tool: "edit", state: { status: "error", input: { filePath: "/Users/ana/p/x.ts", oldString: "a", newString: "b\nc" }, error: "no match" } });
  part("p7", "m2", "ses_1", { type: "tool", tool: "todowrite", state: { status: "completed", input: { todos: [{ content: "Uno", status: "completed" }, { content: "Dos", status: "in_progress" }] } } });
  part("p8", "m2", "ses_1", { type: "tool", tool: "question", state: { status: "running", input: { questions: [{ question: "Go on?", options: [{ label: "Yes", description: "" }] }] } } });
  part("p9", "m2", "ses_1", { type: "tool", tool: "read", state: { status: "pending", input: { filePath: "/Users/ana/p/y.ts" } } });
  part("p10", "m2", "ses_1", { type: "compaction", auto: true });
  part("p11", "m2", "ses_1", { type: "step-finish" });

  const chat = readOpencodeChat(db, "ses_1", "/Users/ana");
  expect(chat.model).toBe("MiniMax-M3");
  expect(chat.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "tool", "plan", "question", "tool", "divider"]);
  expect(chat.items[0]).toMatchObject({ kind: "user", text: "Review the project" });
  expect(chat.items[2]).toMatchObject({ kind: "tool", name: "Bash", summary: "ls -la", state: "done", output: "a\nb", detail: { type: "command", command: "ls -la\necho fin" } });
  expect(chat.items[3]).toMatchObject({ kind: "tool", name: "Edit", summary: "~/p/x.ts", state: "error", output: "no match", detail: { type: "diff", added: 2, removed: 1 } });
  expect(chat.items[4]).toMatchObject({ kind: "plan", items: [{ text: "Uno", status: "completed" }, { text: "Dos", status: "in_progress" }] });
  expect(chat.items[5]).toMatchObject({ kind: "question", answer: null, questions: [{ question: "Go on?" }] });
  expect(chat.items[6]).toMatchObject({ kind: "tool", name: "Read", summary: "~/p/y.ts", state: "running" });
});

test("the version changes when a part changes", () => {
  session("ses_1", "/Users/ana/p", 1);
  message("m1", "ses_1", { role: "user" });
  part("p1", "m1", "ses_1", { type: "text", text: "hola" });
  const before = readOpencodeChat(db, "ses_1", "/Users/ana").version;
  db.run("update part set data = ?, time_updated = ? where id = 'p1'", [JSON.stringify({ type: "text", text: "hola!" }), 99999]);
  expect(readOpencodeChat(db, "ses_1", "/Users/ana").version).not.toBe(before);
});
