/**
 * Light/dark theme. With no choice stored the page follows the system (CSS media query); a choice
 * sets data-theme on <html>, which the tokens in index.css honour. Stored per browser.
 */
import { useEffect, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "herdr-web.theme";
const CANVAS: Record<Theme, string> = { light: "#f3f1ea", dark: "#141412" };
const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

function stored(): Theme | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function apply(choice: Theme | null): void {
  const root = document.documentElement;
  if (choice) root.dataset["theme"] = choice;
  else delete root.dataset["theme"];
  const effective = choice ?? (darkQuery().matches ? "dark" : "light");
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = CANVAS[effective];
    meta.removeAttribute("media");
  }
}

/** run before the first render so a stored choice never flashes the other theme */
export function initTheme(): void {
  apply(stored());
}

/** the theme on screen and a toggle that stores the opposite one */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [choice, setChoice] = useState<Theme | null>(stored);
  const [systemDark, setSystemDark] = useState(() => darkQuery().matches);

  useEffect(() => {
    const query = darkQuery();
    const onChange = () => {
      setSystemDark(query.matches);
      if (!stored()) apply(null);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const theme: Theme = choice ?? (systemDark ? "dark" : "light");
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode: the choice lasts this page only */
    }
    setChoice(next);
    apply(next);
  };
  return { theme, toggle };
}
