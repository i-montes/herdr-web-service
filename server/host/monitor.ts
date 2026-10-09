/**
 * The host's health, read every few seconds: CPU (with a VM's steal and iowait), memory, swap,
 * load, network, disks and the heaviest processes. The last hour stays in memory for the charts.
 *
 * Linux reads /proc (no processes spawned); macOS asks vm_stat, sysctl, netstat and ps. Disks are
 * read less often (df). Processes are only scanned while someone is watching: they are the costly
 * part, and nothing keeps their history.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import type { HostDisk, HostInfo, HostProcess, HostSample } from "../../shared/protocol.ts";
import { cpuUsage, parseDf, parseMeminfo, parseNetDev, parseNetstat, parseOsRelease, parsePidStat, parsePs, parseProcStat, parseSwapUsage, parseVmStat, processName, topProcesses, type CpuTimes, type ProcessReading } from "./parse.ts";

export const HOST_INTERVAL_MS = 5000;
const HISTORY = (60 * 60 * 1000) / HOST_INTERVAL_MS;
const DISK_EVERY_MS = 30_000;
const TOP = 6;
const LINUX = process.platform === "linux";
/** Linux's USER_HZ: /proc/<pid>/stat counts CPU time in hundredths of a second */
const TICKS_PER_SECOND = 100;

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function run(cmd: string[]): string | null {
  try {
    const out = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
    return out.exitCode === 0 ? out.stdout.toString() : null;
  } catch {
    return null;
  }
}

function osName(): string {
  if (LINUX) return parseOsRelease(read("/etc/os-release") ?? "") ?? `Linux ${os.release()}`;
  if (process.platform === "darwin") {
    const version = run(["sw_vers", "-productVersion"])?.trim();
    return version ? `macOS ${version}` : "macOS";
  }
  return `${os.type()} ${os.release()}`;
}

function cpuTimes(): CpuTimes | null {
  if (LINUX) return parseProcStat(read("/proc/stat") ?? "");
  let total = 0;
  let idle = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
    idle += t.idle;
  }
  return total ? { total, idle, iowait: null, steal: null } : null;
}

/** the interfaces with a device behind them: no lo, docker bridges, veths or VPN tunnels counted twice */
function physicalInterfaces(): Set<string> {
  try {
    return new Set(readdirSync("/sys/class/net").filter((name) => existsSync(`/sys/class/net/${name}/device`)));
  } catch {
    return new Set();
  }
}

function netBytes(): { rx: number; tx: number } | null {
  if (LINUX) {
    const text = read("/proc/net/dev");
    return text ? parseNetDev(text, physicalInterfaces()) : null;
  }
  if (process.platform === "darwin") return parseNetstat(run(["netstat", "-ibn"]) ?? "");
  return null;
}

function memory(): { used: number; total: number; swap: number | null; swapTotal: number | null } {
  if (LINUX) {
    const m = parseMeminfo(read("/proc/meminfo") ?? "");
    if (m.total) return { used: m.used, total: m.total, swap: m.swapTotal ? m.swapUsed : null, swapTotal: m.swapTotal || null };
  }
  if (process.platform === "darwin") {
    const used = parseVmStat(run(["vm_stat"]) ?? "");
    const swap = parseSwapUsage(run(["sysctl", "-n", "vm.swapusage"]) ?? "");
    if (used !== null) return { used, total: os.totalmem(), swap: swap?.used ?? null, swapTotal: swap?.total ?? null };
  }
  return { used: os.totalmem() - os.freemem(), total: os.totalmem(), swap: null, swapTotal: null };
}

function disks(): HostDisk[] {
  return parseDf(run(["df", "-kP"]) ?? "");
}

export class HostMonitor {
  readonly history: HostSample[] = [];
  private info: HostInfo;
  private cpuBefore = cpuTimes();
  private netBefore: { at: number; rx: number; tx: number } | null = null;
  private disksAt = 0;
  /** Linux: pid → CPU ticks at the last scan, for each process's CPU % */
  private ticksBefore = new Map<number, number>();
  private scannedAt = 0;
  private readonly pageSize = LINUX ? Number(run(["getconf", "PAGESIZE"])?.trim()) || 4096 : 4096;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const cpus = os.cpus();
    const model = cpus[0]?.model?.trim();
    this.info = {
      hostname: os.hostname(),
      os: osName(),
      arch: os.arch(),
      cores: cpus.length || 1,
      cpu_model: model && model !== "unknown" ? model : null,
      mem_total: os.totalmem(),
      swap_total: null,
      boot_at: Date.now() - os.uptime() * 1000,
      load: [0, 0, 0],
      disks: [],
      processes: 0,
      top_cpu: [],
      top_mem: [],
      interval_ms: HOST_INTERVAL_MS,
    };
    const now = Date.now();
    const net = netBytes();
    if (net) this.netBefore = { at: now, ...net };
  }

  /** samples every few seconds; `watching` says whether to scan processes, `onSample` gets each reading */
  start(watching: () => boolean, onSample: (info: HostInfo, sample: HostSample) => void): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        const sample = this.sample(watching());
        onSample(this.info, sample);
      } catch (error) {
        console.error("host stats:", error instanceof Error ? error.message : error);
      }
    }, HOST_INTERVAL_MS);
  }

  current(): HostInfo {
    return this.info;
  }

  /** one reading; `withProcesses` also refreshes the heaviest processes */
  sample(withProcesses: boolean, now = Date.now()): HostSample {
    const times = cpuTimes();
    const cpu = times && this.cpuBefore ? cpuUsage(this.cpuBefore, times) : { cpu: 0, iowait: null, steal: null };
    if (times) this.cpuBefore = times;

    const mem = memory();
    const load = os.loadavg() as [number, number, number];

    let rx: number | null = null;
    let tx: number | null = null;
    const net = netBytes();
    if (net) {
      const before = this.netBefore;
      if (before && now > before.at) {
        const seconds = (now - before.at) / 1000;
        // a counter that went back (an interface came and went) reads as no traffic, not negative
        rx = Math.max(0, (net.rx - before.rx) / seconds);
        tx = Math.max(0, (net.tx - before.tx) / seconds);
      }
      this.netBefore = { at: now, ...net };
    }

    if (now - this.disksAt >= DISK_EVERY_MS) {
      this.info = { ...this.info, disks: disks() };
      this.disksAt = now;
    }
    this.info = { ...this.info, load, mem_total: mem.total, swap_total: mem.swapTotal, boot_at: Date.now() - os.uptime() * 1000 };
    if (withProcesses) this.info = { ...this.info, ...this.processes(now) };
    else if (this.scannedAt) {
      // nobody watching: drop the list rather than show an old one to the next browser
      this.info = { ...this.info, processes: 0, top_cpu: [], top_mem: [] };
      this.ticksBefore.clear();
      this.scannedAt = 0;
    }

    const sample: HostSample = { t: now, cpu: round(cpu.cpu), steal: cpu.steal === null ? null : round(cpu.steal), iowait: cpu.iowait === null ? null : round(cpu.iowait), mem: mem.used, swap: mem.swap, load1: round(load[0], 2), rx: rx === null ? null : Math.round(rx), tx: tx === null ? null : Math.round(tx) };
    this.history.push(sample);
    if (this.history.length > HISTORY) this.history.splice(0, this.history.length - HISTORY);
    return sample;
  }

  private processes(now: number): { processes: number; top_cpu: HostProcess[]; top_mem: HostProcess[] } {
    if (!LINUX) {
      const list = parsePs(run(["ps", "-Ao", "pid=,pcpu=,rss=,comm="]) ?? "");
      return { processes: list.length, ...topProcesses(list, TOP, this.info.cores) };
    }
    // a scan from long ago would give each process its average over that whole time
    const seconds = this.scannedAt && now - this.scannedAt <= 3 * HOST_INTERVAL_MS ? (now - this.scannedAt) / 1000 : 0;
    const ticks = new Map<number, number>();
    const list: ProcessReading[] = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const stat = parsePidStat(read(`/proc/${entry}/stat`) ?? "");
      if (!stat) continue; // it ended between the listing and the read
      const pid = Number(entry);
      ticks.set(pid, stat.ticks);
      const before = this.ticksBefore.get(pid);
      const cpu = seconds > 0 && before !== undefined ? ((stat.ticks - before) / TICKS_PER_SECOND / seconds) * 100 : null;
      // the command line only for the processes that weigh something: it names node scripts and
      // the threads that renamed themselves, and reading it for every process would cost
      const heavy = (cpu ?? 0) >= 0.5 || stat.rssPages * this.pageSize >= 64 * 1024 * 1024;
      const name = heavy ? processName(stat.name, read(`/proc/${entry}/cmdline`) ?? "") : stat.name;
      list.push({ pid, name, cpu, mem: stat.rssPages * this.pageSize });
    }
    this.ticksBefore = ticks;
    this.scannedAt = now;
    return { processes: list.length, ...topProcesses(list, TOP, this.info.cores) };
  }
}

function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
