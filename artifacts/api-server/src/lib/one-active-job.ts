/**
 * "This project is already rendering", when the database is the one that
 * noticed.
 *
 * Both queueing routes check for a pending job before inserting one, and both
 * checks are a SELECT followed by an INSERT with nothing between them. Two
 * requests milliseconds apart — a double-click, or the browser retrying after a
 * dropped response — both read "nothing pending" and both write. The second
 * render costs a customer their month: two encodes of one clip, both measured,
 * both summed by the meter, and only one of them visible anywhere in the
 * product.
 *
 * `jobs_one_active_per_project` (migration 0013) makes the second insert fail
 * instead of succeed. This turns that failure back into the answer the route
 * was already trying to give, so the race and the ordinary case produce the
 * same 409 rather than a race producing a 500.
 */

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";

export function isDuplicateActiveJob(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown; cause?: unknown };
  if (candidate.code === UNIQUE_VIOLATION && candidate.constraint === "jobs_one_active_per_project") return true;
  // Drizzle wraps the driver error on some paths, so the cause is checked too
  // rather than trusting one shape — getting this wrong turns a handled race
  // back into a 500, which is the thing being fixed.
  return candidate.cause ? isDuplicateActiveJob(candidate.cause) : false;
}

export const ALREADY_RENDERING = "This project is already rendering.";
