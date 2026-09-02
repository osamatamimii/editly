/**
 * Which screens are written in both languages, and where the choice is kept.
 *
 * Split from `language.tsx` because this half has no React in it, and a suite
 * that wants to read the route list should not have to stand up a DOM to do
 * it. `tools/language-test.mjs` imports this module directly and compares it
 * against the copy of the same list inside `index.html`.
 */
import { DEFAULT_LANGUAGE, isLanguage, type Language } from "@/lib/landing-copy";

/**
 * Where the choice lives.
 *
 * One key for the product rather than one for the landing page, because a
 * person who switched the marketing site to English and then signed up has
 * already said which language they read.
 */
export const LANGUAGE_KEY = "editly:language";

/** What the landing page used before there was an app-wide preference. */
const LEGACY_KEY = "editly:landing-language";

/**
 * The screens whose copy exists in both languages.
 *
 * This list is the seam, and it is deliberately short and boring: a route is
 * added by the commit that translates it, not by the commit that intends to.
 * Paths are matched by prefix so `/onboarding` covers nothing else and a future
 * `/account` would cover only itself.
 */
export const BILINGUAL: readonly string[] = ["/", "/onboarding"];

export function isBilingualRoute(pathname: string): boolean {
  if (pathname === "/") return true;
  return BILINGUAL.some((route) => route !== "/" && (pathname === route || pathname.startsWith(`${route}/`)));
}

/**
 * The stored preference, or the default.
 *
 * `?lang=` wins, so a link can carry a language. Every read is wrapped:
 * `localStorage` does not merely return null in some privacy modes, it throws.
 */
export function storedLanguage(): Language {
  try {
    const asked = new URLSearchParams(window.location.search).get("lang");
    if (isLanguage(asked)) return asked;
  } catch {
    /* no URL to read */
  }
  try {
    const kept = window.localStorage.getItem(LANGUAGE_KEY) ?? window.localStorage.getItem(LEGACY_KEY);
    if (isLanguage(kept)) return kept;
  } catch {
    /* storage blocked */
  }
  return DEFAULT_LANGUAGE;
}
