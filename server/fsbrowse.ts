/**
 * Folder picker for "Nueva sesión": lists the subfolders of a folder inside the user's home.
 * Paths travel as `~/…`; anything that resolves outside home (through `..` or a symlink) is
 * refused, so a signed-in browser can browse projects without seeing the rest of the machine.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { tildePath } from "./herdr/roster.ts";

export interface DirEntry {
  name: string;
  /** current branch when the folder is a git checkout */
  git: string | null;
}

export type DirListing = { ok: true; path: string; dirs: DirEntry[] } | { ok: false; error: string };

const MAX_ENTRIES = 500;

export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/** the real folder `path` names, or null when it is not a folder inside home */
export function folderInHome(path: string, home: string): string | null {
  try {
    const realHome = realpathSync(home);
    const real = realpathSync(resolve(expandHome(path || "~", home)));
    const rel = relative(realHome, real);
    if (rel.startsWith("..") || rel.startsWith(sep) || resolve(realHome, rel) !== real) return null;
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function gitBranch(dir: string): string | null {
  try {
    const head = readFileSync(join(dir, ".git", "HEAD"), "utf8").trim();
    return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : head.slice(0, 7);
  } catch {
    return null;
  }
}

export function listDirs(path: string, home: string): DirListing {
  const dir = folderInHome(path, home);
  if (!dir) return { ok: false, error: "folder not found inside home" };
  const realHome = realpathSync(home);
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || (e.isSymbolicLink() && folderInHome(join(dir, e.name), home) !== null)))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_ENTRIES);
  } catch {
    return { ok: false, error: "folder not readable" };
  }
  return { ok: true, path: tildePath(dir, realHome), dirs: names.map((name) => ({ name, git: gitBranch(join(dir, name)) })) };
}
