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

import { MAX_MESSAGE_LENGTH } from "@workspace/api-zod/limits";

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
/**
 * The sentence that turns a long recording into a set of posts.
 *
 * Written once and read twice: the first-run screen offers it as a suggestion,
 * and the clip-extraction screen writes it into the editor when somebody picks
 * a recording there. Two copies of a sentence that has to *parse* would be two
 * copies that can disagree, and only one of them would be under the check that
 * runs every suggestion through the real keyword planner.
 */
export const CLIPS_REQUEST = {
  en: "Cut it into 3 clips for Reels",
  ar: "قسّمه إلى 3 مقاطع لريلز",
} as const;

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
    sentence: CLIPS_REQUEST,
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

/*
  `preferredLanguage` used to live here, and it read `navigator.languages` to
  decide which language to offer the sentences in.

  It is gone because the product now has one answer to "which language is this
  person in", and it is not that one. The landing page's argument, written out
  in `lib/language.tsx`, is that phones in this product's first market are very
  often set to English, so reading the browser would quietly turn "Arabic first"
  into "English for nearly everyone". Two functions answering the same question
  differently is the drift this repository keeps paying for; one of them had to
  go, and it was the one nobody could see the answer of.

  The type stayed, because the suggestions below are still pairs.
*/
export type FirstRunLanguage = "en" | "ar";

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

/*
  Written as escapes rather than as the characters themselves, because half of
  them are invisible in an editor and a rule nobody can see in the source is a
  rule that gets "tidied" away.
*/
const BIDI_AND_CONTROL =
  /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * The sentence somebody pressed on the landing page, if they pressed one.
 *
 * The features section on the landing page puts a real request under each
 * feature - "Cut the silences and caption it" - and pressing it carries that
 * sentence here, in the URL, so the first screen after signing up already has
 * the thing they asked for written in the box. The alternative is what the
 * product did before: somebody presses a sentence, signs up, and lands on an
 * empty field with no memory of what they came for.
 *
 * In the URL and not in a module variable, because a sign-in happens in
 * between. `App.tsx` carries `pathname + search` through `?next=`, so the
 * sentence survives the round trip; anything held in memory would not survive
 * the page load the redirect back performs.
 *
 * ## What this refuses, and why it refuses rather than trusts
 *
 * A query string is written by whoever made the link, which on a public page
 * is anybody. This one lands in a text box and then in a message the person
 * sends themselves, so the damage available is small - but "small" is not a
 * reason to accept a megabyte of text, a line break that turns one sentence
 * into a fake conversation, or the control characters that make a box render
 * something other than what it holds.
 *
 * So: every run of whitespace, line breaks included, becomes one space; every
 * C0/C1 control character and every bidirectional override is dropped - the
 * overrides because this product is bilingual and U+202E is precisely the
 * character that makes Arabic and English render in an order the text does not
 * actually have; and the result is cut to the same ceiling the server puts on
 * a message, so a link cannot place a sentence the API would refuse anyway.
 *
 * Returns "" for anything missing, empty, or malformed, and never throws:
 * `URLSearchParams` is forgiving, but a screen seeded from this while it
 * mounts must not be able to fail to mount because of a link.
 */
export function askedSentence(search: string): string {
  let raw: string | null = null;
  try {
    raw = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("ask");
  } catch {
    return "";
  }
  if (!raw) return "";
  const cleaned = raw
    .replace(BIDI_AND_CONTROL, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, MAX_MESSAGE_LENGTH);
}
