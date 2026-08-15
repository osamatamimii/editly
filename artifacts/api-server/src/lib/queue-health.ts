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
  // A timestamp from the future is a clock disagreement, not a live worker, but
  // it is also not evidence of absence — treat it as present and let the next
  // beat settle it.
  return now - seen < WORKER_OFFLINE_AFTER_MS;
}
