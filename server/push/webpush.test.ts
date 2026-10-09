import { expect, test } from "bun:test";
import { b64url, encryptPayload, fromB64url, generateVapidKeys, sendPush, vapidAuthorization } from "./webpush.ts";

const enc = new TextEncoder();

/** a P-256 key pair from raw private (d) and uncompressed public bytes, base64url */
async function ecdhPair(d: string, pub: string): Promise<CryptoKeyPair> {
  const raw = fromB64url(pub);
  const jwk = { kty: "EC", crv: "P-256", d, x: b64url(raw.slice(1, 33)), y: b64url(raw.slice(33, 65)), ext: true };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = await crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, true, []);
  return { privateKey, publicKey };
}

test("RFC 8291 appendix A: the worked example encrypts to the published body, byte for byte", async () => {
  const serverKey = await ecdhPair("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
  const body = await encryptPayload(enc.encode("When I grow up, I want to be a watermelon"), { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" }, { salt: fromB64url("DGv6ra1nlYgDCS1FRnbzlw"), serverKey });
  expect(b64url(body)).toBe(
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  );
});

/** the browser's side of RFC 8291, to read back what we sent */
type Bytes = Uint8Array<ArrayBuffer>;

async function decrypt(body: Bytes, ua: CryptoKeyPair, auth: Bytes): Promise<string> {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256));
  const hk = async (s: Bytes, ikm: Bytes, info: Bytes, n: number) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
  const ikm = await hk(auth, secret, new Uint8Array([...enc.encode("WebPush: info\0"), ...uaPublic, ...asPublic]), 32);
  const cek = await hk(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hk(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), body.slice(21 + idlen)));
  expect(plain[plain.length - 1]).toBe(2);
  return new TextDecoder().decode(plain.slice(0, -1));
}

test("a payload sent to a browser decrypts with its keys; each message uses fresh keys", async () => {
  const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const keys = { p256dh: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey))), auth: b64url(auth) };
  const a = await encryptPayload(enc.encode('{"title":"fix-discount needs you"}'), keys);
  const b = await encryptPayload(enc.encode('{"title":"fix-discount needs you"}'), keys);
  expect(await decrypt(a, ua, auth)).toBe('{"title":"fix-discount needs you"}');
  expect(b64url(a)).not.toBe(b64url(b));
});

test("VAPID: a JWT for the push service's origin, signed with our key and verifiable with the public one", async () => {
  const keys = await generateVapidKeys();
  const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, "mailto:me@example.com", 1_000_000_000_000);
  const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
  expect(k).toBe(keys.publicKey);
  const [h, c, s] = token!.split(".");
  expect(JSON.parse(new TextDecoder().decode(fromB64url(c!)))).toEqual({ aud: "https://fcm.googleapis.com", exp: 1_000_000_000 + 12 * 3600, sub: "mailto:me@example.com" });
  const pub = await crypto.subtle.importKey("raw", fromB64url(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, fromB64url(s!), enc.encode(`${h}.${c}`))).toBe(true);
});

test("sendPush posts the encrypted body with the push headers and reports the status", async () => {
  const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const target = { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/x", keys: { p256dh: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey))), auth: b64url(new Uint8Array(16)) } };
  let seen: RequestInit | null = null;
  const status = await sendPush(target, { title: "hi" }, await generateVapidKeys(), "mailto:me@example.com", { urgency: "high", fetch: async (_url, init) => ((seen = init), new Response(null, { status: 201 })) });
  expect(status).toBe(201);
  expect(seen!.headers).toMatchObject({ "Content-Encoding": "aes128gcm", TTL: "3600", Urgency: "high" });
});
