/**
 * Reads the choice an agent's terminal is waiting on (permission, question, folder trust, a
 * slash command's menu) from the pane's visible text: the option list around the `❯` cursor,
 * numbered or not, and the question above it; Claude Code's /effort slider is read as a row of
 * levels. Answering moves the cursor with arrow keys and presses Enter, which works for every
 * such menu whatever its numbering.
 */
import type { PanePrompt } from "../../shared/protocol.ts";

const CURSOR = "❯";
/** `❯ 1. text`, with the ↓/↑ a scrolled list shows in place of the cursor */
const NUMBERED = /^(\s*)(?:[❯↓↑]\s*)?(\d+)\.\s+(\S.*)$/;
const CURRENT = /\s*✔\s*/;
/** results, output markers and "… +3 more": never options */
const NOT_OPTION = /^\s*[⎿⏺✻●▔│╭╰…]/;
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** a line without box-drawing borders and trailing spaces */
function clean(line: string): string {
  return line.replace(/^\s*[│┃]/, "").replace(/[│┃]\s*$/, "").replace(/\s+$/, "");
}

const indent = (line: string) => line.length - line.trimStart().length;
/** a separator, even one carrying a short status note (`▔▔▔▔ ● high · /effort ▔`) */
const isRule = (line: string) => {
  const rest = line.replace(/[\s─━═▔╭╮╰╯┌┐└┘\-]/g, "");
  return rest.length === 0 || rest.length < line.trim().length * 0.3;
};

/** `label  description` columns → `label · description`, the ✔ of the current choice removed */
function optionText(text: string): string {
  return text.replace(CURRENT, "  ").trim().replace(/\s{2,}/g, " · ");
}

/** the question above a list: a line asking something, else the heading of the block above */
function titleAbove(lines: string[], first: number): string {
  const above: string[] = [];
  const block: string[] = [];
  let blockDone = false;
  for (let i = first - 1; i >= 0 && i >= first - 15; i--) {
    const text = lines[i]!.trim();
    if (!text || isRule(text)) {
      if (block.length) blockDone = true;
      continue;
    }
    above.push(text);
    if (!blockDone) block.push(text);
  }
  const asked = above.find((t) => t.endsWith("?")) ?? above.find((t) => t.includes("?"));
  if (asked) return asked;
  const top = block[block.length - 1] ?? "";
  return top.length <= 60 ? top : (block[0] ?? "");
}

/** Claude Code's /effort slider: `low  medium  high  xhigh  max` under a ▲ marker */
function effortSlider(lines: string[]): PanePrompt | null {
  const row = lines.findIndex((l) => /\blow\s+medium\s+high\s+xhigh\s+max\b/.test(l));
  if (row < 0) return null;
  const marker = lines.slice(Math.max(0, row - 3), row).find((l) => l.includes("▲"));
  if (!marker) return null;
  const at = marker.indexOf("▲");
  const columns = EFFORT_LEVELS.map((level) => {
    const start = lines[row]!.indexOf(level);
    return start + level.length / 2;
  });
  let selected = 0;
  columns.forEach((c, i) => Math.abs(c - at) < Math.abs(columns[selected]! - at) && (selected = i));
  return { title: "Effort", options: [...EFFORT_LEVELS], selected, current: selected, axis: "horizontal" };
}

export function parsePrompt(screen: string): PanePrompt | null {
  const lines = screen.split("\n").map(clean);
  const slider = effortSlider(lines);
  if (slider) return slider;

  let cursor = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (new RegExp(`^\\s*${CURSOR}\\s+\\S`).test(lines[i]!)) {
      cursor = i;
      break;
    }
  }
  if (cursor < 0) return null;

  const numbered = NUMBERED.exec(lines[cursor]!.replace(CURSOR, " "));
  if (numbered) {
    // every numbered line near the cursor, 1..n in order; text below an option that sits left of
    // its text column is a wrapped continuation, text at or right of it is a description
    const options: string[] = [];
    let current: number | undefined;
    let first = -1;
    let selected = 0;
    let column = 0;
    const push = (m: RegExpExecArray, line: string, i: number) => {
      if (CURRENT.test(m[3]!)) current = options.length;
      options.push(optionText(m[3]!));
      column = line.indexOf(m[3]!);
      if (i === cursor) selected = options.length - 1;
    };
    for (let i = Math.max(0, cursor - 30); i < Math.min(lines.length, cursor + 30); i++) {
      const line = lines[i]!.replace(CURSOR, " ");
      const m = NUMBERED.exec(line);
      if (m && Number(m[2]) === options.length + 1) {
        if (first < 0) first = i;
        push(m, line, i);
      } else if (m && Number(m[2]) === 1) {
        // a new list starts: keep only the one around the cursor
        if (i > cursor) break;
        options.length = 0;
        current = undefined;
        first = i;
        push(m, line, i);
      } else if (options.length && line.trim() && indent(line) < column && !isRule(line) && !NOT_OPTION.test(line)) {
        options[options.length - 1] += " " + line.trim();
      } else if (options.length && !line.trim() && i > cursor) {
        // a blank line after the cursor's list ends it unless more options follow
        const next = lines.slice(i + 1).find((l) => l.trim());
        if (!next || !NUMBERED.test(next.replace(CURSOR, " "))) break;
      }
    }
    if (options.length < 2) return null;
    return { title: titleAbove(lines, first), options, selected, axis: "vertical", ...(current !== undefined ? { current } : {}) };
  }

  // unnumbered: siblings share the text column of the cursor line, up to a blank line. A cursor
  // at column 0 is the input prompt or an echoed message, never a menu
  const column = lines[cursor]!.indexOf(CURSOR) + 2;
  if (lines[cursor]!.indexOf(CURSOR) === 0) return null;
  const sibling = (line: string | undefined) => line !== undefined && line.trim() !== "" && indent(line) === column && !line.trimStart().startsWith(CURSOR) && !NOT_OPTION.test(line);
  let start = cursor;
  while (sibling(lines[start - 1])) start--;
  let end = cursor;
  while (sibling(lines[end + 1])) end++;
  if (end === start) return null;
  const options = lines.slice(start, end + 1).map((l) => optionText(l.replace(CURSOR, "")));
  return { title: titleAbove(lines, start), options, selected: cursor - start, axis: "vertical" };
}

/** arrow presses from the current selection to `index`, then Enter; null when out of range */
export function keysToChoose(prompt: PanePrompt, index: number): ("up" | "down" | "left" | "right" | "enter")[] | null {
  if (!Number.isInteger(index) || index < 0 || index >= prompt.options.length) return null;
  const steps = index - prompt.selected;
  const [back, forward] = prompt.axis === "horizontal" ? (["left", "right"] as const) : (["up", "down"] as const);
  return [...Array<"up" | "down" | "left" | "right">(Math.abs(steps)).fill(steps > 0 ? forward : back), "enter"];
}

// --- OpenCode's dialogs: the choice is marked by color only -------------------------------------

/** a terminal line as text plus each character's background color (null: the default) */
export function ansiCells(line: string): { text: string; bg: (string | null)[] } {
  let text = "";
  const bg: (string | null)[] = [];
  let current: string | null = null;
  const sgr = (params: number[]) => {
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      if (p === 0 || p === 49) current = null;
      else if (p === 48 && params[i + 1] === 2) {
        current = params.slice(i + 2, i + 5).join(",");
        i += 4;
      } else if (p === 48 && params[i + 1] === 5) {
        current = `#${params[i + 2]}`;
        i += 2;
      } else if (p === 38 && params[i + 1] === 2) i += 4;
      else if (p === 38 && params[i + 1] === 5) i += 2;
      else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) current = `#${p}`;
    }
  };
  // CSI sequences (colors handled, the rest skipped), OSC sequences skipped
  const re = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\r/g;
  let at = 0;
  for (let m = re.exec(line); ; m = re.exec(line)) {
    const end = m ? m.index : line.length;
    for (const ch of line.slice(at, end)) {
      text += ch;
      bg.push(current);
    }
    if (!m) break;
    if (m[2] === "m") sgr((m[1] || "0").split(";").map(Number));
    at = re.lastIndex;
  }
  return { text, bg };
}

/** the key hints at the end of OpenCode's dialog row: `ctrl+f fullscreen  ⇆ select  enter confirm` */
const OC_HINTS = /\s{2,}(?:ctrl\+f fullscreen\s+)?⇆ select.*$|\s{2,}enter confirm.*$/;

/**
 * OpenCode's permission dialog ("△ Permission required" … `Allow once   Allow always   Reject`):
 * options in a row, moved with ←/→, the chosen one only shown by its background. Read from the
 * screen with its colors (Herdr's `format: "ansi"`).
 */
export function parseOpencodePrompt(ansiScreen: string): PanePrompt | null {
  const rows = ansiScreen.split("\n").map(ansiCells);
  const plain = rows.map((r) => clean(r.text));
  let row = -1;
  for (let i = plain.length - 1; i >= 0; i--) {
    if (/⇆ select|enter confirm/.test(plain[i]!)) {
      row = i;
      break;
    }
  }
  if (row < 0) return null;
  const { text, bg } = rows[row]!;
  const hint = OC_HINTS.exec(text);
  const body = hint ? text.slice(0, hint.index) : text;
  // each label with where it starts, the borders left out
  const options: { label: string; at: number }[] = [];
  for (const m of body.matchAll(/[^\s┃│](?:\S| (?! ))*/g)) options.push({ label: m[0], at: m.index });
  if (options.length < 2) return null;
  // the chosen one has a background none of the others share
  const colors = options.map((o) => bg[o.at] ?? null);
  const selected = colors.findIndex((c) => colors.filter((d) => d === c).length === 1);

  // the title: the heading (△ …) and what it asks for (the ← line) above the row
  let title = "";
  for (let i = row - 1; i >= 0 && i >= row - 25; i--) {
    const line = plain[i]!.trim();
    if (/^[△⚠]/.test(line)) {
      const heading = line.replace(/^[△⚠]\s*/, "");
      const detail = plain.slice(i + 1, row).map((l) => l.trim()).find((l) => l && !/^Patterns$/.test(l));
      title = detail ? `${heading}: ${detail.replace(/^[←→]\s*/, "")}` : heading;
      break;
    }
  }
  if (!title) title = plain.slice(Math.max(0, row - 15), row).map((l) => l.trim()).filter(Boolean).at(-1) ?? "OpenCode is asking";
  return { title, options: options.map((o) => o.label), selected: Math.max(0, selected), axis: "horizontal" };
}
