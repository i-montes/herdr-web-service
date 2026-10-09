/**
 * Terminal prompts for the setup popup. Passwords are typed in raw mode: nothing typed is
 * echoed (a dot per character), and the rules are redrawn under the field on every key.
 * Without a TTY (a pipe), one line of stdin is read instead, for scripted installs.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { passwordRules } from "../server/auth/password.ts";

const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const CLEAR_LINE = "\r\x1b[2K";

function readPipedLine(): string {
  const line = readFileSync(0, "utf8").split("\n")[0] ?? "";
  return line.replace(/\r$/, "");
}

/**
 * Feed raw-mode keys to `handle` until it returns true. A listener rather than `for await` on
 * stdin: breaking out of the async iterator destroys the stream, and the next prompt would
 * find stdin closed.
 */
function readRaw(handle: (key: string) => boolean): Promise<void> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const onData = (chunk: string | Buffer) => {
      // a chunk may carry several keys (a paste, a fast typist); an escape sequence is one key
      const text = String(chunk);
      const keys = text.startsWith("\x1b") ? [text] : Array.from(text);
      for (const key of keys) {
        if (!handle(key)) continue;
        stdin.off("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
        resolve();
        return;
      }
    };
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.resume();
  });
}

interface SecretOptions {
  /** draw the rule indicators under the field and refuse Enter until they all pass */
  rules?: boolean;
}

/**
 * A secret typed without echo. With `rules`, four indicator lines follow the field and Enter is
 * accepted only once every rule passes; otherwise a hint is shown and typing continues.
 */
export async function readSecret(label: string, options: SecretOptions = {}): Promise<string> {
  if (!process.stdin.isTTY) return readPipedLine();
  const out = process.stdout;
  const ruleLines = options.rules ? passwordRules("").length : 0;
  let value = "";
  let hint = "";

  const render = () => {
    out.write(`${CLEAR_LINE}${label} ${"•".repeat(value.length)}`);
    if (options.rules) {
      for (const rule of passwordRules(value)) {
        out.write(`\n${CLEAR_LINE}  ${rule.ok ? `${GREEN}✓` : `${DIM}○`} ${rule.label}${RESET}`);
      }
      out.write(`\n${CLEAR_LINE}${hint ? `${RED}${hint}${RESET}` : ""}`);
      // back up to the field, after the dots
      out.write(`\x1b[${ruleLines + 1}A\r\x1b[${label.length + 1 + value.length}C`);
    }
  };

  render();
  await readRaw((key) => {
    if (key === "\u0003") {
      // ctrl+c
      out.write("\n".repeat(ruleLines + 2));
      process.exit(130);
    }
    if (key === "\r" || key === "\n") {
      if (!options.rules || passwordRules(value).every((rule) => rule.ok)) return true;
      hint = "faltan reglas por cumplir";
      render();
      return false;
    }
    if (key === "\u007f" || key === "\b") value = value.slice(0, -1);
    else if (key === "\u0015") value = ""; // ctrl+u
    else if (key.startsWith("\x1b") || key < " ") return false; // escape sequences, other controls
    else value += key;
    hint = "";
    render();
    return false;
  });
  // leave the cursor on a fresh line below everything drawn
  out.write("\n".repeat(ruleLines + 2));
  return value;
}

/** A visible answer; returns "" on an empty line or without a TTY. */
export function ask(label: string): string {
  if (!process.stdin.isTTY) return "";
  return prompt(label) ?? "";
}

const YES = new Set(["s", "si", "sí", "y", "yes"]);
const NO = new Set(["n", "no"]);

/** A yes/no question; Enter takes the default and anything unrecognised asks again. */
export function confirm(label: string, defaultYes: boolean): boolean {
  if (!process.stdin.isTTY) return defaultYes;
  const hint = defaultYes ? "[S/n]" : "[s/N]";
  for (;;) {
    const answer = (prompt(`${label} ${hint}`) ?? "").trim().toLowerCase();
    if (!answer) return defaultYes;
    if (YES.has(answer)) return true;
    if (NO.has(answer)) return false;
  }
}

/**
 * A line typed in cooked mode, read without blocking the event loop: unlike `prompt()`, SIGINT
 * and SIGHUP listeners still run while it waits. Returns "" without a TTY.
 */
export function readLine(label: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve("");
  process.stdout.write(`${label} `);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buffer = "";
    const onData = (chunk: string | Buffer) => {
      buffer += String(chunk);
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      stdin.off("data", onData);
      stdin.pause();
      resolve(buffer.slice(0, nl).replace(/\r$/, ""));
    };
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.resume();
  });
}

/** `confirm` that leaves signal listeners able to run while it waits (see `readLine`). */
export async function confirmAsync(label: string, defaultYes: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes;
  const hint = defaultYes ? "[S/n]" : "[s/N]";
  for (;;) {
    const answer = (await readLine(`${label} ${hint}`)).trim().toLowerCase();
    if (!answer) return defaultYes;
    if (YES.has(answer)) return true;
    if (NO.has(answer)) return false;
  }
}

/**
 * A numbered menu answered with one key: a digit picks that option, Enter picks the default
 * (ignored when there is none). Returns the chosen option's `key`.
 */
export async function choose(label: string, options: { key: string; label: string }[], defaultKey?: string): Promise<string> {
  const fallback = options.find((option) => option.key === defaultKey);
  if (!process.stdin.isTTY) {
    if (fallback) return fallback.key;
    throw new Error(`choose("${label}") needs a TTY or a default`);
  }
  const out = process.stdout;
  out.write(`${label}\n`);
  options.forEach((option, i) => {
    const mark = option === fallback ? `  ${DIM}(por defecto)${RESET}` : "";
    out.write(`  ${i + 1}) ${option.label}${mark}\n`);
  });
  let picked: { key: string; label: string } | undefined;
  await readRaw((key) => {
    if (key === "\u0003") {
      out.write("\n");
      process.exit(130);
    }
    if (key === "\r" || key === "\n") picked = fallback;
    else if (/^[1-9]$/.test(key)) picked = options[Number(key) - 1];
    return picked !== undefined;
  });
  out.write(`> ${picked!.label}\n`);
  return picked!.key;
}

/** `stty sane` in case a crash left the terminal in raw mode */
export function restoreTerminal(): void {
  if (process.stdin.isTTY) spawnSync("stty", ["sane"], { stdio: "inherit" });
}
