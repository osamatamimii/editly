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

/**
 * Is this file longer than what was left of the month when the job was queued?
 *
 * The API asks the same question, and cannot always answer it: the length it
 * has comes from the browser and the browser is allowed to send nothing. When
 * it sends nothing the refusal is skipped entirely — not deferred, skipped —
 * so a free account with one minute left could queue a nine-minute file and
 * the shortfall would be discovered by the meter afterwards, on a render we
 * had already paid to produce.
 *
 * No operation makes a clip longer, so the source is an upper bound on what
 * this render can consume, and comparing it to the balance is the same
 * conservative rule the policy layer applies — now applied to a number that was
 * measured rather than claimed.
 *
 * A null balance means the row predates the column and is treated as no limit:
 * refusing old work over a field it could not have carried would be inventing a
 * failure. Zero is a real answer and is enforced.
 */
export function exceedsAllowance(sourceSeconds: number, remainingSeconds: number | null): boolean {
  if (remainingSeconds == null || !Number.isFinite(remainingSeconds) || remainingSeconds < 0) return false;
  return sourceSeconds > remainingSeconds + CEILING_TOLERANCE_SECONDS;
}

/** The sentence for that one. Both numbers, because "limit reached" invites an argument. */
export function overAllowanceMessage(sourceSeconds: number, remainingSeconds: number): string {
  const left = remainingSeconds < 1 ? "none left" : `${spoken(remainingSeconds)} left`;
  return `This file is ${spoken(sourceSeconds)} and you have ${left} in this month's allowance. Nothing has been charged for it. Your minutes reset at the start of next month, and upgrading adds them immediately.`;
}

/**
 * How long something is, in the unit a person would use for it.
 *
 * Everything used to be printed in minutes, which produced "This file is 0.2
 * minutes and your plan takes up to 0 in one upload" — arithmetically correct
 * and unusable. Nobody reads a twelve-second clip as a fifth of a minute, and a
 * refusal that rounds the limit to zero reads as a bug rather than a rule.
 */
function spoken(seconds: number): string {
  const whole = Math.round(seconds);
  if (whole < 90) return `${whole} second${whole === 1 ? "" : "s"}`;
  const minutes = Math.round((seconds / 60) * 10) / 10;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** The sentence the customer sees. It names the length, because "too long" invites an argument. */
export function tooLongMessage(sourceSeconds: number, maxSourceSeconds: number): string {
  return `This file is ${spoken(sourceSeconds)} and your plan takes up to ${spoken(maxSourceSeconds)} in one upload. A longer plan, or a shorter clip, and we will edit it.`;
}

function usable(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
