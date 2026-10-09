import { expect, test } from "bun:test";
import { cpuUsage, parseDf, parseMeminfo, parseNetDev, parseNetstat, parseOsRelease, parsePidStat, parsePs, parseProcStat, parseSwapUsage, parseVmStat, processName, topProcesses } from "./parse.ts";

test("/proc/stat: busy, iowait and steal between two readings", () => {
  const a = parseProcStat("cpu  100 0 50 800 20 0 0 30 0 0\ncpu0 1 2 3\n")!;
  const b = parseProcStat("cpu  160 0 70 880 30 0 0 60 0 0\n")!;
  expect(a).toEqual({ total: 1000, idle: 820, iowait: 20, steal: 30 });
  // 200 ticks went by: 90 idle (80 + 10 iowait), 30 steal
  const usage = cpuUsage(a, b);
  expect(usage.cpu).toBeCloseTo(55);
  expect(usage.iowait).toBeCloseTo(5);
  expect(usage.steal).toBeCloseTo(15);
  expect(cpuUsage(a, a)).toEqual({ cpu: 0, iowait: 0, steal: 0 });
  expect(parseProcStat("nothing")).toBeNull();
});

test("meminfo: in use leaves out what the kernel can drop", () => {
  const m = parseMeminfo("MemTotal:       1000 kB\nMemFree:          100 kB\nMemAvailable:     600 kB\nSwapTotal:   200 kB\nSwapFree:   150 kB\n");
  expect(m).toEqual({ total: 1000 * 1024, used: 400 * 1024, swapTotal: 200 * 1024, swapUsed: 50 * 1024 });
});

const NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 500 5 0 0 0 0 0 0 500 5 0 0 0 0 0 0
enp0s6: 1000 10 0 0 0 0 0 0 300 3 0 0 0 0 0 0
docker0: 70 1 0 0 0 0 0 0 80 1 0 0 0 0 0 0
`;

test("net/dev: only the physical interfaces, or all but lo when none is known", () => {
  expect(parseNetDev(NET_DEV, new Set(["enp0s6"]))).toEqual({ rx: 1000, tx: 300 });
  expect(parseNetDev(NET_DEV, new Set())).toEqual({ rx: 1070, tx: 380 });
});

test("macOS netstat: the en* link rows, with or without an address", () => {
  const text = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                        10     0       9999       10     0       9999     0
en0        1500  <Link#6>    a4:83:e7:00:00:01   100     0       5000       50     0       2000     0
en0        1500  192.168.1     192.168.1.20       100     -       5000       50     -       2000     -
en1        1500  <Link#7>                         10     0        100        5     0         40     0
`;
  expect(parseNetstat(text)).toEqual({ rx: 5100, tx: 2040 });
  expect(parseNetstat("garbage")).toBeNull();
});

test("macOS vm_stat and swap", () => {
  const vm = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               1000.
Pages active:                             200.
Pages wired down:                         100.
Pages occupied by compressor:              50.
`;
  expect(parseVmStat(vm)).toBe(350 * 16384);
  expect(parseVmStat("")).toBeNull();
  expect(parseSwapUsage("total = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)")).toEqual({ total: 2048 * 1048576, used: 1024 * 1048576 });
});

test("df: real disks once each, root first; macOS's data volume stands for /", () => {
  const linux = `Filesystem     1024-blocks     Used Available Capacity Mounted on
tmpfs              2455028     2408   2452620       1% /run
/dev/sda1        202051056 57728640 144306032      29% /
/dev/sda16          911580   183224    664716      22% /boot
/dev/loop3           65536    65536         0     100% /snap/core/1
/dev/sdb1             1000      500       400      56% /data disk
/dev/sda1        202051056 57728640 144306032      29% /var/lib/docker
`;
  expect(parseDf(linux)).toEqual([
    { mount: "/", used: 57728640 * 1024, total: (57728640 + 144306032) * 1024 },
    { mount: "/data disk", used: 500 * 1024, total: 900 * 1024 },
  ]);
  const mac = `Filesystem   1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1s1   482797652  10000000 200000000     5%    /
/dev/disk3s6     482797652   2000000 200000000     1%    /System/Volumes/VM
/dev/disk3s5     482797652 250000000 200000000    56%    /System/Volumes/Data
`;
  expect(parseDf(mac)).toEqual([{ mount: "/", used: 250000000 * 1024, total: 450000000 * 1024 }]);
});

test("/proc/<pid>/stat, names with spaces and parentheses included", () => {
  const stat = "1234 (my (odd) name) S 1 1234 1234 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 4 0 100 123456789 3000 18446744073709551615";
  expect(parsePidStat(stat)).toEqual({ name: "my (odd) name", ticks: 300, rssPages: 3000 });
  expect(parsePidStat("")).toBeNull();
});

test("process names: the program, an interpreter's script, never the arguments", () => {
  expect(processName("MainThread", "/home/u/.nvm/node\0/p/node_modules/astro/bin/astro.mjs\0dev\0")).toBe("node astro.mjs");
  expect(processName("python3", "/usr/bin/python3\0-u\0/srv/app/worker.py\0--token=secret\0")).toBe("python3 worker.py");
  expect(processName("clickhouse-serv", "clickhouse-server\0--config-file=/etc/x.xml\0")).toBe("clickhouse-server");
  expect(processName("next-server (v", "next-server (v16.0.0)\0")).toBe("next-server (v");
  expect(processName("kworker/0:1", "")).toBe("kworker/0:1");
});

test("ps and the heaviest programs, added up, CPU as a share of the machine", () => {
  const list = parsePs("  10  50.0  1000 /usr/lib/postgresql/bin/postgres\n  11  30.0  2000 postgres\n  12   0.0 900000 /Applications/Claude.app/claude\nbad line\n");
  expect(list).toEqual([
    { pid: 10, cpu: 50, mem: 1000 * 1024, name: "postgres" },
    { pid: 11, cpu: 30, mem: 2000 * 1024, name: "postgres" },
    { pid: 12, cpu: 0, mem: 900000 * 1024, name: "claude" },
  ]);
  const top = topProcesses([...list, { pid: 13, name: "fresh", cpu: null, mem: 1 }], 5, 4);
  expect(top.top_cpu).toEqual([{ name: "postgres", count: 2, cpu: 20, mem: 3000 * 1024 }]);
  expect(top.top_mem.map((p) => [p.name, p.count, p.cpu])).toEqual([["claude", 1, 0], ["postgres", 2, 20], ["fresh", 1, null]]);
});

test("os-release", () => {
  expect(parseOsRelease('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.4 LTS"\n')).toBe("Ubuntu 24.04.4 LTS");
  expect(parseOsRelease("")).toBeNull();
});
