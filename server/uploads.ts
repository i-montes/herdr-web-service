/**
 * Images pasted or picked in the chat, kept in the system's temp folder so its own cleaning
 * removes them (and this server drops any older than a week). The agent reads them by path.
 *
 * Only PNG, JPEG, GIF and WebP are accepted, recognised by their first bytes (never by the name
 * or the declared type), up to MAX_UPLOAD bytes, stored under a random name readable only by the
 * user. Names are the only handle the web gets back, and only well-formed ones are served.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_UPLOAD = 10 * 1024 * 1024;
export const UPLOAD_MAX_AGE = 7 * 24 * 3600 * 1000;

const TYPES = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as const;
type Ext = keyof typeof TYPES;
const NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;

export function uploadDir(base = tmpdir()): string {
  return join(base, "herdr-web-uploads");
}

/** the image format from its magic bytes, or null */
export function sniffImage(bytes: Uint8Array): Ext | null {
  const at = (i: number, ...values: number[]) => values.every((v, k) => bytes[i + k] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  return null;
}

export type Saved = { ok: true; name: string; path: string; type: string; size: number } | { ok: false; error: "too_large" | "not_an_image" | "empty" };

export function saveUpload(bytes: Uint8Array, dir = uploadDir()): Saved {
  if (bytes.length === 0) return { ok: false, error: "empty" };
  if (bytes.length > MAX_UPLOAD) return { ok: false, error: "too_large" };
  const ext = sniffImage(bytes);
  if (!ext) return { ok: false, error: "not_an_image" };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${randomUUID()}.${ext}`;
  const path = join(dir, name);
  writeFileSync(path, bytes, { mode: 0o600 });
  return { ok: true, name, path, type: TYPES[ext], size: bytes.length };
}

/** the stored file for a name the server handed out; null for anything else */
export function uploadPath(name: string, dir = uploadDir()): { path: string; type: string } | null {
  const m = NAME.exec(name);
  if (!m) return null;
  const path = join(dir, name);
  try {
    return statSync(path).isFile() ? { path, type: TYPES[m[1] as Ext] } : null;
  } catch {
    return null;
  }
}

/** drops uploads older than `maxAge`; returns how many */
export function cleanupUploads(now = Date.now(), maxAge = UPLOAD_MAX_AGE, dir = uploadDir()): number {
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!NAME.test(name)) continue;
      const path = join(dir, name);
      if (now - statSync(path).mtimeMs > maxAge) {
        rmSync(path, { force: true });
        removed++;
      }
    }
  } catch {
    /* no folder yet */
  }
  return removed;
}
