/**
 * Where the plugin keeps things and how it is configured.
 *
 * Herdr hands a plugin two directories: HERDR_PLUGIN_CONFIG_DIR for user-editable settings and
 * HERDR_PLUGIN_STATE_DIR for runtime state. Both survive reinstalls; the plugin root does not.
 * Outside Herdr (plain `bun server/index.ts` during development) sensible fallbacks apply.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccessMode } from "./access.ts";

export const PLUGIN_ID = "imontes.herdr-web-service";
export const DEFAULT_PORT = 7340;

const env = process.env;
const home = homedir();

export const CONFIG_DIR = env["HERDR_PLUGIN_CONFIG_DIR"] || join(env["XDG_CONFIG_HOME"] || join(home, ".config"), "herdr", "plugins", "config", PLUGIN_ID);
export const STATE_DIR = env["HERDR_PLUGIN_STATE_DIR"] || join(env["XDG_STATE_HOME"] || join(home, ".local", "state"), "herdr", "plugins", PLUGIN_ID);

for (const dir of [CONFIG_DIR, STATE_DIR]) mkdirSync(dir, { recursive: true, mode: 0o700 });

/** Parse `KEY=value` lines (comments and blanks skipped, matching quotes stripped). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/** `KEY=value` lines from <config dir>/.env; the process environment wins. */
export function loadDotEnv(path = join(CONFIG_DIR, ".env")): void {
  if (!existsSync(path)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
    if (env[key] === undefined) env[key] = value;
  }
}

loadDotEnv();

export const config = {
  /** loopback by default; a reverse proxy (Caddy) sits in front on a VPS */
  host: env["HOST"] || "127.0.0.1",
  port: Number(env["PORT"]) || DEFAULT_PORT,
  /** the address users open; set by setup, used for cookies, QR codes and push */
  publicUrl: env["PUBLIC_URL"] || "",
  /** local | lan | remote: decides which Host/Origin and login transports are accepted */
  accessMode: (env["ACCESS_MODE"] as AccessMode) || "local",
  /** tunnel provider in remote mode (set by setup) */
  tunnel: env["TUNNEL"] || "",
  /** extra allowed Origin while developing (set by `bun run dev` for the Vite server) */
  devOrigin: env["DEV_ORIGIN"] || "",
  herdrSocket: env["HERDR_SOCKET_PATH"] || join(env["XDG_CONFIG_HOME"] || join(home, ".config"), "herdr", "herdr.sock"),
  herdrBin: env["HERDR_BIN_PATH"] || "herdr",
  authFile: join(CONFIG_DIR, "auth.json"),
  sessionsFile: join(STATE_DIR, "sessions.json"),
  pidFile: join(STATE_DIR, "server.pid"),
  logFile: join(STATE_DIR, "server.log"),
  distDir: join(import.meta.dir, "..", "dist"),
};
