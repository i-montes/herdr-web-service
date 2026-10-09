import { hostname } from "node:os";
import { defaultRun, type Runner } from "./run.ts";
import * as portal from "./portal.ts";
import * as tailscale from "./tailscale.ts";

export type TunnelKind = "tailscale" | "portal";

export interface TunnelResult {
  kind: TunnelKind;
  url: string;
  /** true when the provider persists itself (Tailscale); false when a service unit is needed (Portal) */
  persistent: boolean;
  /** Portal tunnel name, needed by the service unit's `exposeArgs` */
  name?: string;
  /** Portal binary (absolute path when it is not on PATH), for the service unit */
  bin?: string;
}

export async function setupTunnel(kind: TunnelKind, port: number): Promise<TunnelResult> {
  if (kind === "tailscale") {
    const bin = await tailscale.ensureInstalled();
    await tailscale.ensureLoggedIn(bin);
    await tailscale.ensureOperator(bin);
    const url = await tailscale.ensureFunnel(port, bin);
    return { kind, url, persistent: true };
  }
  const bin = await portal.ensureInstalled();
  const name = portal.askName(hostname());
  const url = await portal.probeUrl(name, port, bin);
  return { kind, url, persistent: false, name, bin };
}

/** Undoes what the provider keeps running by itself; false when that failed. */
export async function teardownTunnel(kind: TunnelKind, port: number, run: Runner = defaultRun): Promise<boolean> {
  // Portal runs as a service unit owned by the service step; nothing to undo here.
  if (kind === "tailscale") return tailscale.teardownFunnel(port, run);
  return true;
}

/** Read-only: Tailscale Funnel/serve currently proxies to this port (whatever `.env` says). */
export function funnelServes(port: number, run: Runner = defaultRun): Promise<boolean> {
  return tailscale.funnelServes(port, run);
}
