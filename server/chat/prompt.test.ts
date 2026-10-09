import { expect, test } from "bun:test";
import { keysToChoose, parsePrompt } from "./prompt.ts";

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
☐ Migraciones

¿Aplico las 2 migraciones antes de correr los tests?

  1. Sí, en la base local
     Recomendado · no toca staging
❯ 2. No, solo los tests
     Algunos fallarán por el esquema
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
    title: "¿Aplico las 2 migraciones antes de correr los tests?",
    options: ["Sí, en la base local", "No, solo los tests", "Type something."],
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
  expect(p).toEqual({ title: "Esfuerzo", options: ["low", "medium", "high", "xhigh", "max"], selected: 2, current: 2, axis: "horizontal" });
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
