/** Key-level `.env` editing: change some keys, leave comments and unrelated keys untouched. */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "../../server/config.ts";

export function readEnv(path: string): Record<string, string> {
  return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
}

/** Set (string) or delete (`null`) keys, one `KEY=value` per line. The file stays mode 0600. */
export function writeEnv(path: string, patch: Record<string, string | null>): void {
  const pending = new Map(Object.entries(patch));
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  if (lines.at(-1) === "") lines.pop();
  const out: string[] = [];
  for (const line of lines) {
    const eq = line.indexOf("=");
    const key = line.trim().startsWith("#") || eq <= 0 ? undefined : line.slice(0, eq).trim();
    if (key === undefined || !Object.hasOwn(patch, key)) {
      out.push(line);
      continue;
    }
    // first occurrence is replaced in place; later duplicates are dropped so the value cannot resurface
    if (!pending.has(key)) continue;
    const value = pending.get(key)!;
    pending.delete(key);
    if (value !== null) out.push(`${key}=${value}`);
  }
  for (const [key, value] of pending) if (value !== null) out.push(`${key}=${value}`);
  writeFileSync(path, out.length ? out.join("\n") + "\n" : "", { mode: 0o600 });
  chmodSync(path, 0o600);
}
