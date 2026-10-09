/**
 * Web Push without dependencies: VAPID (RFC 8292) to identify this server to the push service,
 * and aes128gcm payload encryption (RFC 8291) so the push service only relays ciphertext. All of
 * it on WebCrypto: ECDSA and ECDH on P-256, HKDF-SHA-256, AES-128-GCM.
 */

export interface PushSubscriptionKeys {
  /** the browser's P-256 public key, uncompressed (65 bytes), base64url */
  p256dh: string;
  /** the browser's 16-byte auth secret, base64url */
  auth: string;
}

export interface VapidKeys {
  /** uncompressed P-256 public key, base64url: the browser's `applicationServerKey` */
  publicKey: string;
  privateJwk: JsonWebKey;
}

const enc = new TextEncoder();

/** bytes WebCrypto accepts: backed by a plain ArrayBuffer */
type Bytes = Uint8Array<ArrayBuffer>;

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromB64url(text: string): Bytes {
  return new Uint8Array(Buffer.from(text, "base64url"));
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { publicKey: b64url(publicKey), privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey) };
}

/** `Authorization` for one push service: a JWT (ES256) for its origin, valid 12 h, plus our key */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto signs ECDSA as r‖s (64 bytes): exactly the JOSE form a JWT wants
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

/**
 * RFC 8291: encrypt `payload` for one browser. A fresh ECDH key pair and salt per message; the
 * body is the aes128gcm header (salt, record size, our public key) followed by a single record.
 * `test` pins the random parts, only to check against RFC 8291's worked example.
 */
export async function encryptPayload(payload: Uint8Array, keys: PushSubscriptionKeys, test?: { salt: Bytes; serverKey: CryptoKeyPair }): Promise<Bytes> {
  const uaPublic = fromB64url(keys.p256dh);
  const authSecret = fromB64url(keys.auth);
  const salt: Bytes = test?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const server = test?.serverKey ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", server.publicKey));

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, server.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  // one record, so it is the last: the payload, then the 0x02 delimiter
  const plaintext = concat(payload, new Uint8Array([2]));
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, plaintext));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

export interface PushTarget {
  endpoint: string;
  keys: PushSubscriptionKeys;
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Sends one push. Returns the push service's status: 201 delivered, 404/410 the subscription is
 * gone for good (drop it), anything else a passing failure.
 */
export async function sendPush(target: PushTarget, payload: object, keys: VapidKeys, subject: string, opts: { ttl?: number; urgency?: "normal" | "high"; fetch?: Fetch } = {}): Promise<number> {
  const body = await encryptPayload(enc.encode(JSON.stringify(payload)), target.keys);
  const res = await (opts.fetch ?? fetch)(target.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(target.endpoint, keys, subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(opts.ttl ?? 3600),
      Urgency: opts.urgency ?? "normal",
    },
    body,
  });
  await res.body?.cancel().catch(() => {});
  return res.status;
}
