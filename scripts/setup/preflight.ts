/** Checks run before the setup wizard: tool versions, the web build and the Herdr socket. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../server/config.ts";
import { HerdrClient } from "../../server/herdr/client.ts";

const ROOT = join(import.meta.dir, "..", "..");

/** First `x.y.z` found in `text`, as numbers; null when there is none. */
function parseVersion(text: string): number[] | null {
  const match = /(\d+(?:\.\d+)*)/.exec(text);
  return match ? match[1]!.split(".").map(Number) : null;
}

/** `have >= want`, comparing dotted numbers; tolerates a prefix such as "herdr 0.9.3". */
export function versionAtLeast(have: string, want: string): boolean {
  const a = parseVersion(have);
  const b = parseVersion(want);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export type PreflightResult = { ok: true } | { ok: false; problems: string[] };

export async function preflight(): Promise<PreflightResult> {
  const problems: string[] = [];

  const herdrBin = process.env["HERDR_BIN_PATH"] || "herdr";
  const version = spawnSync(herdrBin, ["--version"], { encoding: "utf8" });
  if (version.error || version.status !== 0) {
    problems.push(`No se encontró el binario de Herdr (${herdrBin}): instala Herdr o define HERDR_BIN_PATH`);
  } else if (!versionAtLeast(version.stdout, "0.9.0")) {
    problems.push(`Herdr ${version.stdout.trim()} es demasiado antiguo: se necesita 0.9.0 o superior, actualiza Herdr`);
  }

  if (!versionAtLeast(Bun.version, "1.3.0")) {
    problems.push(`Bun ${Bun.version} es demasiado antiguo: se necesita 1.3.0 o superior, ejecuta \`bun upgrade\``);
  }

  if (!existsSync(join(ROOT, "dist", "index.html"))) {
    problems.push("Falta dist/: ejecuta `bun run build`");
  }

  const client = new HerdrClient(config.herdrSocket);
  try {
    await Promise.race([
      client.request("ping"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
    ]);
  } catch {
    problems.push(`Herdr no responde en ${config.herdrSocket}: abre Herdr (o revisa HERDR_SOCKET_PATH)`);
  }

  return problems.length ? { ok: false, problems } : { ok: true };
}
