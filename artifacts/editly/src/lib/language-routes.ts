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
 * This list is the seam, and it stays a list of what *is* translated rather
 * than a list of exceptions. It was three routes; it is now the product,
 * because the product is written in both languages. The temptation at that
 * point is to invert it — "everything except the legal pages" — and that would
 * throw away the only property this file has: a route joins on the commit that
 * translates it, and `tools/language-test.mjs` refuses a member with bare
 * English left in it. Inverted, a screen added next month would claim Arabic it
 * does not have, which is the exact bug `lib/language.tsx` was written about.
 *
 * Paths are matched by prefix, so `/project` covers `/project/:id` and
 * `/export` covers `/export/:id`.
 *
 * `/privacy` and `/terms` are deliberately absent. They are the two screens in
 * this product whose words are a commitment rather than a description, and an
 * Arabic privacy policy written by whoever was translating the buttons is a
 * liability with a language toggle on it. They keep declaring English until a
 * lawyer has written the Arabic.
 *
 * The 404 is absent for a different reason: it has no path of its own. It
 * answers at whatever address was mistyped, so it cannot be listed here, and it
 * sets `lang` and `dir` on its own wrapper the way the landing page does.
 */
export const BILINGUAL: readonly string[] = [
  "/",
  "/login",
  "/reset-password",
  "/unsubscribe",
  "/onboarding",
  "/dashboard",
  "/project",
  "/export",
  "/clips",
  "/scheduled",
  "/account",
  "/admin",
];

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
