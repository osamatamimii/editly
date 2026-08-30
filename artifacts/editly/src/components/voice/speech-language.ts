/**
 * Which language to listen for.
 *
 * This was read from the chat input: `arabic={/[\u0600-\u06FF]/.test(chatInput)}`.
 * The chat input is empty when you press the microphone — that is the whole
 * reason you are pressing it — so the answer was always "not Arabic", and the
 * recogniser was asked for `en-US` while somebody spoke Arabic at it. It is
 * hard to think of a better way to make speech recognition look broken: the
 * engine was working perfectly and being asked the wrong question.
 *
 * So it is answered from things that are actually true when the button is
 * pressed, most specific first:
 *
 *   1. What they have already said in this project. Somebody who typed Arabic
 *      to Noah a minute ago is going to speak Arabic now, and this is the
 *      strongest signal there is.
 *   2. What is in the box, if anything, which is the old rule kept as a
 *      fallback rather than as the answer.
 *   3. The browser's own languages, which is what the person set their computer
 *      to and is right far more often than a guess.
 *   4. English.
 *
 * A person can still override it, because all four of these are inferences and
 * the one time they are wrong is the time somebody is switching languages.
 */
const ARABIC = /[\u0600-\u06FF]/;

/** The BCP-47 tags the recogniser is given, not the two-letter codes. */
export const SPEECH_TAGS = { ar: "ar-SA", en: "en-US" } as const;
export type SpeechLanguage = keyof typeof SPEECH_TAGS;

export function guessSpeechLanguage({
  said = [],
  typed = "",
  browser = typeof navigator === "undefined" ? [] : [...(navigator.languages ?? [navigator.language ?? ""])],
}: {
  /** What this person has written in this project, newest last. */
  said?: string[];
  typed?: string;
  browser?: string[];
} = {}): SpeechLanguage {
  // Newest first: a conversation that switched language switched for a reason.
  for (let i = said.length - 1; i >= 0; i--) {
    const line = said[i];
    if (line && ARABIC.test(line)) return "ar";
    if (line && /[a-z]/i.test(line)) return "en";
  }
  if (ARABIC.test(typed)) return "ar";
  if (typed.trim() && /[a-z]/i.test(typed)) return "en";
  for (const tag of browser) {
    if (typeof tag === "string" && tag.toLowerCase().startsWith("ar")) return "ar";
  }
  return "en";
}
