/** The address the server listens on in `lan` mode and the canonical URL of each access mode. */
import { networkInterfaces } from "node:os";
import type { AccessMode } from "../../server/access.ts";

interface Iface {
  address: string;
  family: string | number;
  internal: boolean;
}

type Ifaces = Record<string, Iface[] | undefined>;

/** Containers, bridges, VPNs and overlays: never the Wi-Fi/Ethernet address a phone can reach. */
const VIRTUAL = /^(docker|br-|veth|utun|tailscale|wg|bridge|vmnet|ham|zt)/;

/** RFC 1918: 10/8, 172.16/12, 192.168/16. */
export function isPrivateIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

const ipv4 = (i: Iface) => !i.internal && (i.family === "IPv4" || i.family === 4);

/** Every non-internal IPv4 of this machine, virtual interfaces included (what the user may type). */
export function localIPv4s(ifaces: Ifaces = networkInterfaces()): string[] {
  return Object.values(ifaces).flatMap((list) => (list ?? []).filter(ipv4).map((i) => i.address));
}

/** First non-internal IPv4 of a physical-looking interface, preferring private ranges. */
export function pickLanAddress(ifaces: Ifaces): string | null {
  const v4 = Object.entries(ifaces)
    .filter(([name]) => !VIRTUAL.test(name))
    .flatMap(([, list]) => (list ?? []).filter(ipv4).map((i) => i.address));
  return v4.find(isPrivateIPv4) ?? v4[0] ?? null;
}

export function lanAddress(): string | null {
  return pickLanAddress(networkInterfaces());
}

export function canonicalUrl(mode: AccessMode, host: string, port: number, tunnelUrl?: string): string {
  if (mode === "local") return `http://localhost:${port}`;
  if (mode === "lan") return `http://${host}:${port}`;
  if (!tunnelUrl) throw new Error("remote mode needs the tunnel URL");
  return tunnelUrl;
}
