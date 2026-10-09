import { beforeEach, expect, test } from "bun:test";
import {
  ADMITTED_MS, BACKOFF_MAX_MS, GLOBAL_FAILURES, GLOBAL_WINDOW_MS,
  _reset, _setNow, bucketFor, loginWait, recordLoginFailure, recordLoginSuccess,
} from "./ratelimit.ts";

let now = 1_000_000;
const set = (ms: number) => { now = ms; _setNow(ms); };
const adv = (ms: number) => set(now + ms);
beforeEach(() => { _reset(); set(1_000_000); });

test("ipv6 addresses share a /64 bucket", () => {
  expect(bucketFor("2001:db8:1:2:aaaa::1")).toBe(bucketFor("2001:db8:1:2:bbbb::9"));
  expect(bucketFor("2001:db8:1:2::1")).not.toBe(bucketFor("2001:db8:1:3::1"));
  expect(bucketFor("1.2.3.4")).toBe("1.2.3.4");
  expect(bucketFor(null)).toBeNull();
});

test("ipv6 forms normalize to the same bucket", () => {
  const expected = "2001:db8:0:1::/64";
  expect(bucketFor("2001:db8:0:1:0:0:0:5")).toBe(expected);
  expect(bucketFor("2001:0DB8:0000:0001:0000:0000:0000:0001")).toBe(expected);
  expect(bucketFor("2001:db8:0:1::5")).toBe(expected);
  expect(bucketFor("2001:db8:0:1::5%eth0")).toBe(expected);
});

test("ipv4-mapped ipv6 is treated as ipv4", () => {
  expect(bucketFor("::ffff:1.2.3.4")).toBe("1.2.3.4");
  expect(bucketFor("::ffff:0102:0304")).toBe("1.2.3.4");
  expect(bucketFor("::1")).toBe("0:0:0:0::/64");
});

test("five free failures, then exponential wait", () => {
  const a = "1.2.3.4";
  for (let i = 0; i < 5; i++) recordLoginFailure(a);
  expect(loginWait(a)).toBe(0);
  recordLoginFailure(a);
  expect(loginWait(a)).toBe(1);
  adv(1000);
  expect(loginWait(a)).toBe(0);
  recordLoginFailure(a);
  expect(loginWait(a)).toBe(2);
  for (let i = 0; i < 30; i++) recordLoginFailure(a);
  expect(loginWait(a)).toBe(BACKOFF_MAX_MS / 1000);
});

test("failures across a /64 share one budget; other buckets are unaffected", () => {
  for (let i = 0; i < 6; i++) recordLoginFailure(`2001:db8:1:2::${i + 1}`);
  expect(loginWait("2001:db8:1:2:ffff::1")).toBe(1);
  expect(loginWait("2001:db8:1:3::1")).toBe(0);
});

test("success clears the per-address budget", () => {
  const a = "1.2.3.4";
  for (let i = 0; i < 7; i++) recordLoginFailure(a);
  adv(10_000);
  recordLoginSuccess(a);
  expect(loginWait(a)).toBe(0);
  recordLoginFailure(a);
  expect(loginWait(a)).toBe(0);
});

test("global window holds strangers but not admitted addresses", () => {
  recordLoginSuccess("9.9.9.9");
  for (let i = 0; i < GLOBAL_FAILURES; i++) {
    recordLoginFailure(`10.0.${i >> 8}.${i & 255}`);
    adv(1000);
  }
  const oldestLeaves = 1_000_000 + GLOBAL_WINDOW_MS;
  expect(loginWait("10.9.9.9")).toBe(Math.ceil((oldestLeaves - now) / 1000));
  expect(loginWait(null)).toBeGreaterThan(0);
  expect(loginWait("2001:db8:5:5::1")).toBeGreaterThan(0);
  expect(loginWait("9.9.9.9")).toBe(0);
  set(oldestLeaves + 1); // oldest failure leaves the window: 49 remain
  expect(loginWait("10.9.9.9")).toBe(0);
});

test("admission expires after 30 days", () => {
  recordLoginSuccess("9.9.9.9");
  for (let i = 0; i < GLOBAL_FAILURES; i++) recordLoginFailure(`10.0.0.${i}`);
  expect(loginWait("9.9.9.9")).toBe(0);
  adv(ADMITTED_MS + 1);
  for (let i = 0; i < GLOBAL_FAILURES; i++) recordLoginFailure(`10.0.1.${i}`);
  expect(loginWait("9.9.9.9")).toBeGreaterThan(0);
});

test("maps stay bounded", () => {
  for (let i = 0; i < 6000; i++) recordLoginSuccess(`10.${i >> 8 & 255}.${i & 255}.1`);
  for (let i = 0; i < 6000; i++) recordLoginFailure(`11.${i >> 8 & 255}.${i & 255}.1`);
  adv(GLOBAL_WINDOW_MS + 1); // only the per-bucket map is under test
  for (let i = 0; i < 4; i++) recordLoginFailure("11.0.0.1");
  expect(loginWait("11.0.0.1")).toBe(0);
});
