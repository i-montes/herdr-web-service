import { beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _reload, addSubscription, liveSubscriptions, parseSubscription, pushEndpointAllowed, removeSubscription, removeSubscriptionsOf, sessionsWithPush, vapidKeys } from "./store.ts";

// tests/preload.ts points the state and config dirs at temp folders
const stateFile = join(process.env["HERDR_PLUGIN_STATE_DIR"]!, "push.json");
const P256 = Buffer.from(new Uint8Array([4, ...new Uint8Array(64).fill(7)])).toString("base64url");
const AUTH = Buffer.from(new Uint8Array(16).fill(1)).toString("base64url");
const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: P256, auth: AUTH } });

beforeEach(() => {
  writeFileSync(stateFile, "[]");
  _reload();
});

test("only the browsers' push services are accepted as endpoints", () => {
  for (const ok of ["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/QK", "https://wns2-par02p.notify.windows.com/w/?token=x"]) expect(pushEndpointAllowed(ok)).toBe(true);
  for (const bad of [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:8443/x",
    "https://127.0.0.1/x",
    "https://localhost/x",
    "https://evil.com/fcm.googleapis.com",
    "https://fcm.googleapis.com.evil.com/x",
    "https://user:pw@fcm.googleapis.com/x",
    "https://notapple-push.apple.com.example/x",
    "not a url",
  ]) expect(pushEndpointAllowed(bad)).toBe(false);
});

test("a subscription needs a 65-byte P-256 key and a 16-byte auth secret", () => {
  expect(parseSubscription(sub("https://fcm.googleapis.com/fcm/send/a"))).toEqual(sub("https://fcm.googleapis.com/fcm/send/a"));
  expect(parseSubscription({ ...sub("https://fcm.googleapis.com/fcm/send/a"), keys: { p256dh: AUTH, auth: AUTH } })).toBeNull();
  expect(parseSubscription({ ...sub("https://fcm.googleapis.com/fcm/send/a"), keys: { p256dh: P256, auth: P256 } })).toBeNull();
  expect(parseSubscription(sub("https://10.0.0.1/push"))).toBeNull();
  expect(parseSubscription(null)).toBeNull();
});

test("subscriptions follow their sign-in: same endpoint replaces, a dead session drops them", () => {
  addSubscription(sub("https://fcm.googleapis.com/a"), "s1");
  addSubscription(sub("https://fcm.googleapis.com/a"), "s2");
  addSubscription(sub("https://web.push.apple.com/b"), "s1");
  expect(liveSubscriptions(() => true).map((s) => [s.endpoint, s.session])).toEqual([["https://fcm.googleapis.com/a", "s2"], ["https://web.push.apple.com/b", "s1"]]);
  expect(liveSubscriptions((s) => s === "s2").map((s) => s.endpoint)).toEqual(["https://fcm.googleapis.com/a"]);
  removeSubscription("https://fcm.googleapis.com/a");
  expect(liveSubscriptions(() => true)).toEqual([]);
  expect(statSync(stateFile).mode & 0o777).toBe(0o600);
});

test("the VAPID keys are made once and kept private in the config dir", async () => {
  const a = await vapidKeys();
  const b = await vapidKeys();
  expect(a.publicKey).toBe(b.publicKey);
  const path = join(process.env["HERDR_PLUGIN_CONFIG_DIR"]!, "vapid.json");
  expect(existsSync(path)).toBe(true);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(path, "utf8")).publicKey).toBe(a.publicKey);
});

test("a sign-in that ends takes its subscriptions; the others stay", () => {
  addSubscription(sub("https://fcm.googleapis.com/a"), "s1");
  addSubscription(sub("https://web.push.apple.com/b"), "s2");
  expect([...sessionsWithPush()].sort()).toEqual(["s1", "s2"]);
  removeSubscriptionsOf("s1");
  expect(liveSubscriptions(() => true).map((s) => s.session)).toEqual(["s2"]);
});
