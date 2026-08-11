/**
 * How long the video is — answered in a way that cannot be silently wrong.
 *
 * Two numbers in this pipeline decide what a customer owes and what they are
 * allowed to upload, and both of them used to be arrived at carelessly.
 *
 * The output length was `probeDuration(file).catch(() => null)`. `null` is not
 * a neutral value here: the meter sums this column, SQL skips nulls, so a
 * render nobody could measure was charged at zero minutes — forever, with no
 * alert and no reconciliation. The failure was invisible precisely because it
 * favoured the customer, which is the class of bug that never gets reported.
 *
 * The source length came from the browser. It was optional, unvalidated, and it
 * gated the upload ceiling that separates the paid tiers — so omitting one
 * field removed the ceiling entirely.
 *
 * Both are fixed the same way: measure, and when measuring fails, fall back
 * through progressively weaker answers and *record which one was used*. An
 * estimate is a perfectly acceptable thing to bill on. An estimate that cannot
 * be told apart from a measurement afterwards is not.
 */

export type DurationSource = "probe" | "estimate" | "fallback";

export interface MeasuredDuration {
  seconds: number;
  how: DurationSource;
}

/**
 * A render that produced a file but could not be measured is charged at
 * something rather than nothing.
 *
 * `estimate` is the length the renderer computed for the edit it just built —
 * arithmetic over the cut map, not a guess. `sourceSeconds` is the last resort
 * and overcharges slightly (the output is never longer than the source), which
 * is the right direction for the error to point when we have already spent the
 * encode.
 *
 * @param probe    Reads the finished file. Tried twice: ffprobe failing once on
 *                 a machine that has just finished an encode is usually load,
 *                 not a broken file.
 */
export async function measureOutput(
  probe: () => Promise<number>,
  fallbacks: { estimate?: number | null; sourceSeconds?: number | null },
): Promise<MeasuredDuration> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const seconds = await probe();
      if (usable(seconds)) return { seconds, how: "probe" };
    } catch {
      // Fall through to the next attempt, then to the estimates.
    }
  }

  if (usable(fallbacks.estimate)) return { seconds: fallbacks.estimate, how: "estimate" };
  if (usable(fallbacks.sourceSeconds)) return { seconds: fallbacks.sourceSeconds, how: "fallback" };

  // A finished render of length zero is not a thing that exists. Something is
  // wrong upstream, and the honest move is to say so rather than to write a
  // number that makes the job look free.
  throw new Error("the finished render could not be measured, and nothing was available to estimate from");
}

/**
 * Is this file longer than the plan that queued it allows?
 *
 * The ceiling travels on the job rather than being looked up here, so the
 * worker needs to know nothing about plans or prices, and a plan change while
 * the job sat in the queue cannot retroactively refuse work already accepted.
 *
 * A tolerance of a second absorbs container rounding — a file that probes at
 * 1800.04 seconds against a 30-minute ceiling is a 30-minute file, and refusing
 * it over four hundredths of a second would be indefensible.
 */
const CEILING_TOLERANCE_SECONDS = 1;

export function exceedsCeiling(sourceSeconds: number, maxSourceSeconds: number | null): boolean {
  if (maxSourceSeconds == null || !Number.isFinite(maxSourceSeconds) || maxSourceSeconds <= 0) return false;
  return sourceSeconds > maxSourceSeconds + CEILING_TOLERANCE_SECONDS;
}

/** The sentence the customer sees. It names the length, because "too long" invites an argument. */
export function tooLongMessage(sourceSeconds: number, maxSourceSeconds: number): string {
  const minutes = Math.round((sourceSeconds / 60) * 10) / 10;
  const ceiling = Math.round(maxSourceSeconds / 60);
  return `This file is ${minutes} minutes and your plan takes up to ${ceiling} in one upload. A longer plan, or a shorter clip, and we will edit it.`;
}

function usable(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
