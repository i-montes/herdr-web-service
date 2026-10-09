/**
 * The setup wizard (spec steps 0–9). Every effect goes through `WizardDeps` so the flow can be
 * tested with fakes; `defaultDeps()` wires the real modules. Each step is idempotent: a re-run
 * with the same answers rewrites nothing and ends with the same summary.
 *
 * Tunnel safety: a Funnel turned on by this run is recorded in `.env` (`TUNNEL`) before it is
 * enabled and turned off again if the run does not get to save the new configuration (error,
 * declined URL change, SIGINT/SIGHUP/SIGTERM). Leaving remote mode turns off any Funnel that
 * proxies to our port, whatever `.env` says.
 */
import { join } from "node:path";
import type { AccessMode } from "../../server/access.ts";
import { CONFIG_DIR, STATE_DIR, config } from "../../server/config.ts";
import { ask, choose, confirmAsync, readLine } from "../tui.ts";
import { readEnv, writeEnv } from "./env.ts";
import { stopLooseServer } from "./loose.ts";
import { canonicalUrl, isPrivateIPv4, lanAddress, localIPv4s } from "./network.ts";
import { passwordStep } from "./password.ts";
import { preflight, type PreflightResult } from "./preflight.ts";
import {
  installUnit, restartUnit, stopUnit, uninstallUnit, unitInstalled, unitRunning, type Unit, type UnitParams,
} from "./service.ts";
import { installStatusLine, statusLineCommand, statusLinePaths, type InstallResult } from "./statusline.ts";
import { renderSummary } from "./summary.ts";
import { exposeArgs } from "./tunnel/portal.ts";
import { funnelServes, setupTunnel, teardownTunnel, type TunnelKind, type TunnelResult } from "./tunnel/index.ts";
import { verifyHealth, type HealthResult } from "./verify.ts";

/** Ends the wizard early: the message (if any) is printed and the process exits with `code`. */
export class SetupAborted extends Error {
  constructor(message: string, readonly code = 1) {
    super(message);
  }
}

export interface WizardDeps {
  envPath: string;
  port: number;
  unitParams: Omit<UnitParams, "portalArgs">;
  /** where the service log is (a file or a command), shown on failures and in the summary */
  logFile: string;
  serviceKind: "launchd" | "systemd";
  log: (line: string) => void;
  preflight: () => Promise<PreflightResult>;
  choose: (label: string, options: { key: string; label: string }[], defaultKey?: string) => Promise<string>;
  /** must not block the event loop, so interrupt cleanup can run while it waits */
  confirm: (label: string, defaultYes: boolean) => Promise<boolean>;
  /** a visible answer, "" for Enter; must not block the event loop either */
  ask: (label: string) => Promise<string>;
  waitEnter: () => void;
  passwordStep: () => Promise<void>;
  lanAddress: () => string | null;
  /** every IPv4 of this machine, to validate a typed LAN address */
  localAddresses: () => string[];
  setupTunnel: (kind: TunnelKind, port: number) => Promise<TunnelResult>;
  /** false when the tunnel could not be turned off */
  teardownTunnel: (kind: TunnelKind, port: number) => Promise<boolean>;
  /** read-only: Tailscale Funnel/serve proxies to this port now */
  funnelServes: (port: number) => Promise<boolean>;
  unitInstalled: (u: Unit) => boolean;
  unitRunning: (u: Unit) => Promise<boolean>;
  installUnit: (u: Unit, p: UnitParams) => Promise<"installed" | "unchanged">;
  uninstallUnit: (u: Unit) => Promise<void>;
  stopUnit: (u: Unit) => Promise<void>;
  restartUnit: (u: Unit) => Promise<void>;
  stopLooseServer: () => Promise<unknown>;
  /** registers our Claude Code status line (context and plan usage for the web chat) */
  installStatusLine: () => InstallResult;
  verifyHealth: (url: string) => Promise<HealthResult>;
  /** runs `cleanup` on SIGINT/SIGHUP/SIGTERM, then exits 130; returns the unsubscribe */
  onInterrupt: (cleanup: () => Promise<void>) => () => void;
}

const ROOT = join(import.meta.dir, "..", "..");

function onInterrupt(cleanup: () => Promise<void>): () => void {
  const signals = ["SIGINT", "SIGHUP", "SIGTERM"] as const;
  let running = false;
  const handler = () => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        console.log("\nInterrumpido: deshaciendo los cambios a medias...");
        await cleanup();
      } catch (error) {
        console.log(`No se pudo deshacer todo: ${(error as Error).message}`);
      } finally {
        process.exit(130);
      }
    })();
  };
  for (const s of signals) process.on(s, handler);
  return () => {
    for (const s of signals) process.off(s, handler);
  };
}

export function defaultDeps(): WizardDeps {
  const mac = process.platform === "darwin";
  return {
    envPath: join(CONFIG_DIR, ".env"),
    port: config.port,
    unitParams: { bun: process.execPath, root: ROOT, configDir: CONFIG_DIR, stateDir: STATE_DIR, socket: config.herdrSocket },
    logFile: mac ? config.logFile : "journalctl --user -u herdr-web-service.service",
    serviceKind: mac ? "launchd" : "systemd",
    log: (line) => console.log(line),
    preflight,
    choose,
    confirm: confirmAsync,
    ask: readLine,
    waitEnter: () => void ask("Pulsa Enter para cerrar."),
    passwordStep,
    lanAddress,
    localAddresses: () => localIPv4s(),
    setupTunnel,
    teardownTunnel: (kind, port) => teardownTunnel(kind, port),
    funnelServes: (port) => funnelServes(port),
    unitInstalled,
    unitRunning: (u) => unitRunning(u),
    installUnit: (u, p) => installUnit(u, p),
    uninstallUnit: (u) => uninstallUnit(u),
    stopUnit: (u) => stopUnit(u),
    restartUnit: (u) => restartUnit(u),
    stopLooseServer,
    installStatusLine: () =>
      installStatusLine(
        statusLinePaths(CONFIG_DIR),
        statusLineCommand({ bun: process.execPath, root: ROOT, stateDir: STATE_DIR, configDir: CONFIG_DIR }),
      ),
    verifyHealth: (url) => verifyHealth(url),
    onInterrupt,
  };
}

const MODES: { key: AccessMode; label: string }[] = [
  { key: "local", label: "Solo este equipo" },
  { key: "lan", label: "En casa por Wi-Fi (misma red, sin HTTPS)" },
  { key: "remote", label: "Desde cualquier sitio (túnel con HTTPS)" },
];

const TUNNELS: { key: TunnelKind; label: string }[] = [
  { key: "tailscale", label: "Tailscale Funnel (recomendado: URL estable, certificado real)" },
  { key: "portal", label: "Portal (sin cuenta ni sudo)" },
];

const isMode = (v: string | undefined): v is AccessMode => MODES.some((m) => m.key === v);
const isTunnel = (v: string | undefined): v is TunnelKind => TUNNELS.some((t) => t.key === v);

export const URL_CHANGE = "La URL cambia: los dispositivos y sesiones abiertos con la URL anterior tendrán que volver a entrar. ¿Continuar?";
export const PUBLIC_IP = "Esa IP es pública: el servidor quedará expuesto a internet por HTTP sin cifrar. ¿Seguro?";

/**
 * The LAN address to listen on: shown, overridable, validated. The default is the saved HOST while
 * it is still one of this machine's addresses (a re-run keeps the URL), else the detected one.
 */
async function lanHost(deps: WizardDeps, savedHost: string | undefined): Promise<string> {
  const mine = deps.localAddresses();
  const detected = savedHost && mine.includes(savedHost) ? savedHost : deps.lanAddress();
  for (let attempt = 0; attempt < 5; attempt++) {
    const typed = (await deps.ask(detected ? `IP de este equipo en la red [${detected}]:` : "IP de este equipo en la red:")).trim();
    const ip = typed || detected;
    if (!ip) break;
    if (!mine.includes(ip)) {
      deps.log(`${ip} no es una dirección IPv4 de este equipo. Disponibles: ${mine.join(", ") || "ninguna"}`);
      continue;
    }
    if (!isPrivateIPv4(ip) && !(await deps.confirm(PUBLIC_IP, false))) continue;
    return ip;
  }
  throw new SetupAborted("No hay una dirección IPv4 de red local válida: conecta este equipo a la red y vuelve a intentarlo.");
}

/** Step 7b: never fatal, the server works without it (the web chat just shows no usage). */
function statusLineStep(deps: WizardDeps): void {
  let result: InstallResult;
  try {
    result = deps.installStatusLine();
  } catch (error) {
    deps.log(`No se pudo registrar la status line de Claude Code: ${(error as Error).message}`);
    deps.log("El chat web no mostrará el contexto ni los límites del plan de Claude.");
    return;
  }
  switch (result.status) {
    case "installed":
      return deps.log("Status line de Claude Code: instalada (contexto y límites del plan para el chat web)");
    case "updated":
      return deps.log("Status line de Claude Code: actualizada");
    case "unchanged":
      return deps.log("Status line de Claude Code: sin cambios");
    case "chained":
      return deps.log(`Status line de Claude Code: instalada; la que había (${result.previous}) se sigue mostrando delante`);
    case "no-claude":
      return deps.log("Claude Code no está instalado: el chat web no mostrará su contexto ni los límites del plan. Vuelve a ejecutar la configuración después de instalarlo.");
    case "unreadable":
      deps.log(`No se pudo leer ${result.detail}`);
      return deps.log("Status line de Claude Code: sin instalar. Arregla el archivo y vuelve a ejecutar la configuración.");
  }
}

export async function runWizard(deps: WizardDeps = defaultDeps()): Promise<void> {
  const { log, port } = deps;
  log("Herdr Web Service — configuración\n");

  // 0. preflight
  const pf = await deps.preflight();
  if (!pf.ok) {
    log("No se puede continuar:");
    for (const p of pf.problems) log(`  - ${p}`);
    throw new SetupAborted("");
  }

  const saved = readEnv(deps.envPath);
  const savedTunnel = isTunnel(saved.TUNNEL) ? saved.TUNNEL : undefined;
  const savedPort = Number(saved.PORT) || port;

  // 1. mode
  const mode = (await deps.choose("¿Desde dónde vas a usar el cliente web?", MODES, isMode(saved.ACCESS_MODE) ? saved.ACCESS_MODE : "local")) as AccessMode;
  log("");

  // 2. password
  await deps.passwordStep();
  log("");

  // listening address (lan needs a LAN IPv4; the others stay on loopback)
  const host = mode === "lan" ? await lanHost(deps, saved.HOST) : "127.0.0.1";

  // Undo state for steps 3–6. `committed`: the new .env is written, so the tunnel is the configured one.
  let committed = false;
  /** a Funnel this run may have turned on (no configured remote Funnel was serving our port before) */
  let freshFunnel = false;
  /** TUNNEL was written ahead of enabling the tunnel and must be put back on rollback */
  let tunnelIntent = false;
  /** the Portal unit was stopped to probe again, and not yet replaced by a new unit */
  let portalStopped = false;
  const cleanup = async () => {
    if (!committed) {
      if (freshFunnel) {
        // "off" fails when Funnel never got enabled (or tailscale is missing): then nothing is exposed
        if ((await deps.teardownTunnel("tailscale", port)) || !(await deps.funnelServes(port))) {
          freshFunnel = false;
        } else {
          // keep TUNNEL=tailscale in .env: `uninstall` or a re-run will find and retry it
          log(`No pude apagar Tailscale Funnel: ejecuta \`tailscale funnel --bg ${port} off\`.`);
        }
      }
      if (tunnelIntent && !freshFunnel) {
        writeEnv(deps.envPath, { TUNNEL: saved.TUNNEL ?? null });
        tunnelIntent = false;
      }
    }
    if (portalStopped) {
      await deps.restartUnit("tunnel");
      portalStopped = false;
    }
  };

  // 3. tunnel
  let tunnel: TunnelResult | undefined;
  /** the running Portal unit is kept as is */
  let reused = false;
  // Registered before the tunnel step: a signal between Funnel going on and setupTunnel returning
  // must still turn it off. Blocking prompts inside the tunnel modules (tui.confirm/ask) hold the
  // event loop, so a signal there is only handled once they return; TUNNEL is already in .env
  // for that case, so uninstall or a re-run finds the Funnel.
  const unsubscribe = deps.onInterrupt(cleanup);
  try {
    if (mode === "remote") {
      if (savedTunnel === "portal" && deps.unitInstalled("tunnel") && saved.PUBLIC_URL) {
        // a second `portal expose` would fight the running service for the same name
        log(`Portal ya está configurado para publicar este servidor en ${saved.PUBLIC_URL}.`);
        if (!(await deps.confirm("¿Cambiar el túnel?", false))) {
          tunnel = { kind: "portal", url: saved.PUBLIC_URL, persistent: false };
          reused = true;
          if (!(await deps.unitRunning("tunnel"))) {
            await deps.restartUnit("tunnel");
            log("Servicio del túnel: arrancado de nuevo");
          }
        }
      }
      if (!tunnel) {
        const kind = (await deps.choose("Túnel:", TUNNELS, savedTunnel ?? "tailscale")) as TunnelKind;
        if (kind === "portal" && deps.unitInstalled("tunnel")) {
          await deps.stopUnit("tunnel");
          portalStopped = true;
        }
        if (kind !== savedTunnel) {
          // recorded before enabling: an interrupted run leaves a trace uninstall/re-run can act on
          writeEnv(deps.envPath, { TUNNEL: kind });
          tunnelIntent = true;
        }
        // "fresh" from actual state, not the TUNNEL marker (an interrupted run leaves TUNNEL=tailscale
        // under a local/lan .env): only a configured remote Funnel already serving our port is kept
        const configuredFunnel =
          saved.ACCESS_MODE === "remote" && savedTunnel === "tailscale" && (await deps.funnelServes(port));
        freshFunnel = kind === "tailscale" && !configuredFunnel;
        tunnel = await deps.setupTunnel(kind, port);
        if (tunnel.kind === "portal" && !tunnel.name) throw new Error("Portal no devolvió el nombre del túnel");
      }
      log("");
    }

    // 4. canonical URL
    const url = canonicalUrl(mode, host, port, tunnel?.url);
    if (saved.PUBLIC_URL && saved.PUBLIC_URL !== url && !URL.canParse(saved.PUBLIC_URL)) {
      // nothing could have been opened with it, so there is nothing to warn about
      log(`URL guardada no válida (${saved.PUBLIC_URL}): se reemplaza`);
    } else if (saved.PUBLIC_URL && saved.PUBLIC_URL !== url) {
      log(`URL guardada: ${saved.PUBLIC_URL}`);
      log(`URL nueva:    ${url}`);
      if (!(await deps.confirm(URL_CHANGE, false))) throw new SetupAborted("Cancelado: la configuración guardada no cambió.");
    }
    log(`URL: ${url}`);

    // retire a previous tunnel this configuration no longer uses: it would keep exposing the server
    const kind = tunnel?.kind;
    if (kind !== "tailscale") {
      for (const p of new Set([savedPort, port])) {
        if (!(await deps.funnelServes(p)) && !(savedTunnel === "tailscale" && p === savedPort)) continue;
        log(`Apagando Tailscale Funnel en el puerto ${p}...`);
        if (!(await deps.teardownTunnel("tailscale", p)) && (await deps.funnelServes(p))) {
          throw new SetupAborted(`No pude apagar Tailscale Funnel: ejecuta \`tailscale funnel --bg ${p} off\` y vuelve a ejecutar la configuración.`);
        }
      }
    }
    if (kind !== "portal" && deps.unitInstalled("tunnel")) {
      log("Quitando el servicio de Portal del modo anterior...");
      await deps.uninstallUnit("tunnel");
    }

    // 5. listening config
    log(`Guardando ${deps.envPath}`);
    writeEnv(deps.envPath, { ACCESS_MODE: mode, HOST: host, PORT: String(port), PUBLIC_URL: url, TUNNEL: kind ?? null });
    committed = true;

    // 6. services (a detached server would hold the port the service needs)
    await deps.stopLooseServer();
    const server = await deps.installUnit("server", deps.unitParams);
    log(`Servicio del servidor: ${server === "installed" ? "instalado" : "sin cambios"}`);
    if (tunnel?.kind === "portal" && !reused) {
      const result = await deps.installUnit("tunnel", { ...deps.unitParams, portalArgs: [tunnel.bin ?? "portal", ...exposeArgs(tunnel.name!, port)] });
      portalStopped = false;
      log(`Servicio del túnel: ${result === "installed" ? "instalado" : "sin cambios"}`);
    }

    // 7. restart: a freshly (re)written unit was just started with the new .env; an unchanged one was not
    if (server === "unchanged") {
      await deps.restartUnit("server");
      log("Servidor reiniciado");
    }
    unsubscribe();
    statusLineStep(deps);

    // 8. verification
    for (;;) {
      log(`Verificando ${url}/api/health ...`);
      const health = await deps.verifyHealth(url);
      if (health.ok) {
        log("Responde.");
        if (health.note) log(health.note);
        break;
      }
      log(`No responde: ${health.reason}`);
      log(`Registro del servidor: ${deps.logFile}`);
      if (!(await deps.confirm("¿Reintentar?", true))) {
        throw new SetupAborted("La configuración quedó guardada, pero el servidor no respondió en la URL. Revisa el registro y vuelve a ejecutar la configuración.");
      }
    }

    // 9. summary
    log(renderSummary({ mode, url, tunnel: kind, logFile: deps.logFile, serviceKind: deps.serviceKind }));
    deps.waitEnter();
  } catch (error) {
    unsubscribe();
    try {
      await cleanup();
    } catch (undoError) {
      log(`No se pudo deshacer todo: ${(undoError as Error).message}`);
    }
    throw error;
  }
}
