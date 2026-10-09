/**
 * Persistent user services: systemd --user on Linux, a LaunchAgent on macOS.
 * Two units: "server" (the web server) and "tunnel" (Portal's expose process).
 * Unit files live under $HOME, resolved at call time so tests can point HOME at a tmpdir.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Unit = "server" | "tunnel";

export interface UnitParams {
  /** absolute path of the bun binary (used by the "server" unit) */
  bun: string;
  /** plugin root: WorkingDirectory, and where server/index.ts lives */
  root: string;
  configDir: string;
  stateDir: string;
  socket: string;
  /**
   * Full argv of the "tunnel" unit, binary included: `[portalBin, ...exposeArgs(name, port)]`.
   * Required for "tunnel", ignored for "server".
   */
  portalArgs?: string[];
}

/** Runs a command and returns its exit code; 127 when the binary does not exist. */
export type Run = (argv: string[]) => Promise<number>;

export const defaultRun: Run = async (argv) => {
  try {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return await proc.exited;
  } catch {
    return 127;
  }
};

const isMac = () => process.platform === "darwin";
const home = () => process.env.HOME ?? "";

function argv(u: Unit, p: UnitParams): string[] {
  if (u === "server") return [p.bun, "server/index.ts"];
  if (!p.portalArgs?.length) throw new Error("the tunnel unit needs portalArgs");
  return p.portalArgs;
}

function envPairs(p: UnitParams): [string, string][] {
  return [
    ["HERDR_PLUGIN_CONFIG_DIR", p.configDir],
    ["HERDR_PLUGIN_STATE_DIR", p.stateDir],
    ["HERDR_SOCKET_PATH", p.socket],
  ];
}

/**
 * One systemd command-line word. Plain words stay bare; anything else is double-quoted with
 * `\` and `"` escaped. `%` (specifiers) and `$` (env substitution) are doubled in both forms.
 */
function sdWord(s: string): string {
  const v = s.replace(/%/g, "%%").replace(/\$/g, "$$$$");
  if (/^[A-Za-z0-9_@%$:,.\/=+-]+$/.test(v)) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** Environment= value; `$` is not expanded there, only `%` specifiers need doubling. */
function sdEnv(key: string, value: string): string {
  const v = value.replace(/%/g, "%%");
  const assignment = `${key}=${v}`;
  if (/^[A-Za-z0-9_@%:,.\/=+-]+$/.test(assignment)) return assignment;
  return `"${assignment.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

export function renderSystemdUnit(u: Unit, p: UnitParams): string {
  const desc = u === "server" ? "Herdr Web Service server" : "Herdr Web Service tunnel (Portal)";
  return [
    "[Unit]",
    `Description=${desc}`,
    "After=network-online.target",
    "",
    "[Service]",
    "Restart=on-failure",
    "RestartSec=2",
    `WorkingDirectory=${sdWord(p.root)}`,
    ...envPairs(p).map(([k, v]) => `Environment=${sdEnv(k, v)}`),
    `ExecStart=${argv(u, p).map(sdWord).join(" ")}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function label(u: Unit): string {
  return u === "server" ? "dev.herdr-web-service" : "dev.herdr-web-service.tunnel";
}

export function renderLaunchAgent(u: Unit, p: UnitParams): string {
  const log = xml(`${p.stateDir}/${u}.log`);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${label(u)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...argv(u, p).map((a) => `    <string>${xml(a)}</string>`),
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${xml(p.root)}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...envPairs(p).flatMap(([k, v]) => [`    <key>${k}</key>`, `    <string>${xml(v)}</string>`]),
    `  </dict>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${log}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${log}</string>`,
    `</dict>`,
    `</plist>`,
    "",
  ].join("\n");
}

function sdName(u: Unit): string {
  return u === "server" ? "herdr-web-service.service" : "herdr-web-service-tunnel.service";
}

export function unitPath(u: Unit): string {
  return isMac()
    ? `${home()}/Library/LaunchAgents/${label(u)}.plist`
    : `${home()}/.config/systemd/user/${sdName(u)}`;
}

export function unitInstalled(u: Unit): boolean {
  return existsSync(unitPath(u));
}

const render = (u: Unit, p: UnitParams) => (isMac() ? renderLaunchAgent(u, p) : renderSystemdUnit(u, p));
const domain = () => `gui/${process.getuid?.() ?? 0}`;

async function ensureLinger(run: Run): Promise<void> {
  const user = process.env.USER ?? "";
  if ((await run(["loginctl", "enable-linger", user])) === 0) return;
  console.log("No pude activar 'linger', así que el servicio solo arrancará cuando inicies sesión.");
  console.log("Para que arranque con el sistema, ejecuta una vez:");
  console.log(`  sudo loginctl enable-linger ${user}`);
}

/**
 * Writes the unit when its content differs and converges the service state. "installed"/"unchanged"
 * refer to the file: identical content never rewrites it nor restarts a running service, but a
 * unit that is not loaded/enabled (stopped via bootout, failed earlier install) is loaded again.
 */
export async function installUnit(u: Unit, p: UnitParams, run: Run = defaultRun): Promise<"installed" | "unchanged"> {
  const path = unitPath(u);
  const content = render(u, p);
  const existed = existsSync(path);
  const same = existed && readFileSync(path, "utf8") === content;
  if (!same) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  if (isMac()) {
    if (!same) await run(["launchctl", "bootout", domain(), path]); // not loaded yet is fine
    if (!same || (await run(["launchctl", "print", `${domain()}/${label(u)}`])) !== 0) {
      if ((await run(["launchctl", "bootstrap", domain(), path])) !== 0) throw new Error(`launchctl bootstrap failed for ${path}`);
    }
    return same ? "unchanged" : "installed";
  }
  const name = sdName(u);
  const up = same && (await run(["systemctl", "--user", "is-enabled", name])) === 0 && (await run(["systemctl", "--user", "is-active", name])) === 0;
  if (!up) {
    if ((await run(["systemctl", "--user", "daemon-reload"])) !== 0) throw new Error("systemctl --user daemon-reload failed");
    if ((await run(["systemctl", "--user", "enable", "--now", name])) !== 0) throw new Error(`systemctl --user enable --now ${name} failed`);
    // enable --now does not restart an already running unit (first installs have nothing running): apply the new ExecStart/Environment
    if (existed && !same && (await run(["systemctl", "--user", "restart", name])) !== 0) throw new Error(`systemctl --user restart ${name} failed`);
  }
  await ensureLinger(run);
  return same ? "unchanged" : "installed";
}

export async function uninstallUnit(u: Unit, run: Run = defaultRun): Promise<void> {
  const path = unitPath(u);
  if (isMac()) {
    await run(["launchctl", "bootout", domain(), path]);
  } else {
    await run(["systemctl", "--user", "disable", "--now", sdName(u)]);
  }
  if (existsSync(path)) unlinkSync(path);
  if (!isMac()) await run(["systemctl", "--user", "daemon-reload"]);
}

/** Starts the unit if stopped, restarts it if running. */
export async function restartUnit(u: Unit, run: Run = defaultRun): Promise<void> {
  if (isMac()) {
    if ((await run(["launchctl", "kickstart", "-k", `${domain()}/${label(u)}`])) === 0) return;
    // not loaded (after stopUnit's bootout): load it again
    if ((await run(["launchctl", "bootstrap", domain(), unitPath(u)])) !== 0) throw new Error(`launchctl bootstrap failed for ${unitPath(u)}`);
    return;
  }
  if ((await run(["systemctl", "--user", "restart", sdName(u)])) !== 0) throw new Error(`systemctl --user restart ${sdName(u)} failed`);
}

/** Stops the unit; KeepAlive/Restart would otherwise bring it back. On macOS this unloads it. */
export async function stopUnit(u: Unit, run: Run = defaultRun): Promise<void> {
  if (isMac()) await run(["launchctl", "bootout", domain(), unitPath(u)]);
  else await run(["systemctl", "--user", "stop", sdName(u)]);
}

/** Loaded (macOS: launchd knows the label) or active (Linux) right now. */
export async function unitRunning(u: Unit, run: Run = defaultRun): Promise<boolean> {
  if (isMac()) return (await run(["launchctl", "print", `${domain()}/${label(u)}`])) === 0;
  return (await run(["systemctl", "--user", "is-active", sdName(u)])) === 0;
}
