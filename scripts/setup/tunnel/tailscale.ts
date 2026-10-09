import { confirm } from "../../tui.ts";
import { defaultRun, type Runner } from "./run.ts";

export function parseStatus(json: string): { state: string; dnsName: string | null } {
  const s = JSON.parse(json) as { BackendState?: string; Self?: { DNSName?: string } };
  const dns = s.Self?.DNSName?.replace(/\.$/, "") ?? "";
  return { state: s.BackendState ?? "Unknown", dnsName: dns || null };
}

export function enableLinkFrom(output: string): string | null {
  return output.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0] ?? null;
}

export function funnelUrl(dnsName: string): string {
  return `https://${dnsName}`;
}

/** The CLI inside the macOS app (Mac App Store or standalone), which does not put `tailscale` on PATH. */
export const APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/** The first Tailscale CLI that answers `version`: `tailscale` on PATH, then the macOS app's. */
export async function tailscaleBin(run: Runner = defaultRun): Promise<string | null> {
  for (const c of ["tailscale", APP_CLI]) {
    if ((await run([c, "version"])).code === 0) return c;
  }
  return null;
}

/** Install Tailscale when missing (Linux) and return the CLI to use from then on. */
export async function ensureInstalled(run: Runner = defaultRun): Promise<string> {
  const have = await tailscaleBin(run);
  if (have) return have;
  if (process.platform === "darwin") {
    console.log("Tailscale no está instalado.");
    console.log("Instala la app de Tailscale (https://tailscale.com/download/mac o la Mac App Store),");
    console.log("inicia sesión en ella y vuelve a ejecutar la configuración.");
    throw new Error("Tailscale no está instalado");
  }
  console.log("Tailscale no está instalado. El script oficial de instalación pedirá sudo.");
  if (!confirm("¿Instalar Tailscale ahora?", true)) throw new Error("Instalación de Tailscale cancelada");
  // pipefail: a failed curl must not look like a successful (empty) sh run
  const r = await run(["bash", "-c", "set -o pipefail; curl -fsSL https://tailscale.com/install.sh | sh"], { inherit: true });
  if (r.code !== 0) throw new Error("Falló la instalación de Tailscale");
  const bin = await tailscaleBin(run);
  if (!bin) throw new Error("Tailscale se instaló pero el comando `tailscale` no responde");
  return bin;
}

async function status(bin: string, run: Runner) {
  const r = await run([bin, "status", "--json"]);
  // `status --json` exits non-zero in some states (e.g. stopped) but still prints JSON
  try {
    return parseStatus(r.stdout);
  } catch {
    throw new Error(`No se pudo leer el estado de Tailscale: ${r.stderr.trim() || r.stdout.trim()}`);
  }
}

export async function ensureLoggedIn(bin: string, run: Runner = defaultRun): Promise<void> {
  if ((await status(bin, run)).state === "Running") return;
  console.log("Tailscale necesita iniciar sesión. Se ejecutará `sudo tailscale login`; abre el link que aparezca.");
  const sudo = process.platform === "darwin" ? [] : ["sudo"];
  // `login`, not `up`: `up` refuses when the host already has non-default settings (hostname,
  // accept-dns...) unless all are repeated; `login` keeps them as they are.
  const r = await run([...sudo, bin, "login"], { inherit: true });
  if (r.code !== 0) throw new Error("`tailscale login` falló");
  if ((await status(bin, run)).state !== "Running") throw new Error("Tailscale no quedó conectado");
}

/** Linux only: lets this user drive Funnel without sudo. The macOS app needs no operator. */
export async function ensureOperator(bin: string, run: Runner = defaultRun, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== "linux") return;
  const user = process.env.USER ?? process.env.LOGNAME;
  if (!user) return;
  // Probe: a read-only funnel command works without sudo once the operator is set.
  if ((await run([bin, "funnel", "status"])).code === 0) return;
  console.log("Se ejecutará `sudo tailscale set --operator` para no pedir sudo en los pasos siguientes.");
  const r = await run(["sudo", bin, "set", `--operator=${user}`], { inherit: true });
  if (r.code !== 0) throw new Error("No se pudo fijar el operador de Tailscale");
}

export async function ensureFunnel(port: number, bin: string, run: Runner = defaultRun): Promise<string> {
  for (;;) {
    const r = await run([bin, "funnel", "--bg", String(port)]);
    if (r.code === 0) break;
    const out = `${r.stdout}\n${r.stderr}`;
    const link = enableLinkFrom(out);
    if (!link) throw new Error(`tailscale funnel falló: ${out.trim()}`);
    console.log("Funnel no está habilitado en tu tailnet. Ábrelo y actívalo:");
    console.log(`  ${link}`);
    if (!confirm("¿Listo? Enter para reintentar", true)) throw new Error("Funnel no habilitado");
  }
  const { dnsName } = await status(bin, run);
  if (!dnsName) throw new Error("Tailscale no reporta un nombre DNS para este equipo");
  return funnelUrl(dnsName);
}

/** Turns our Funnel off; false when tailscale refused or is missing (the caller says so). */
export async function teardownFunnel(port: number, run: Runner = defaultRun): Promise<boolean> {
  const bin = await tailscaleBin(run);
  if (!bin) return false;
  return (await run([bin, "funnel", "--bg", String(port), "off"])).code === 0;
}

/**
 * Read-only: whether Tailscale serve/funnel proxies to our loopback port right now. False when
 * tailscale is missing or its status cannot be read.
 */
export async function funnelServes(port: number, run: Runner = defaultRun): Promise<boolean> {
  const bin = await tailscaleBin(run);
  if (!bin) return false;
  const r = await run([bin, "funnel", "status", "--json"]);
  if (r.code !== 0) return false;
  let status: { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
  try {
    status = JSON.parse(r.stdout);
  } catch {
    return false;
  }
  const ours = new RegExp(`^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}(/|$)`);
  return Object.values(status.Web ?? {}).some((site) =>
    Object.values(site.Handlers ?? {}).some((h) => typeof h.Proxy === "string" && ours.test(h.Proxy)),
  );
}
