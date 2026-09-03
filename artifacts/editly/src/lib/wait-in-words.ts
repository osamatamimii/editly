/**
 * A wait, in the words somebody uses for one.
 *
 * The number is computed on the server, where the queue is; the phrasing is
 * here, where the reader is. What this owes them is not precision — the number
 * underneath is a median of recent renders — but a shape they can plan around:
 * "about four minutes" is a decision they can make, "247 seconds" is arithmetic
 * they have to do.
 *
 * `null` gets the sentence this screen has always shown. That case is not a
 * failure: it is a deployment with too little history to have a typical render,
 * and inventing a number for it would be worse than the vague sentence, because
 * somebody would plan around the invention.
 *
 * The language is an argument with a default rather than a read of the stored
 * preference, because this is a pure function with a suite that calls it
 * directly: `tools/capacity-test.mjs` asserts the exact sentences, and a
 * function whose answer depends on browser storage is one that suite could not
 * ask a question of.
 */
import type { Language } from "@/lib/landing-copy";

export function waitInWords(seconds: number | null | undefined, language: Language = "en"): string {
  const arabic = language === "ar";
  if (typeof seconds !== "number" || seconds <= 0) {
    return arabic ? "بانتظار جهاز يفرغ…" : "Waiting for a free slot…";
  }
  if (seconds < 90) return arabic ? "يبدأ خلال أقل من دقيقة…" : "Starting in under a minute…";
  if (seconds >= 3600) {
    return arabic
      ? "أكثر من ساعة من التنفيذات قبل هذا…"
      : "More than an hour of renders ahead of this one…";
  }
  const minutes = Math.round(seconds / 60);
  if (arabic) {
    // Arabic counts in threes, so the three shapes are written out rather than
    // generated. A wait that reads wrong is a wait nobody trusts the number of.
    const said = minutes === 1 ? "دقيقة" : minutes === 2 ? "دقيقتين" : `${minutes} دقائق`;
    return `نحو ${said} حتى يبدأ…`;
  }
  return `About ${minutes} minute${minutes === 1 ? "" : "s"} until this starts…`;
}
