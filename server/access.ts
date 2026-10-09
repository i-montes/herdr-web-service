/**
 * Per-request access policy: which proxy headers to trust, which Host/Origin to accept, when a
 * login may travel, and the security headers every response carries (spec rules H1-H4, H8).
 *
 * Pure functions over `RequestFacts` so the policy is testable without a server. This module
 * must not import config.ts; callers pass an `AccessConfig`.
 */

import type { AccessMode } from "../shared/protocol.ts";
export type { AccessMode };

export interface RequestFacts {
  /** TCP peer address */
  peer: string | null;
  host: string | null;
  origin: string | null;
  forwardedFor: string | null;
  forwardedProto: string | null;
  protocol: "http:" | "https:";
  method: string;
  path: string;
}

export interface AccessConfig {
  mode: AccessMode;
  publicUrl: string;
  host: string;
  port: number;
  /** extra allowed Origin for development (the Vite dev server) */
  devOrigin?: string;
}

export function isLoopback(address: string): boolean {
  const a = address.toLowerCase();
  if (a === "::1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice("::ffff:".length) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

function peerIsLoopback(f: RequestFacts): boolean {
  return f.peer !== null && isLoopback(f.peer);
}

/** H1: the proxy's X-Forwarded-For (last hop) only when the proxy is us; else the TCP peer. */
export function clientAddress(f: RequestFacts): string | null {
  if (peerIsLoopback(f)) {
    const forwarded = f.forwardedFor?.split(",").at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  return f.peer;
}

/** H1: X-Forwarded-Proto only counts when the peer is a local proxy. */
export function isSecure(f: RequestFacts): boolean {
  if (peerIsLoopback(f)) return f.forwardedProto === "https";
  return f.protocol === "https:";
}

/** Lowercase hostname without port or IPv6 brackets. */
function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(1, end);
  }
  const colon = h.indexOf(":");
  return colon === -1 ? h : h.slice(0, colon);
}

/** H3: hostnames (lowercase, no port) this server answers to. */
export function allowedHosts(c: AccessConfig): string[] {
  const hosts = ["localhost", "127.0.0.1", "::1"];
  if (c.publicUrl) {
    try {
      hosts.push(hostnameOf(new URL(c.publicUrl).host));
    } catch {
      /* an invalid PUBLIC_URL adds nothing */
    }
  }
  if (c.mode === "lan") hosts.push(c.host.toLowerCase());
  return hosts;
}

/** Serialized origin (lowercase, default port dropped), or null when there is none. */
function originOf(text: string): string | null {
  try {
    const origin = new URL(text).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** H4: exact origins (scheme://host:port) allowed to send non-GET requests and open /ws. */
export function allowedOrigins(c: AccessConfig): string[] {
  const candidates = [`http://localhost:${c.port}`, `http://127.0.0.1:${c.port}`, `http://[::1]:${c.port}`];
  if (c.publicUrl) candidates.push(c.publicUrl);
  if (c.mode === "lan") candidates.push(`http://${c.host.includes(":") ? `[${c.host}]` : c.host}:${c.port}`);
  if (c.devOrigin) candidates.push(c.devOrigin);
  return candidates.map(originOf).filter((o): o is string => o !== null);
}

/** H3: the Host header names one of the allowed hosts (any port). */
export function hostAllowed(f: RequestFacts, c: AccessConfig): boolean {
  if (!f.host) return false;
  return allowedHosts(c).includes(hostnameOf(f.host));
}

/** H4: Origin, when present, must exactly match an allowed origin; on /ws it is required. */
export function originAllowed(f: RequestFacts, c: AccessConfig): boolean {
  if (f.origin === null) return f.path !== "/ws";
  const origin = originOf(f.origin); // the opaque "null" origin yields null
  return origin !== null && allowedOrigins(c).includes(origin);
}

/** H2: remote needs HTTPS, lan accepts HTTP, local only from loopback (also any unknown mode). */
export function loginTransportAllowed(f: RequestFacts, c: AccessConfig): boolean {
  if (c.mode === "remote") return isSecure(f);
  if (c.mode === "lan") return true;
  return peerIsLoopback(f);
}

const CSP = "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

/** H8 */
export function securityHeaders(secure: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
  if (secure) headers["strict-transport-security"] = "max-age=31536000";
  return headers;
}

export function factsFrom(request: Request, peer: string | null): RequestFacts {
  const url = new URL(request.url);
  const h = request.headers;
  return {
    peer,
    host: h.get("host"),
    origin: h.get("origin"),
    forwardedFor: h.get("x-forwarded-for"),
    forwardedProto: h.get("x-forwarded-proto"),
    protocol: url.protocol === "https:" ? "https:" : "http:",
    method: request.method,
    path: url.pathname,
  };
}
