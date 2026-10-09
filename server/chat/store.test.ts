import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateTranscript, projectDirName, readChat } from "./store.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "hw-chat-")));
const projects = join(home, ".claude/projects");
const dir = join(projects, "-Users-ana-p-app");
mkdirSync(dir, { recursive: true });
afterAll(() => rmSync(home, { recursive: true, force: true }));

const userLine = (text: string) => JSON.stringify({ type: "user", uuid: text, message: { content: text } }) + "\n";

test("Claude's folder naming", () => {
  expect(projectDirName("/Users/ana/p/app")).toBe("-Users-ana-p-app");
  expect(projectDirName("/Users/ana/my.site_v2")).toBe("-Users-ana-my-site-v2");
});

test("Herdr's report wins; otherwise the newest transcript of the folder", () => {
  writeFileSync(join(dir, "old.jsonl"), userLine("old"));
  writeFileSync(join(dir, "new.jsonl"), userLine("new"));
  utimesSync(join(dir, "old.jsonl"), new Date(1000), new Date(1000));
  expect(locateTranscript({ cwd: "/Users/ana/p/app", session: null }, home)).toEqual({ path: join(dir, "new.jsonl"), source: "guess" });
  expect(locateTranscript({ cwd: "/Users/ana/p/app", session: { kind: "id", value: "old" } }, home)).toEqual({ path: join(dir, "old.jsonl"), source: "herdr" });
  expect(locateTranscript({ cwd: "/x", session: { kind: "path", value: join(dir, "old.jsonl") } }, home)).toEqual({ path: join(dir, "old.jsonl"), source: "herdr" });
});

test("never a file outside ~/.claude/projects", () => {
  writeFileSync(join(home, "secret.jsonl"), userLine("secret"));
  expect(locateTranscript({ cwd: "/Users/ana/p/app", session: { kind: "path", value: join(home, "secret.jsonl") } }, home)?.source).toBe("guess");
  expect(locateTranscript({ cwd: "/Users/ana/p/app", session: { kind: "id", value: "../../secret" } }, home)?.source).toBe("guess");
  expect(locateTranscript({ cwd: "/nowhere", session: null }, home)).toBeNull();
});

test("reads only what was appended, and a partial line waits", async () => {
  const file = join(dir, "live.jsonl");
  writeFileSync(file, userLine("uno") + '{"type":"user","uuid":"dos","message":{"content":"d');
  const first = await readChat(file, home);
  expect(first.items.map((i) => (i.kind === "user" ? i.text : ""))).toEqual(["uno"]);
  appendFileSync(file, 'os"}}\n' + userLine("tres"));
  const second = await readChat(file, home);
  expect(second.items.map((i) => (i.kind === "user" ? i.text : ""))).toEqual(["uno", "dos", "tres"]);
  expect(second.version).not.toBe(first.version);
  writeFileSync(file, userLine("nuevo"));
  expect((await readChat(file, home)).items.map((i) => (i.kind === "user" ? i.text : ""))).toEqual(["nuevo"]);
});
