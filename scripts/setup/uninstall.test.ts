import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Unit } from "./service.ts";
import { runUninstall, type UninstallDeps } from "./uninstall.ts";

let dir = "";
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "unin-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function harness(opts: { env?: string; units?: Unit[]; serving?: number[]; teardownOk?: boolean; loose?: boolean }) {
  const envPath = join(dir, ".env");
  if (opts.env !== undefined) writeFileSync(envPath, opts.env);
  const calls: string[] = [];
  const out: string[] = [];
  const units = new Set(opts.units ?? []);
  const serving = new Set(opts.serving ?? []);
  const deps: UninstallDeps = {
    envPath,
    port: 7340,
    authFile: join(dir, "auth.json"),
    log: (l) => out.push(l),
    unitInstalled: (u) => units.has(u),
    stopUnit: async (u) => void calls.push(`stop:${u}`),
    uninstallUnit: async (u) => {
      calls.push(`uninstall:${u}`);
      units.delete(u);
    },
    stopLooseServer: async () => (calls.push("stopLoose"), opts.loose ?? false),
    funnelServes: async (p) => serving.has(p),
    teardownTunnel: async (k, p) => {
      calls.push(`teardown:${k}:${p}`);
      if (opts.teardownOk === false) return false;
      serving.delete(p);
      return true;
    },
  };
  return { deps, calls, output: () => out.join("\n") };
}

test("no TUNNEL in .env but Funnel serves our port: turned off, before the units go", async () => {
  const h = harness({ env: "ACCESS_MODE=local\n", units: ["server"], serving: [7340] });
  expect(await runUninstall(h.deps)).toBe(true);
  expect(h.calls).toEqual(["teardown:tailscale:7340", "stop:server", "uninstall:server", "stopLoose"]);
  expect(h.output()).toContain("apagado: Tailscale Funnel");
});

test("TUNNEL=tailscale is turned off even if status cannot tell", async () => {
  const h = harness({ env: "TUNNEL=tailscale\nPORT=7340\n" });
  await runUninstall(h.deps);
  expect(h.calls).toContain("teardown:tailscale:7340");
});

test("a failed Funnel off is reported, not hidden", async () => {
  const h = harness({ env: "TUNNEL=tailscale\n", serving: [7340], teardownOk: false });
  expect(await runUninstall(h.deps)).toBe(false);
  expect(h.output()).not.toContain("apagado: Tailscale Funnel");
  expect(h.output()).toContain("tailscale funnel --bg 7340 off");
});

test("TUNNEL=tailscale with tailscale gone: says it was not active", async () => {
  const h = harness({ env: "TUNNEL=tailscale\n", teardownOk: false });
  expect(await runUninstall(h.deps)).toBe(true);
  expect(h.output()).toContain("no estaba activo");
});

test("nothing configured: no teardown, units removed, kept files listed", async () => {
  const h = harness({ units: ["server", "tunnel"], loose: true });
  expect(await runUninstall(h.deps)).toBe(true);
  expect(h.calls).toEqual(["stop:tunnel", "uninstall:tunnel", "stop:server", "uninstall:server", "stopLoose"]);
  expect(h.output()).toContain("conservado:");
  expect(h.output()).toContain("servidor suelto");
});
