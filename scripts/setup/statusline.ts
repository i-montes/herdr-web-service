/**
 * Registers `scripts/statusline.ts` as Claude Code's status line (`settings.json` → `statusLine`),
 * which is how the web chat gets context and plan usage. Someone else's status line is not
 * replaced but chained: it is saved to `<config dir>/claude-statusline.json` and our script runs
 * it with the same input and prints its output first. `uninstall` puts it back.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface StatusLinePaths {
  /** Claude Code's config dir: `$CLAUDE_CONFIG_DIR` or `~/.claude` */
  claudeDir: string;
  /** `<config dir>/claude-statusline.json`: the chained status line, `{ previous: <statusLine> }` */
  savedFile: string;
}

export type InstallResult =
  | { status: "installed" | "updated" | "unchanged" }
  | { status: "chained"; previous: string }
  | { status: "no-claude" }
  | { status: "unreadable"; detail: string };

export type RemoveResult =
  | { status: "removed" | "absent" | "foreign" }
  | { status: "restored"; previous: string }
  | { status: "unreadable"; detail: string };

export function statusLinePaths(configDir: string): StatusLinePaths {
  return {
    claudeDir: process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude"),
    savedFile: join(configDir, "claude-statusline.json"),
  };
}

type Settings = Record<string, unknown>;
type StatusLine = Record<string, unknown>;

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function statusLineCommand(p: { bun: string; root: string; stateDir: string; configDir: string }): string {
  return [p.bun, join(p.root, "scripts", "statusline.ts"), p.stateDir, p.configDir].map(shq).join(" ");
}

/** Ours whatever paths it was installed with (the plugin's state/config dirs carry its id). */
function isOurs(line: unknown): line is StatusLine {
  const command = (line as StatusLine | undefined)?.["command"];
  return typeof command === "string" && command.includes("herdr-web-service") && command.includes("scripts/statusline.ts");
}

const commandOf = (line: unknown) => String((line as StatusLine)["command"] ?? "");

function read(file: string): { settings: Settings } | { error: string } {
  if (!existsSync(file)) return { settings: {} };
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return { settings: value as Settings };
    return { error: "no es un objeto JSON" };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function write(file: string, value: unknown): void {
  writeFileSync(file + ".tmp", JSON.stringify(value, null, 2) + "\n");
  renameSync(file + ".tmp", file);
}

export function installStatusLine(paths: StatusLinePaths, command: string): InstallResult {
  if (!existsSync(paths.claudeDir)) return { status: "no-claude" };
  const file = join(paths.claudeDir, "settings.json");
  const r = read(file);
  if ("error" in r) return { status: "unreadable", detail: `${file}: ${r.error}` };
  const current = r.settings["statusLine"];

  if (isOurs(current)) {
    if (current["command"] === command) return { status: "unchanged" };
    write(file, { ...r.settings, statusLine: { ...current, command } });
    return { status: "updated" };
  }
  if (current && typeof current === "object") {
    write(paths.savedFile, { previous: current });
    write(file, { ...r.settings, statusLine: { type: "command", command, padding: (current as StatusLine)["padding"] ?? 0 } });
    return { status: "chained", previous: commandOf(current) };
  }
  write(file, { ...r.settings, statusLine: { type: "command", command, padding: 0 } });
  return { status: "installed" };
}

export function removeStatusLine(paths: StatusLinePaths): RemoveResult {
  const file = join(paths.claudeDir, "settings.json");
  const r = read(file);
  if ("error" in r) return { status: "unreadable", detail: `${file}: ${r.error}` };
  const current = r.settings["statusLine"];
  if (!isOurs(current)) {
    if (!current) rmSync(paths.savedFile, { force: true });
    return { status: current ? "foreign" : "absent" };
  }

  const previous = read(paths.savedFile);
  const restore = "settings" in previous ? previous.settings["previous"] : undefined;
  const { statusLine: _, ...rest } = r.settings;
  write(file, restore ? { ...rest, statusLine: restore } : rest);
  rmSync(paths.savedFile, { force: true });
  return restore ? { status: "restored", previous: commandOf(restore) } : { status: "removed" };
}
