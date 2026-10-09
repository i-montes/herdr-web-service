import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts reads these at import time, so they must be set before any server module loads
const stateDir = mkdtempSync(join(tmpdir(), "hwv-state-"));
const configDir = mkdtempSync(join(tmpdir(), "hwv-config-"));
process.env["HERDR_PLUGIN_STATE_DIR"] = stateDir;
process.env["HERDR_PLUGIN_CONFIG_DIR"] = configDir;

const mod = await import("./sessions.ts");
const { createSession, sessionFromRequest, sessionCookie, revokeSession, listSessions, sessionAlive, hashToken, _setNow, _reload, SESSION_COOKIE, IDLE_DAYS, ABSOLUTE_DAYS } = mod;
const file = join(stateDir, "sessions.json");
const DAY = 86_400_000;

function withCookie(token: string): Request {
  return new Request("http://x", { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` } });
}

beforeEach(() => {
  _setNow(null);
  writeFileSync(file, "[]");
  _reload();
});
afterAll(() => {
  _setNow(null);
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

test("the file holds hashes, not tokens", () => {
  const { token } = createSession(new Request("http://x"), "1.2.3.4");
  const raw = readFileSync(file, "utf8");
  const parsed = JSON.parse(raw);
  expect(parsed[0].id_hash).toHaveLength(64);
  expect(parsed[0].id_hash).toBe(hashToken(token));
  expect(parsed[0].id).toBeUndefined();
  expect(raw).not.toContain(token);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("a hash read from the file cannot be used as a cookie", () => {
  createSession(new Request("http://x"), null);
  const stolen = JSON.parse(readFileSync(file, "utf8"))[0].id_hash as string;
  expect(sessionFromRequest(withCookie(stolen))).toBeNull();
});

test("a cookie with the token resolves the session; a wrong one does not", () => {
  const { session, token } = createSession(new Request("http://x"), null);
  expect(sessionFromRequest(withCookie(token))?.id_hash).toBe(session.id_hash);
  expect(sessionFromRequest(withCookie(token + "x"))).toBeNull();
  expect(sessionFromRequest(withCookie("short"))).toBeNull();
  expect(sessionFromRequest(new Request("http://x"))).toBeNull();
});

test("sessionCookie carries the token and the Secure flag only when asked", () => {
  expect(sessionCookie("tok", true)).toContain(`${SESSION_COOKIE}=tok;`);
  expect(sessionCookie("tok", true)).toContain("; Secure");
  expect(sessionCookie("tok", false)).not.toContain("Secure");
});

test("sessionCookie without persistence is a browser-session cookie", () => {
  expect(sessionCookie("tok", true)).toContain(`Max-Age=${ABSOLUTE_DAYS * 86_400}`);
  expect(sessionCookie("tok", true, false)).not.toContain("Max-Age");
  expect(sessionCookie("tok", true, false)).not.toContain("Expires");
});

test("idle and absolute expiry", () => {
  const t0 = Date.now();
  _setNow(t0);
  const { token } = createSession(new Request("http://x"), null);

  // idle: just under the limit is fine and refreshes last_seen_at; past it is rejected
  _setNow(t0 + (IDLE_DAYS - 1) * DAY);
  expect(sessionFromRequest(withCookie(token))).not.toBeNull();
  _setNow(t0 + (IDLE_DAYS - 1) * DAY + (IDLE_DAYS - 1) * DAY);
  expect(sessionFromRequest(withCookie(token))).not.toBeNull();

  // an untouched session dies after IDLE_DAYS
  _setNow(t0);
  const idle = createSession(new Request("http://x"), null).token;
  _setNow(t0 + IDLE_DAYS * DAY + 1);
  expect(sessionFromRequest(withCookie(idle))).toBeNull();

  // absolute: keep touching it, it still dies after ABSOLUTE_DAYS
  _setNow(t0);
  const abs = createSession(new Request("http://x"), null).token;
  for (let d = 20; d < ABSOLUTE_DAYS; d += 20) {
    _setNow(t0 + d * DAY);
    expect(sessionFromRequest(withCookie(abs))).not.toBeNull();
  }
  _setNow(t0 + ABSOLUTE_DAYS * DAY + 1000);
  expect(sessionFromRequest(withCookie(abs))).toBeNull();
  expect(listSessions().length).toBe(0);
});

test("revokeSession removes by id_hash", () => {
  const { session, token } = createSession(new Request("http://x"), null);
  revokeSession(session.id_hash);
  expect(sessionFromRequest(withCookie(token))).toBeNull();
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
});

test("legacy entries with plain id are ignored and the server still starts", () => {
  const now = Date.now();
  writeFileSync(file, JSON.stringify([{ id: "abc", created_at: now, last_seen_at: now, user_agent: "", address: null }]));
  _reload();
  expect(sessionFromRequest(withCookie("abc"))).toBeNull();
  expect(listSessions()).toEqual([]);
  const { token } = createSession(new Request("http://x"), null);
  expect(sessionFromRequest(withCookie(token))).not.toBeNull();
  const saved = JSON.parse(readFileSync(file, "utf8"));
  expect(saved).toHaveLength(1);
  expect(saved[0].id).toBeUndefined();
});

test("sessionAlive: live, revoked and idle-expired sessions", () => {
  const t0 = Date.UTC(2026, 0, 1);
  _setNow(t0);
  const live = createSession(new Request("http://x"), null).session;
  const revoked = createSession(new Request("http://x"), null).session;
  expect(sessionAlive(live.id_hash)).toBe(true);
  expect(sessionAlive(revoked.id_hash)).toBe(true);
  revokeSession(revoked.id_hash);
  expect(sessionAlive(revoked.id_hash)).toBe(false);
  expect(sessionAlive("0".repeat(64))).toBe(false);
  _setNow(t0 + IDLE_DAYS * DAY - 1);
  expect(sessionAlive(live.id_hash)).toBe(true);
  _setNow(t0 + IDLE_DAYS * DAY + 1);
  expect(sessionAlive(live.id_hash)).toBe(false);
});
