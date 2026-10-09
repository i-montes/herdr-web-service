import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnv } from "./env.ts";
import type { TunnelKind, TunnelResult } from "./tunnel/index.ts";
import type { Unit, UnitParams } from "./service.ts";
import { PUBLIC_IP, runWizard, SetupAborted, URL_CHANGE, type WizardDeps } from "./wizard.ts";

let dir = "";
let envPath = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wiz-"));
  envPath = join(dir, ".env");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Harness {
  deps: WizardDeps;
  calls: string[];
  installed: Map<Unit, UnitParams>;
  output: () => string;
  confirms: string[];
  /** the cleanup registered with onInterrupt, while registered */
  interrupt: () => (() => Promise<void>) | undefined;
}

/**
 * Fake seams. `chooses` answers menus in order; `answers` maps a confirm label fragment to the
 * reply (unlisted confirms take their default).
 */
function harness(opts: {
  chooses: string[];
  answers?: Record<string, boolean | (() => boolean | Promise<boolean>)>;
  asks?: string[];
  addresses?: string[];
  serving?: number[];
  teardownOk?: boolean;
  running?: Unit[];
  tunnel?: (kind: TunnelKind, port: number) => TunnelResult;
  units?: Unit[];
  health?: ({ ok: true } | { ok: false; reason: string })[];
  lan?: string | null;
  installResult?: "installed" | "unchanged";
}): Harness {
  const calls: string[] = [];
  const confirms: string[] = [];
  const out: string[] = [];
  const installed = new Map<Unit, UnitParams>();
  const present = new Set<Unit>(opts.units ?? []);
  const chooses = [...opts.chooses];
  const health = [...(opts.health ?? [{ ok: true as const }])];
  const asks = [...(opts.asks ?? [])];
  const serving = new Set(opts.serving ?? []);
  let interrupt: (() => Promise<void>) | undefined;
  const deps: WizardDeps = {
    envPath,
    port: 7340,
    unitParams: { bun: "/bin/bun", root: "/root", configDir: "/c", stateDir: "/s", socket: "/sock" },
    logFile: "/s/server.log",
    serviceKind: "launchd",
    log: (s) => out.push(s),
    preflight: async () => ({ ok: true }),
    choose: async (label, options, def) => {
      const next = chooses.shift();
      calls.push(`choose:${label}:${def ?? ""}`);
      const key = next === "" ? def : next;
      if (!options.some((o) => o.key === key)) throw new Error(`bad choice ${key}`);
      return key!;
    },
    confirm: async (label, def) => {
      confirms.push(label);
      const hit = Object.entries(opts.answers ?? {}).find(([frag]) => label.includes(frag));
      if (!hit) return def;
      return typeof hit[1] === "function" ? hit[1]() : hit[1];
    },
    ask: async (label) => {
      calls.push(`ask:${label}`);
      return asks.shift() ?? "";
    },
    localAddresses: () => opts.addresses ?? ["192.168.1.20", "10.8.0.2", "203.0.113.7"],
    funnelServes: async (port) => serving.has(port),
    unitRunning: async (u) => (opts.running ?? opts.units ?? []).includes(u),
    onInterrupt: (cleanup) => {
      interrupt = cleanup;
      return () => {
        interrupt = undefined;
      };
    },
    waitEnter: () => calls.push("enter"),
    passwordStep: async () => void calls.push("password"),
    lanAddress: () => (opts.lan === undefined ? "192.168.1.20" : opts.lan),
    setupTunnel: async (kind, port) => {
      calls.push(`setupTunnel:${kind}`);
      if (!opts.tunnel) throw new Error("no tunnel expected");
      return opts.tunnel(kind, port);
    },
    teardownTunnel: async (kind, port) => {
      calls.push(`teardown:${kind}:${port}`);
      if (opts.teardownOk === false) return false;
      serving.delete(port);
      return true;
    },
    unitInstalled: (u) => present.has(u),
    installUnit: async (u, p) => {
      calls.push(`install:${u}`);
      installed.set(u, p);
      present.add(u);
      return opts.installResult ?? "installed";
    },
    uninstallUnit: async (u) => {
      calls.push(`uninstall:${u}`);
      present.delete(u);
    },
    stopUnit: async (u) => void calls.push(`stop:${u}`),
    restartUnit: async (u) => void calls.push(`restart:${u}`),
    stopLooseServer: async () => void calls.push("stopLoose"),
    verifyHealth: async (url) => {
      calls.push(`verify:${url}`);
      return health.shift() ?? { ok: true };
    },
  };
  return { deps, calls, installed, output: () => out.join("\n"), confirms, interrupt: () => interrupt };
}

const tailscale = (_: TunnelKind): TunnelResult => ({ kind: "tailscale", url: "https://mac.tail.ts.net", persistent: true });
const portal = (_: TunnelKind): TunnelResult => ({
  kind: "portal", url: "https://herdr-mac.portal.example", persistent: false, name: "herdr-mac", bin: "/home/u/.local/bin/portal",
});

describe("runWizard", () => {
  test("local: writes .env, installs the server unit only, verifies localhost", async () => {
    const h = harness({ chooses: ["local"] });
    await runWizard(h.deps);
    expect(readEnv(envPath)).toEqual({ ACCESS_MODE: "local", HOST: "127.0.0.1", PORT: "7340", PUBLIC_URL: "http://localhost:7340" });
    expect(h.calls).toEqual([
      "choose:¿Desde dónde vas a usar el cliente web?:local", "password", "stopLoose", "install:server",
      "verify:http://localhost:7340", "enter",
    ]);
    expect(h.output()).toContain("http://localhost:7340");
  });

  test("an unchanged server unit is restarted to pick up the new .env", async () => {
    const h = harness({ chooses: ["local"], installResult: "unchanged" });
    await runWizard(h.deps);
    expect(h.calls).toContain("restart:server");
    expect(h.output()).toContain("sin cambios");
  });

  test("preselects the saved mode", async () => {
    writeFileSync(envPath, "ACCESS_MODE=lan\nHOST=192.168.1.20\nPUBLIC_URL=http://192.168.1.20:7340\n");
    const h = harness({ chooses: [""] });
    await runWizard(h.deps);
    expect(h.calls[0]).toBe("choose:¿Desde dónde vas a usar el cliente web?:lan");
  });

  test("lan: listens on the LAN address and shows its limitations", async () => {
    const h = harness({ chooses: ["lan"] });
    await runWizard(h.deps);
    expect(readEnv(envPath)).toMatchObject({ ACCESS_MODE: "lan", HOST: "192.168.1.20", PUBLIC_URL: "http://192.168.1.20:7340" });
    expect(h.calls).toContain("verify:http://192.168.1.20:7340");
    expect(h.output()).toContain("sin push");
  });

  test("lan without a LAN address aborts before writing anything", async () => {
    const h = harness({ chooses: ["lan"], lan: null });
    await expect(runWizard(h.deps)).rejects.toBeInstanceOf(SetupAborted);
    expect(readEnv(envPath)).toEqual({});
  });

  test("a failed preflight aborts before any question", async () => {
    const h = harness({ chooses: [] });
    h.deps.preflight = async () => ({ ok: false, problems: ["Falta dist/"] });
    await expect(runWizard(h.deps)).rejects.toBeInstanceOf(SetupAborted);
    expect(h.output()).toContain("Falta dist/");
    expect(h.calls).toEqual([]);
  });

  test("remote + tailscale: no tunnel unit, TUNNEL saved, verifies the tunnel URL", async () => {
    const h = harness({ chooses: ["remote", "tailscale"], tunnel: tailscale });
    await runWizard(h.deps);
    expect(readEnv(envPath)).toEqual({
      ACCESS_MODE: "remote", HOST: "127.0.0.1", PORT: "7340", PUBLIC_URL: "https://mac.tail.ts.net", TUNNEL: "tailscale",
    });
    expect(h.calls).toContain("setupTunnel:tailscale");
    expect(h.calls).not.toContain("install:tunnel");
    expect(h.calls).toContain("install:server");
    expect(h.calls).toContain("verify:https://mac.tail.ts.net");
    expect(h.output()).toContain("ufw allow 22");
  });

  test("remote + portal: installs the tunnel unit with the full portal argv", async () => {
    const h = harness({ chooses: ["remote", "portal"], tunnel: portal });
    await runWizard(h.deps);
    expect(readEnv(envPath)).toMatchObject({ TUNNEL: "portal", PUBLIC_URL: "https://herdr-mac.portal.example" });
    expect(h.installed.get("tunnel")?.portalArgs).toEqual([
      "/home/u/.local/bin/portal", "expose", "--name", "herdr-mac", "--http-route", "/=http://127.0.0.1:7340", "--discovery=false",
    ]);
  });

  test("portal re-run with the unit installed reuses the saved URL without probing", async () => {
    writeFileSync(envPath, "ACCESS_MODE=remote\nHOST=127.0.0.1\nPORT=7340\nPUBLIC_URL=https://saved.portal\nTUNNEL=portal\n");
    const h = harness({ chooses: ["remote"], units: ["server", "tunnel"], tunnel: portal });
    await runWizard(h.deps);
    expect(h.calls.some((c) => c.startsWith("setupTunnel"))).toBe(false);
    expect(h.calls).not.toContain("stop:tunnel");
    expect(h.calls).not.toContain("uninstall:tunnel");
    expect(h.confirms.some((c) => c.includes("La URL cambia"))).toBe(false);
    expect(readEnv(envPath)).toMatchObject({ PUBLIC_URL: "https://saved.portal", TUNNEL: "portal" });
  });

  test("portal re-run choosing to change stops the running tunnel before probing again", async () => {
    writeFileSync(envPath, "ACCESS_MODE=remote\nPUBLIC_URL=https://herdr-mac.portal.example\nTUNNEL=portal\n");
    const h = harness({ chooses: ["remote", "portal"], units: ["server", "tunnel"], tunnel: portal, answers: { "¿Cambiar el túnel?": true } });
    await runWizard(h.deps);
    expect(h.calls.indexOf("stop:tunnel")).toBeLessThan(h.calls.indexOf("setupTunnel:portal"));
    expect(h.calls).toContain("install:tunnel");
  });

  test("declining a URL change aborts without touching .env or services", async () => {
    const before = "ACCESS_MODE=local\nPUBLIC_URL=http://localhost:7340\n";
    writeFileSync(envPath, before);
    const h = harness({ chooses: ["lan"], answers: { "La URL cambia": false } });
    await expect(runWizard(h.deps)).rejects.toBeInstanceOf(SetupAborted);
    expect(h.confirms).toContain(URL_CHANGE);
    expect(URL_CHANGE).toBe("La URL cambia: los dispositivos y sesiones abiertos con la URL anterior tendrán que volver a entrar. ¿Continuar?");
    expect(readEnv(envPath)).toEqual({ ACCESS_MODE: "local", PUBLIC_URL: "http://localhost:7340" });
    expect(h.calls.some((c) => c.startsWith("install"))).toBe(false);
  });

  test("declining after stopping a portal unit starts it again", async () => {
    writeFileSync(envPath, "ACCESS_MODE=remote\nPUBLIC_URL=https://saved.portal\nTUNNEL=portal\n");
    const h = harness({
      chooses: ["remote", "portal"], units: ["server", "tunnel"], tunnel: portal,
      answers: { "¿Cambiar el túnel?": true, "La URL cambia": false },
    });
    await expect(runWizard(h.deps)).rejects.toBeInstanceOf(SetupAborted);
    expect(h.calls).toContain("restart:tunnel");
  });

  test("declining after turning Funnel on turns it off again", async () => {
    writeFileSync(envPath, "ACCESS_MODE=local\nPUBLIC_URL=http://localhost:7340\n");
    const h = harness({ chooses: ["remote", "tailscale"], tunnel: tailscale, answers: { "La URL cambia": false } });
    await expect(runWizard(h.deps)).rejects.toBeInstanceOf(SetupAborted);
    expect(h.calls).toContain("teardown:tailscale:7340");
  });

  test("accepting a URL change proceeds", async () => {
    writeFileSync(envPath, "PUBLIC_URL=http://192.168.1.20:7340\n");
    const h = harness({ chooses: ["local"], answers: { "La URL cambia": true } });
    await runWizard(h.deps);
    expect(h.confirms).toContain(URL_CHANGE);
    expect(readEnv(envPath).PUBLIC_URL).toBe("http://localhost:7340");
  });

  test("a saved PUBLIC_URL that is not a URL is replaced without asking", async () => {
    writeFileSync(envPath, "PUBLIC_URL=pwd\n");
    const h = harness({ chooses: ["local"] });
    await runWizard(h.deps);
    expect(h.confirms.some((c) => c.includes("La URL cambia"))).toBe(false);
    expect(h.output()).toContain("URL guardada no válida (pwd): se reemplaza");
    expect(readEnv(envPath).PUBLIC_URL).toBe("http://localhost:7340");
    expect(h.calls).toContain("install:server");
  });

  test("leaving remote/tailscale turns Funnel off and clears TUNNEL", async () => {
    writeFileSync(envPath, "ACCESS_MODE=remote\nPORT=7340\nPUBLIC_URL=https://mac.tail.ts.net\nTUNNEL=tailscale\n");
    const h = harness({ chooses: ["local"], units: ["server"], answers: { "La URL cambia": true } });
    await runWizard(h.deps);
    expect(h.calls).toContain("teardown:tailscale:7340");
    expect(readEnv(envPath).TUNNEL).toBeUndefined();
  });

  test("leaving remote/portal removes the tunnel unit", async () => {
    writeFileSync(envPath, "ACCESS_MODE=remote\nPUBLIC_URL=https://saved.portal\nTUNNEL=portal\n");
    const h = harness({ chooses: ["local"], units: ["server", "tunnel"], answers: { "La URL cambia": true } });
    await runWizard(h.deps);
    expect(h.calls).toContain("uninstall:tunnel");
    expect(h.calls).not.toContain("teardown:tailscale:7340");
  });

  test("switching tailscale to portal turns Funnel off", async () => {
    writeFileSync(envPath, "ACCESS_MODE=remote\nPUBLIC_URL=https://mac.tail.ts.net\nTUNNEL=tailscale\n");
    const h = harness({ chooses: ["remote", "portal"], tunnel: portal, answers: { "La URL cambia": true } });
    await runWizard(h.deps);
    expect(h.calls).toContain("teardown:tailscale:7340");
    expect(h.calls).toContain("install:tunnel");
  });

  test("failed verification offers a retry and shows the log path", async () => {
    const h = harness({ chooses: ["local"], health: [{ ok: false, reason: "conexión rechazada" }, { ok: true }] });
    await runWizard(h.deps);
    expect(h.calls.filter((c) => c.startsWith("verify")).length).toBe(2);
    expect(h.output()).toContain("conexión rechazada");
    expect(h.output()).toContain("/s/server.log");
    expect(h.confirms).toContain("¿Reintentar?");
  });

  test("declining the retry aborts with no summary", async () => {
    const h = harness({ chooses: ["local"], health: [{ ok: false, reason: "x" }], answers: { "¿Reintentar?": false } });
    await expect(runWizard(h.deps)).rejects.toBeInstanceOf(SetupAborted);
    expect(h.calls).not.toContain("enter");
  });

  describe("tunnel rollback (Funnel must never outlive a non-remote .env)", () => {
    const LOCAL = "ACCESS_MODE=local\nHOST=127.0.0.1\nPORT=7340\nPUBLIC_URL=http://localhost:7340\n";

    test("TUNNEL is recorded in .env before the tunnel is enabled", async () => {
      writeFileSync(envPath, LOCAL);
      let during: string | undefined;
      const h = harness({
        chooses: ["remote", "tailscale"], answers: { "La URL cambia": true },
        tunnel: (k) => ((during = readEnv(envPath).TUNNEL), tailscale(k)),
      });
      await runWizard(h.deps);
      expect(during).toBe("tailscale");
    });

    test("setupTunnel throwing after Funnel went on: Funnel off, TUNNEL restored", async () => {
      writeFileSync(envPath, LOCAL);
      const h = harness({ chooses: ["remote", "tailscale"], tunnel: () => { throw new Error("Tailscale no reporta un nombre DNS"); } });
      await expect(runWizard(h.deps)).rejects.toThrow("nombre DNS");
      expect(h.calls).toContain("teardown:tailscale:7340");
      expect(readEnv(envPath)).toEqual({ ACCESS_MODE: "local", HOST: "127.0.0.1", PORT: "7340", PUBLIC_URL: "http://localhost:7340" });
    });

    test("an error after setupTunnel (before saving) turns the fresh Funnel off", async () => {
      writeFileSync(envPath, LOCAL);
      const h = harness({ chooses: ["remote", "tailscale"], tunnel: tailscale, answers: { "La URL cambia": () => { throw new Error("boom"); } } });
      await expect(runWizard(h.deps)).rejects.toThrow("boom");
      expect(h.calls).toContain("teardown:tailscale:7340");
      expect(readEnv(envPath).TUNNEL).toBeUndefined();
    });

    test("an interrupt while the URL change is asked turns the fresh Funnel off", async () => {
      writeFileSync(envPath, LOCAL);
      let h: Harness;
      h = harness({
        chooses: ["remote", "tailscale"], tunnel: tailscale,
        answers: {
          "La URL cambia": async () => {
            const cleanup = h.interrupt();
            expect(cleanup).toBeDefined();
            await cleanup!(); // what SIGINT/SIGHUP runs before exiting 130
            return false;
          },
        },
      });
      await expect(runWizard(h.deps)).rejects.toBeInstanceOf(SetupAborted);
      expect(h.calls.filter((c) => c === "teardown:tailscale:7340").length).toBe(1);
      expect(readEnv(envPath).TUNNEL).toBeUndefined();
    });

    test("an interrupt while setupTunnel is still running turns the fresh Funnel off", async () => {
      writeFileSync(envPath, LOCAL);
      const h = harness({ chooses: ["remote", "tailscale"], tunnel: tailscale, answers: { "La URL cambia": false } });
      let registered = false;
      h.deps.setupTunnel = async (kind, port) => {
        h.calls.push(`setupTunnel:${kind}`);
        const cleanup = h.interrupt();
        registered = cleanup !== undefined;
        await cleanup?.(); // Funnel already on, setupTunnel not yet returned: SIGINT arrives
        return tailscale(kind);
      };
      await expect(runWizard(h.deps)).rejects.toBeInstanceOf(SetupAborted);
      expect(registered).toBe(true);
      expect(h.calls.indexOf("teardown:tailscale:7340")).toBeGreaterThan(h.calls.indexOf("setupTunnel:tailscale"));
      expect(readEnv(envPath).TUNNEL).toBeUndefined();
    });

    test("an already configured Funnel is left alone when the run fails", async () => {
      writeFileSync(envPath, "ACCESS_MODE=remote\nPORT=7340\nPUBLIC_URL=https://mac.tail.ts.net\nTUNNEL=tailscale\n");
      const h = harness({ chooses: ["remote", "tailscale"], tunnel: tailscale, units: ["server"], serving: [7340] });
      h.deps.installUnit = async () => { throw new Error("launchctl bootstrap failed"); };
      await expect(runWizard(h.deps)).rejects.toThrow("bootstrap");
      expect(h.calls.some((c) => c.startsWith("teardown"))).toBe(false);
      expect(readEnv(envPath).TUNNEL).toBe("tailscale");
    });

    test("a stale TUNNEL marker under a local .env does not protect a Funnel this run enabled", async () => {
      writeFileSync(envPath, LOCAL + "TUNNEL=tailscale\n");
      const h = harness({ chooses: ["remote", "tailscale"], tunnel: tailscale, answers: { "La URL cambia": false } });
      await expect(runWizard(h.deps)).rejects.toBeInstanceOf(SetupAborted);
      expect(h.calls).toContain("teardown:tailscale:7340");
    });

    test("TUNNEL=tailscale in a remote .env but Funnel not serving counts as fresh", async () => {
      writeFileSync(envPath, "ACCESS_MODE=remote\nPORT=7340\nPUBLIC_URL=https://old.ts.net\nTUNNEL=tailscale\n");
      const h = harness({ chooses: ["remote", "tailscale"], tunnel: tailscale, answers: { "La URL cambia": false } });
      await expect(runWizard(h.deps)).rejects.toBeInstanceOf(SetupAborted);
      expect(h.calls).toContain("teardown:tailscale:7340");
    });

    test("a Funnel that cannot be turned off keeps TUNNEL in .env for uninstall", async () => {
      writeFileSync(envPath, LOCAL);
      const h = harness({ chooses: ["remote", "tailscale"], tunnel: tailscale, teardownOk: false, serving: [7340], answers: { "La URL cambia": false } });
      await expect(runWizard(h.deps)).rejects.toBeInstanceOf(SetupAborted);
      expect(readEnv(envPath).TUNNEL).toBe("tailscale");
      expect(h.output()).toContain("tailscale funnel --bg 7340 off");
    });

    test("leaving remote turns off a Funnel on our port even without TUNNEL in .env", async () => {
      writeFileSync(envPath, LOCAL);
      const h = harness({ chooses: ["local"], serving: [7340] });
      await runWizard(h.deps);
      expect(h.calls.indexOf("teardown:tailscale:7340")).toBeLessThan(h.calls.indexOf("install:server"));
    });

    test("a Funnel that stays on aborts before saving", async () => {
      writeFileSync(envPath, LOCAL);
      const h = harness({ chooses: ["local"], serving: [7340], teardownOk: false });
      await expect(runWizard(h.deps)).rejects.toThrow("tailscale funnel --bg 7340 off");
      expect(h.calls).not.toContain("install:server");
    });

    test("no Funnel on our port: nothing is turned off", async () => {
      const h = harness({ chooses: ["local"] });
      await runWizard(h.deps);
      expect(h.calls.some((c) => c.startsWith("teardown"))).toBe(false);
    });
  });

  describe("Portal unit repair", () => {
    const SAVED = "ACCESS_MODE=remote\nHOST=127.0.0.1\nPORT=7340\nPUBLIC_URL=https://herdr-mac.portal.example\nTUNNEL=portal\n";

    test("a throw in installUnit(server) after stopping Portal starts it again", async () => {
      writeFileSync(envPath, SAVED);
      const h = harness({ chooses: ["remote", "portal"], units: ["server", "tunnel"], tunnel: portal, answers: { "¿Cambiar el túnel?": true } });
      h.deps.installUnit = async (u) => {
        h.calls.push(`install:${u}`);
        throw new Error("launchctl bootstrap failed");
      };
      await expect(runWizard(h.deps)).rejects.toThrow("bootstrap");
      expect(h.calls).toContain("stop:tunnel");
      expect(h.calls.at(-1)).toBe("restart:tunnel");
    });

    test("reuse path starts a unit that is not loaded", async () => {
      writeFileSync(envPath, SAVED);
      const h = harness({ chooses: ["remote"], units: ["server", "tunnel"], running: [] });
      await runWizard(h.deps);
      expect(h.calls).toContain("restart:tunnel");
      expect(h.calls.some((c) => c.startsWith("setupTunnel"))).toBe(false);
    });

    test("reuse path leaves a running unit alone", async () => {
      writeFileSync(envPath, SAVED);
      const h = harness({ chooses: ["remote"], units: ["server", "tunnel"] });
      await runWizard(h.deps);
      expect(h.calls).not.toContain("restart:tunnel");
    });

    test("portal without a name fails before anything is saved", async () => {
      const h = harness({ chooses: ["remote", "portal"], tunnel: () => ({ kind: "portal", url: "https://p", persistent: false }) });
      await expect(runWizard(h.deps)).rejects.toThrow("nombre");
      expect(readEnv(envPath).PUBLIC_URL).toBeUndefined();
      expect(h.calls.some((c) => c.startsWith("install"))).toBe(false);
    });
  });

  describe("LAN address prompt", () => {
    test("shows the detected address as the default", async () => {
      const h = harness({ chooses: ["lan"], asks: [""] });
      await runWizard(h.deps);
      expect(h.calls).toContain("ask:IP de este equipo en la red [192.168.1.20]:");
      expect(readEnv(envPath).HOST).toBe("192.168.1.20");
    });

    test("offers the saved HOST when it is still an address of this machine", async () => {
      writeFileSync(envPath, "ACCESS_MODE=lan\nHOST=10.8.0.2\nPORT=7340\nPUBLIC_URL=http://10.8.0.2:7340\n");
      const h = harness({ chooses: ["lan"], asks: [""] });
      await runWizard(h.deps);
      expect(h.calls).toContain("ask:IP de este equipo en la red [10.8.0.2]:");
      expect(readEnv(envPath).HOST).toBe("10.8.0.2");
    });

    test("offers the detected address when the saved HOST is gone", async () => {
      writeFileSync(envPath, "ACCESS_MODE=lan\nHOST=192.168.5.5\nPORT=7340\nPUBLIC_URL=http://192.168.5.5:7340\n");
      const h = harness({ chooses: ["lan"], asks: [""], answers: { "La URL cambia": true } });
      await runWizard(h.deps);
      expect(h.calls).toContain("ask:IP de este equipo en la red [192.168.1.20]:");
      expect(readEnv(envPath)).toMatchObject({ HOST: "192.168.1.20", PUBLIC_URL: "http://192.168.1.20:7340" });
    });

    test("the lan summary says to re-run setup if the address changes", async () => {
      const h = harness({ chooses: ["lan"], asks: [""] });
      await runWizard(h.deps);
      expect(h.output()).toContain("Si cambia la IP de este equipo, vuelve a ejecutar la configuración.");
    });

    test("accepts another address of this machine", async () => {
      const h = harness({ chooses: ["lan"], asks: ["10.8.0.2"] });
      await runWizard(h.deps);
      expect(readEnv(envPath)).toMatchObject({ HOST: "10.8.0.2", PUBLIC_URL: "http://10.8.0.2:7340" });
    });

    test("rejects an address that is not this machine's and asks again", async () => {
      const h = harness({ chooses: ["lan"], asks: ["192.168.1.99", ""] });
      await runWizard(h.deps);
      expect(h.output()).toContain("192.168.1.99 no es una dirección IPv4 de este equipo");
      expect(readEnv(envPath).HOST).toBe("192.168.1.20");
    });

    test("a public address needs confirmation; No goes back to the prompt", async () => {
      const h = harness({ chooses: ["lan"], asks: ["203.0.113.7", ""], answers: { "IP es pública": false } });
      await runWizard(h.deps);
      expect(h.confirms).toContain(PUBLIC_IP);
      expect(readEnv(envPath).HOST).toBe("192.168.1.20");
    });

    test("a confirmed public address is used", async () => {
      const h = harness({ chooses: ["lan"], asks: ["203.0.113.7"], answers: { "IP es pública": true } });
      await runWizard(h.deps);
      expect(readEnv(envPath).HOST).toBe("203.0.113.7");
    });

    test("a detected public address also needs confirmation", async () => {
      const h = harness({ chooses: ["lan"], lan: "203.0.113.7", asks: [""], answers: { "IP es pública": true } });
      await runWizard(h.deps);
      expect(h.confirms).toContain(PUBLIC_IP);
    });
  });
});
