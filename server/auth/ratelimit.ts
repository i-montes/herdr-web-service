/**
 * Login rate limiting (H6). Pure module: no config, no I/O.
 *
 * - Failures are counted per bucket: an IPv4 address as is, an IPv6 address by its /64 (a single
 *   host usually owns a whole /64, so per-address counting would be meaningless).
 * - Per bucket: FREE_FAILURES free failures, then 1 s, 2 s, 4 s ... capped at BACKOFF_MAX_MS.
 * - Globally: once GLOBAL_FAILURES failures (from anywhere) fall inside GLOBAL_WINDOW_MS, every
 *   address that is not "admitted" waits until the oldest of them leaves the window. An address
 *   is admitted for ADMITTED_MS after it presented the correct password. An unknown address
 *   (null) is never admitted, so it is held by the global window but has no per-address budget.
 */
export const FREE_FAILURES = 5;
export const BACKOFF_MS = 1_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
export const GLOBAL_FAILURES = 50;
export const GLOBAL_WINDOW_MS = 10 * 60_000;
export const ADMITTED_MS = 30 * 24 * 3_600_000;
const MAX_ENTRIES = 4096;

let now = 0;
let clockSet = false;
const clock = (): number => (clockSet ? now : Date.now());

const failures = new Map<string, { count: number; until: number }>();
const admitted = new Map<string, number>(); // bucket -> admitted until
/** Opaque handle to one recorded failure, so a reserved attempt can be taken back. */
export type FailureToken = { readonly at: number };
let recent: FailureToken[] = []; // the latest failures, at most GLOBAL_FAILURES

/** Parse an IPv6 literal into 8 hextets, or null when it is not one. */
function parseV6(input: string): number[] | null {
  let s = input.split("%")[0]!.toLowerCase();
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    s = s.slice(0, v4.index) + ((o[0]! << 8) | o[1]!).toString(16) + ":" + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (p: string) => (p === "" ? [] : p.split(":"));
  const head = part(halves[0]!);
  const tail = halves.length === 2 ? part(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

export function bucketFor(address: string | null): string | null {
  if (!address) return null;
  if (!address.includes(":")) return address;
  const h = parseV6(address);
  if (!h) return address;
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    return `${h[6]! >> 8}.${h[6]! & 255}.${h[7]! >> 8}.${h[7]! & 255}`;
  }
  return `${h.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

function pruneRecent(t: number): void {
  recent = recent.filter((f) => f.at > t - GLOBAL_WINDOW_MS);
}

function cap<V>(map: Map<string, V>): void {
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value!);
}

/** seconds the address must still wait before another attempt is compared, or 0 */
export function loginWait(address: string | null): number {
  const t = clock();
  const bucket = bucketFor(address);
  let wait = bucket ? Math.max(0, (failures.get(bucket)?.until ?? 0) - t) : 0;
  pruneRecent(t);
  const isAdmitted = bucket !== null && (admitted.get(bucket) ?? 0) > t;
  if (!isAdmitted && recent.length >= GLOBAL_FAILURES) {
    wait = Math.max(wait, recent[0]!.at + GLOBAL_WINDOW_MS - t);
  }
  return wait <= 0 ? 0 : Math.ceil(wait / 1000);
}

/**
 * Record a failure and return a token for it. Callers reserve the failure before the (async)
 * password check, so parallel guesses are throttled; a correct password releases it.
 */
export function recordLoginFailure(address: string | null): FailureToken {
  const t = clock();
  pruneRecent(t);
  const token: FailureToken = { at: t };
  recent.push(token);
  if (recent.length > GLOBAL_FAILURES) recent.shift();
  const bucket = bucketFor(address);
  if (!bucket) return token;
  const count = (failures.get(bucket)?.count ?? 0) + 1;
  const wait = count <= FREE_FAILURES ? 0 : Math.min(BACKOFF_MS * 2 ** (count - FREE_FAILURES - 1), BACKOFF_MAX_MS);
  failures.delete(bucket); // re-insert so eviction drops the least recently failed bucket
  failures.set(bucket, { count, until: wait ? t + wait : 0 });
  cap(failures);
  return token;
}

/** Take a reserved failure back out of the global window (the password was correct). */
export function releaseFailure(token: FailureToken): void {
  recent = recent.filter((f) => f !== token);
}

export function recordLoginSuccess(address: string | null): void {
  const bucket = bucketFor(address);
  if (!bucket) return;
  failures.delete(bucket);
  admitted.delete(bucket);
  admitted.set(bucket, clock() + ADMITTED_MS);
  cap(admitted);
}

export function _reset(): void {
  failures.clear();
  admitted.clear();
  recent = [];
  clockSet = false;
}

export function _setNow(ms: number): void {
  now = ms;
  clockSet = true;
}
