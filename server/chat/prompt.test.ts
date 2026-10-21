import { expect, test } from "bun:test";
import { ansiCells, mayShowOpencodeDialog, parseOpencodePrompt, keysToChoose, keysToStep, parsePrompt, questionStep } from "./prompt.ts";

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
    descriptions: ["Recommended · does not touch staging", "Some will fail because of the schema", null],
    selected: 1,
    axis: "vertical",
    question: true,
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

test("OpenCode: the hints as plain text, without the dialog's heading, are not a dialog", () => {
  // a command shown on another agent's screen that mentions them
  const shown = [border(esc("238;238;238", "20;20;20", "  Bash(python3 - <<'EOF' … `Allow once   Allow always   Reject`, `⇆ select`/`enter confirm`)")), border(esc("128;128;128", "20;20;20", "     … +68 lines"))].join("\n");
  expect(parseOpencodePrompt(shown)).toBeNull();
  expect(parseOpencodePrompt(opencodeScreen(0).split("\n").slice(4).join("\n"))).toBeNull();
});

const QPANEL = "20;20;20";
const questionScreen = (chosen: number) =>
  [
    border(esc("238;238;238", QPANEL, "  ¿Qué hago con los iconos actuales y los nuevos?")),
    border(""),
    ...[
      ["Tú me pasas los nuevos archivos ahora", "Espera a que coloques los PNG en public/ y los referencio desde el"],
      ["Generar placeholders con SVG", "Creo SVGs neutros y los coloco como icon-192.png"],
      ["Type your own answer", null],
    ].flatMap(([label, description], i) => [
      border(esc("238;238;238", i === chosen ? PANEL : QPANEL, `  ${i + 1}. ${label}`) + esc("255;255;255", QPANEL, " ".repeat(40) + "~/proyectos/recova-crm:main")),
      ...(description ? [border(esc("128;128;128", QPANEL, `     ${description}`)), ...(i === 0 ? [border(esc("128;128;128", QPANEL, "     manifest."))] : [])] : []),
    ]),
    border(esc("128;128;128", QPANEL, "  ↑↓ select  enter submit  esc dismiss") + esc("255;255;255", QPANEL, " ".repeat(40) + "• OpenCode 1.18.35")),
  ].join("\n");

test("OpenCode's question: numbered options with their descriptions, the chosen row by its background", () => {
  expect(parseOpencodePrompt(questionScreen(0))).toEqual({
    title: "¿Qué hago con los iconos actuales y los nuevos?",
    options: ["Tú me pasas los nuevos archivos ahora · Espera a que coloques los PNG en public/ y los referencio desde el manifest.", "Generar placeholders con SVG · Creo SVGs neutros y los coloco como icon-192.png", "Type your own answer"],
    selected: 0,
    axis: "vertical",
  });
  // the plain read is what decides to read the colors: both dialogs must pass it
  const plainOf = (screen: string) => screen.replace(/\x1b\[[0-9;]*m|\r/g, "");
  expect(parsePrompt(plainOf(questionScreen(0)))).toBeNull();
  expect(mayShowOpencodeDialog(plainOf(questionScreen(0)))).toBe(true);
  expect(mayShowOpencodeDialog(plainOf(opencodeScreen(0)))).toBe(true);
  expect(mayShowOpencodeDialog("  ▣  Build · MiniMax-M3")).toBe(false);
  const second = parseOpencodePrompt(questionScreen(1))!;
  expect(second.selected).toBe(1);
  expect(keysToChoose(second, 2)).toEqual(["down", "enter"]);
});

test("ansi cells: text and backgrounds, 256 colors and resets included", () => {
  expect(ansiCells("a\x1b[48;5;21mbc\x1b[0md\x1b]0;title\x07e\r")).toEqual({ text: "abcde", bg: [null, "#21", "#21", null, null] });
  expect(ansiCells("\x1b[44mx\x1b[49my").bg).toEqual(["#44", null]);
});

// several questions in one, as Claude Code 2.1 draws them: tabs, checkboxes, "Next", a review
const RULE = "────────────────────────────────────────────────────────────";
const toppings = (cursor: "olives" | "next") => `
${RULE}
←  ☒ Color  ☒ Toppings  ☐ Size  ✔ Submit  →

Which toppings do you want?

  1. [✔] Cheese
         classic
${cursor === "olives" ? "❯" : " "} 2. [ ] Olives
         salty
  3. [✔] Basil
         fresh
  4. [ ] Type something
${cursor === "next" ? "❯" : " "}    Next
${RULE}
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

test("a multiple choice: its ticks, and Next as a choice without a number", () => {
  const prompt = parsePrompt(toppings("olives"))!;
  expect(prompt).toMatchObject({
    title: "Which toppings do you want?",
    options: ["Cheese", "Olives", "Basil", "Type something", "Next", "Chat about this"],
    checked: [true, false, true, false, null, null],
    next: 4,
    selected: 1,
    steps: [
      { label: "Color", answered: true },
      { label: "Toppings", answered: true },
      { label: "Size", answered: false },
    ],
  });
  // the ✔ of a ticked box is not the current setting
  expect(prompt.current).toBeUndefined();
  // "Chat about this" sits below Next: one more step down than its number says
  expect(keysToChoose(prompt, 5)).toEqual(["down", "down", "down", "down", "enter"]);
  // the cursor on Next still reads the whole menu
  expect(parsePrompt(toppings("next"))).toMatchObject({ selected: 4, next: 4, options: prompt.options });
});

test("the review before submitting, the last of the tabs", () => {
  const review = `
${RULE}
←  ☒ Pet  ☐ Fruit  ✔ Submit  →

Review your answers

⚠ You have not answered all questions

 ● Cat or dog?
   → Cat

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel
`;
  const prompt = parsePrompt(review)!;
  expect(prompt).toMatchObject({
    title: "Ready to submit your answers?",
    options: ["Submit answers", "Cancel"],
    review: [{ question: "Cat or dog?", answer: "Cat" }],
    step: 2,
  });
  expect(keysToStep(prompt, 0)).toEqual(["left", "left"]);
  expect(keysToStep(prompt, 2)).toEqual([]);
  expect(keysToStep(prompt, 3)).toBeNull();
});

test("the question on screen is the tab on its own background", () => {
  const row = (colored: number) => {
    const tabs = [" ☒ Pet ", " ☐ Fruit ", " ✔ Submit "];
    return "\x1b[38;2;153;153;153m← \x1b[0m" + tabs.map((t, i) => (i === colored ? `\x1b[38;2;0;0;0m\x1b[48;2;177;185;249m${t}\x1b[0m` : t)).join(" ") + " →";
  };
  expect(questionStep(`\n${row(0)}\n\nCat or dog?\n`)).toBe(0);
  expect(questionStep(`\n${row(1)}\n`)).toBe(1);
  expect(questionStep(`\n${row(2)}\n`)).toBe(2);
  expect(questionStep("no tabs here")).toBeNull();
  const prompt = { ...parsePrompt(toppings("olives"))!, step: 1 };
  expect(keysToStep(prompt, 3)).toEqual(["right", "right"]);
  expect(keysToStep(prompt, 0)).toEqual(["left"]);
});
