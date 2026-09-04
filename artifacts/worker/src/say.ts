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

/**
 * The three shapes an Arabic noun takes after a number.
 *
 * English needs two forms and picks between them on `n === 1`. Arabic needs
 * three, and the boundary is not where an English speaker expects it: the
 * plural is used for **three to ten** and the *singular* comes back from
 * eleven upward. So `${n} فجوة` — the shape every counted note in this worker
 * was written in — is right for 1, right for 11 and 100, and wrong for
 * exactly the range the product hits most: "أزلت 4 فجوة" is the register of a
 * machine translation, and it was the first thing an Arabic-speaking customer
 * read after their render finished.
 */
export interface ArabicNoun {
  /** فجوة — one of them, and eleven or more of them. */
  one: string;
  /** فجوتين — exactly two, where the number itself is not written. */
  two: string;
  /** فجوات — three to ten. */
  few: string;
}

/**
 * A number and its noun, agreeing.
 *
 * One and two drop the digit, because Arabic carries the count in the noun and
 * "1 فجوة" reads like a form field. Above a hundred the tail decides — 103
 * ends in three, and the noun follows the part you say last.
 */
export function countedAr(count: number, noun: ArabicNoun): string {
  const n = Math.abs(Math.round(count));
  if (n === 1) return noun.one;
  if (n === 2) return noun.two;
  const tail = n % 100;
  return tail >= 3 && tail <= 10 ? `${n} ${noun.few}` : `${n} ${noun.one}`;
}

/** The nouns this worker counts in its notes. */
export const AR_NOUNS = {
  gap: { one: "فجوة", two: "فجوتين", few: "فجوات" },
  caption: { one: "كابشن", two: "كابشنين", few: "كابشنات" },
  clip: { one: "قصاصة", two: "قصاصتين", few: "قصاصات" },
  second: { one: "ثانية", two: "ثانيتين", few: "ثوانٍ" },
  word: { one: "كلمة", two: "كلمتين", few: "كلمات" },
} as const satisfies Record<string, ArabicNoun>;
