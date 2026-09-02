/**
 * One language for the whole product, and a document that does not lie about it.
 *
 * ## What was wrong
 *
 * `index.html` declared `lang="ar" dir="rtl"` on the document, because the
 * product's default language is Arabic and the landing page is written in it.
 * The landing page then sets its own `lang`/`dir` on its wrapper, so it was
 * always correct. Everything behind the login screen is written in English and
 * set nothing, so it inherited `rtl` from the root and rendered English text
 * right to left.
 *
 * Measured on a real Chromium at 390px, signed in, on `/account`:
 *
 *   - the back chevron sat on the right, pointing away from where it goes
 *   - "Uploading doesn't spend them." rendered as ".Uploading doesn't spend them"
 *   - the price rendered as "9/month$" rather than "$9/month"
 *
 * That is the bidi algorithm doing exactly what it was told: a trailing full
 * stop and a leading currency symbol are neutral characters, and in a
 * right-to-left paragraph they go to the other end. Every English sentence on
 * every signed-in screen ended with a leading full stop, and every price had
 * its dollar sign on the wrong side, for every customer, in production.
 *
 * Nothing failed. No console error, no log line, no test. It looks like
 * carelessness rather than a bug, which is worse, because it is the screen
 * where somebody decides whether to pay.
 *
 * ## What this does instead
 *
 * The document declares the language of the screen it is actually showing.
 *
 * A person's language choice is a preference, remembered across the product
 * and shared with the landing page. But the preference is not what the document
 * announces: `BILINGUAL` below lists the screens whose copy exists in both
 * languages, and everywhere else the document says English, because that is
 * what is on it. A route joins that list on the commit that translates it, and
 * `tools/language-test.mjs` refuses a member with untranslated English in it.
 *
 * The alternative — declaring Arabic everywhere and translating later — is how
 * the bug above happened. A document that claims a language it is not written
 * in is wrong today in exchange for being right eventually.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { directionOf, say, type Language, type Phrase } from "@/lib/landing-copy";
import { LANGUAGE_KEY, isBilingualRoute, storedLanguage } from "@/lib/language-routes";

export { BILINGUAL, LANGUAGE_KEY, isBilingualRoute, storedLanguage } from "@/lib/language-routes";

interface LanguageValue {
  /** What the person reads, wherever they are in the product. */
  language: Language;
  /** What this screen is actually written in, which is what the document says. */
  screenLanguage: Language;
  choose: (next: Language) => void;
  /** The half of a pair this person reads. */
  t: (phrase: Phrase) => string;
}

const Context = createContext<LanguageValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [language, setLanguage] = useState<Language>(storedLanguage);

  const screenLanguage: Language = isBilingualRoute(location) ? language : "en";

  /*
    The document, kept honest on every navigation.

    Set here rather than in `index.html` alone because the app is one document
    across every route: a person who opens the Arabic landing page and then
    signs in has an `rtl` root and an English screen, and nothing would ever
    have put it back.
  */
  useEffect(() => {
    const root = document.documentElement;
    root.lang = screenLanguage;
    root.dir = directionOf(screenLanguage);
  }, [screenLanguage]);

  const value = useMemo<LanguageValue>(
    () => ({
      language,
      screenLanguage,
      choose: (next: Language) => {
        setLanguage(next);
        try {
          window.localStorage.setItem(LANGUAGE_KEY, next);
        } catch {
          /* storage blocked; the choice lasts this session */
        }
      },
      t: (phrase: Phrase) => say(phrase, language),
    }),
    [language, screenLanguage],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/**
 * The language, from anywhere below the provider.
 *
 * Throws rather than falling back to a default, because a component reading a
 * silent default is a component rendering the wrong language with nothing to
 * show for it.
 */
export function useLanguage(): LanguageValue {
  const value = useContext(Context);
  if (!value) throw new Error("useLanguage must be used inside LanguageProvider");
  return value;
}
