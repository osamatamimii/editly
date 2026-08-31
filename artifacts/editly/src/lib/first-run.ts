/**
 * The first five minutes, which nothing in this product has ever owned.
 *
 * Somebody signs up and lands on a dashboard with a "New Project" button and
 * one sentence telling them to "tell Editly what you want done with it" —
 * without a single example of what that sentence looks like. The entire value
 * of this product is in that sentence, and the product has never shown one.
 *
 * Ten renders exist in production and one account made all of them. That is not
 * a marketing number: it is the measured cost of a first screen that assumes
 * the person already knows the vocabulary.
 *
 * ## Why these sentences and not better-written ones
 *
 * Every suggestion below is a sentence the **keyword parser actually handles**,
 * checked by `tools/onboarding-test.mjs` against the real `planFromText` in
 * both languages. That check is the whole design. Copy on a first-run screen
 * drifts from the parser the moment either changes, and the failure is the
 * worst one this product can have: the first thing a new person ever asks for
 * comes back refused.
 *
 * The keyword parser rather than the model, on purpose. The model is better and
 * it needs a key; the parser is what answers when there is none, and a
 * suggestion that only works on a configured deployment is a suggestion that
 * fails silently on one that is not.
 *
 * ## And why Arabic is not a translation
 *
 * The parser reads two languages and they are not the same shape. "Pull out the
 * strongest 30 seconds" matches; «أعطني أقوى 30 ثانية» does **not** — the
 * Arabic highlight patterns want «أفضل جزء» or «أقوى لقطة», not a number of
 * seconds. So each entry carries a sentence written in each language rather
 * than one sentence translated, and the suite holds both to the same standard.
 *
 * That gap is real and worth fixing where the patterns live; it is recorded
 * rather than papered over. Nothing here compensates for it by suggesting a
 * phrase that returns a refusal.
 */

export interface Suggestion {
  /** Stable, and what the test names when one of them stops parsing. */
  id: string;
  /** Two or three words on the button. A name, never a promise. */
  label: { en: string; ar: string };
  /** The sentence that goes into the project. Verified against the parser. */
  sentence: { en: string; ar: string };
}

/**
 * Six, and the number is a decision.
 *
 * Enough that somebody recognises their own kind of video in the list, few
 * enough that reading them is not itself a task. The fastest way to make a
 * choice feel like work is to offer forty.
 */
export const SUGGESTIONS: readonly Suggestion[] = [
  {
    id: "silence-captions-tiktok",
    label: { en: "Cut and caption", ar: "قصّ وترجمة" },
    sentence: {
      en: "Cut the silences and caption it, vertical for TikTok",
      ar: "اقصص الصمت وضيف ترجمة، عمودي لتيك توك",
    },
  },
  {
    id: "highlight",
    label: { en: "The best part", ar: "أفضل جزء" },
    sentence: {
      en: "Pull out the strongest 30 seconds and caption it",
      ar: "أعطني أفضل جزء مع ترجمة",
    },
  },
  {
    id: "clips",
    label: { en: "Three clips", ar: "ثلاثة مقاطع" },
    sentence: {
      en: "Cut it into 3 clips for Reels",
      ar: "قسّمه إلى 3 مقاطع لريلز",
    },
  },
  {
    id: "tighten-hook",
    label: { en: "Tighten and hook", ar: "شدّ وافتتاح" },
    sentence: {
      en: "Tighten it up and start with the best bit",
      ar: "شدّه وابدأ بالأقوى",
    },
  },
  {
    id: "captions-audio-youtube",
    label: { en: "Ready for YouTube", ar: "جاهز ليوتيوب" },
    sentence: {
      en: "Caption it and level the audio for YouTube",
      ar: "ضيف ترجمة وظبط الصوت ليوتيوب",
    },
  },
  {
    id: "look",
    label: { en: "Give it a look", ar: "أعطه مظهرًا" },
    sentence: {
      en: "Make it cinematic, fade in and out",
      ar: "خلّيه سينمائي مع تلاشي بالبداية والنهاية",
    },
  },
];

export type FirstRunLanguage = "en" | "ar";

/**
 * Which language to offer the sentences in.
 *
 * Read from the browser rather than asked, because a question before the first
 * screen is a cost paid by everybody to help some. It is only the *suggestions*
 * that change — the product answers in whichever language the sentence is
 * written in, so a person who switches is not switching the product, only the
 * examples in front of them.
 */
export function preferredLanguage(languages: readonly string[]): FirstRunLanguage {
  return languages.some((tag) => tag.toLowerCase().startsWith("ar")) ? "ar" : "en";
}

const DISMISSED_KEY = "editly.first-run.dismissed";

/**
 * Whether this browser has been shown the first run already.
 *
 * A per-browser convenience and deliberately not an account flag: the thing
 * that really ends the first run is **having a project**, which is server
 * truth and which the dashboard checks. This only stops the screen reappearing
 * for somebody who chose to skip it and has not made anything yet.
 *
 * In a try/catch because `localStorage` throws outright in some privacy modes —
 * not returns null, throws — and a first-run screen that crashes the dashboard
 * is worse than one that shows twice.
 */
export function hasSkippedFirstRun(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function skipFirstRun(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Nothing to do and nothing to say. The screen shows again next time,
    // which is a small annoyance and not a failure.
  }
}
