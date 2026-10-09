/**
 * Pure readers of the host's numbers: Linux's /proc files and the output of macOS's commands,
 * turned into plain values. host/monitor.ts reads the files and runs the commands.
 */
import type { HostDisk, HostProcess } from "../../shared/protocol.ts";

/** cumulative CPU time from /proc/stat's first line (or summed from os.cpus() on macOS) */
export interface CpuTimes {
  total: number;
  idle: number;
  iowait: number | null;
  steal: number | null;
}

/** /proc/stat: "cpu  user nice system idle iowait irq softirq steal guest guest_nice" */
export function parseProcStat(text: string): CpuTimes | null {
  const line = text.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = line.trim().split(/\s+/).slice(1).map(Number);
  // guest time is already counted in user
  return { total: user + nice + system + idle + iowait + irq + softirq + steal, idle: idle + iowait, iowait, steal };
}

/** % busy, iowait and steal between two readings */
export function cpuUsage(before: CpuTimes, after: CpuTimes): { cpu: number; iowait: number | null; steal: number | null } {
  const total = after.total - before.total;
  if (total <= 0) return { cpu: 0, iowait: before.iowait === null ? null : 0, steal: before.steal === null ? null : 0 };
  const pct = (n: number) => Math.min(100, Math.max(0, (n / total) * 100));
  return {
    cpu: pct(total - (after.idle - before.idle)),
    iowait: after.iowait !== null && before.iowait !== null ? pct(after.iowait - before.iowait) : null,
    steal: after.steal !== null && before.steal !== null ? pct(after.steal - before.steal) : null,
  };
}

/** /proc/meminfo → bytes: in use is MemTotal − MemAvailable (caches the kernel can drop are free) */
export function parseMeminfo(text: string): { total: number; used: number; swapTotal: number; swapUsed: number } {
  const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0) * 1024;
  const total = kb("MemTotal");
  const available = text.includes("MemAvailable:") ? kb("MemAvailable") : kb("MemFree") + kb("Buffers") + kb("Cached");
  return { total, used: Math.max(0, total - available), swapTotal: kb("SwapTotal"), swapUsed: Math.max(0, kb("SwapTotal") - kb("SwapFree")) };
}

/** /proc/net/dev → bytes received and sent, summed over `interfaces` (all but lo when empty) */
export function parseNetDev(text: string, interfaces: ReadonlySet<string>): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const line of text.split("\n").slice(2)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (interfaces.size ? !interfaces.has(name) : name === "lo") continue;
    const fields = line.slice(colon + 1).trim().split(/\s+/).map(Number);
    rx += fields[0] ?? 0;
    tx += fields[8] ?? 0;
  }
  return { rx, tx };
}

/** macOS `netstat -ibn`: bytes of the en* interfaces, one row each (the <Link#> one) */
export function parseNetstat(text: string): { rx: number; tx: number } | null {
  const lines = text.trim().split("\n");
  const head = lines[0]?.trim().split(/\s+/) ?? [];
  const ib = head.indexOf("Ibytes");
  const ob = head.indexOf("Obytes");
  if (ib < 0 || ob < 0) return null;
  let rx = 0;
  let tx = 0;
  for (const line of lines.slice(1)) {
    const f = line.trim().split(/\s+/);
    if (!/^en\d+$/.test(f[0] ?? "") || !f[2]?.startsWith("<Link#")) continue;
    // a row without an address has one column fewer: count from the end
    rx += Number(f[f.length - (head.length - ib)] ?? 0);
    tx += Number(f[f.length - (head.length - ob)] ?? 0);
  }
  return { rx, tx };
}

/** macOS `vm_stat`: in use = active + wired + compressed pages (what Activity Monitor calls used) */
export function parseVmStat(text: string): number | null {
  const size = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!size) return null;
  const pages = (label: string) => Number(new RegExp(`^${label}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0);
  return (pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor")) * size;
}

/** macOS `sysctl -n vm.swapusage`: "total = 2048.00M  used = 1022.75M  free = 1025.25M  (encrypted)" */
export function parseSwapUsage(text: string): { total: number; used: number } | null {
  const mb = (key: string) => Number(new RegExp(`${key} = ([\\d.]+)M`).exec(text)?.[1]);
  const total = mb("total");
  const used = mb("used");
  return Number.isFinite(total) && Number.isFinite(used) ? { total: total * 1024 * 1024, used: used * 1024 * 1024 } : null;
}

/** mounts nobody needs to watch: system snapshots, boot partitions, snaps, macOS's helper volumes */
const HIDDEN_MOUNT = /^\/(?:boot(?:\/|$)|snap\/|System\/Volumes\/(?!Data$))/;

/** `df -kP`: real disks (a /dev device), each device once, the root first */
export function parseDf(text: string): HostDisk[] {
  const seen = new Set<string>();
  const disks: HostDisk[] = [];
  for (const line of text.trim().split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const device = f[0]!;
    const mount = f.slice(5).join(" ");
    if (!device.startsWith("/dev/") || device.startsWith("/dev/loop") || HIDDEN_MOUNT.test(mount) || seen.has(device)) continue;
    seen.add(device);
    const used = Number(f[2]) * 1024;
    const available = Number(f[3]) * 1024;
    // used + available, as df's percentage does: the blocks reserved for root count as neither
    disks.push({ mount, used, total: used + available });
  }
  // macOS's data volume is where the files are: show it as the root
  const data = disks.find((d) => d.mount === "/System/Volumes/Data");
  const list = data ? [{ ...data, mount: "/" }, ...disks.filter((d) => d !== data && d.mount !== "/")] : disks;
  return list.sort((a, b) => (a.mount === "/" ? -1 : b.mount === "/" ? 1 : a.mount.localeCompare(b.mount)));
}

/** one process from /proc/<pid>/stat: its name, CPU ticks so far and resident pages */
export function parsePidStat(text: string): { name: string; ticks: number; rssPages: number } | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  // fields after the name, from "state" (field 3): utime is field 14, stime 15, rss 24
  const f = text.slice(close + 2).split(" ");
  const ticks = Number(f[11]) + Number(f[12]);
  const rssPages = Number(f[21]);
  if (!Number.isFinite(ticks) || !Number.isFinite(rssPages)) return null;
  return { name: text.slice(open + 1, close), ticks, rssPages };
}

const INTERPRETER = /^(?:node|nodejs|bun|deno|python[\d.]*|ruby|perl|php[\d.]*|java)$/;

/**
 * A readable name from Linux's 15-character comm and the command line: the program's file name,
 * and for an interpreter its script too ("node astro.mjs" rather than a thread name like
 * "MainThread"). Arguments are left out: they can carry tokens.
 */
export function processName(comm: string, cmdline: string): string {
  const argv = cmdline.split("\0").filter(Boolean);
  const program = argv[0]?.split("/").pop() ?? "";
  // a process that rewrote its title ("next-server (v16)") has no separate arguments
  if (!program || (argv.length === 1 && program.includes(" "))) return comm;
  const script = argv.slice(1).find((a) => !a.startsWith("-"))?.split("/").pop();
  return INTERPRETER.test(program) && script ? `${program} ${script}` : program;
}

/** one process as read: pid, name, % of one core (null until two readings) and resident bytes */
export interface ProcessReading {
  pid: number;
  name: string;
  cpu: number | null;
  mem: number;
}

/** `ps -Ao pid=,pcpu=,rss=,comm=` (macOS: a recent CPU %, rss in KB, comm a path) */
export function parsePs(text: string): ProcessReading[] {
  const list: ProcessReading[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    list.push({ pid: Number(m[1]), cpu: Number(m[2]), mem: Number(m[3]) * 1024, name: m[4]!.trim().split("/").pop()! });
  }
  return list;
}

/**
 * The `n` heaviest programs by CPU and by memory, each program's processes added up (four
 * postgres workers are one row). CPU becomes a share of the whole machine, `cores` cores.
 */
export function topProcesses(list: ProcessReading[], n: number, cores: number): { top_cpu: HostProcess[]; top_mem: HostProcess[] } {
  const groups = new Map<string, HostProcess>();
  for (const p of list) {
    const g = groups.get(p.name) ?? { name: p.name, count: 0, cpu: null, mem: 0 };
    g.count++;
    g.mem += p.mem;
    if (p.cpu !== null) g.cpu = (g.cpu ?? 0) + p.cpu / Math.max(1, cores);
    groups.set(p.name, g);
  }
  const all = [...groups.values()].map((g) => ({ ...g, cpu: g.cpu === null ? null : Math.round(g.cpu * 10) / 10 }));
  return {
    top_cpu: all.filter((g) => (g.cpu ?? 0) > 0).sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0)).slice(0, n),
    top_mem: [...all].sort((a, b) => b.mem - a.mem).slice(0, n),
  };
}

/** /etc/os-release's PRETTY_NAME */
export function parseOsRelease(text: string): string | null {
  const m = /^PRETTY_NAME=(.*)$/m.exec(text);
  return m ? m[1]!.trim().replace(/^"(.*)"$/, "$1") : null;
}
