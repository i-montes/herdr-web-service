/** The server started without a service unit (`plugin.ts start`): a detached process with a pid file. */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { config } from "../../server/config.ts";

export function recordedPid(): number | null {
  if (!existsSync(config.pidFile)) return null;
  const pid = Number(readFileSync(config.pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** Stops the detached server if one is recorded; returns whether there was one. */
export async function stopLooseServer(): Promise<boolean> {
  const pid = recordedPid();
  if (pid === null) {
    if (existsSync(config.pidFile)) unlinkSync(config.pidFile);
    return false;
  }
  // the whole process group: start spawned it as a group leader
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    process.kill(pid, "SIGTERM");
  }
  for (let i = 0; i < 40 && recordedPid() !== null; i++) await Bun.sleep(100);
  if (recordedPid() !== null) process.kill(pid, "SIGKILL");
  if (existsSync(config.pidFile)) unlinkSync(config.pidFile);
  return true;
}
