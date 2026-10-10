import { expect, test } from "bun:test";
import { ansiCells, parseOpencodePrompt, keysToChoose, parsePrompt } from "./prompt.ts";

const trust = `
❯ claude

───────────────────────────────────────────────────────
 Accessing workspace:

 /Users/ana/p/notas

 Quick safety check: Is this a project you created or one you trust? If not, take
 a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`;

const permission = `
⏺ Bash(npm run test)
  ⎿  Running…

╭──────────────────────────────────────────────╮
│ Bash command                                 │
│                                              │
│   npm run test                               │
│   Run the test suite                         │
│                                              │
│ Do you want to proceed?                      │
│ ❯ 1. Yes                                     │
│   2. Yes, and don't ask again for npm run    │
│ test commands in /Users/ana/p                │
│   3. No, and tell Claude what to do          │
│ differently (esc)                            │
╰──────────────────────────────────────────────╯
`;

const question = `
☐ Migrations

Apply the 2 migrations before running the tests?

  1. Yes, on the local database
     Recommended · does not touch staging
❯ 2. No, just the tests
     Some will fail because of the schema
  3. Type something.

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

test("trust prompt: unnumbered options", () => {
  expect(parsePrompt(trust)).toEqual({ title: "Quick safety check: Is this a project you created or one you trust? If not, take", options: ["No, exit", "Yes, I trust this folder"], selected: 0, axis: "vertical" });
});

test("permission prompt inside a box, wrapped options joined", () => {
  expect(parsePrompt(permission)).toEqual({
    title: "Do you want to proceed?",
    options: ["Yes", "Yes, and don't ask again for npm run test commands in /Users/ana/p", "No, and tell Claude what to do differently (esc)"],
    selected: 0,
    axis: "vertical",
  });
});

test("question: descriptions are not options, the cursor can be anywhere", () => {
  expect(parsePrompt(question)).toEqual({
    title: "Apply the 2 migrations before running the tests?",
    options: ["Yes, on the local database", "No, just the tests", "Type something."],
    selected: 1,
    axis: "vertical",
  });
});

test("nothing to choose", () => {
  expect(parsePrompt("❯ ls\nfile.txt\n❯ ")).toBeNull();
  expect(parsePrompt("")).toBeNull();
});

test("keys to choose an option", async () => {
  const p = { title: "", options: ["a", "b", "c"], selected: 1, axis: "vertical" as const };
  expect(keysToChoose(p, 1)).toEqual(["enter"]);
  expect(keysToChoose(p, 2)).toEqual(["down", "enter"]);
  expect(keysToChoose(p, 0)).toEqual(["up", "enter"]);
  expect(keysToChoose(p, 3)).toBeNull();
  expect(keysToChoose(p, -1)).toBeNull();
  expect(keysToChoose({ ...p, axis: "horizontal" }, 2)).toEqual(["right", "enter"]);
  expect(keysToChoose({ ...p, axis: "horizontal" }, 0)).toEqual(["left", "enter"]);
});

const modelMenu = `
 ▐▛███▛█   Claude Code v2.1.295
▝▜██████▀  Fable 5.1 with high effort · Claude Team
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ ● high · /effort ▔
   Select model
   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.

     1.  Default (recommended)  Fable 5.1
     2.  Opus 5.5               For complex work and everyday tasks
     3.  Sonnet 5.5             Most efficient for simpler tasks
   ❯ 4.  Fable 5.1 ✔            For your toughest challenges
     5.  Haiku 5.5              Fastest for quick answers
   ↓ 6.  Haiku 4.5              Fastest for quick answers
      … +3 models

   ● High effort (default) ←/→ to adjust
   Enter to set as default · s to use this session only · Esc to cancel
`;

test("/model: numbered with descriptions, the current one marked, scrolled rows included", () => {
  expect(parsePrompt(modelMenu)).toEqual({
    title: "Select model",
    options: ["Default (recommended) · Fable 5.1", "Opus 5.5 · For complex work and everyday tasks", "Sonnet 5.5 · Most efficient for simpler tasks", "Fable 5.1 · For your toughest challenges", "Haiku 5.5 · Fastest for quick answers", "Haiku 4.5 · Fastest for quick answers"],
    selected: 3,
    current: 3,
    axis: "vertical",
  });
});

const effortSlider = `
❯ /model
  ⎿  Kept model as Fable 5.1
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ ● high · /effort ▔
   Effort
                     Faster                             Smarter
                     ────────────────────▲─────────────────────      Ultracode  off
                     low     medium     high     xhigh      max      Tab to toggle
   ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel
`;

test("/effort: a slider read as levels, answered with ←/→", () => {
  const p = parsePrompt(effortSlider);
  expect(p).toEqual({ title: "Effort", options: ["low", "medium", "high", "xhigh", "max"], selected: 2, current: 2, axis: "horizontal" });
  expect(keysToChoose(p!, 4)).toEqual(["right", "right", "enter"]);
});

test("echoed commands and results at the left edge are not a menu", () => {
  expect(parsePrompt(`
❯ /model
  ⎿  Kept model as Fable 5.1
❯ /output-style
  ⎿  Output style: default
     Available styles:
     - default (current)
───────────────────────────────
❯
───────────────────────────────
  ⏸ manual mode on · ? for shortcuts
`)).toBeNull();
});

// OpenCode's permission dialog as Herdr reads it with `format: "ansi"` (24-bit colors, the chosen
// option on the accent background, the others on the panel's)
const esc = (fg: string, bg: string, text: string) => `\x1b[0m\x1b[38;2;${fg}m\x1b[48;2;${bg}m${text}`;
const PANEL = "30;30;30";
const ACCENT = "245;167;66";
const border = (rest: string) => esc("255;255;255", "10;10;10", "  ") + esc(ACCENT, "20;20;20", "┃") + rest + "\x1b[0m\r";
const dialogRow = (chosen: number) => {
  const labels = ["Allow once", "Allow always", "Reject"];
  const parts = labels.map((label, i) => (i === chosen ? esc("255;255;255", ACCENT, " ") + esc("10;10;10", ACCENT, label) + esc("255;255;255", ACCENT, " ") : esc("128;128;128", PANEL, label)));
  return border(esc("255;255;255", PANEL, "  ") + parts.join(esc("255;255;255", PANEL, "   ")) + esc("255;255;255", PANEL, "        ") + esc("238;238;238", PANEL, "ctrl+f fullscreen  ⇆ select  enter confirm"));
};
const opencodeScreen = (chosen: number) =>
  [
    border(esc("238;238;238", "20;20;20", "  $ grep -rn brand app/layout.tsx")),
    border(""),
    border(esc(ACCENT, "20;20;20", "  △ ") + esc("238;238;238", "20;20;20", "Permission required")),
    border(esc("128;128;128", "20;20;20", "    ← ") + esc("238;238;238", "20;20;20", "Access external directory ~/proyectos/recova-crm-pwa/app")),
    border(""),
    border(esc("128;128;128", "20;20;20", "  Patterns")),
    border(esc("238;238;238", "20;20;20", "  - /home/ubuntu/proyectos/recova-crm-pwa/app/*")),
    border(esc("255;255;255", PANEL, "    ")),
    dialogRow(chosen),
    border(esc("255;255;255", PANEL, "    ")),
  ].join("\n");

test("OpenCode's permission dialog: the choice is the option with its own background", () => {
  const prompt = parseOpencodePrompt(opencodeScreen(0));
  expect(prompt).toEqual({ title: "Permission required: Access external directory ~/proyectos/recova-crm-pwa/app", options: ["Allow once", "Allow always", "Reject"], selected: 0, axis: "horizontal" });
  expect(parseOpencodePrompt(opencodeScreen(1))!.selected).toBe(1);
  // answered with ←/→ and Enter, like the dialog's own keys
  expect(keysToChoose(prompt!, 2)).toEqual(["right", "right", "enter"]);
  expect(keysToChoose(parseOpencodePrompt(opencodeScreen(2))!, 0)).toEqual(["left", "left", "enter"]);
});

test("OpenCode: no dialog row, no prompt; the plain reader leaves it alone", () => {
  expect(parseOpencodePrompt(border(esc("238;238;238", "20;20;20", "  ▣  Build · MiniMax-M3")))).toBeNull();
  const plain = opencodeScreen(0).replace(/\x1b\[[0-9;]*m|\r/g, "");
  expect(parsePrompt(plain)).toBeNull();
});

test("ansi cells: text and backgrounds, 256 colors and resets included", () => {
  expect(ansiCells("a\x1b[48;5;21mbc\x1b[0md\x1b]0;title\x07e\r")).toEqual({ text: "abcde", bg: [null, "#21", "#21", null, null] });
  expect(ansiCells("\x1b[44mx\x1b[49my").bg).toEqual(["#44", null]);
});
