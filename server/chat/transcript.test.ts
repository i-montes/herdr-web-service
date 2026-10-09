import { expect, test } from "bun:test";
import { Transcript } from "./transcript.ts";

const HOME = "/Users/ana";
const line = (o: unknown) => JSON.stringify(o);
const user = (content: unknown, extra: object = {}) => line({ type: "user", uuid: "u" + Math.random(), timestamp: "2026-10-08T10:00:00Z", message: { role: "user", content }, ...extra });
const assistant = (content: unknown[], model = "claude-opus-5-5") => line({ type: "assistant", uuid: "a" + Math.random(), timestamp: "2026-10-08T10:00:01Z", message: { role: "assistant", model, content } });

function feed(lines: string[]) {
  const t = new Transcript(HOME);
  for (const l of lines) t.feed(l);
  return t;
}

test("user and assistant text, thinking and internal messages hidden", () => {
  const t = feed([
    user("Hola, revisa el proyecto"),
    user("<command-name>/clear</command-name>"),
    user("algo", { isMeta: true }),
    user("Resumen anterior", { isCompactSummary: true }),
    assistant([{ type: "thinking", thinking: "..." }, { type: "text", text: "Voy a **revisar**." }]),
    user("texto con <system-reminder>secreto</system-reminder> visible"),
    "not json",
    line({ type: "attachment" }),
  ]);
  const items = t.snapshot(100).items;
  expect(items.map((i) => i.kind)).toEqual(["user", "command", "assistant", "user"]);
  expect(items[1]).toMatchObject({ kind: "command", command: "/clear" });
  expect(items[2]).toMatchObject({ kind: "assistant", text: "Voy a **revisar**." });
  expect(items[3]).toMatchObject({ text: "texto con  visible" });
  expect(t.snapshot(100).model).toBe("claude-opus-5-5");
});

test("a tool call is paired with its result", () => {
  const t = feed([
    assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test\n--watch=false", description: "run tests" } }]),
    assistant([{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/Users/ana/p/a.ts" } }]),
    user([{ type: "tool_result", tool_use_id: "t1", content: "✓ 48 passed", is_error: false }]),
  ]);
  const [bash, read] = t.snapshot(100).items;
  expect(bash).toMatchObject({ kind: "tool", name: "Bash", summary: "npm test", state: "done", output: "✓ 48 passed", detail: { type: "command", command: "npm test\n--watch=false" } });
  expect(read).toMatchObject({ kind: "tool", name: "Read", summary: "~/p/a.ts", state: "running", output: null });
});

test("errors, array results and long output", () => {
  const t = feed([
    assistant([{ type: "tool_use", id: "t1", name: "Grep", input: { pattern: "TODO" } }]),
    user([{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "x".repeat(20_000) }], is_error: true }]),
  ]);
  const [grep] = t.snapshot(100).items;
  expect(grep).toMatchObject({ state: "error", summary: "TODO" });
  expect((grep as { output: string }).output.length).toBeLessThan(6100);
});

test("edits become diffs", () => {
  const t = feed([assistant([{ type: "tool_use", id: "e", name: "Edit", input: { file_path: "/Users/ana/p/s.prisma", old_string: "a\nb", new_string: "a2\nb\nc" } }])]);
  expect(t.snapshot(100).items[0]).toMatchObject({
    kind: "tool",
    summary: "~/p/s.prisma",
    detail: { type: "diff", path: "~/p/s.prisma", added: 3, removed: 2, lines: [{ op: "-", text: "a" }, { op: "-", text: "b" }, { op: "+", text: "a2" }, { op: "+", text: "b" }, { op: "+", text: "c" }] },
  });
});

test("only the latest plan is shown; questions carry their answer", () => {
  const todos = (s: string) => ({ todos: [{ content: "Revisar", status: "completed" }, { content: "Aplicar", status: s }] });
  const t = feed([
    assistant([{ type: "tool_use", id: "p1", name: "TodoWrite", input: todos("pending") }]),
    assistant([{ type: "tool_use", id: "q", name: "AskUserQuestion", input: { questions: [{ question: "¿Aplico?", options: [{ label: "Sí", description: "local" }, { label: "No", description: "" }] }] } }]),
    assistant([{ type: "tool_use", id: "p2", name: "TodoWrite", input: todos("in_progress") }]),
    user([{ type: "tool_result", tool_use_id: "q", content: "User answered: Sí" }]),
  ]);
  const items = t.snapshot(100).items;
  expect(items.map((i) => i.kind)).toEqual(["question", "plan"]);
  expect(items[0]).toMatchObject({ questions: [{ question: "¿Aplico?", options: [{ label: "Sí", description: "local" }, { label: "No", description: "" }] }], answer: "User answered: Sí" });
  expect(items[1]).toMatchObject({ items: [{ text: "Revisar", status: "completed" }, { text: "Aplicar", status: "in_progress" }] });
});

test("compaction leaves a divider; the snapshot keeps the tail", () => {
  const lines = [line({ type: "system", subtype: "compact_boundary", uuid: "c" })];
  for (let i = 0; i < 10; i++) lines.push(user(`m${i}`));
  const snap = feed(lines).snapshot(4);
  expect(snap.hidden).toBe(7);
  expect(snap.items.map((i) => (i.kind === "user" ? i.text : i.kind))).toEqual(["m6", "m7", "m8", "m9"]);
  expect(feed(lines).snapshot(100).items[0]).toMatchObject({ kind: "divider", text: "Conversación compactada" });
});

test("sidechain (subagent) lines are skipped", () => {
  expect(feed([user("sub", { isSidechain: true }), user("main")]).snapshot(10).items).toHaveLength(1);
});

test("slash commands and what they print, from user lines or system lines", () => {
  const sys = (content: string) => line({ type: "system", subtype: "local_command", uuid: "s" + Math.random(), content });
  const t = feed([
    user("<local-command-caveat>The command below was run directly in Claude Code</local-command-caveat>"),
    user("<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args>high</command-args>"),
    user("<local-command-stdout>Cancelled</local-command-stdout>"),
    sys("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>"),
    sys("<local-command-stdout>Kept model as `Fable 5.1`</local-command-stdout>"),
    user("sigue"),
  ]);
  expect(t.snapshot(10).items).toMatchObject([
    { kind: "command", command: "/effort high", output: "Cancelled" },
    { kind: "command", command: "/model", output: "Kept model as `Fable 5.1`" },
    { kind: "user", text: "sigue" },
  ]);
});

test("queued messages wait, dequeued ones leave, absorbed ones become user messages", () => {
  const op = (operation: string, extra: object = {}) => line({ type: "queue-operation", operation, uuid: "q" + Math.random(), timestamp: "2026-10-08T10:00:02Z", ...extra });
  const t = feed([op("enqueue", { content: "uno" }), op("enqueue", { content: "dos" }), op("enqueue", { content: "tres" })]);
  expect(t.snapshot(10).queued).toEqual(["uno", "dos", "tres"]);
  t.feed(op("dequeue"));
  t.feed(user("uno"));
  t.feed(op("remove", { content: "tres", reason: "absorbed_mid_turn" }));
  const snap = t.snapshot(10);
  expect(snap.queued).toEqual(["dos"]);
  expect(snap.items.map((i) => (i.kind === "user" ? i.text : i.kind))).toEqual(["uno", "tres"]);
});

test("an edit's real patch replaces the diff guessed from its input", () => {
  const t = feed([
    assistant([{ type: "tool_use", id: "w", name: "Write", input: { file_path: "/Users/ana/p/a.ts", content: "a\nB\nc\nd" } }]),
    line({
      type: "user",
      uuid: "r",
      message: { content: [{ type: "tool_result", tool_use_id: "w", content: "The file has been updated successfully." }] },
      toolUseResult: { type: "update", structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [" a", "-b", "+B", " c", "+d"] }] },
    }),
  ]);
  expect(t.snapshot(10).items[0]).toMatchObject({
    kind: "tool",
    detail: { type: "diff", added: 2, removed: 1, lines: [{ op: "@", text: "1" }, { op: " ", text: "a" }, { op: "-", text: "b" }, { op: "+", text: "B" }, { op: " ", text: "c" }, { op: "+", text: "d" }] },
  });
});

test("a new file keeps every line as added", () => {
  const t = feed([
    assistant([{ type: "tool_use", id: "w", name: "Write", input: { file_path: "/Users/ana/p/n.ts", content: "x\ny" } }]),
    line({ type: "user", uuid: "r", message: { content: [{ type: "tool_result", tool_use_id: "w", content: "File created" }] }, toolUseResult: { type: "create", structuredPatch: [] } }),
  ]);
  expect(t.snapshot(10).items[0]).toMatchObject({ detail: { added: 2, removed: 0 } });
});

test("background task notices are not user messages; pasted blocks are unwrapped", () => {
  const notice = "<task-notification>\n<task-id>b7</task-id>\n<status>failed</status>\n<summary>Background command \"Build\" failed with exit code 144</summary>\n</task-notification>";
  const t = feed([
    user(notice, { origin: { kind: "task-notification" } }),
    user('mira esto\n\n<pasted_content id="ab12">\nlínea pegada\n</pasted_content id="ab12">'),
    line({ type: "queue-operation", operation: "enqueue", uuid: "q", content: notice }),
  ]);
  const snap = t.snapshot(10);
  expect(snap.items).toMatchObject([
    { kind: "divider", text: 'Tarea en segundo plano: Background command "Build" failed with exit code 144 (failed)' },
    { kind: "user", text: "mira esto\n\nlínea pegada" },
  ]);
  expect(snap.queued).toEqual([]);
});
