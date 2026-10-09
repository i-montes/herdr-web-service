import { test, expect } from "bun:test";
import { allowedOrigins, clientAddress, factsFrom, hostAllowed, isLoopback, isSecure, loginTransportAllowed, originAllowed, securityHeaders, type AccessConfig, type RequestFacts } from "./access.ts";

function facts(overrides: Partial<RequestFacts> = {}): RequestFacts {
  return {
    peer: "203.0.113.9",
    host: "app.example.ts.net",
    origin: null,
    forwardedFor: null,
    forwardedProto: null,
    protocol: "http:",
    method: "GET",
    path: "/api/x",
    ...overrides,
  };
}

const cfg: AccessConfig = { mode: "remote", publicUrl: "https://app.example.ts.net", host: "127.0.0.1", port: 7340 };

test("forwarded headers are trusted only from a loopback peer", () => {
  expect(clientAddress(facts({ peer: "127.0.0.1", forwardedFor: "1.2.3.4, 5.6.7.8" }))).toBe("5.6.7.8");
  expect(clientAddress(facts({ peer: "203.0.113.9", forwardedFor: "5.6.7.8" }))).toBe("203.0.113.9");
  expect(isSecure(facts({ peer: "127.0.0.1", forwardedProto: "https" }))).toBe(true);
  expect(isSecure(facts({ peer: "203.0.113.9", forwardedProto: "https" }))).toBe(false);
});

test("host allowlist ignores port and case", () => {
  expect(hostAllowed(facts({ host: "APP.example.ts.net:443" }), cfg)).toBe(true);
  expect(hostAllowed(facts({ host: "localhost:5173" }), cfg)).toBe(true);
  expect(hostAllowed(facts({ host: "evil.com" }), cfg)).toBe(false);
  expect(hostAllowed(facts({ host: "192.168.1.20:7340" }), { ...cfg, mode: "lan", host: "192.168.1.20" })).toBe(true);
});

test("origin is optional except on /ws", () => {
  expect(originAllowed(facts({ origin: null }), cfg)).toBe(true);
  expect(originAllowed(facts({ origin: null, path: "/ws" }), cfg)).toBe(false);
  expect(originAllowed(facts({ origin: "https://evil.com" }), cfg)).toBe(false);
  expect(originAllowed(facts({ origin: "https://app.example.ts.net" }), cfg)).toBe(true);
});

test("origin is compared as an exact origin: scheme, host and port", () => {
  expect(originAllowed(facts({ origin: "https://APP.example.ts.net:443" }), cfg)).toBe(true);
  expect(originAllowed(facts({ origin: "http://app.example.ts.net" }), cfg)).toBe(false);
  expect(originAllowed(facts({ origin: "https://app.example.ts.net:8443" }), cfg)).toBe(false);
  expect(originAllowed(facts({ origin: "http://localhost:7340" }), cfg)).toBe(true);
  expect(originAllowed(facts({ origin: "http://[::1]:7340" }), cfg)).toBe(true);
  expect(originAllowed(facts({ origin: "http://localhost:3000" }), cfg)).toBe(false);
  expect(originAllowed(facts({ origin: "http://localhost:5173" }), cfg)).toBe(false);
  expect(originAllowed(facts({ origin: "http://localhost:5173" }), { ...cfg, devOrigin: "http://localhost:5173" })).toBe(true);
  const lan: AccessConfig = { ...cfg, mode: "lan", host: "192.168.1.20" };
  expect(originAllowed(facts({ origin: "http://192.168.1.20:7340" }), lan)).toBe(true);
  expect(originAllowed(facts({ origin: "http://192.168.1.20:8080" }), lan)).toBe(false);
  expect(originAllowed(facts({ origin: "http://192.168.1.20:7340" }), cfg)).toBe(false);
});

test("allowedOrigins lists the exact origins", () => {
  expect(allowedOrigins({ ...cfg, devOrigin: "http://localhost:5173" }).sort()).toEqual(
    ["https://app.example.ts.net", "http://localhost:7340", "http://127.0.0.1:7340", "http://[::1]:7340", "http://localhost:5173"].sort(),
  );
  expect(allowedOrigins({ ...cfg, publicUrl: "pwd" })).not.toContain("null");
});

test("login transport per mode", () => {
  expect(loginTransportAllowed(facts({ peer: "127.0.0.1", forwardedProto: "https" }), cfg)).toBe(true);
  expect(loginTransportAllowed(facts({ peer: "127.0.0.1", forwardedProto: "http" }), cfg)).toBe(false);
  expect(loginTransportAllowed(facts({ peer: "192.168.1.5" }), { ...cfg, mode: "lan", host: "192.168.1.20" })).toBe(true);
  expect(loginTransportAllowed(facts({ peer: "192.168.1.5" }), { ...cfg, mode: "local" })).toBe(false);
  expect(loginTransportAllowed(facts({ peer: "127.0.0.1" }), { ...cfg, mode: "local" })).toBe(true);
});

test("security headers", () => {
  expect(securityHeaders(false)["content-security-policy"]).toBe("default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  expect(securityHeaders(true)["strict-transport-security"]).toBe("max-age=31536000");
  expect(securityHeaders(false)["strict-transport-security"]).toBeUndefined();
});

test("loopback covers 127/8, ::1 and IPv4-mapped 127", () => {
  for (const a of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) expect(isLoopback(a)).toBe(true);
  for (const a of ["128.0.0.1", "10.0.0.1", "::ffff:10.0.0.1", "::2", "127.0.0.1.evil.com"]) expect(isLoopback(a)).toBe(false);
});

test("bracketed IPv6 host, missing host and opaque origin", () => {
  expect(hostAllowed(facts({ host: "[::1]:7340" }), cfg)).toBe(true);
  expect(hostAllowed(facts({ host: null }), cfg)).toBe(false);
  expect(hostAllowed(facts({ host: "192.168.1.20" }), { ...cfg, host: "192.168.1.20" })).toBe(false);
  expect(originAllowed(facts({ origin: "null", path: "/ws" }), cfg)).toBe(false);
  expect(originAllowed(facts({ origin: "http://localhost:7340", path: "/ws" }), cfg)).toBe(true);
});

test("factsFrom reads the request", () => {
  const request = new Request("http://127.0.0.1:7340/api/session?x=1", {
    method: "POST",
    headers: { host: "app.example.ts.net", origin: "https://app.example.ts.net", "x-forwarded-for": "1.2.3.4", "x-forwarded-proto": "https" },
  });
  expect(factsFrom(request, "127.0.0.1")).toEqual({
    peer: "127.0.0.1",
    host: "app.example.ts.net",
    origin: "https://app.example.ts.net",
    forwardedFor: "1.2.3.4",
    forwardedProto: "https",
    protocol: "http:",
    method: "POST",
    path: "/api/session",
  });
});
