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
/** a multiple choice's checkbox at the start of an option: `[✔] Cheese`, `[ ] Olives` */
const CHECKBOX = /^\[([ ✔✓])\]\s+/;
/** the unnumbered row under a multiple choice that confirms it, maybe under the cursor */
const NEXT = /^\s*(?:❯\s*)?(Next|Submit)\s*$/;
/** Claude Code's question tabs: `←  ☒ Color  ☐ Toppings  ✔ Submit  →` */
const TABS = /^\s*←\s+(.*[☐☒].*?)\s+→\s*$/;

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

/** the tabs of several questions in one: each header and whether it has an answer */
function questionSteps(lines: string[]): { label: string; answered: boolean }[] | null {
  for (const line of lines) {
    const row = TABS.exec(line);
    if (!row) continue;
    const steps = [...row[1]!.matchAll(/([☐☒])\s+(\S(?:\S| (?! ))*)/g)].map((m) => ({ label: m[2]!, answered: m[1] === "☒" }));
    if (steps.length) return steps;
  }
  return null;
}

/** the review before submitting: `● question` lines, each with its `→ answer` below */
function reviewOf(lines: string[]): { question: string; answer: string }[] | null {
  const start = lines.findIndex((l) => l.trim() === "Review your answers");
  if (start < 0) return null;
  const review: { question: string; answer: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const text = lines[i]!.trim();
    if (text.startsWith("●")) review.push({ question: text.replace(/^●\s*/, ""), answer: "" });
    else if (text.startsWith("→") && review.length) review[review.length - 1]!.answer = text.replace(/^→\s*/, "");
    else if (text.startsWith(CURSOR) || NUMBERED.test(text)) break;
  }
  return review;
}

/**
 * Which tab of several questions is on screen: the only one on its own background (the screen
 * with its colors). An index into the tabs, Submit (the review) last; null when unseen.
 */
export function questionStep(ansiScreen: string): number | null {
  for (const { text, bg } of ansiScreen.split("\n").map(ansiCells)) {
    if (!TABS.test(clean(text))) continue;
    const colors = [...text.matchAll(/[☐☒✔]/g)].map((m) => bg[m.index] ?? null);
    const step = colors.findIndex((c) => c !== null && colors.filter((d) => d === c).length === 1);
    return step >= 0 ? step : null;
  }
  return null;
}

export function parsePrompt(screen: string): PanePrompt | null {
  const menu = parseMenu(screen);
  if (!menu) return null;
  // only AskUserQuestion offers to write your own answer, or to talk it over instead
  const asks = menu.checked || menu.options.some((o) => /^Type something\.?$|^Chat about this$/.test(o));
  const prompt = asks ? { ...menu, question: true } : menu;
  const lines = screen.split("\n").map(clean);
  const steps = questionSteps(lines);
  if (!steps) return prompt;
  const review = reviewOf(lines);
  // the review is the last tab; elsewhere the colors tell which question is on screen
  return { ...prompt, question: true, steps, ...(review ? { review, step: steps.length } : {}) };
}

function parseMenu(screen: string): PanePrompt | null {
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
  if (numbered || NEXT.test(lines[cursor]!)) {
    // every numbered line near the cursor, 1..n in order; text below an option that sits left of
    // its text column is a wrapped continuation, text at or right of it is a description
    const options: string[] = [];
    const descriptions: (string | null)[] = [];
    const checked: (boolean | null)[] = [];
    let current: number | undefined;
    let next: number | undefined;
    let first = -1;
    let selected = 0;
    let column = 0;
    const push = (m: RegExpExecArray, line: string, i: number) => {
      // a checkbox is the state of the option, not part of its label (nor its ✔ the current setting)
      const box = CHECKBOX.exec(m[3]!);
      if (!box && CURRENT.test(m[3]!)) current = options.length;
      checked.push(box ? box[1] !== " " : null);
      descriptions.push(null);
      options.push(optionText(m[3]!.replace(CHECKBOX, "")));
      column = line.indexOf(m[3]!);
      if (i === cursor) selected = options.length - 1;
    };
    for (let i = Math.max(0, cursor - 30); i < Math.min(lines.length, cursor + 30); i++) {
      const line = lines[i]!.replace(CURSOR, " ");
      const m = NUMBERED.exec(line);
      // the unnumbered "Next" row takes a place in `options`, not a number
      if (m && Number(m[2]) === options.length + (next === undefined ? 1 : 0)) {
        if (first < 0) first = i;
        push(m, line, i);
      } else if (m && Number(m[2]) === 1) {
        // a new list starts: keep only the one around the cursor
        if (i > cursor) break;
        options.length = 0;
        descriptions.length = 0;
        checked.length = 0;
        current = undefined;
        next = undefined;
        first = i;
        push(m, line, i);
      } else if (options.length && checked.some((c) => c !== null) && next === undefined && NEXT.test(lines[i]!)) {
        // a multiple choice's confirm row: a choice like the others, without a number
        next = options.length;
        checked.push(null);
        descriptions.push(null);
        options.push(NEXT.exec(lines[i]!)![1]!);
        if (i === cursor) selected = next;
      } else if (options.length && line.trim() && indent(line) < column && !isRule(line) && !NOT_OPTION.test(line)) {
        options[options.length - 1] += " " + line.trim();
      } else if (options.length && line.trim() && !isRule(line) && !NOT_OPTION.test(line)) {
        // at or right of the text column: the option's description, maybe wrapped
        const last = options.length - 1;
        descriptions[last] = descriptions[last] ? `${descriptions[last]} ${line.trim()}` : line.trim();
      } else if (options.length && !line.trim() && i > cursor) {
        // a blank line after the cursor's list ends it unless more options follow
        const following = lines.slice(i + 1).find((l) => l.trim());
        if (!following || !NUMBERED.test(following.replace(CURSOR, " "))) break;
      }
    }
    if (options.length < 2) return null;
    const multiple = checked.some((c) => c !== null) ? { checked, ...(next !== undefined ? { next } : {}) } : {};
    const described = descriptions.some((d) => d !== null) ? { descriptions } : {};
    return { title: titleAbove(lines, first), options, selected, axis: "vertical", ...(current !== undefined ? { current } : {}), ...multiple, ...described };
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

/** arrow presses from the question on screen to the `step`-th tab (the review last); null when out of range */
export function keysToStep(prompt: PanePrompt, step: number): ("left" | "right")[] | null {
  if (!prompt.steps || prompt.step === undefined || !Number.isInteger(step) || step < 0 || step > prompt.steps.length) return null;
  const moves = step - prompt.step;
  return Array<"left" | "right">(Math.abs(moves)).fill(moves > 0 ? "right" : "left");
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

/** the key hints under OpenCode's dialogs: permission (`⇆ select  enter confirm`) or question (`↑↓ select  enter submit`) */
const OC_DIALOG = /⇆ select|enter confirm|↑↓ select\s+enter submit/;

/** a screen that may show one of OpenCode's dialogs: worth reading again with its colors */
export function mayShowOpencodeDialog(plainScreen: string): boolean {
  return OC_DIALOG.test(plainScreen);
}

/** the key hints at the end of OpenCode's dialog row: `ctrl+f fullscreen  ⇆ select  enter confirm` */
const OC_HINTS = /\s{2,}(?:ctrl\+f fullscreen\s+)?⇆ select.*$|\s{2,}enter confirm.*$/;

/**
 * OpenCode's permission dialog ("△ Permission required" … `Allow once   Allow always   Reject`):
 * options in a row, moved with ←/→, the chosen one only shown by its background. Both the row's
 * key hints and the △ heading above it must be there. Read from the
 * screen with its colors (Herdr's `format: "ansi"`).
 */
export function parseOpencodePrompt(ansiScreen: string): PanePrompt | null {
  const rows = ansiScreen.split("\n").map(ansiCells);
  const plain = rows.map((r) => clean(r.text));
  let row = -1;
  for (let i = plain.length - 1; i >= 0; i--) {
    if (OC_DIALOG.test(plain[i]!)) {
      row = i;
      break;
    }
  }
  if (row < 0) return null;
  // the question dialog: numbered options down the screen, hints `↑↓ select  enter submit`
  if (/↑↓ select|enter submit/.test(plain[row]!) && !/⇆ select/.test(plain[row]!)) return opencodeQuestion(rows, plain, row);
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
  // without its heading the row is not the dialog: those words were text on the screen
  if (!title) return null;
  return { title, options: options.map((o) => o.label), selected: Math.max(0, selected), axis: "horizontal" };
}

/**
 * OpenCode's question tool: the question, then `1. label` rows each with an indented description,
 * the chosen row on its own background. Answered with ↑/↓ and Enter.
 */
function opencodeQuestion(rows: { text: string; bg: (string | null)[] }[], plain: string[], row: number): PanePrompt | null {
  const options: string[] = [];
  const colors: (string | null)[] = [];
  let first = -1;
  let column = 0;
  for (let i = Math.max(0, row - 60); i < row; i++) {
    // OpenCode's sidebar shares the rows, far to the right: cut it off
    const line = plain[i]!.replace(/(\S)\s{6,}\S.*$/, "$1");
    const m = /^(\s*)(\d+)\.\s+(\S.*)$/.exec(line);
    if (m && Number(m[2]) === options.length + 1) {
      if (first < 0) first = i;
      options.push(m[3]!.trim());
      column = line.indexOf(m[3]!);
      const at = rows[i]!.text.indexOf(`${m[2]}.`);
      colors.push(rows[i]!.bg[at] ?? null);
    } else if (m && Number(m[2]) === 1) {
      // an earlier numbered list (the agent's text): start over
      options.length = 0;
      colors.length = 0;
      first = i;
      options.push(m[3]!.trim());
      column = line.indexOf(m[3]!);
      const at = rows[i]!.text.indexOf("1.");
      colors.push(rows[i]!.bg[at] ?? null);
    } else if (options.length && line.trim() && indent(line) >= column && indent(line) <= column + 4) {
      // the description under an option (wrapped onto several rows)
      const last = options.length - 1;
      options[last] += (options[last]!.includes(" · ") ? " " : " · ") + line.trim();
    }
  }
  if (options.length < 2 || first < 1) return null;
  const selected = colors.findIndex((c) => colors.filter((d) => d === c).length === 1);
  const title = plain.slice(Math.max(0, first - 8), first).map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  if (!title) return null;
  return { title, options, selected: Math.max(0, selected), axis: "vertical" };
}
