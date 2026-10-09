import { expect, test } from "bun:test";
import type { HostInfo, HostSample } from "../../shared/protocol.ts";
import { bytes, hostHealth, uptime } from "./host.ts";

const GB = 1024 ** 3;
const info = (over: Partial<HostInfo> = {}): HostInfo => ({
  hostname: "vps", os: "Ubuntu", arch: "arm64", cores: 4, cpu_model: null, mem_total: 16 * GB, swap_total: 4 * GB, boot_at: 0,
  load: [0.5, 0.5, 0.5], disks: [{ mount: "/", used: 50 * GB, total: 100 * GB }], processes: 100, top_cpu: [], top_mem: [], interval_ms: 5000, ...over,
});
const sample = (t: number, over: Partial<HostSample> = {}): HostSample => ({ t, cpu: 10, steal: 0, iowait: 0, mem: 4 * GB, swap: 0, load1: 0.5, rx: 0, tx: 0, ...over });
const minute = (over: Partial<HostSample>) => Array.from({ length: 12 }, (_, i) => sample(100_000 + i * 5000, over));

test("a quiet machine is healthy", () => {
  expect(hostHealth({ info: info(), samples: minute({}) })).toEqual({ level: "ok", reasons: [] });
});

test("each limit says what is wrong, the critical ones first", () => {
  const health = hostHealth({
    info: info({ load: [5, 4, 3], disks: [{ mount: "/", used: 97 * GB, total: 100 * GB }, { mount: "/data", used: 10, total: 100 }] }),
    samples: minute({ mem: 14 * GB, steal: 12 }),
  });
  expect(health.level).toBe("critical");
  expect(health.reasons).toEqual(["/ 97% full", "Load 5.00 on 4 cores", "Memory 88% used", "CPU steal 12% (the provider's other machines)"]);
});

test("one CPU spike is not an alarm; a busy minute is", () => {
  const spike = [...minute({ cpu: 10 }).slice(0, 11), sample(160_000, { cpu: 100 })];
  expect(hostHealth({ info: info(), samples: spike }).level).toBe("ok");
  expect(hostHealth({ info: info(), samples: minute({ cpu: 90 }) }).reasons).toEqual(["CPU 90% busy"]);
});

test("swap only counts where there is swap", () => {
  expect(hostHealth({ info: info({ swap_total: null }), samples: minute({ swap: null }) }).level).toBe("ok");
  expect(hostHealth({ info: info(), samples: minute({ swap: 3 * GB }) }).reasons).toEqual(["Swap 75% used"]);
});

test("formats", () => {
  expect(bytes(512)).toBe("512 B");
  expect(bytes(1536)).toBe("1.5 KB");
  expect(bytes(137 * GB)).toBe("137 GB");
  expect(uptime(0, (100 * 24 + 5) * 3_600_000)).toBe("100d 5h");
  expect(uptime(0, 3 * 3_600_000 + 12 * 60_000)).toBe("3h 12m");
  expect(uptime(0, 7 * 60_000)).toBe("7m");
});
