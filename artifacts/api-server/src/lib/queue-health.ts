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
