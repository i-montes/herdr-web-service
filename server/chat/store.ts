/**
 * Finds a pane's Claude Code transcript and keeps it parsed. Herdr's Claude integration reports
 * the session per pane; without that report the newest transcript of the pane's folder is used.
 * Only files under ~/.claude/projects are ever read. Each transcript is read incrementally:
 * a poll parses just the bytes appended since the last one.
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ChatSnapshot } from "../../shared/protocol.ts";
import { Transcript } from "./transcript.ts";

/** items sent per read; older ones are counted in `hidden` */
export const CHAT_LIMIT = 400;

export interface PaneSessionRef {
  /** absolute cwd of the pane */
  cwd: string;
  /** Herdr's `agent_session` for the pane, when the integration reported one */
  session: { kind: string; value: string } | null;
}

/** Claude Code stores a folder's transcripts under its path with every non-alphanumeric as `-` */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function projectsDir(home: string): string {
  return join(home, ".claude", "projects");
}

/** `path` when it is an existing .jsonl inside ~/.claude/projects */
function inProjects(path: string, home: string): string | null {
  try {
    const root = realpathSync(projectsDir(home));
    const real = realpathSync(path);
    const rel = relative(root, real);
    if (!rel || rel.startsWith("..") || rel.startsWith(sep) || !real.endsWith(".jsonl")) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

function newestIn(dir: string): string | null {
  try {
    let best: { path: string; mtime: number } | null = null;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      const mtime = statSync(path).mtimeMs;
      if (!best || mtime > best.mtime) best = { path, mtime };
    }
    return best?.path ?? null;
  } catch {
    return null;
  }
}

export function locateTranscript(ref: PaneSessionRef, home: string): { path: string; source: "herdr" | "guess" } | null {
  const folder = join(projectsDir(home), projectDirName(ref.cwd));
  if (ref.session?.value) {
    const candidate = ref.session.kind === "path" ? ref.session.value : join(folder, `${ref.session.value}.jsonl`);
    const path = inProjects(candidate, home);
    if (path) return { path, source: "herdr" };
  }
  const guess = newestIn(folder);
  const path = guess && inProjects(guess, home);
  return path ? { path, source: "guess" } : null;
}

interface Cached {
  transcript: Transcript;
  /** bytes parsed so far, always just after a newline */
  offset: number;
  ino: number;
}

/** most recently read last; the oldest is dropped past CACHE_SIZE */
const cache = new Map<string, Cached>();
const CACHE_SIZE = 20;

export async function readChat(path: string, home: string): Promise<Omit<ChatSnapshot, "source">> {
  const stat = statSync(path);
  let entry = cache.get(path);
  if (entry) {
    cache.delete(path);
    cache.set(path, entry);
  } else if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
  // rewritten or replaced (a shorter file, another inode): start over
  if (!entry || stat.size < entry.offset || stat.ino !== entry.ino) {
    entry = { transcript: new Transcript(home), offset: 0, ino: stat.ino };
    cache.set(path, entry);
  }
  if (stat.size > entry.offset) {
    const bytes = new Uint8Array(await Bun.file(path).slice(entry.offset, stat.size).arrayBuffer());
    // stop at the last complete line: a line still being written (maybe mid-character) waits
    const end = bytes.lastIndexOf(0x0a);
    if (end >= 0) {
      for (const line of new TextDecoder().decode(bytes.subarray(0, end)).split("\n")) if (line.trim()) entry.transcript.feed(line);
      entry.offset += end + 1;
    }
  }
  return entry.transcript.snapshot(CHAT_LIMIT, `${stat.ino}:${entry.offset}`);
}
