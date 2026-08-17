/**
 * When did any render machine last say it was here?
 *
 * One row, read on a path that is polled every few seconds by every open
 * editor, so the answer is cached briefly. Ten seconds is far shorter than the
 * two-minute window that decides online from offline, so the cache cannot
 * change any verdict — it only stops a progress poll from becoming a second
 * database round trip.
 *
 * Absence is returned as `null` rather than thrown. This is used to decide
 * whether to tell somebody nothing is listening, and a failed read is not
 * evidence that nothing is listening; the caller falls back to the age of the
 * queue, which is where it was before this existed.
 */
import { desc } from "drizzle-orm";
import { db, workerHeartbeatsTable } from "@workspace/db";
import { logger } from "./logger";

const CACHE_MS = 10_000;

let cachedAt = 0;
let cached: Date | null = null;

export async function newestWorkerSeenAt(now = Date.now()): Promise<Date | null> {
  if (now - cachedAt < CACHE_MS) return cached;
  try {
    const [newest] = await db
      .select({ lastSeenAt: workerHeartbeatsTable.lastSeenAt })
      .from(workerHeartbeatsTable)
      .orderBy(desc(workerHeartbeatsTable.lastSeenAt))
      .limit(1);
    cached = newest?.lastSeenAt ? new Date(newest.lastSeenAt) : null;
    cachedAt = now;
  } catch (error) {
    logger.warn({ err: error }, "could not read worker heartbeats");
    // Deliberately not cached: a failed read should be retried on the next
    // request, not remembered for ten seconds.
  }
  return cached;
}

/** For tests, and for anything that needs a fresh answer after a write. */
export function resetWorkerPresenceCache(): void {
  cachedAt = 0;
  cached = null;
}
