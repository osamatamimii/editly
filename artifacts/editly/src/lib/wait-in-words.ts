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
 */
export function waitInWords(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || seconds <= 0) return "Waiting for a free slot…";
  if (seconds < 90) return "Starting in under a minute…";
  if (seconds >= 3600) return "More than an hour of renders ahead of this one…";
  const minutes = Math.round(seconds / 60);
  return `About ${minutes} minute${minutes === 1 ? "" : "s"} until this starts…`;
}
