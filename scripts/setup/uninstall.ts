/**
 * `plugin.ts uninstall`: tunnel off, service units removed, Claude Code's status line put back;
 * the password and the .env stay.
 */
import { readEnv } from "./env.ts";
import type { Unit } from "./service.ts";
import type { RemoveResult } from "./statusline.ts";
import type { TunnelKind } from "./tunnel/index.ts";

export interface UninstallDeps {
  envPath: string;
  port: number;
  authFile: string;
  log: (line: string) => void;
  unitInstalled: (u: Unit) => boolean;
  stopUnit: (u: Unit) => Promise<void>;
  uninstallUnit: (u: Unit) => Promise<void>;
  stopLooseServer: () => Promise<boolean>;
  /** read-only: Tailscale Funnel/serve proxies to this port now */
  funnelServes: (port: number) => Promise<boolean>;
  teardownTunnel: (kind: TunnelKind, port: number) => Promise<boolean>;
  removeStatusLine: () => RemoveResult;
}

/** Returns false when something could not be undone (the output says what to run). */
export async function runUninstall(d: UninstallDeps): Promise<boolean> {
  const env = readEnv(d.envPath);
  const envPort = Number(env.PORT) || d.port;
  let ok = true;

  // Funnel first: with the server gone it would only serve errors, but it must not outlive us.
  // Checked whatever .env says: an interrupted setup may have left it on without saving TUNNEL.
  for (const port of new Set([envPort, d.port])) {
    if (!(env.TUNNEL === "tailscale" && port === envPort) && !(await d.funnelServes(port))) continue;
    if (await d.teardownTunnel("tailscale", port)) {
      d.log(`turned off: Tailscale Funnel (port ${port})`);
    } else if (!(await d.funnelServes(port))) {
      d.log(`Tailscale Funnel: was not active (port ${port})`);
    } else {
      ok = false;
      d.log(`FAILED to turn off Tailscale Funnel: run \`tailscale funnel --bg ${port} off\``);
    }
  }

  const units: [Unit, string][] = [["tunnel", "tunnel service (Portal)"], ["server", "server service"]];
  for (const [unit, label] of units) {
    if (!d.unitInstalled(unit)) continue;
    await d.stopUnit(unit);
    await d.uninstallUnit(unit);
    d.log(`removed: ${label}`);
  }
  if (await d.stopLooseServer()) d.log("stopped: standalone server");

  try {
    const r = d.removeStatusLine();
    if (r.status === "removed") d.log("removed: Claude Code status line");
    else if (r.status === "restored") d.log(`restored: Claude Code status line (${r.previous})`);
    else if (r.status === "unreadable") {
      ok = false;
      d.log(`FAILED to remove the Claude Code status line: ${r.detail}`);
    }
  } catch (error) {
    ok = false;
    d.log(`FAILED to remove the Claude Code status line: ${(error as Error).message}`);
  }

  d.log(`kept: password (${d.authFile}) and configuration (${d.envPath})`);
  d.log("Tailscale and Portal, if you used them, are still installed.");
  return ok;
}
