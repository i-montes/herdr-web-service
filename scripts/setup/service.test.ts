import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installUnit, renderLaunchAgent, renderSystemdUnit, restartUnit, stopUnit, uninstallUnit, unitInstalled, unitPath, unitRunning,
  type UnitParams,
} from "./service.ts";

const P: UnitParams = { bun: "/usr/bin/bun", root: "/opt/x", configDir: "/c", stateDir: "/st", socket: "/s" };
const realPlatform = process.platform;
const realHome = process.env.HOME;
let tmp = "";
const platform = (v: string) => Object.defineProperty(process, "platform", { value: v });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "svc-"));
  process.env.HOME = tmp;
});
afterEach(() => {
  platform(realPlatform);
  process.env.HOME = realHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe("renderSystemdUnit", () => {
  test("server unit", () => {
    const s = renderSystemdUnit("server", P);
    for (const line of [
      "Restart=on-failure", "RestartSec=2", "WorkingDirectory=/opt/x", "Environment=HERDR_SOCKET_PATH=/s",
      "Environment=HERDR_PLUGIN_CONFIG_DIR=/c", "Environment=HERDR_PLUGIN_STATE_DIR=/st",
      "ExecStart=/usr/bin/bun server/index.ts", "WantedBy=default.target",
    ]) expect(s).toContain(line);
  });
  test("tunnel unit runs the portal argv", () => {
    const s = renderSystemdUnit("tunnel", { ...P, portalArgs: ["/home/u/.local/bin/portal", "expose", "--name", "herdr-a", "--http-route", "/=http://127.0.0.1:7340"] });
    expect(s).toContain("ExecStart=/home/u/.local/bin/portal expose --name herdr-a --http-route /=http://127.0.0.1:7340");
  });
  test("tunnel without portalArgs throws", () => {
    expect(() => renderSystemdUnit("tunnel", P)).toThrow();
  });
  test("quotes spaces, quotes and specifiers", () => {
    const s = renderSystemdUnit("server", { ...P, bun: "/my dir/b&n/bun", root: "/opt/my x", configDir: '/c"q', stateDir: "/100%/s$" });
    expect(s).toContain('ExecStart="/my dir/b&n/bun" server/index.ts');
    expect(s).toContain('WorkingDirectory="/opt/my x"');
    expect(s).toContain('Environment="HERDR_PLUGIN_CONFIG_DIR=/c\\"q"');
    expect(s).toContain('Environment="HERDR_PLUGIN_STATE_DIR=/100%%/s$"');
  });
});

describe("renderLaunchAgent", () => {
  test("server plist", () => {
    const s = renderLaunchAgent("server", P);
    expect(s).toContain("<key>KeepAlive</key>");
    expect(s).toContain("<key>RunAtLoad</key>");
    expect(s).toContain("<string>dev.herdr-web-service</string>");
    expect(s).toContain("<string>/usr/bin/bun</string>");
    expect(s).toContain("<string>/st/server.log</string>");
  });
  test("tunnel label and log", () => {
    const s = renderLaunchAgent("tunnel", { ...P, portalArgs: ["/p/portal", "expose"] });
    expect(s).toContain("dev.herdr-web-service.tunnel");
    expect(s).toContain("<string>expose</string>");
    expect(s).toContain("/st/tunnel.log");
  });
  test("XML-escapes paths with spaces and ampersands", () => {
    const s = renderLaunchAgent("server", { ...P, bun: "/A & B/bun", root: "/o<p>t x" });
    expect(s).toContain("<string>/A &amp; B/bun</string>");
    expect(s).toContain("<string>/o&lt;p&gt;t x</string>");
    expect(s).not.toContain("A & B");
  });
});

describe("unitPath", () => {
  test("linux", () => {
    platform("linux");
    expect(unitPath("server")).toBe(`${tmp}/.config/systemd/user/herdr-web-service.service`);
    expect(unitPath("tunnel")).toBe(`${tmp}/.config/systemd/user/herdr-web-service-tunnel.service`);
  });
  test("macOS", () => {
    platform("darwin");
    expect(unitPath("server")).toBe(`${tmp}/Library/LaunchAgents/dev.herdr-web-service.plist`);
    expect(unitPath("tunnel")).toBe(`${tmp}/Library/LaunchAgents/dev.herdr-web-service.tunnel.plist`);
  });
});

describe("installUnit", () => {
  const recorder = (codes: Record<string, number> = {}) => {
    const calls: string[][] = [];
    return { calls, run: async (a: string[]) => (calls.push(a), codes[a[0] === "loginctl" ? "loginctl" : ""] ?? 0) };
  };

  test("second install with the same content is unchanged and runs nothing", async () => {
    platform("linux");
    const r = recorder();
    expect(await installUnit("server", P, r.run)).toBe("installed");
    const n = r.calls.length;
    expect(readFileSync(unitPath("server"), "utf8")).toBe(renderSystemdUnit("server", P));
    r.calls.length = 0;
    expect(await installUnit("server", P, r.run)).toBe("unchanged");
    // loaded and enabled: only state checks and linger, nothing that restarts or reloads
    expect(r.calls.map((c) => c.join(" "))).toEqual([
      "systemctl --user is-enabled herdr-web-service.service",
      "systemctl --user is-active herdr-web-service.service",
      `loginctl enable-linger ${process.env.USER}`,
    ]);
    expect(n).toBeGreaterThan(0);
    r.calls.length = 0;
    expect(await installUnit("server", { ...P, root: "/other" }, r.run)).toBe("installed");
    expect(r.calls.map((c) => c.join(" "))).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now herdr-web-service.service",
      "systemctl --user restart herdr-web-service.service",
      `loginctl enable-linger ${process.env.USER}`,
    ]);
  });

  test("linux: identical content but not active gets enabled again", async () => {
    platform("linux");
    await installUnit("server", P, async () => 0);
    const calls: string[][] = [];
    expect(await installUnit("server", P, async (a) => (calls.push(a), a[2] === "is-active" ? 3 : 0))).toBe("unchanged");
    const cmds = calls.map((c) => c.join(" "));
    expect(cmds).toContain("systemctl --user daemon-reload");
    expect(cmds).toContain("systemctl --user enable --now herdr-web-service.service");
    expect(cmds.some((c) => c.includes("restart"))).toBe(false);
  });

  test("macOS: identical content, loaded: only print; not loaded: bootstrap", async () => {
    platform("darwin");
    await installUnit("server", P, async () => 0);
    const uid = process.getuid!();
    const loaded: string[][] = [];
    expect(await installUnit("server", P, async (a) => (loaded.push(a), 0))).toBe("unchanged");
    expect(loaded).toEqual([["launchctl", "print", `gui/${uid}/dev.herdr-web-service`]]);
    const down: string[][] = [];
    await installUnit("server", P, async (a) => (down.push(a), a[1] === "print" ? 113 : 0));
    expect(down.map((c) => c[1])).toEqual(["print", "bootstrap"]);
  });

  test("linux command sequence and linger hint on failure", async () => {
    platform("linux");
    process.env.USER = "ana";
    const r = recorder({ loginctl: 1 });
    const out: string[] = [];
    const log = console.log;
    console.log = (...a) => void out.push(a.join(" "));
    try { await installUnit("server", P, r.run); } finally { console.log = log; }
    expect(r.calls.map((c) => c.join(" "))).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now herdr-web-service.service",
      "loginctl enable-linger ana",
    ]);
    expect(out.join("\n")).toContain("sudo loginctl enable-linger ana");
  });

  test("macOS bootouts then bootstraps; failure to bootstrap throws", async () => {
    platform("darwin");
    const r = recorder();
    await installUnit("server", P, r.run);
    const uid = process.getuid!();
    expect(r.calls).toEqual([
      ["launchctl", "bootout", `gui/${uid}`, unitPath("server")],
      ["launchctl", "bootstrap", `gui/${uid}`, unitPath("server")],
    ]);
    await expect(installUnit("tunnel", { ...P, portalArgs: ["p"] }, async (a) => (a[1] === "bootstrap" ? 5 : 0))).rejects.toThrow();
  });

  test("uninstall removes the file; restart and stop use the right commands", async () => {
    platform("darwin");
    const r = recorder();
    await installUnit("server", P, r.run);
    expect(unitInstalled("server")).toBe(true);
    r.calls.length = 0;
    await restartUnit("server", r.run);
    await stopUnit("server", r.run);
    await uninstallUnit("server", r.run);
    const uid = process.getuid!();
    expect(r.calls[0]).toEqual(["launchctl", "kickstart", "-k", `gui/${uid}/dev.herdr-web-service`]);
    expect(r.calls[1]![1]).toBe("bootout");
    expect(unitInstalled("server")).toBe(false);
    expect(existsSync(unitPath("server"))).toBe(false);
  });

  test("macOS restart falls back to bootstrap when not loaded", async () => {
    platform("darwin");
    const calls: string[][] = [];
    await restartUnit("server", async (a) => (calls.push(a), a[1] === "kickstart" ? 113 : 0));
    expect(calls[1]![1]).toBe("bootstrap");
  });

  test("linux restart/stop/uninstall", async () => {
    platform("linux");
    const r = recorder();
    await installUnit("server", P, r.run);
    r.calls.length = 0;
    await restartUnit("server", r.run);
    await stopUnit("server", r.run);
    await uninstallUnit("server", r.run);
    expect(r.calls.map((c) => c.join(" "))).toEqual([
      "systemctl --user restart herdr-web-service.service",
      "systemctl --user stop herdr-web-service.service",
      "systemctl --user disable --now herdr-web-service.service",
      "systemctl --user daemon-reload",
    ]);
  });
});

describe("unitRunning", () => {
  test("macOS: loaded per launchctl print", async () => {
    platform("darwin");
    const calls: string[][] = [];
    expect(await unitRunning("tunnel", async (a) => (calls.push(a), 0))).toBe(true);
    expect(calls[0]).toEqual(["launchctl", "print", `gui/${process.getuid?.() ?? 0}/dev.herdr-web-service.tunnel`]);
    expect(await unitRunning("tunnel", async () => 113)).toBe(false);
  });
  test("linux: systemctl --user is-active", async () => {
    platform("linux");
    const calls: string[][] = [];
    expect(await unitRunning("tunnel", async (a) => (calls.push(a), 3))).toBe(false);
    expect(calls[0]).toEqual(["systemctl", "--user", "is-active", "herdr-web-service-tunnel.service"]);
  });
});
