/**
 * Which theme is on, and who decided.
 *
 * Three states, not two, and the third is the important one. "System" means the
 * app follows the machine — light through the working day, dark once the OS
 * turns over in the evening — and it is the default, because someone who has
 * already told their computer how they like to see things has told us too.
 * A two-state toggle throws that away and makes every new visitor re-answer a
 * question they answered once, globally.
 *
 * An explicit choice overrides it and is remembered. It also stops following
 * the system from that moment: someone who deliberately picked dark at noon
 * does not want us undoing it at dusk.
 *
 * The class is applied to <html>, not <body>, so the background colour reaches
 * the overscroll area and the page does not flash black at the edges of a
 * rubber-band scroll on a light theme.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/** Shared with the inline script in index.html — see the note there. */
export const THEME_STORAGE_KEY = "editly:theme";

interface ThemeContextValue {
  /** What the user chose, including "system". */
  preference: ThemePreference;
  /** What is actually on screen right now. Never "system". */
  theme: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
  /** Light → dark → system → light. What the header button does. */
  cycle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function prefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function readStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // Private browsing, or storage disabled. Not a reason to fail to render.
  }
  return "system";
}

function resolve(preference: ThemePreference): ResolvedTheme {
  if (preference === "system") return prefersDark() ? "dark" : "light";
  return preference;
}

/**
 * Put the resolved theme on <html>.
 *
 * `color-scheme` is set alongside the class because it is what tells the
 * browser to draw its *own* surfaces — scrollbars, the caret, date pickers,
 * form controls it renders natively — in the matching theme. Without it a
 * light page keeps a dark scrollbar down the side, which is the sort of detail
 * nobody reports and everybody notices.
 */
function apply(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.toggle("light", theme === "light");
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const [theme, setTheme] = useState<ResolvedTheme>(() => resolve(readStoredPreference()));

  useEffect(() => {
    const next = resolve(preference);
    setTheme(next);
    apply(next);
  }, [preference]);

  // Only while following the system. Once someone has chosen, the OS flipping
  // at sunset must not undo their choice.
  useEffect(() => {
    if (preference !== "system") return;
    if (typeof window === "undefined" || !window.matchMedia) return;

    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const next: ResolvedTheme = query.matches ? "dark" : "light";
      setTheme(next);
      apply(next);
    };

    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // The theme still applies for this session; it just will not be remembered.
    }
  }, []);

  const cycle = useCallback(() => {
    setPreference(preference === "light" ? "dark" : preference === "dark" ? "system" : "light");
  }, [preference, setPreference]);

  const value = useMemo(
    () => ({ preference, theme, setPreference, cycle }),
    [preference, theme, setPreference, cycle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside a ThemeProvider");
  return context;
}
