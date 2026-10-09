/**
 * Push subscriptions (one per browser that turned notifications on) and this server's VAPID keys.
 *
 * A subscription belongs to the sign-in that created it: signing out, expiry or a revocation drops
 * it, so a lost phone stops getting pushes with its session. Its endpoint must be a known push
 * service: the server POSTs to it, and an arbitrary URL would let a signed-in browser aim the
 * server at internal addresses.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, STATE_DIR } from "../config.ts";
import { fromB64url, generateVapidKeys, type PushSubscriptionKeys, type VapidKeys } from "./webpush.ts";

export interface StoredSubscription {
  endpoint: string;
  keys: PushSubscriptionKeys;
  /** the SHA-256 of the session token that subscribed (as in sessions.json) */
  session: string;
  created_at: number;
}

/** the browsers' push services: Chrome/Edge/Opera/Samsung (FCM), Firefox, Safari, Windows */
const PUSH_HOSTS = ["fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"];
const MAX_SUBSCRIPTIONS = 50;

export function pushEndpointAllowed(endpoint: string): boolean {
  if (endpoint.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return false;
  return PUSH_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

/** a browser's PushSubscription JSON, checked: known push service, a P-256 key, a 16-byte secret */
export function parseSubscription(body: unknown): { endpoint: string; keys: PushSubscriptionKeys } | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof b.endpoint !== "string" || !pushEndpointAllowed(b.endpoint)) return null;
  const { p256dh, auth } = b.keys ?? {};
  if (typeof p256dh !== "string" || typeof auth !== "string") return null;
  const key = fromB64url(p256dh);
  if (key.length !== 65 || key[0] !== 4 || fromB64url(auth).length !== 16) return null;
  return { endpoint: b.endpoint, keys: { p256dh, auth } };
}

const file = () => join(STATE_DIR, "push.json");
let subscriptions: StoredSubscription[] = load();

function load(): StoredSubscription[] {
  try {
    const parsed = JSON.parse(readFileSync(file(), "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((s): s is StoredSubscription => typeof s?.endpoint === "string" && typeof s?.session === "string") : [];
  } catch {
    return [];
  }
}

function save(): void {
  writeFileSync(file(), JSON.stringify(subscriptions, null, 2), { mode: 0o600 });
  chmodSync(file(), 0o600);
}

export function _reload(): void {
  subscriptions = load();
}

/** a browser subscribes again with the same endpoint after a refresh: it replaces its old entry */
export function addSubscription(sub: { endpoint: string; keys: PushSubscriptionKeys }, session: string, now = Date.now()): void {
  subscriptions = subscriptions.filter((s) => s.endpoint !== sub.endpoint);
  subscriptions.push({ ...sub, session, created_at: now });
  subscriptions = subscriptions.slice(-MAX_SUBSCRIPTIONS);
  save();
}

export function removeSubscription(endpoint: string): void {
  const before = subscriptions.length;
  subscriptions = subscriptions.filter((s) => s.endpoint !== endpoint);
  if (subscriptions.length !== before) save();
}

/** the subscriptions whose sign-in still lives; the others are dropped for good */
export function liveSubscriptions(sessionAlive: (session: string) => boolean): StoredSubscription[] {
  const live = subscriptions.filter((s) => sessionAlive(s.session));
  if (live.length !== subscriptions.length) {
    subscriptions = live;
    save();
  }
  return live;
}

export function hasSubscription(endpoint: string): boolean {
  return subscriptions.some((s) => s.endpoint === endpoint);
}

/** this server's VAPID keys, made on first use; they live with the config (they are its identity) */
let vapid: Promise<VapidKeys> | null = null;
export function vapidKeys(): Promise<VapidKeys> {
  vapid ??= (async () => {
    const path = join(CONFIG_DIR, "vapid.json");
    if (existsSync(path)) {
      try {
        const keys = JSON.parse(readFileSync(path, "utf8")) as VapidKeys;
        if (typeof keys.publicKey === "string" && typeof keys.privateJwk === "object") return keys;
      } catch {
        /* unreadable: make new ones (browsers subscribed to the old key subscribe again) */
      }
    }
    const keys = await generateVapidKeys();
    writeFileSync(path, JSON.stringify(keys, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
    return keys;
  })();
  return vapid;
}
