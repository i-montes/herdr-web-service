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
  return { title: "Esfuerzo", options: [...EFFORT_LEVELS], selected, current: selected, axis: "horizontal" };
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
