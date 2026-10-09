/**
 * How long each pane has been open, and the status memory kept across restarts.
 *
 * Herdr reports no times, but `pane.process_info` gives the pane's shell pid, and the shell starts
 * with the pane: `ps` says how long it has run. Asked once per terminal (a start never changes).
 * The status memory (when each pane last changed status) is saved in the state dir, so a restart
 * of this server (an update) does not wipe the "working for 12 min" of every session.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentStatus } from "../../shared/protocol.ts";
import type { HerdrClient } from "./client.ts";
import { terminalOf, type StatusMemory } from "./roster.ts";

/** `ps -o etime` ("[[dd-]hh:]mm:ss", the same on Linux and macOS) → seconds */
export function parseEtime(text: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return null;
  const [, d = "0", h = "0", m, s] = match;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(m)) * 60 + Number(s);
}

/** `ps -o pid=,etime=` lines → pid → start (ms epoch, to the second) */
export function parsePsStarts(output: string, now: number): Map<number, number> {
  const starts = new Map<number, number>();
  for (const line of output.split("\n")) {
    const [pid, etime] = line.trim().split(/\s+/);
    const seconds = parseEtime(etime ?? "");
    if (pid && seconds !== null) starts.set(Number(pid), Math.floor(now / 1000 - seconds) * 1000);
  }
  return starts;
}

async function processStarts(pids: number[], now: number): Promise<Map<number, number>> {
  if (!pids.length) return new Map();
  const ps = Bun.spawn(["ps", "-o", "pid=,etime=", "-p", pids.join(",")], { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(ps.stdout).text();
  await ps.exited;
  return parsePsStarts(output, now);
}

/** terminal_id → when its pane opened; null when it couldn't be told (asked once all the same) */
export class PaneLifetimes {
  readonly opened = new Map<string, number | null>();

  /** reads the start of every pane not seen before, and forgets the closed ones */
  async update(herdr: HerdrClient, panes: unknown[], now = Date.now()): Promise<void> {
    const live = new Map(panes.map((p) => [terminalOf(p), String((p as { pane_id?: unknown }).pane_id ?? "")] as const));
    for (const terminal of this.opened.keys()) if (!live.has(terminal)) this.opened.delete(terminal);
    const fresh = [...live].filter(([terminal, pane]) => terminal && pane && !this.opened.has(terminal));
    if (!fresh.length) return;
    const shells = await Promise.all(
      fresh.map(([, pane_id]) =>
        herdr
          .request<{ process_info?: { shell_pid?: unknown } }>("pane.process_info", { pane_id })
          .then((r) => (typeof r.process_info?.shell_pid === "number" ? r.process_info.shell_pid : null))
          .catch(() => null),
      ),
    );
    const starts = await processStarts(shells.filter((pid): pid is number => pid !== null), now).catch(() => new Map<number, number>());
    fresh.forEach(([terminal], i) => this.opened.set(terminal, starts.get(shells[i] ?? -1) ?? null));
  }
}

// --- status memory on disk -----------------------------------------------------------------

const STATUSES: readonly AgentStatus[] = ["idle", "working", "blocked", "done", "unknown"];

export function loadStatusMemory(stateDir: string): StatusMemory {
  const memory: StatusMemory = new Map();
  try {
    const saved = JSON.parse(readFileSync(join(stateDir, "panes.json"), "utf8")) as Record<string, { status?: unknown; changed_at?: unknown; terminal_id?: unknown }>;
    for (const [pane, entry] of Object.entries(saved)) {
      if (!STATUSES.includes(entry.status as AgentStatus) || typeof entry.terminal_id !== "string") continue;
      memory.set(pane, { status: entry.status as AgentStatus, changed_at: typeof entry.changed_at === "number" ? entry.changed_at : null, terminal_id: entry.terminal_id });
    }
  } catch {
    /* none yet, or unreadable: start from what Herdr shows */
  }
  return memory;
}

let lastSaved = "";
/** writes the memory when it changed since the last write */
export function saveStatusMemory(stateDir: string, memory: StatusMemory): void {
  const text = JSON.stringify(Object.fromEntries(memory));
  if (text === lastSaved) return;
  lastSaved = text;
  try {
    writeFileSync(join(stateDir, "panes.json"), text, { mode: 0o600 });
  } catch (error) {
    console.error("panes.json:", error instanceof Error ? error.message : error);
  }
}
