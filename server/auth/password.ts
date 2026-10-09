/**
 * One operator, one password. The hash lives in <config dir>/auth.json (mode 600) and is set by
 * `bun scripts/plugin.ts setup` or `set-password`; nothing over HTTP can create or change it, so a
 * freshly installed server on a public address is closed until its owner opens it from the host.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "../config.ts";

interface AuthFile {
  password_hash: string;
  updated_at: string;
}

export function passwordConfigured(): boolean {
  return existsSync(config.authFile);
}

function readAuth(): AuthFile | null {
  if (!existsSync(config.authFile)) return null;
  try {
    return JSON.parse(readFileSync(config.authFile, "utf8")) as AuthFile;
  } catch {
    return null;
  }
}

export interface PasswordRule {
  id: "length" | "symbol" | "number" | "upper";
  label: string;
  ok: boolean;
}

export const PASSWORD_MIN_LENGTH = 6;

/** The rules a password must meet, each with whether `plain` meets it (for live indicators). */
export function passwordRules(plain: string): PasswordRule[] {
  return [
    { id: "length", label: `at least ${PASSWORD_MIN_LENGTH} characters`, ok: plain.length >= PASSWORD_MIN_LENGTH },
    { id: "symbol", label: "a symbol (!@#$%…)", ok: /[^\p{L}\p{N}\s]/u.test(plain) },
    { id: "number", label: "a number", ok: /\p{N}/u.test(plain) },
    { id: "upper", label: "an uppercase letter", ok: /\p{Lu}/u.test(plain) },
  ];
}

export function passwordValid(plain: string): boolean {
  return passwordRules(plain).every((rule) => rule.ok);
}

export async function setPassword(plain: string): Promise<void> {
  const failing = passwordRules(plain).filter((rule) => !rule.ok);
  if (failing.length > 0) throw new Error(`the password needs ${failing.map((rule) => rule.label).join(", ")}`);
  const password_hash = await Bun.password.hash(plain, { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 });
  const data: AuthFile = { password_hash, updated_at: new Date().toISOString() };
  writeFileSync(config.authFile, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  chmodSync(config.authFile, 0o600);
}

export async function verifyPassword(plain: string): Promise<boolean> {
  const auth = readAuth();
  if (!auth) return false;
  return Bun.password.verify(plain, auth.password_hash);
}
