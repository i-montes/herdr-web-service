/**
 * Browser sessions: a random token in an HttpOnly cookie. <state dir>/sessions.json stores only
 * the SHA-256 of the token, so reading that file (other agents run as the same OS user) does not
 * let anyone log in. A session dies after IDLE_DAYS without use or ABSOLUTE_DAYS after creation.
 * Login rate limiting lives in ratelimit.ts.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";
import { parseCookies } from "../http.ts";

export const SESSION_COOKIE = "hwv_session";
export const IDLE_DAYS = 30;
export const ABSOLUTE_DAYS = 180;
const MAX_SESSIONS = 50;
const DAY_MS = 86_400_000;

export interface Session {
  /** hex SHA-256 of the cookie token; the token itself is never stored */
  id_hash: string;
  created_at: number;
  last_seen_at: number;
  user_agent: string;
  address: string | null;
}

let sessions: Session[] = load();
let nowOverride: number | null = null;

const now = (): number => nowOverride ?? Date.now();

/** test hook: freeze the clock at `ms` (null restores the real clock) */
export function _setNow(ms: number | null): void {
  nowOverride = ms;
}

/** test hook: re-read sessions.json */
export function _reload(): void {
  sessions = load();
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function load(): Session[] {
  if (!existsSync(config.sessionsFile)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(config.sessionsFile, "utf8"));
    if (!Array.isArray(parsed)) return [];
    // entries from before hashing (plain `id`, no `id_hash`) are dropped: those users sign in again
    return parsed.filter((s): s is Session => typeof s === "object" && s !== null && typeof (s as Session).id_hash === "string");
  } catch {
    return [];
  }
}

function save(): void {
  writeFileSync(config.sessionsFile, JSON.stringify(sessions, null, 2) + "\n", { mode: 0o600 });
  chmodSync(config.sessionsFile, 0o600); // `mode` only applies when the file is created
}

function expired(session: Session): boolean {
  const t = now();
  return t - session.last_seen_at > IDLE_DAYS * DAY_MS || t - session.created_at > ABSOLUTE_DAYS * DAY_MS;
}

/** `token` is the cookie value; only its hash is kept */
export function createSession(request: Request, address: string | null): { session: Session; token: string } {
  const token = randomBytes(32).toString("base64url");
  const session: Session = {
    id_hash: hashToken(token),
    created_at: now(),
    last_seen_at: now(),
    user_agent: request.headers.get("user-agent") ?? "",
    address,
  };
  sessions = sessions.filter((s) => !expired(s)).slice(-(MAX_SESSIONS - 1));
  sessions.push(session);
  save();
  return { session, token };
}

export function sessionFromRequest(request: Request): Session | null {
  const token = parseCookies(request.headers.get("cookie")).get(SESSION_COOKIE);
  if (!token) return null;
  const wanted = Buffer.from(hashToken(token), "hex");
  const found = sessions.find((s) => {
    const have = Buffer.from(s.id_hash, "hex");
    return have.length === wanted.length && timingSafeEqual(have, wanted);
  });
  if (!found || expired(found)) return null;
  // touch at most once a minute; the file is not worth a write per request
  if (now() - found.last_seen_at > 60_000) {
    found.last_seen_at = now();
    save();
  }
  return found;
}

export function revokeSession(idHash: string): void {
  sessions = sessions.filter((s) => s.id_hash !== idHash);
  save();
}

/** true while `idHash` names a stored session that has not expired (used to close stale sockets) */
export function sessionAlive(idHash: string): boolean {
  const found = sessions.find((s) => s.id_hash === idHash);
  return found !== undefined && !expired(found);
}

export function listSessions(): Session[] {
  return sessions.filter((s) => !expired(s));
}

/** `persistent: false` leaves out Max-Age, so the browser drops the cookie when it closes */
export function sessionCookie(token: string, secure: boolean, persistent = true): string {
  const maxAge = persistent ? `; Max-Age=${ABSOLUTE_DAYS * 86_400}` : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${maxAge}${secure ? "; Secure" : ""}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
