/** Fitting a pane's screen into the terminal view without sideways scrolling. Pure helpers. */

/** JetBrains Mono advances 600/1000 em per character */
export const CHAR_EM = 0.6;
export const MIN_FONT_PX = 10;
export const MAX_FONT_PX = 14;

/** a line drawn only with rule characters: shown as a full-width rule instead of characters */
export function isRule(line: string): boolean {
  return /^\s*[─━═]{3,}[─━═\s]*$/.test(line);
}

/**
 * The font size that makes the widest line fit `width` px, between MIN and MAX; when even the
 * minimum does not fit, `wrap` asks for long lines to wrap. Rules never count: they stretch.
 */
export function fitTerminal(lines: string[], width: number): { fontPx: number; wrap: boolean } {
  const cols = Math.max(1, ...lines.filter((l) => !isRule(l)).map((l) => [...l.replace(/\s+$/, "")].length));
  const fits = Math.floor((width / (cols * CHAR_EM)) * 10) / 10;
  if (fits >= MIN_FONT_PX) return { fontPx: Math.min(MAX_FONT_PX, fits), wrap: false };
  return { fontPx: MIN_FONT_PX, wrap: true };
}
