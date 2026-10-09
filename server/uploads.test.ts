import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_UPLOAD, cleanupUploads, saveUpload, sniffImage, uploadPath } from "./uploads.ts";

const dir = join(mkdtempSync(join(tmpdir(), "hw-up-")), "herdr-web-uploads");
afterAll(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1]);

test("images are recognised by their bytes", () => {
  expect(sniffImage(png)).toBe("png");
  expect(sniffImage(jpg)).toBe("jpg");
  expect(sniffImage(webp)).toBe("webp");
  expect(sniffImage(new TextEncoder().encode("GIF89a..."))).toBe("gif");
  expect(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
  expect(sniffImage(new TextEncoder().encode("#!/bin/sh\nrm -rf /"))).toBeNull();
});

test("saved under a random name, private to the user, and served back only by that name", () => {
  const saved = saveUpload(png, dir);
  if (!saved.ok) throw new Error(saved.error);
  expect(saved.name).toMatch(/^[0-9a-f-]{36}\.png$/);
  expect(saved.type).toBe("image/png");
  expect(statSync(saved.path).mode & 0o777).toBe(0o600);
  expect(uploadPath(saved.name, dir)).toEqual({ path: saved.path, type: "image/png" });
  expect(uploadPath("../../etc/passwd", dir)).toBeNull();
  expect(uploadPath("x.png", dir)).toBeNull();
});

test("refused: not an image, empty, too large", () => {
  expect(saveUpload(new TextEncoder().encode("hola"), dir)).toEqual({ ok: false, error: "not_an_image" });
  expect(saveUpload(new Uint8Array(), dir)).toEqual({ ok: false, error: "empty" });
  const big = new Uint8Array(MAX_UPLOAD + 1);
  big.set(png);
  expect(saveUpload(big, dir)).toEqual({ ok: false, error: "too_large" });
});

test("old uploads are cleaned", () => {
  const old = saveUpload(jpg, dir);
  const fresh = saveUpload(webp, dir);
  if (!old.ok || !fresh.ok) throw new Error("save");
  utimesSync(old.path, new Date(1000), new Date(1000));
  expect(cleanupUploads(Date.now(), 24 * 3600 * 1000, dir)).toBe(1);
  expect(uploadPath(old.name, dir)).toBeNull();
  expect(uploadPath(fresh.name, dir)).not.toBeNull();
});
