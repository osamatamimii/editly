/**
 * Telling a busy queue apart from an absent one.
 *
 * These look identical from the outside — a job sits at queued, progress stays
 * at zero — but they mean opposite things to the person waiting. One is "your
 * turn is coming"; the other is "nothing is going to happen." A progress bar
 * that never moves says the first while the second is true, which is the single
 * most dishonest thing an interface can do to someone who is waiting.
 */

/** Unclaimed for longer than this means no worker is running. */
export const NO_WORKER_AFTER_MS = 5 * 60 * 1000;

/** Has this job been sitting in the queue with nobody picking it up? */
export function isUnclaimed(
  job: { status: string; createdAt: Date | string; lockedAt?: Date | string | null },
  now = Date.now(),
): boolean {
  if (job.status !== "queued") return false;
  if (job.lockedAt) return false;
  const created = new Date(job.createdAt).getTime();
  return now - created >= NO_WORKER_AFTER_MS;
}

/**
 * The same question, asked with the one piece of evidence that settles it.
 *
 * `isUnclaimed` knows only how old an unclaimed row is, which is a guess — and
 * a guess that is wrong in exactly the situation the product is built for. One
 * worker busy on a Pro customer's ninety-minute render means every job queued
 * behind it crosses five minutes, and each one gets told "nothing has picked
 * this up yet" while a machine is very much running and will reach it shortly.
 * That is the inversion the file header says this module exists to prevent,
 * committed by the module itself.
 *
 * A worker that beat recently is proof. Given proof, age means "your turn is
 * coming", which the queue position already says better. Only in the absence of
 * proof does age get to speak.
 */
export function isUnattended(
  job: { status: string; createdAt: Date | string; lockedAt?: Date | string | null },
  workerLastSeenAt: Date | string | null | undefined,
  now = Date.now(),
): boolean {
  if (workerOnline(workerLastSeenAt, now)) return false;
  return isUnclaimed(job, now);
}

/**
 * How long after its last word a worker is assumed gone.
 *
 * Generously more than the heartbeat interval, because a worker mid-render is
 * busy and a network hiccup is not a death. The cost of being slow to declare
 * one dead is a minute of stale reassurance; the cost of being quick is telling
 * somebody nothing is listening while their render is being made.
 */
export const WORKER_OFFLINE_AFTER_MS = 2 * 60 * 1000;

export function workerOnline(
  lastSeenAt: Date | string | null | undefined,
  now = Date.now(),
): boolean {
  if (!lastSeenAt) return false;
  const seen = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(seen)) return false;
  /*
    A timestamp from the future is a clock disagreement, not a live worker, but
    it is also not evidence of absence — so a small one is treated as present
    and the next beat settles it.

    "Small" is the part that was missing. The row is written from the worker's
    own clock and read against the API's, and `now - seen < 120000` is
    satisfied by *any* future timestamp, however far out. A Fly machine that
    came up with its clock ninety minutes ahead — a hypervisor restore, a
    failed NTP step — beat normally, died, and went on reading `online: true`
    for ninety minutes, with `lastSeenAgoSeconds` clamped to 0 so the skew that
    caused it was hidden too. The monitor written after the outage in August
    stayed green through exactly that.

    One window's grace in each direction. Past it, a clock this far out is not
    evidence of anything and the honest answer is that nothing is listening.
  */
  const drift = now - seen;
  if (drift < -WORKER_OFFLINE_AFTER_MS) return false;
  return drift < WORKER_OFFLINE_AFTER_MS;
}


// ─── How long the wait actually is ──────────────────────────────────────────

/**
 * "Waiting for a free slot" is true and it is not an answer.
 *
 * One worker renders one job at a time, and that is a measurement rather than a
 * choice: peak resident memory for ffmpeg on a 1080p source is 602 MB for two
 * pieces and 1088 MB for six, against a machine with one gigabyte
 * (`MAX_SEPARATE_DECODES` in the renderer carries the whole table). A second
 * render inside the same box does not go slower, it gets OOM-killed — and an
 * OOM is not a failed render, it is a job that dies with no note while the
 * customer's minute is spent. So capacity is machines, not threads.
 *
 * Which makes the number below the thing that actually matters to somebody
 * waiting. Ten people uploading in an afternoon is a queue whatever the machine
 * count is, and a sentence that says "waiting" without saying *how long* reads
 * as a fault the tenth time somebody sees it. These three functions turn the
 * queue into a number, and refuse to when the number would be invented.
 */

/**
 * How many workers are actually listening.
 *
 * A count and not a boolean, because the wait divides by it: adding a machine
 * has to shorten the estimate on its own, without anybody editing a constant.
 */
export function liveWorkers(
  lastSeenAts: Array<Date | string | null | undefined>,
  now = Date.now(),
): number {
  return lastSeenAts.filter((seen) => workerOnline(seen, now)).length;
}

/**
 * The fewest finished renders before a median means anything.
 *
 * Production has ten renders in its whole history. A "typical" drawn from three
 * of them is not a typical, it is one video with a confident sentence wrapped
 * around it — and a wait that is wrong by a factor of five is worse than no
 * wait at all, because somebody plans around it.
 */
export const RATE_SAMPLE_MIN = 5;

export interface RenderSample {
  /** Wall-clock milliseconds from claim to finish. */
  wallMs: number;
  /** Length of the source that render was made from. */
  sourceSeconds: number;
}

/**
 * Milliseconds of work per second of source, at the middle of what we have seen.
 *
 * Per second of source rather than a flat average per job, because render time
 * scales with the length of the footage and a queue holding one podcast and
 * four clips is not five equal waits. A flat median would tell everyone behind
 * the podcast the same wrong number.
 *
 * The median rather than the mean, for the same reason and in the other
 * direction: one pathological render — a machine that stalled, a provider that
 * timed out — should not move the answer everybody else is given.
 */
export function renderRate(samples: RenderSample[]): number | null {
  const usable = samples
    .filter((s) => s.wallMs > 0 && s.sourceSeconds > 0)
    .map((s) => s.wallMs / s.sourceSeconds)
    .sort((a, b) => a - b);
  if (usable.length < RATE_SAMPLE_MIN) return null;
  const mid = Math.floor(usable.length / 2);
  return usable.length % 2 === 0 ? (usable[mid - 1]! + usable[mid]!) / 2 : usable[mid]!;
}

export interface WaitInput {
  /** Source seconds of everything that will be rendered before this job is. */
  aheadSourceSeconds: number;
  workers: number;
  /** From `renderRate`. Null means we have not seen enough to say. */
  rate: number | null;
}

/**
 * Seconds until this job starts, rounded up, or null when we cannot say.
 *
 * Three ways to get null, and each one is a refusal rather than a fallback: no
 * rate is not enough history, no workers is a different sentence entirely —
 * "nothing is listening" — and no work ahead means the wait is not the thing to
 * show, the render is about to start.
 *
 * Rounded **up**, to the half minute. Somebody told four minutes and given
 * three and a half has been treated well; somebody told three and given four
 * has been lied to. And a wait shown to the second would be false precision
 * dressed as care: the number underneath it is a median of five renders.
 */
export function waitEstimate(input: WaitInput): number | null {
  if (input.rate === null || input.rate <= 0) return null;
  if (input.workers <= 0) return null;
  if (input.aheadSourceSeconds <= 0) return null;
  const seconds = (input.aheadSourceSeconds * input.rate) / 1000 / input.workers;
  return Math.max(30, Math.ceil(seconds / 30) * 30);
}
