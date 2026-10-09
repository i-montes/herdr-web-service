/**
 * Control script: the one entry point for Herdr actions, the startup hook and a plain shell.
 *
 *   bun scripts/plugin.ts start | stop | status | setup | uninstall | set-password | url
 *
 * `start` uses the service unit when one is installed; otherwise it spawns the server detached,
 * records its pid under HERDR_PLUGIN_STATE_DIR and waits for /api/health. `setup` runs the
 * interactive wizard (Herdr opens it in a popup pane): access mode, password, tunnel, service.
 * `uninstall` removes the service units, the tunnel and our Claude Code status line, keeping the password and the .env. Herdr injects HERDR_SOCKET_PATH, HERDR_BIN_PATH and the plugin dirs.
 */
import { spawn } from "node:child_process";
import { existsSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, STATE_DIR, config } from "../server/config.ts";
import { passwordConfigured } from "../server/auth/password.ts";
import { recordedPid, stopLooseServer } from "./setup/loose.ts";
import { askAndSetPassword } from "./setup/password.ts";
import { restartUnit, stopUnit, uninstallUnit, unitInstalled } from "./setup/service.ts";
import { removeStatusLine, statusLinePaths } from "./setup/statusline.ts";
import { funnelServes, teardownTunnel } from "./setup/tunnel/index.ts";
import { runUninstall } from "./setup/uninstall.ts";
import { runWizard, SetupAborted } from "./setup/wizard.ts";
import { choose, confirm, restoreTerminal } from "./tui.ts";

const ROOT = join(import.meta.dir, "..");
const origin = `http://${config.host}:${config.port}`;

async function healthy(): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function start(): Promise<void> {
  if (await healthy()) {
    console.log(`already running at ${origin}`);
    return;
  }
  if (!existsSync(join(ROOT, "dist", "index.html"))) {
    console.error("dist/ is missing: run `bun run build` (plugin install does this for you)");
    process.exit(1);
  }
  if (unitInstalled("server")) {
    // the service manager owns the process: (re)start through it and just wait for health
    await restartUnit("server");
    for (let i = 0; i < 40; i++) {
      if (await healthy()) {
        console.log(`running at ${origin} (${serviceKind()})`);
        if (!passwordConfigured()) console.log("no password set yet: run the setup action (Web: setup) before exposing this server");
        return;
      }
      await Bun.sleep(250);
    }
    console.error(`server did not answer in time; see ${join(STATE_DIR, "server.log")}`);
    process.exit(1);
  }
  const log = openSync(config.logFile, "a");
  const child = spawn(process.execPath, [join(ROOT, "server", "index.ts")], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env },
  });
  child.unref();
  if (!child.pid) {
    console.error("could not spawn the server");
    process.exit(1);
  }
  writeFileSync(config.pidFile, `${child.pid}\n`, { mode: 0o600 });
  for (let i = 0; i < 40; i++) {
    if (await healthy()) {
      console.log(`running at ${origin} (pid ${child.pid})`);
      if (!passwordConfigured()) console.log("no password set yet: run the setup action (Web: setup) before exposing this server");
      return;
    }
    await Bun.sleep(250);
  }
  console.error(`server did not answer in time; see ${config.logFile}`);
  process.exit(1);
}

function serviceKind(): "systemd" | "launchd" | "none" {
  if (!unitInstalled("server")) return "none";
  return process.platform === "darwin" ? "launchd" : "systemd";
}

async function stop(): Promise<void> {
  if (unitInstalled("server")) {
    // a plain kill would be undone by KeepAlive/Restart
    await stopUnit("server");
    console.log("stopped");
    return;
  }
  console.log((await stopLooseServer()) ? "stopped" : "not running");
}

async function status(): Promise<void> {
  const pid = recordedPid();
  const up = await healthy();
  console.log(`${up ? "running" : "stopped"} ${origin}${pid ? ` (pid ${pid})` : ""}`);
  console.log(`service: ${serviceKind()}`);
  console.log(`password: ${passwordConfigured() ? "set" : "NOT SET"}`);
  console.log(`public url: ${config.publicUrl || "(none)"}`);
  console.log(`config: ${CONFIG_DIR}`);
}

async function setup(): Promise<void> {
  try {
    await runWizard();
  } catch (error) {
    if (error instanceof SetupAborted) {
      if (error.message) console.log(`\n${error.message}`);
    } else {
      console.log(`\nError: ${(error as Error).message}`);
    }
    if (process.stdin.isTTY) prompt("Press Enter to close.");
    process.exit(error instanceof SetupAborted ? error.code : 1);
  }
}

async function uninstall(): Promise<void> {
  const ok = await runUninstall({
    envPath: join(CONFIG_DIR, ".env"),
    port: config.port,
    authFile: config.authFile,
    log: (line) => console.log(line),
    unitInstalled,
    stopUnit: (u) => stopUnit(u),
    uninstallUnit: (u) => uninstallUnit(u),
    stopLooseServer,
    funnelServes: (port) => funnelServes(port),
    teardownTunnel: (kind, port) => teardownTunnel(kind, port),
    removeStatusLine: () => removeStatusLine(statusLinePaths(CONFIG_DIR)),
  });
  if (!ok) process.exit(1);
}

const [verb, arg] = process.argv.slice(2);
process.on("exit", restoreTerminal);
switch (verb) {
  case "start": await start(); break;
  case "stop": await stop(); break;
  case "status": await status(); break;
  case "setup": await setup(); break;
  case "uninstall": await uninstall(); break;
  case "set-password":
    if (arg) { console.error("set-password takes no argument: it asks for the password without echo (or reads one line from a pipe)"); process.exit(2); }
    await askAndSetPassword();
    break;
  case "tui-demo": { // hidden: exercised by tests/pty.py
    const choice = await choose("Access:", [{ key: "local", label: "Local only" }, { key: "lan", label: "Local network" }], "local");
    console.log(`choice=${choice} confirm=${confirm("Continue?", true)}`);
    break;
  }
  case "url": console.log(config.publicUrl || origin); break;
  default:
    console.error("usage: bun scripts/plugin.ts start|stop|status|setup|uninstall|set-password|url");
    process.exit(2);
}
// a stdin that was put in raw mode keeps the event loop alive on some runtimes
process.exit(0);
