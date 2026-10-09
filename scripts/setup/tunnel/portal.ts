import { ask } from "../../tui.ts";
import { defaultRun, type Runner } from "./run.ts";

/** A DNS label: lowercase letters, digits and inner hyphens, at most 63 chars. */
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidName(name: string): boolean {
  return LABEL.test(name);
}

export function portalName(hostname: string): string {
  const short = (hostname.split(".")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const name = `herdr-${short || "web"}`.slice(0, 63).replace(/-+$/, "");
  return name;
}

export function exposeArgs(name: string, port: number): string[] {
  return ["expose", "--name", name, "--http-route", `/=http://127.0.0.1:${port}`, "--discovery=false"];
}

export function readyUrlFrom(line: string): string | null {
  return line.match(/service ready at (https:\/\/\S+)/)?.[1] ?? null;
}

export function askName(hostname: string): string {
  const def = portalName(hostname);
  for (;;) {
    const typed = ask(`Tunnel name [${def}]: `).trim();
    if (!typed) return def;
    if (isValidName(typed)) return typed;
    console.log("Invalid name: use only lowercase letters, digits and hyphens (max. 63, no hyphen at the start or end).");
  }
}

/** Where Portal's install.sh may put the binary (it picks an existing one, ~/.local/bin or ~/bin). */
function candidates(): string[] {
  const home = process.env.HOME ?? "";
  return ["portal", `${home}/.local/bin/portal`, `${home}/bin/portal`, "/usr/local/bin/portal"];
}

/** Absolute path (or bare name when on PATH) of a working portal binary, or null. */
export async function portalBin(run: Runner = defaultRun): Promise<string | null> {
  for (const c of candidates()) {
    if ((await run([c, "--help"])).code !== 127) return c;
  }
  return null;
}

/** Install Portal when missing and return the binary to use from then on. */
export async function ensureInstalled(run: Runner = defaultRun): Promise<string> {
  const have = await portalBin(run);
  if (have) return have;
  console.log("Installing Portal (no sudo, for your user only)...");
  // pipefail: a failed curl must not look like a successful (empty) bash run
  const r = await run(
    [
      "bash",
      "-c",
      "set -o pipefail; curl -fsSL https://github.com/gosuda/portal-tunnel/releases/latest/download/install.sh | bash",
    ],
    { inherit: true },
  );
  if (r.code !== 0) throw new Error("Portal installation failed");
  const bin = await portalBin(run);
  if (!bin) {
    throw new Error("Portal was installed but the `portal` binary cannot be found (searched PATH, ~/.local/bin, ~/bin and /usr/local/bin)");
  }
  return bin;
}

function spawnPortal(bin: string, name: string, port: number) {
  try {
    return Bun.spawn([bin, ...exposeArgs(name, port)], { stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new Error(`Could not run Portal (${bin}). Check that it is installed and on PATH.`);
  }
}

/** Start portal in the foreground, read its public URL, then stop it. */
export async function probeUrl(name: string, port: number, bin = "portal", timeoutMs = 60_000): Promise<string> {
  const proc = spawnPortal(bin, name, port);
  const deadline = Date.now() + timeoutMs;
  const readers = [proc.stdout, proc.stderr].map((s) => s.getReader());
  const dec = new TextDecoder();
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Portal did not publish a URL within 60 s")), Math.max(0, deadline - Date.now()));
      let open = readers.length;
      for (const rd of readers) {
        (async () => {
          let buf = "";
          for (;;) {
            const { done, value } = await rd.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const l of lines) {
              const url = readyUrlFrom(l);
              if (url) {
                clearTimeout(timer);
                resolve(url);
                return;
              }
            }
          }
          if (--open === 0) {
            clearTimeout(timer);
            reject(new Error("Portal exited without publishing a URL"));
          }
        })().catch(reject);
      }
    });
  } finally {
    proc.kill();
  }
}
