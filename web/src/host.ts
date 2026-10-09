/**
 * The host's health as the server streams it over /ws (roster.ts hands the frames here): the
 * latest machine info and the last hour of readings for the charts, plus the pure rules that turn
 * them into "Healthy", "Watch" or "Critical".
 */
import { useSyncExternalStore } from "react";
import type { HostInfo, HostSample } from "../../shared/protocol.ts";

export interface HostState {
  info: HostInfo;
  samples: HostSample[];
}

const HOUR = 60 * 60 * 1000;
let state: HostState | null = null;
const listeners = new Set<() => void>();

/** a `host` frame: the whole history on connect, then one reading at a time */
export function receiveHost(info: HostInfo, samples: HostSample[], history: boolean): void {
  const last = state?.samples.at(-1)?.t ?? 0;
  const merged = history ? samples : [...(state?.samples ?? []), ...samples.filter((s) => s.t > last)];
  const cutoff = (merged.at(-1)?.t ?? 0) - HOUR;
  state = { info, samples: merged.filter((s) => s.t > cutoff) };
  listeners.forEach((l) => l());
}

export function useHost(): HostState | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

// --- formatting -------------------------------------------------------------------------------

/** 1536 → "1.5 KB", base 1024 as the system tools show it */
export function bytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export const rate = (n: number | null) => (n === null ? "—" : `${bytes(n)}/s`);

export const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);

/** "12d 4h" since boot */
export function uptime(bootAt: number, now: number): string {
  const m = Math.max(0, Math.floor((now - bootAt) / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  return h ? `${h}h ${m % 60}m` : `${m % 60}m`;
}

// --- health -----------------------------------------------------------------------------------

export type Level = "ok" | "warn" | "critical";

export interface Health {
  level: Level;
  /** what is wrong, worst first: "Memory 93% used" */
  reasons: string[];
}

/** the last minute's average of a reading, so one spike does not raise the alarm */
function recent(samples: HostSample[], pick: (s: HostSample) => number | null): number | null {
  const end = samples.at(-1)?.t;
  if (end === undefined) return null;
  const values = samples.filter((s) => s.t > end - 60_000).map(pick).filter((v): v is number => v !== null);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export const memLevel = (p: number): Level => (p >= 95 ? "critical" : p >= 85 ? "warn" : "ok");
export const diskLevel = (p: number): Level => (p >= 95 ? "critical" : p >= 85 ? "warn" : "ok");
export const cpuLevel = (p: number): Level => (p >= 95 ? "critical" : p >= 85 ? "warn" : "ok");
/** load per core: above 1 there is a queue for the CPU */
export const loadLevel = (perCore: number): Level => (perCore >= 2 ? "critical" : perCore >= 1 ? "warn" : "ok");

export function hostHealth({ info, samples }: HostState): Health {
  const found: { level: Level; text: string }[] = [];
  const add = (level: Level, text: string) => level !== "ok" && found.push({ level, text });

  const cpu = recent(samples, (s) => s.cpu);
  if (cpu !== null) add(cpuLevel(cpu), `CPU ${Math.round(cpu)}% busy`);
  add(loadLevel(info.load[0] / info.cores), `Load ${info.load[0].toFixed(2)} on ${info.cores} cores`);
  const mem = samples.at(-1)?.mem;
  if (mem !== undefined) {
    const p = pct(mem, info.mem_total);
    add(memLevel(p), `Memory ${Math.round(p)}% used`);
  }
  const swap = samples.at(-1)?.swap;
  if (swap != null && info.swap_total) {
    const p = pct(swap, info.swap_total);
    add(p >= 80 ? "critical" : p >= 50 ? "warn" : "ok", `Swap ${Math.round(p)}% used`);
  }
  for (const d of info.disks) {
    const p = pct(d.used, d.total);
    add(diskLevel(p), `${d.mount} ${Math.round(p)}% full`);
  }
  const steal = recent(samples, (s) => s.steal);
  if (steal !== null) add(steal >= 25 ? "critical" : steal >= 10 ? "warn" : "ok", `CPU steal ${Math.round(steal)}% (the provider's other machines)`);
  const iowait = recent(samples, (s) => s.iowait);
  if (iowait !== null) add(iowait >= 40 ? "critical" : iowait >= 20 ? "warn" : "ok", `Waiting on disk ${Math.round(iowait)}% of the time`);

  found.sort((a, b) => (a.level === b.level ? 0 : a.level === "critical" ? -1 : 1));
  return { level: found[0]?.level ?? "ok", reasons: found.map((f) => f.text) };
}

export const LEVEL_LABEL: Record<Level, string> = { ok: "Healthy", warn: "Watch", critical: "Critical" };
