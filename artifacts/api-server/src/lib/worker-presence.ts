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
import { desc, sql } from "drizzle-orm";
import { db, workerHeartbeatsTable } from "@workspace/db";
import { logger } from "./logger";
import { liveWorkers, renderRate, type RenderSample } from "./queue-health";

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


// ─── What this deployment can get through ───────────────────────────────────

/**
 * How many machines are listening, and how fast they have been.
 *
 * Both change slowly and both are read on a path polled every few seconds by
 * every open editor, so they are cached together for half a minute. Half a
 * minute is far shorter than the two-minute window that decides a worker online
 * from offline, so the cache cannot change that verdict — it only stops a
 * progress poll from becoming three database round trips.
 *
 * Read as one statement rather than two, because the pair is used together to
 * produce a single number and two reads a moment apart can disagree: a worker
 * that left between them makes the estimate divide by a machine that is gone.
 */
const CAPACITY_CACHE_MS = 30_000;

export interface Capacity {
  /** Workers that have said something within the online window. */
  workers: number;
  /** Milliseconds of work per second of source, or null if too little history. */
  rate: number | null;
}

let capacityAt = 0;
let capacity: Capacity = { workers: 0, rate: null };

/**
 * How far back to look for a typical render.
 *
 * Thirty days, because the answer should follow the machine and the code. A
 * median over all time would still be carrying the renders from before the
 * decoder change that made cold opens fast, and telling everybody to wait for a
 * worker that no longer exists.
 */
const RATE_WINDOW_DAYS = 30;

/** And enough of them that a slow week does not become the truth. */
const RATE_SAMPLE_LIMIT = 50;

export async function renderCapacity(now = Date.now()): Promise<Capacity> {
  if (now - capacityAt < CAPACITY_CACHE_MS) return capacity;
  try {
    const seen = await db
      .select({ lastSeenAt: workerHeartbeatsTable.lastSeenAt })
      .from(workerHeartbeatsTable);

    const finished = await db.execute(sql`
      select extract(epoch from (finished_at - started_at)) * 1000 as wall_ms,
             source_seconds
        from jobs
       where status = 'done'
         and started_at is not null
         and finished_at is not null
         and source_seconds > 0
         -- First attempts only, because started_at is not re-stamped on a
         -- retry: the claim writes COALESCE(started_at, now()) so a job that
         -- died and succeeded on attempt two measures from the first claim,
         -- and the span includes the failed attempt plus the whole
         -- thirty-minute stale-lock window before it was requeued. That is a
         -- perfectly good record of what happened to that job and a terrible
         -- sample of how long a render takes: one such row is twenty times the
         -- rate of a healthy one, and with ten renders in the whole history a
         -- couple of them move the median by a factor of eight. The wait
         -- estimate is a number people plan around.
         and attempts <= 1
         and finished_at > now() - interval '${sql.raw(String(RATE_WINDOW_DAYS))} days'
       order by finished_at desc
       limit ${RATE_SAMPLE_LIMIT}
    `);
    const samples: RenderSample[] = finished.rows.map((row) => ({
      wallMs: Number((row as { wall_ms: unknown }).wall_ms),
      sourceSeconds: Number((row as { source_seconds: unknown }).source_seconds),
    }));

    capacity = {
      workers: liveWorkers(seen.map((s) => s.lastSeenAt), now),
      rate: renderRate(samples),
    };
    capacityAt = now;
  } catch (error) {
    logger.warn({ err: error }, "could not read render capacity");
    // Not cached: a failed read is retried next time rather than remembered.
  }
  return capacity;
}

/**
 * Source seconds of everything that renders before this job does.
 *
 * `source_seconds` is measured by the worker from the file, so a job still in
 * the queue has none — which is every job this is counting. The project's own
 * duration stands in: it is written by the browser and the schema says plainly
 * that it is for display, which is exactly what this is. A row with neither is
 * counted as nothing rather than guessed at, and the estimate that comes out is
 * short rather than invented.
 */
export async function workAheadOf(jobId: string): Promise<number | null> {
  try {
    const ahead = await db.execute(sql`
      with me as (select priority, created_at from jobs where id = ${jobId})
      select coalesce(sum(coalesce(j.source_seconds, p.duration, 0)), 0) as seconds
        from jobs j
        join projects p on p.id = j.project_id
       cross join me
       where j.status in ('queued', 'running')
         and j.id <> ${jobId}
         and (
           -- Work that has already started is ahead of you whatever its
           -- priority: it is holding a machine right now, and priority orders
           -- what has not been claimed yet, not what is running. Leaving this
           -- out made a job raised to the front of the queue report a wait of
           -- zero while a render was in progress on the only worker.
           j.status = 'running'
           -- And for the rest, the order claimJob takes them in: priority
           -- first, then age, strictly first-in-first-out within a priority.
           -- Written out rather than as a row comparison, because this
           -- predicate and that ORDER BY have to agree, and the one that is
           -- easy to read is the one that stays agreeing.
           or j.priority > me.priority
           or (j.priority = me.priority and j.created_at < me.created_at)
         )
    `);
    const row = ahead.rows[0] as { seconds: unknown } | undefined;
    return row ? Number(row.seconds) : null;
  } catch (error) {
    logger.warn({ err: error }, "could not measure the queue ahead of a job");
    return null;
  }
}

/** For tests, and for anything that needs a fresh answer after a write. */
export function resetCapacityCache(): void {
  capacityAt = 0;
  capacity = { workers: 0, rate: null };
}
