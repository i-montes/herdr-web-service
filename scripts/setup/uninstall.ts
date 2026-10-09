/** `plugin.ts uninstall`: tunnel off, service units removed; the password and the .env stay. */
import { readEnv } from "./env.ts";
import type { Unit } from "./service.ts";
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
      d.log(`apagado: Tailscale Funnel (puerto ${port})`);
    } else if (!(await d.funnelServes(port))) {
      d.log(`Tailscale Funnel: no estaba activo (puerto ${port})`);
    } else {
      ok = false;
      d.log(`NO se pudo apagar Tailscale Funnel: ejecuta \`tailscale funnel --bg ${port} off\``);
    }
  }

  const units: [Unit, string][] = [["tunnel", "servicio del túnel (Portal)"], ["server", "servicio del servidor"]];
  for (const [unit, label] of units) {
    if (!d.unitInstalled(unit)) continue;
    await d.stopUnit(unit);
    await d.uninstallUnit(unit);
    d.log(`quitado: ${label}`);
  }
  if (await d.stopLooseServer()) d.log("parado: servidor suelto");

  d.log(`conservado: contraseña (${d.authFile}) y configuración (${d.envPath})`);
  d.log("Tailscale y Portal, si los usabas, siguen instalados.");
  return ok;
}
