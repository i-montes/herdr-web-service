import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installStatusLine, removeStatusLine, statusLineCommand, type StatusLinePaths } from "./statusline.ts";

let dir = "";
let paths: StatusLinePaths;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sl-"));
  paths = { claudeDir: join(dir, ".claude"), savedFile: join(dir, "config", "claude-statusline.json") };
  mkdirSync(join(dir, "config"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const OURS = statusLineCommand({
  bun: "/home/u/.bun/bin/bun",
  root: "/home/u/.local/share/herdr/plugins/imontes.herdr-web-service",
  stateDir: "/home/u/.local/state/herdr/plugins/imontes.herdr-web-service",
  configDir: "/home/u/.config/herdr/plugins/imontes.herdr-web-service",
});
const FOREIGN = { type: "command", command: "~/bin/my-line.sh", padding: 2 };

const settingsFile = () => join(paths.claudeDir, "settings.json");
const writeSettings = (value: unknown) => {
  mkdirSync(paths.claudeDir, { recursive: true });
  writeFileSync(settingsFile(), typeof value === "string" ? value : JSON.stringify(value, null, 2));
};
const settings = () => JSON.parse(readFileSync(settingsFile(), "utf8")) as Record<string, unknown>;
const saved = () => JSON.parse(readFileSync(paths.savedFile, "utf8")) as { previous: unknown };

test("the command quotes every path for the shell", () => {
  expect(statusLineCommand({ bun: "/b/bun", root: "/r it's", stateDir: "/s", configDir: "/c" })).toBe(
    `'/b/bun' '/r it'\\''s/scripts/statusline.ts' '/s' '/c'`,
  );
});

describe("installStatusLine", () => {
  test("without Claude Code (no config dir) nothing is created", () => {
    expect(installStatusLine(paths, OURS)).toEqual({ status: "no-claude" });
    expect(existsSync(paths.claudeDir)).toBe(false);
  });

  test("no settings.json yet: created with ours", () => {
    mkdirSync(paths.claudeDir);
    expect(installStatusLine(paths, OURS)).toEqual({ status: "installed" });
    expect(settings()).toEqual({ statusLine: { type: "command", command: OURS, padding: 0 } });
  });

  test("no status line: ours is added, other keys kept", () => {
    writeSettings({ model: "opus", hooks: { Stop: [] } });
    expect(installStatusLine(paths, OURS)).toEqual({ status: "installed" });
    expect(settings()).toEqual({ model: "opus", hooks: { Stop: [] }, statusLine: { type: "command", command: OURS, padding: 0 } });
    expect(existsSync(paths.savedFile)).toBe(false);
  });

  test("ours already there: unchanged, file not rewritten", () => {
    const text = JSON.stringify({ statusLine: { type: "command", command: OURS, padding: 0 } });
    writeSettings(text);
    expect(installStatusLine(paths, OURS)).toEqual({ status: "unchanged" });
    expect(readFileSync(settingsFile(), "utf8")).toBe(text);
  });

  test("ours with an old path: only the command is updated", () => {
    const old = "/old/bun /old/herdr-web-service/scripts/statusline.ts /s";
    writeSettings({ statusLine: { type: "command", command: old, padding: 1 } });
    expect(installStatusLine(paths, OURS)).toEqual({ status: "updated" });
    expect(settings().statusLine).toEqual({ type: "command", command: OURS, padding: 1 });
  });

  test("someone else's: saved for chaining, ours keeps its padding", () => {
    writeSettings({ statusLine: FOREIGN });
    expect(installStatusLine(paths, OURS)).toEqual({ status: "chained", previous: FOREIGN.command });
    expect(saved()).toEqual({ previous: FOREIGN });
    expect(settings().statusLine).toEqual({ type: "command", command: OURS, padding: 2 });
  });

  test("re-run after chaining keeps the saved one", () => {
    writeSettings({ statusLine: FOREIGN });
    installStatusLine(paths, OURS);
    expect(installStatusLine(paths, OURS)).toEqual({ status: "unchanged" });
    expect(saved()).toEqual({ previous: FOREIGN });
  });

  test("unreadable settings.json is left alone", () => {
    writeSettings("{ not json");
    const result = installStatusLine(paths, OURS);
    expect(result.status).toBe("unreadable");
    expect(readFileSync(settingsFile(), "utf8")).toBe("{ not json");
  });
});

describe("removeStatusLine", () => {
  test("ours without a previous one: the key is removed", () => {
    writeSettings({ model: "opus" });
    installStatusLine(paths, OURS);
    expect(removeStatusLine(paths)).toEqual({ status: "removed" });
    expect(settings()).toEqual({ model: "opus" });
  });

  test("ours over someone else's: the original is restored and the saved file deleted", () => {
    writeSettings({ statusLine: FOREIGN });
    installStatusLine(paths, OURS);
    expect(removeStatusLine(paths)).toEqual({ status: "restored", previous: FOREIGN.command });
    expect(settings().statusLine).toEqual(FOREIGN);
    expect(existsSync(paths.savedFile)).toBe(false);
  });

  test("changed by hand since: left alone", () => {
    writeSettings({ statusLine: FOREIGN });
    expect(removeStatusLine(paths)).toEqual({ status: "foreign" });
    expect(settings().statusLine).toEqual(FOREIGN);
  });

  test("nothing installed: absent", () => {
    expect(removeStatusLine(paths)).toEqual({ status: "absent" });
    writeSettings({});
    expect(removeStatusLine(paths)).toEqual({ status: "absent" });
  });
});
