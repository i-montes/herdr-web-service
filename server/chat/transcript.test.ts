import { expect, test } from "bun:test";
import { Transcript, commandGist } from "./transcript.ts";

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
    user("Hi, review the project"),
    user("<command-name>/clear</command-name>"),
    user("something", { isMeta: true }),
    user("Earlier summary", { isCompactSummary: true }),
    assistant([{ type: "thinking", thinking: "..." }, { type: "text", text: "Let me **review** it." }]),
    user("text with <system-reminder>secret</system-reminder> visible"),
    "not json",
    line({ type: "attachment" }),
  ]);
  const items = t.snapshot(100).items;
  expect(items.map((i) => i.kind)).toEqual(["user", "command", "assistant", "user"]);
  expect(items[1]).toMatchObject({ kind: "command", command: "/clear" });
  expect(items[2]).toMatchObject({ kind: "assistant", text: "Let me **review** it." });
  expect(items[3]).toMatchObject({ text: "text with  visible" });
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
  const todos = (s: string) => ({ todos: [{ content: "Review", status: "completed" }, { content: "Apply", status: s }] });
  const t = feed([
    assistant([{ type: "tool_use", id: "p1", name: "TodoWrite", input: todos("pending") }]),
    assistant([{ type: "tool_use", id: "q", name: "AskUserQuestion", input: { questions: [{ question: "Apply it?", options: [{ label: "Yes", description: "local" }, { label: "No", description: "" }] }] } }]),
    assistant([{ type: "tool_use", id: "p2", name: "TodoWrite", input: todos("in_progress") }]),
    user([{ type: "tool_result", tool_use_id: "q", content: "User answered: Yes" }]),
  ]);
  const items = t.snapshot(100).items;
  expect(items.map((i) => i.kind)).toEqual(["question", "plan"]);
  expect(items[0]).toMatchObject({ questions: [{ question: "Apply it?", options: [{ label: "Yes", description: "local" }, { label: "No", description: "" }] }], answer: "User answered: Yes" });
  expect(items[1]).toMatchObject({ items: [{ text: "Review", status: "completed" }, { text: "Apply", status: "in_progress" }] });
});

test("compaction leaves a divider; the snapshot keeps the tail", () => {
  const lines = [line({ type: "system", subtype: "compact_boundary", uuid: "c" })];
  for (let i = 0; i < 10; i++) lines.push(user(`m${i}`));
  const snap = feed(lines).snapshot(4);
  expect(snap.hidden).toBe(7);
  expect(snap.items.map((i) => (i.kind === "user" ? i.text : i.kind))).toEqual(["m6", "m7", "m8", "m9"]);
  expect(feed(lines).snapshot(100).items[0]).toMatchObject({ kind: "divider", text: "Conversation compacted" });
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
    user('look at this\n\n<pasted_content id="ab12">\npasted line\n</pasted_content id="ab12">'),
    line({ type: "queue-operation", operation: "enqueue", uuid: "q", content: notice }),
  ]);
  const snap = t.snapshot(10);
  expect(snap.items).toMatchObject([
    { kind: "divider", text: 'Background task: Background command "Build" failed with exit code 144 (failed)' },
    { kind: "user", text: "look at this\n\npasted line" },
  ]);
  expect(snap.queued).toEqual([]);
});

const notice = (id: string, body: string) => `<task-notification>\n<task-id>${id}</task-id>\n${body}\n</task-notification>`;
const running = (t: Transcript) => t.snapshot(100).tasks.map((x) => `${x.kind}${x.background ? "(bg)" : ""}:${x.id}:${x.label}${x.last_event ? `:${x.last_event}` : ""}`);

test("running tasks: a background subagent runs from its launch until its final notice", () => {
  const t = feed([assistant([{ type: "tool_use", id: "t1", name: "Agent", input: { description: "Translate the web", subagent_type: "general-purpose", prompt: "…", run_in_background: "true" } }])]);
  expect(running(t)).toEqual(["agent(bg):t1:Translate the web"]);
  t.feed(user([{ type: "tool_result", tool_use_id: "t1", content: "Async agent launched" }], { toolUseResult: { isAsync: true, status: "async_launched", agentId: "a42" } }));
  expect(running(t)).toEqual(["agent(bg):a42:Translate the web"]);
  expect(t.snapshot(100).tasks[0]).toMatchObject({ detail: "general-purpose" });
  // the notice is queued first and reaches the conversation later: either one ends it, once
  t.feed(line({ type: "queue-operation", operation: "enqueue", content: notice("a42", "<status>completed</status>\n<summary>Agent finished</summary>") }));
  expect(running(t)).toEqual([]);
  t.feed(user(notice("a42", "<status>completed</status>")));
  expect(running(t)).toEqual([]);
  // SendMessage resumes it until its next final notice
  t.feed(assistant([{ type: "tool_use", id: "t2", name: "SendMessage", input: { to: "a42", message: "one more thing" } }]));
  expect(running(t)).toEqual(["agent(bg):a42:Translate the web"]);
});

test("running tasks: a foreground subagent holds the turn until its result", () => {
  const t = feed([assistant([{ type: "tool_use", id: "t1", name: "Agent", input: { description: "Search the code" } }])]);
  expect(running(t)).toEqual(["agent:t1:Search the code"]);
  t.feed(user([{ type: "tool_result", tool_use_id: "t1", content: "found it" }], { toolUseResult: { status: "completed", agentId: "a1" } }));
  expect(running(t)).toEqual([]);
});

test("running tasks: background commands end with their notice or a TaskStop; ctrl+b counts too", () => {
  const t = feed([
    assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "bun run dev", description: "Dev server", run_in_background: true } }]),
    user([{ type: "tool_result", tool_use_id: "t1", content: "Command running in background with ID: b1" }], { toolUseResult: { backgroundTaskId: "b1" } }),
    assistant([{ type: "tool_use", id: "t2", name: "Bash", input: { command: "bun test --watch" } }]),
    user([{ type: "tool_result", tool_use_id: "t2", content: "moved to background" }], { toolUseResult: { backgroundTaskId: "b2" } }),
  ]);
  expect(running(t)).toEqual(["command(bg):b1:Dev server", "command(bg):b2:bun test --watch"]);
  expect(t.snapshot(100).tasks[0]).toMatchObject({ detail: "bun run dev" });
  // a TaskStop that fails stops nothing
  t.feed(assistant([{ type: "tool_use", id: "t3", name: "TaskStop", input: { task_id: "b1" } }]));
  t.feed(user([{ type: "tool_result", tool_use_id: "t3", content: "no such task", is_error: true }]));
  expect(running(t)).toHaveLength(2);
  t.feed(assistant([{ type: "tool_use", id: "t4", name: "TaskStop", input: { task_id: "b1" } }]));
  t.feed(user([{ type: "tool_result", tool_use_id: "t4", content: "Successfully stopped task: b1" }]));
  t.feed(user(notice("b2", "<status>completed</status>")));
  expect(running(t)).toEqual([]);
});

test("running tasks: a monitor shows its latest event until its stream ends; a failed launch never runs", () => {
  const t = feed([
    assistant([{ type: "tool_use", id: "t1", name: "Monitor", input: { command: "tail -f app.log | grep ERROR", description: "errors in app.log" } }]),
    user([{ type: "tool_result", tool_use_id: "t1", content: "Monitor started" }], { toolUseResult: { taskId: "m1" } }),
    line({ type: "queue-operation", operation: "enqueue", content: notice("m1", '<summary>Monitor event: "errors in app.log"</summary>\n<event>ERROR db timeout</event>') }),
    assistant([{ type: "tool_use", id: "t2", name: "Agent", input: { description: "Never ran", run_in_background: true } }]),
    user([{ type: "tool_result", tool_use_id: "t2", content: "denied", is_error: true }]),
  ]);
  expect(running(t)).toEqual(["monitor(bg):m1:errors in app.log:ERROR db timeout"]);
  t.feed(line({ type: "queue-operation", operation: "enqueue", content: notice("m1", "<status>completed</status>") }));
  expect(running(t)).toEqual([]);
});

test("a command's gist drops the setup steps", () => {
  expect(commandGist("S=/tmp/x; cd /home/ana/app && PORT=1 HOST='a b' bun server.ts > log 2>&1")).toBe("bun server.ts > log 2>&1");
  expect(commandGist("bun run dev\n# more")).toBe("bun run dev");
  expect(commandGist("cd /tmp")).toBe("cd /tmp");
});

test("each monitor event shows in its notice", () => {
  const t = feed([user(notice("m1", '<summary>Monitor event: "build"</summary>\n<event>step 3 ok</event>'))]);
  expect(t.snapshot(100).items[0]).toMatchObject({ kind: "divider", text: 'Background task: Monitor event: "build" — step 3 ok' });
});
