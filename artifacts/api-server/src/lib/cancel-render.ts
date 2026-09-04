/**
 * Stopping renders, in the one place that knows what stopping means.
 *
 * Two callers with the same need and no reason to disagree: the cancel button,
 * which stops one render on purpose, and deleting a project, which stops
 * whatever that project had running because there is nowhere left to put the
 * result.
 *
 * The second is the one nobody reported, because it produces no symptom
 * anybody could describe. Deleting a project left its job holding its lock,
 * its slot in the per-account concurrency cap, and its place in the queue —
 * rendering a video whose project row was already gone, failing at the upload,
 * being retried twice more, and finally settling as "Rendering failed. We are
 * looking into it." against a project that does not exist. Every minute of
 * that is a real machine doing real work for nobody, and it counts against the
 * account the whole time.
 *
 * ## What a cancelled render is
 *
 * A `failed` one carrying `cancelledAt`. See the migration for why it is not a
 * fourth status: `status` is compared in about a hundred and seventy places
 * and every one of them means "settled" by `done` or `failed`.
 *
 * ## Queued and running are different
 *
 * A queued row belongs to nobody, so this settles it outright. A running row
 * belongs to a worker inside ffmpeg, and nothing here can reach into that — so
 * the write is a *request* and the worker reads it at its next progress
 * report, which is several times a second. The row is left `running` in that
 * case, deliberately: claiming a render has stopped while a machine is still
 * encoding it would be the same lie in the other direction.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, jobsTable } from "@workspace/db";
import { CANCELLED_MESSAGE } from "@workspace/api-zod/limits";

/*
  The sentences live in `@workspace/api-zod`, not here.

  Both sides write them: this module settles a job that was still queued, and
  the worker settles one it was in the middle of. A copy on each side is two
  sentences the day one of them is reworded — and the wording is the whole
  point of this feature, which is that a person who stopped a render is not
  shown an apology for a failure that did not happen.
*/
export { CANCELLED_MESSAGE, CANCELLED_MID_RENDER_MESSAGE } from "@workspace/api-zod/limits";

export interface CancelledJob {
  id: string;
  /** `failed` when it was settled here; `running` when a worker still has it. */
  status: string;
}

/**
 * Stop whichever of these jobs is still going. Returns what was actually
 * stopped, which is never more than what was still in flight.
 *
 * Safe to call with jobs that have already finished, and safe to call twice:
 * the `cancelled_at IS NULL` guard means a second call changes nothing and
 * reports nothing, rather than moving a settled row's timestamps around.
 */
export async function cancelJobs(userId: string, jobIds: string[]): Promise<CancelledJob[]> {
  if (jobIds.length === 0) return [];

  // Queued: nobody has it, so it settles here.
  const settled = await db
    .update(jobsTable)
    .set({
      status: "failed",
      cancelledAt: new Date(),
      finishedAt: new Date(),
      error: CANCELLED_MESSAGE,
      stage: null,
      lockedAt: null,
      lockedBy: null,
    })
    .where(
      and(
        eq(jobsTable.userId, userId),
        inArray(jobsTable.id, jobIds),
        eq(jobsTable.status, "queued"),
        isNull(jobsTable.cancelledAt),
      ),
    )
    .returning({ id: jobsTable.id });

  // Running: a request, read by the worker at its next progress report.
  const asked = await db
    .update(jobsTable)
    .set({ cancelledAt: new Date() })
    .where(
      and(
        eq(jobsTable.userId, userId),
        inArray(jobsTable.id, jobIds),
        eq(jobsTable.status, "running"),
        isNull(jobsTable.cancelledAt),
      ),
    )
    .returning({ id: jobsTable.id });

  return [
    ...settled.map((row) => ({ id: row.id, status: "failed" })),
    ...asked.map((row) => ({ id: row.id, status: "running" })),
  ];
}

/**
 * Everything still in flight on a project, stopped.
 *
 * The delete path's entry point: it does not know or care which job is which,
 * only that nothing should go on rendering into storage that is being emptied.
 */
export async function cancelRendersFor(userId: string, projectId: string): Promise<CancelledJob[]> {
  const inFlight = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.userId, userId),
        eq(jobsTable.projectId, projectId),
        inArray(jobsTable.status, ["queued", "running"]),
      ),
    );
  return cancelJobs(userId, inFlight.map((row) => row.id));
}

/** True when this row was stopped by the person rather than by a failure. */
export function wasCancelled(job: { cancelledAt?: Date | string | null }): boolean {
  return job.cancelledAt !== null && job.cancelledAt !== undefined;
}
