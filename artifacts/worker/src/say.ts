/**
 * A note, in the language the person asked in.
 *
 * The render notes are this product's honesty layer. They are the only place
 * that says a caption was skipped for want of a key, that a punch was dropped
 * because the word it landed on was cut, that the levelling missed on the
 * first pass and was measured and corrected. They are also, until now, the
 * only part of the conversation that was English whatever the person typed:
 * round 35 made the reply answer in Arabic, and then the render came back and
 * answered in English, which is a conversation that changes language halfway
 * through.
 *
 * Both halves are required arguments rather than an object with an optional
 * `ar`, for the same reason `Phrase` is a required pair in the matcher: a note
 * that *can* be written without its Arabic is a note that *will* be, on the
 * branch nobody exercised.
 *
 * The language is resolved here rather than carried into the database. The
 * notes column stays `text[]` and the API contract does not change; what is
 * stored is what the person will read. Storing both and choosing later would
 * mean every reader — the editor, the admin console, worker-test — had to know
 * about languages, to no one's benefit.
 */
export type Language = "en" | "ar";

/** The note-writer for one render, bound to the language its job was asked in. */
export type Say = (en: string, ar: string) => string;

export const sayIn =
  (language: Language | null | undefined): Say =>
  (en, ar) =>
    language === "ar" ? ar : en;

/**
 * "en" unless the text contains Arabic.
 *
 * The same rule the reply uses, kept in the worker as its own copy on purpose:
 * the worker is a separate deployment that must not import the API server's
 * modules, and the rule is three lines. A shared package for three lines would
 * be a build dependency between two things that deploy on different days.
 */
export const languageOf = (text: string | null | undefined): Language =>
  text && /[؀-ۿݐ-ݿ]/.test(text) ? "ar" : "en";

/**
 * A pair written somewhere that does not yet know the language.
 *
 * The provider statuses are built once at start-up, long before any job is
 * claimed, so they cannot be resolved with a `Say`. They carry both halves and
 * the job resolves them when it writes its notes.
 */
export interface NotePair {
  en: string;
  ar: string;
}

/** Resolve a pair, or a plain English string, against a language. */
export const pick = (say: Say, pair: NotePair): string => say(pair.en, pair.ar);
