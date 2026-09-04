/**
 * The render worker.
 *
 * Claims jobs from the Postgres queue, runs ffmpeg, writes the result back to
 * Storage. Designed to be run as several identical copies: `FOR UPDATE SKIP
 * LOCKED` means two workers never claim the same row, and a worker that dies
 * mid-render leaves a stale lock that the next sweep returns to the queue.
 *
 * Env: DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { sql, eq, and } from "drizzle-orm";
import pino from "pino";
import { db, pool, jobsTable, projectsTable, assetsTable, messagesTable, clipsTable, comprehensionsTable, workerHeartbeatsTable, type Job } from "@workspace/db";
import { EditPlan, type EditOperation } from "@workspace/api-zod";
import { CANCELLED_MID_RENDER_MESSAGE } from "@workspace/api-zod/limits";
import { downloadObject, uploadObject, bytesPulled, objectBytes, StorageTransferError } from "./storage";
import { roomFor, noRoomMessage, sweepStaleWork } from "./disk";
import { renderPlan, probeDuration, probeSource, grabPosterFrame, shapeFor, frameFor, defaultHeightFor, FfmpegError } from "./ffmpeg";
import { encodePreview, previewPathFor } from "./preview";
import { LIMITS, deliverableSourceMinutes } from "./deadline";
import { reviewOutput } from "./review";
import { chooseClips } from "./highlight";
import { chooseConversationClips, type Reading } from "./conversation";
import { snapToSpeechBreaks } from "./timeline";
import { measureOutput, exceedsCeiling, tooLongMessage, exceedsAllowance, allowanceNow, overAllowanceMessage, exceedsDeliverable, notDeliverableMessage } from "./duration";
import { enrichPlan } from "./enrich";
import { comprehend, transcriptDigest, wordsOf, COMPREHENSION_VERSION } from "./comprehend";
import { resolveProviders } from "./providers";
import { sayIn, countedAr, AR_NOUNS, type Language } from "./say";
import { publishDuePosts, surfaceStrandedPosts } from "./publisher";
import { mailLogsTo, tellThemItDidNotFinish, tellThemTheEditIsReady } from "./mail";
import { prepareUploadedFaces, fetchUploadedFaces } from "./font-prepare";
import { applyRemovals, chooseRemovals, retentionFrom, type SweepableClip, type SweepableProject } from "./sweep";
import { objectStoreFrom } from "@workspace/object-store";
import { serveHealth, HEALTH_PORT } from "./health";
import { buildStillsReel, imageSize } from "./stills";

const WORKER_ID = `${hostname()}-${randomUUID().slice(0, 8)}`;
const POLL_INTERVAL_MS = Number(process.env["POLL_INTERVAL_MS"] ?? 5000);

/**
 * How long a machine that has run out of disk stops asking.
 *
 * Long enough that it is not spinning, short enough that it rejoins as soon
 * as a finished render frees its work directory. See `NoRoomHereError`.
 */
const NO_ROOM_PAUSE_MS = 60_000;
/** A render that has held its lock this long is assumed dead, not slow. */
const STALE_LOCK_MINUTES = Number(process.env["STALE_LOCK_MINUTES"] ?? 30);

const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  ...(process.env["NODE_ENV"] === "production"
    ? {}
    : { transport: { target: "pino-pretty", options: { colorize: true } } }),
}).child({ worker: WORKER_ID });

let shuttingDown = false;

/**
 * Resolved once, at startup, so the log line below is the single place anyone
 * has to look to know what this worker can actually do.
 */
const providers = resolveProviders();

/**
 * Everything the plan asked for turned out to be impossible on this clip — no
 * recogniser for the captions it wanted, no emphasis for the punches. Retrying
 * would produce the same answer, so this is final and the message is the user's.
 */
class PlanEmptiedError extends Error {}

/**
 * The file is longer than the plan that queued it allows.
 *
 * This is checked here, against the file, rather than in the API — where the
 * only duration available is the one the browser sent, which was optional and
 * unvalidated. Omitting it removed the ceiling that separates the paid tiers
 * entirely. Final rather than retried: the file will be exactly as long next
 * time, and the message is the customer's to act on.
 */
class SourceTooLongError extends Error {}

/**
 * This machine has no room for this render; another one will.
 *
 * Not a failure of the job and not the customer's problem, so it is neither
 * reported to them nor counted against their attempts: `processJob` throws it
 * before touching anything, and the loop hands the row straight back to the
 * queue. If every machine is full the job waits, which is the correct thing
 * for it to do — the wrong thing, and what happened before this existed, is
 * three attempts burned on `No space left on device` inside a stderr tail
 * nobody reads, ending at "this project could not be rendered".
 */
class NoRoomHereError extends Error {}

/**
 * The person asked us to stop, and we did.
 *
 * Not a failure of anything: no retry, no apology mail, no "we are looking
 * into it". The row is settled as `failed` because that is what every reader
 * of `status` in this codebase understands as "not going any more", and
 * `cancelled_at` — already set by whoever asked — is what makes the difference
 * legible to the three places that need it.
 *
 * Thrown from `reportProgress`, which is called from every stage of the
 * render, so the request is acted on at whatever the renderer is doing rather
 * than at some checkpoint it might not reach.
 */
class CancelledError extends Error {}

/**
 * Takes the oldest queued job, atomically. SKIP LOCKED is what makes this safe
 * to run in parallel: a row another worker is already claiming is stepped over
 * rather than waited on.
 */
async function claimJob(): Promise<Job | null> {
  const { rows } = await pool.query<Job & Record<string, unknown>>(
    `UPDATE jobs SET
       status = 'running',
       locked_at = now(),
       locked_by = $1,
       started_at = COALESCE(started_at, now()),
       attempts = attempts + 1,
       updated_at = now()
     WHERE id = (
       SELECT id FROM jobs
       WHERE status = 'queued' AND attempts < max_attempts
       -- Priority first, then age. Within a priority this is still strictly
       -- first-in-first-out, so a paid queue cannot starve a free one of
       -- anything except its place at the front.
       ORDER BY priority DESC, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [WORKER_ID],
  );
  if (rows.length === 0) return null;
  const row = rows[0] as Record<string, unknown>;
  assertRowIsUnderstood(row);
  return toJob(row);
}

/**
 * What this person has been billed for since this job was queued.
 *
 * Only rows that reached `done`, only this month, only strictly after the
 * moment this row was written, and never this row itself. That is exactly the
 * amount the snapshot on the row has stopped accounting for.
 */
async function spentSinceQueued(job: Job): Promise<number> {
  const { rows } = await pool.query<{ seconds: string }>(
    `SELECT coalesce(sum(coalesce(billed_seconds, output_seconds)), 0)::float8 AS seconds
       FROM jobs
      WHERE user_id = $1
        AND id <> $2
        AND status = 'done'
        AND finished_at >= greatest($3::timestamptz, date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
    [job.userId, job.id, job.createdAt.toISOString()],
  );
  return Number(rows[0]?.seconds ?? 0);
}

/** Was this row written before the allowance it is carrying was reset? */
function queuedBeforeThisMonth(job: Job, now = new Date()): boolean {
  return job.createdAt.getTime() < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

/**
 * Postgres returns snake_case; the rest of the worker speaks the schema's
 * camelCase. This mapping is by hand because the claim has to be one atomic
 * `UPDATE … RETURNING`, which is below the ORM.
 *
 * Every column the worker reads must appear here. A column that is added to the
 * schema and forgotten here arrives as `undefined` with no error anywhere — and
 * for `maxSourceSeconds` that would mean the upload ceiling quietly stops being
 * enforced, which is the exact failure this ceiling exists to prevent.
 */
function toJob(row: Record<string, unknown>): Job {
  return {
    ...(row as unknown as Job),
    userId: row["user_id"] as string,
    projectId: row["project_id"] as string,
    inputPath: row["input_path"] as string,
    outputPath: row["output_path"] as string | null,
    referencePath: row["reference_path"] as string | null,
    outputSeconds: row["output_seconds"] as number | null,
    outputSecondsSource: row["output_seconds_source"] as string | null,
    sourceSeconds: row["source_seconds"] as number | null,
    maxSourceSeconds: row["max_source_seconds"] as number | null,
    remainingSeconds: row["remaining_seconds"] as number | null,
    priority: row["priority"] as number,
    maxAttempts: row["max_attempts"] as number,
    // Read by the live allowance check, which asks what has been billed since
    // this row was written. It arrived through the spread above as
    // `row.createdAt`, which does not exist — the driver returns `created_at`
    // — so the comparison was against `undefined` and the cast above made it
    // typecheck. Exactly the failure this docblock describes, found by walking
    // into it.
    createdAt: row["created_at"] as Date,
    startedAt: (row["started_at"] as Date | null) ?? null,
    finishedAt: (row["finished_at"] as Date | null) ?? null,
    lockedAt: (row["locked_at"] as Date | null) ?? null,
    lockedBy: (row["locked_by"] as string | null) ?? null,
    updatedAt: row["updated_at"] as Date,
  };
}

/**
 * The columns `toJob` renames, checked against the row it was handed.
 *
 * The mapping is by hand and the cast in `toJob` makes a missing rename
 * typecheck perfectly — the field simply arrives `undefined`, and what happens
 * next depends entirely on which field it was. For `maxSourceSeconds` it is
 * the upload ceiling silently switching off; for `createdAt` it was a date
 * comparison against `undefined`, which is false, every time.
 *
 * So the claim asserts it once, loudly, at the only moment it can be checked:
 * a row is in front of us and we know what we asked for. A worker that boots
 * against a schema it does not understand should say so and stop, not render
 * ten thousand videos with one rule turned off.
 */
const RENAMED_COLUMNS = [
  "user_id", "project_id", "input_path", "output_path", "reference_path",
  "output_seconds", "output_seconds_source", "source_seconds",
  "max_source_seconds", "remaining_seconds", "priority", "max_attempts",
  "created_at", "started_at", "finished_at", "locked_at", "locked_by", "updated_at",
] as const;

function assertRowIsUnderstood(row: Record<string, unknown>): void {
  const missing = RENAMED_COLUMNS.filter((column) => !(column in row));
  if (missing.length > 0) {
    throw new Error(`the jobs row is missing columns this worker reads: ${missing.join(", ")}`);
  }
}

/**
 * Says "I am here", so the product does not have to guess.
 *
 * Written as the worker polls rather than once at startup: a process that
 * started and then wedged is indistinguishable from a healthy one if the only
 * evidence is that it once booted. Throttled, because the poll is every few
 * seconds and nobody needs that resolution to answer "is anything listening".
 */
const HEARTBEAT_EVERY_MS = 20_000;
let lastHeartbeat = 0;

async function heartbeat(now = Date.now()): Promise<void> {
  if (now - lastHeartbeat < HEARTBEAT_EVERY_MS) return;
  lastHeartbeat = now;
  await db
    .insert(workerHeartbeatsTable)
    .values({
      workerId: WORKER_ID,
      // Names of models, never keys — the same two the startup line reports, so
      // "why are my captions missing" is answerable from the product rather
      // than from a log only one person can read.
      transcription: providers.transcriber?.name ?? null,
      vision: providers.sceneReader?.name ?? null,
    })
    .onConflictDoUpdate({
      target: workerHeartbeatsTable.workerId,
      set: {
        lastSeenAt: new Date(),
        transcription: providers.transcriber?.name ?? null,
        vision: providers.sceneReader?.name ?? null,
      },
    });
}

/**
 * Forget the workers that are not coming back.
 *
 * `WORKER_ID` carries a random suffix, so every restart, every deploy and every
 * OOM writes a new row and nothing ever removed one — a table that grows for
 * the life of the product, read in full by `renderCapacity` on every wait
 * estimate. A day is far longer than any window that treats a worker as
 * present (`workerOnline` uses minutes), so anything older than that is a
 * machine that no longer exists.
 */
async function forgetDepartedWorkers(): Promise<void> {
  await pool.query(`DELETE FROM worker_heartbeats WHERE last_seen_at < now() - interval '1 day'`);
}

/**
 * A ceiling on the whole job, not on one invocation of ffmpeg.
 *
 * Every limit in `LIMITS` bounds a single subprocess. Their *sum* was
 * unbounded, and a clips job is `renderPlan` once per window — each with its
 * own fresh four-hour render ceiling — plus a review, a ninety-minute VP9
 * mirror and a thirty-minute upload, six times over. While that runs, the lock
 * is renewed every twenty seconds so the stale sweep never looks at it, the
 * heartbeat keeps writing, `/healthz` answers 200, and with one worker every
 * other customer waits behind it.
 *
 * The work is not cancellable — it is awaiting a subprocess this function
 * cannot see — so what this does is stop *waiting* for it and let the job fail
 * as a job. The process exits afterwards rather than continuing with an
 * abandoned render still running beside it: a machine in that state has an
 * ffmpeg it does not know about holding memory the next render needs, and Fly
 * starts a clean one within seconds.
 */
async function withinJobDeadline<T>(jobId: string, work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const ceiling = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `This job ran for over ${Math.round(LIMITS.job.totalMs / 60_000)} minutes without finishing, which is longer than any edit this can deliver.`,
        ),
      );
    }, LIMITS.job.totalMs);
    timer.unref();
  });
  try {
    return await Promise.race([work(), ceiling]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Returns jobs abandoned by a dead worker to the queue. */
async function requeueStaleJobs(): Promise<number> {
  const { rowCount } = await pool.query(
    /*
      The progress goes back with the job.

      `progress` and `stage` were left where the dead worker put them, so a job
      that died at 62% sat in the queue still saying "Clip 3 of 6: encoding" and
      "62% — you can close this page, it keeps going". The bar does not move
      because nothing is rendering, and the sentence under it says the opposite.
      Worse, a non-null `stage` is what the editor shows *instead* of the wait
      estimate, so the one honest number available to a queued job was hidden by
      a stale one from the render that died.
    */
    `UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL,
       progress = 0, stage = NULL, updated_at = now()
     WHERE status = 'running'
       AND locked_at < now() - ($1 || ' minutes')::interval
       AND attempts < max_attempts`,
    [String(STALE_LOCK_MINUTES)],
  );
  return rowCount ?? 0;
}

/**
 * The job this worker is holding, if any.
 *
 * Only read by the shutdown path. A render is not interruptible — it is one
 * ffmpeg invocation that runs for as long as it runs — so the useful thing to
 * do when the platform says "stop" is to put the work back where somebody else
 * can pick it up, not to hope for time that is not coming.
 */
let heldJobId: string | null = null;

/**
 * Hand the job back, and do not charge it for our departure.
 *
 * Fly sends SIGTERM and, five seconds later by default, SIGKILL. A render
 * takes minutes to hours, so "finish the current job before exiting" was a
 * sentence the platform never honoured: the process died mid-encode, the row
 * stayed `running` with a fresh `locked_at`, and `requeueStaleJobs` would not
 * look at it for thirty minutes — during which the project is locked by the
 * one-active-per-project index and the job still counts against the customer's
 * in-flight limit. Then it came back with `attempts` already spent. Three
 * deploys in the life of one long render and the customer is told "Gave up
 * after repeated failures" about a render that never failed.
 *
 * `attempts` is decremented because the attempt did not happen. Nothing about
 * this job caused it, and the counter exists to stop *this job* from being
 * retried forever.
 */
async function releaseHeldJob(): Promise<void> {
  const id = heldJobId;
  if (!id) return;
  heldJobId = null;
  try {
    const { rowCount } = await pool.query(
      `UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL,
         attempts = GREATEST(0, attempts - 1),
         progress = 0, stage = NULL, updated_at = now()
       WHERE id = $1 AND status = 'running' AND locked_by = $2`,
      [id, WORKER_ID],
    );
    if ((rowCount ?? 0) > 0) logger.warn({ jobId: id }, "handed the job back before exiting");
  } catch (error) {
    // Nothing to do about it here, and the stale sweep is the backstop: the
    // job returns in thirty minutes rather than immediately.
    logger.error({ err: error, jobId: id }, "could not hand the job back");
  }
}

/** Jobs that have burned through every attempt should stop looking pending. */
async function failExhaustedJobs(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE jobs SET status = 'failed',
       error = COALESCE(error, 'Gave up after repeated failures.'),
       locked_at = NULL, locked_by = NULL, finished_at = now(), updated_at = now()
     WHERE status = 'running'
       AND locked_at < now() - ($1 || ' minutes')::interval
       AND attempts >= max_attempts`,
    [String(STALE_LOCK_MINUTES)],
  );
  return rowCount ?? 0;
}

/**
 * How often a running job's lock is renewed while it is being worked on.
 *
 * `locked_at` used to be written once, at claim, and never again — so
 * "abandoned by a dead worker" was decided from a single sample taken before
 * any work happened, and the answer was the same whether the worker had died or
 * was simply still busy. On a plan that sells 240-minute uploads that is not an
 * edge case, it is the flagship: at 30 minutes a second worker requeued the job
 * and started rendering the same file again, at 60 a third did, and at 90 the
 * sweeper marked it `failed` — with the message "Gave up after repeated
 * failures" — while two workers were still encoding it. The customer watched a
 * render that was working report a failure it never had, and we paid for the
 * encode three times.
 *
 * A lock is now a statement about the last few seconds rather than about the
 * moment work began, so the staleness rule above finally means what it says.
 */
/*
  Configurable only so a suite can watch the thing it decides.

  This timer is also where a stop request is read — see `renew` — so the worst
  case for noticing a cancellation is one interval. Twenty seconds against a
  render measured in minutes is right in production and useless in a test,
  which would otherwise have to wait twenty seconds to prove a property that
  takes one query.
*/
const LOCK_RENEW_EVERY_MS = Number(process.env["LOCK_RENEW_EVERY_MS"]) || 20_000;

/**
 * Renews the lock and the worker's heartbeat for as long as `work` runs.
 *
 * Tied to a timer rather than to progress callbacks on purpose: a two-hour
 * encode of a file ffmpeg cannot report progress for is exactly the job that
 * must not be declared dead, and it is the one that would report nothing.
 */
async function withLockKeptAlive<T>(jobId: string, work: () => Promise<T>): Promise<T> {
  const renew = async () => {
    try {
      // `locked_by` in the WHERE clause matters: if this job was taken from us
      // anyway, we must not reach back in and touch the new holder's row.
      /*
        The renewal is also where the stop request is read.

        One query rather than two, and on the timer rather than on the progress
        tick: ffmpeg reports several times a second and a `SELECT` on each of
        those would be the same hot-row problem `lastReported` exists to
        prevent. Twenty seconds is the worst case for noticing, against a
        render measured in minutes, and it costs nothing — the renewal was
        already writing this row.
      */
      const { rows } = await pool.query<{ cancelled_at: Date | null }>(
        `UPDATE jobs SET locked_at = now(), updated_at = now()
          WHERE id = $1 AND locked_by = $2
        RETURNING cancelled_at`,
        [jobId, WORKER_ID],
      );
      if (rows[0]?.cancelled_at) stopRequestedFor = jobId;
      await heartbeat();
    } catch (error) {
      // A failed renewal is not a reason to abandon a render that is going
      // fine. If the database is really gone the job will be requeued, which
      // is the behaviour we want.
      logger.warn({ err: error, jobId }, "could not renew the job lock");
    }
  };
  const timer = setInterval(() => void renew(), LOCK_RENEW_EVERY_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/**
 * The last percentage written for a job, so the same one is not written twice.
 *
 * ffmpeg reports its own timestamp several times a second, and every one of
 * those became an UPDATE on the hottest row in the schema — measured at 2.2 a
 * second, about eight thousand over an hour-long render, writing roughly ninety
 * distinct values. The pool holds three connections, so those updates queue
 * ahead of the lock renewal and the heartbeat, which are the two queries that
 * decide whether this worker still owns its job.
 */
let lastReported: { jobId: string; progress: number; stage: string | null } | null = null;

/**
 * The job this worker has been asked to stop, once it has noticed.
 *
 * Written by the lock renewal, read by `reportProgress`. A job id rather than
 * a boolean so a stale request cannot stop the *next* render: this worker
 * takes one job at a time, and the id is what says which one the answer was
 * about.
 */
let stopRequestedFor: string | null = null;

async function reportProgress(jobId: string, progress: number, stage: string): Promise<void> {
  /*
    Every stage of the render passes through here, which is why the stop is
    checked here.

    A checkpoint of its own would have to be placed by hand at each step and
    would be missed at the one that takes longest. This is called from the
    transcript, the beat read, the subject search, the encode and the review —
    so "stop" means "at whatever you are doing", not "at the next thing you
    finish".
  */
  if (stopRequestedFor === jobId) throw new CancelledError(CANCELLED_MID_RENDER_MESSAGE);

  const rounded = Math.max(0, Math.min(99, Math.round(progress)));
  /*
    Only when it changed, and never backwards.

    The percentage the customer sees is a whole number, and ffmpeg reports its
    own timestamp several times a second — so most of these updates wrote the
    number that was already there. Skipping them is free.

    Backwards is the other half. The stages are reported in the order they are
    reached in the file, and the file does not do them in that order: the beat
    was read at 0.42 while the subject search that runs later was 0.08, so on a
    plan with music and a reframe the bar went to 44%, then to 16%, then climbed
    again. The two are reordered now, and this is the guard that keeps them so —
    a percentage is a promise about how much is left, and one that goes back on
    itself is worse than a spinner.
  */
  if (lastReported && lastReported.jobId === jobId) {
    if (rounded < lastReported.progress) return;
    if (rounded === lastReported.progress && stage === lastReported.stage) return;
  }
  lastReported = { jobId, progress: rounded, stage };
  await db.update(jobsTable).set({ progress: rounded, stage }).where(eq(jobsTable.id, jobId));
  // Progress is also proof of life. The renewal timer covers the silent
  // stretches; this covers everything else without waiting for the next tick.
  await heartbeat();
}

async function processJob(job: Job): Promise<void> {
  const log = logger.child({ jobId: job.id, projectId: job.projectId });
  const workDir = await mkdtemp(path.join(tmpdir(), "editly-render-"));
  /*
    The mark to measure this job's downloads against.

    A delta rather than a per-job counter, because a render pulls from three
    different call sites in two files and the thing being counted is a property
    of the process. This worker takes one job at a time, so the delta is exact
    — and the day that stops being true, `bytesIn`'s own comment says what has
    to change.
  */
  const pulledAtStart = bytesPulled();
  /**
   * The language this job answers in.
   *
   * Written onto the row at enqueue by whoever had the sentence, so the worker
   * — which only ever sees a plan — does not have to guess, and a render
   * already accepted cannot change language because the next thing they typed
   * was in the other one. `say.language` is passed down; `say(en, ar)` writes
   * the notes this function owns.
   */
  const language: Language = job.language === "ar" ? "ar" : "en";
  const say = Object.assign(sayIn(language), { language });

  try {
    const plan = EditPlan.parse(job.plan);

    log.info({ operations: plan.operations.map((o) => o.type) }, "claimed job");

    /*
      Room to work, asked before anything is spent.

      One HEAD against the store, and the answer decides whether this machine
      starts the render or hands the row back for one that can. The check is
      cheap and it is the only one there is: nothing downstream of here reads
      free disk, so a machine whose `/tmp` is already two-thirds full will
      begin a render it cannot finish and discover it at the encode — after the
      download, after the transcription, after the minutes are gone.

      For a stills reel `input_path` names the first photograph, so this asks
      about that file rather than about the reel it becomes. Deliberately kept
      anyway: it is still one machine's honest answer to "have I any room at
      all", and the alternative is no check on the path that writes the most.
    */
    const sourceBytes = await objectBytes(job.inputPath);
    if (sourceBytes !== null) {
      const room = await roomFor(sourceBytes, workDir);
      if (!room.enough) {
        log.warn({ freeBytes: room.freeBytes, neededBytes: room.neededBytes }, noRoomMessage(room));
        throw new NoRoomHereError(noRoomMessage(room));
      }
    }

    // ── The source, which may not exist yet ───────────────────────────────
    //
    // A `stillsReel` plan is a project with no video in it: photographs, and a
    // shop owner who does not own a camera. The reel is assembled here, before
    // anything else has run, and from the next line down this job is an
    // ordinary render of an ordinary clip — measured, ceilinged, enriched,
    // reframed, scored, reviewed and billed by exactly the paths that already
    // exist. That is the whole reason it is built at this end rather than
    // taught to the renderer as a second kind of input.
    //
    // `let`, and this reassignment is the entire integration. Nothing below
    // knows where the file came from.
    let inputFile = path.join(workDir, "input.mp4");
    /*
      Said first in the finished list, because they are about the material
      rather than about the edit: how many photographs went in, how many there
      was no room for, which ones had to sit inside the frame instead of
      filling it. A person reading "12 of your 20 photos" wants that before
      they read what the grade did.
    */
    const reelNotes: string[] = [];
    const reelOp = plan.operations.find((op) => op.type === "stillsReel");
    if (reelOp && reelOp.type === "stillsReel") {
      await reportProgress(job.id, 5, "Building a video from your photos");
      inputFile = await assembleReel(job, reelOp, plan, workDir, log, say, reelNotes);
    } else {
      await reportProgress(job.id, 5, "Fetching your video");
      // Only when there is one to fetch. A reel job's `input_path` names the
      // first photograph, because the column means "the object this render
      // starts from" and for a reel that is exactly what it is — but opening
      // it here would download a file the assembly is about to fetch again.
      await downloadObject(job.inputPath, inputFile);
    }

    // The first honest measurement of this file anyone has made. Everything
    // before now — the ceiling check in the API, the punch placement in a
    // template — worked from a number the browser supplied and could omit.
    const sourceProbe = await probeSource(inputFile);
    const sourceSeconds = sourceProbe.duration;
    if (exceedsCeiling(sourceSeconds, job.maxSourceSeconds)) {
      await db.update(jobsTable).set({ sourceSeconds }).where(eq(jobsTable.id, job.id));
      throw new SourceTooLongError(tooLongMessage(sourceSeconds, job.maxSourceSeconds as number));
    }
    // The same refusal for the other number the API could not check. It skips
    // the allowance whenever the browser omitted a duration, which is the one
    // case where the file could be anything at all — so the check lands here,
    // against a length that was measured, and before the encode is paid for.
    //
    // Against the balance *now*, not the balance when the row was written. The
    // snapshot is per-job and every job fired in the same second carries the
    // same one, so thirty of them each saw a full allowance and thirty of them
    // were allowed. See `allowanceNow`.
    const balance = allowanceNow(job.remainingSeconds, await spentSinceQueued(job), queuedBeforeThisMonth(job));
    if (exceedsAllowance(sourceSeconds, balance)) {
      await db.update(jobsTable).set({ sourceSeconds }).where(eq(jobsTable.id, job.id));
      throw new SourceTooLongError(overAllowanceMessage(sourceSeconds, balance as number));
    }
    /*
      And the third ceiling, which is ours rather than theirs.

      `deliverableSourceMinutes()` has existed, measured and documented, since
      the deadline was written, and nothing read it. It is what this machine
      can finish before `LIMITS.render.totalMs` kills the job — 115 minutes of
      source at the measured 2.07× — against a pricing page that sells 240 on
      Pro and 600 on Studio.

      Unreachable while the bucket refuses anything over 50 MB, and live the
      morning that changes. The failure it replaces is the worst one available:
      a file the plan allows, four hours of paid compute, and "Rendering
      failed. We are looking into it." — three times over.
    */
    const deliverable = deliverableSourceMinutes();
    if (exceedsDeliverable(sourceSeconds, deliverable)) {
      await db.update(jobsTable).set({ sourceSeconds }).where(eq(jobsTable.id, job.id));
      log.error(
        { sourceSeconds, deliverableMinutes: deliverable },
        "refused a file inside its plan that this machine cannot render in time",
      );
      throw new SourceTooLongError(notDeliverableMessage(sourceSeconds, deliverable));
    }
    // Written back to the project as well, so the next render's ceiling check
    // and the next template's punch placement start from the truth. A lie told
    // once is repaired permanently rather than repeated.
    await db
      .update(projectsTable)
      .set({ duration: Math.round(sourceSeconds) })
      .where(and(eq(projectsTable.id, job.projectId), eq(projectsTable.userId, job.userId)));

    // The look this edit is being matched to, when there is one. Fetched only
    // if the job carries a reference: measuring one costs a few ffmpeg passes
    // and nobody should pay for them by default.
    let referenceFile: string | null = null;
    /** Said out loud when the reference could not be fetched. See below. */
    const referenceNotes: string[] = [];
    if (job.referencePath) {
      await reportProgress(job.id, 7, "Fetching the video you want to match");
      try {
        referenceFile = path.join(workDir, "reference.mp4");
        await downloadObject(job.referencePath, referenceFile);
      } catch (error) {
        /*
          The reference is an improvement to the edit, not a precondition for
          it. Losing it costs the match and nothing else — so the render goes
          on, and the person is told.

          Being told is the part that was missing. This was a log line and
          nothing more, so the project went on showing an attached reference,
          the edit came back with none of its look, and the only place that
          knew was a machine's stdout. Somebody comparing the two videos would
          conclude the feature does not work, which is the conclusion this
          codebase exists to prevent: a render that quietly did less than it
          said.
        */
        referenceFile = null;
        log.warn({ err: error }, "could not fetch the reference video");
        referenceNotes.push(
          say(
            "could not fetch the video you asked to match, so this edit was made without it. The reference is still on the project, and rendering again will use it",
            "تعذّر جلب الفيديو الذي طلبت مطابقته، فصُنع هذا التعديل دونه. المرجع ما زال على المشروع، وإعادة التنفيذ ستستعمله",
          ),
        );
      }
    }

    // Whatever the plan could not know without the file — the words, where the
    // emphasis fell, what the reference looks like — is filled in here. It
    // degrades rather than fails, and every degradation comes back as a note.
    const enriched = await enrichPlan(inputFile, plan, {
      providers,
      // The language the sentence was written in, snapshotted onto the job at
      // enqueue. Every note from here down comes back in it, so the render's
      // answer is in the same language as the reply that promised it.
      language: say.language,
      referencePath: referenceFile,
      onProgress: (stage) => {
        void reportProgress(job.id, 8, stage).catch(() => {});
      },
    });
    if (enriched.notes.length > 0) log.warn({ notes: enriched.notes }, "plan degraded");

    if (enriched.plan.operations.length === 0) {
      throw new PlanEmptiedError(
        enriched.notes[0] ?? "Nothing in that request could be applied to this clip.",
      );
    }

    // The words, on the source clock, so the cut can avoid landing inside one
    // and the critic can refuse to emphasise a hesitation. A measurement of
    // this file rather than a decision about it, which is why it travels beside
    // the plan and not inside it.
    const words = (enriched.transcript?.segments ?? []).flatMap((segment) =>
      segment.words.map((word) => ({
        start: word.startMs / 1000,
        end: word.endMs / 1000,
        filler: word.filler,
        // Carried for the clip titles alone; the cut logic never reads it.
        text: word.text,
        /*
          Who said it, when the plan asked for speaker labels.

          The label is on the segment rather than the word — a segment is one
          run of one voice — so it is stamped onto each word here, where the
          two shapes meet. Absent on every plan that did not ask, which is
          what `conversation.ts` checks before it uses turns at all.
        */
        ...(typeof segment.speaker === "number" ? { speaker: segment.speaker } : {}),
      })),
    );

    /*
      What this video is *about*, read once and kept with the project.

      Best-effort, and the one call in this function that is allowed to fail
      silently in the log rather than on the job: nobody paid for a reading, and
      a render that succeeded must not be turned into a failure by the step that
      came after it. `readMaterial` therefore swallows everything.

      It runs only when a transcript already exists — which means when the plan
      needed one for something else. A render that asked for silence removal and
      a vertical crop never transcribes, and paying a speech model on its behalf
      so that a *later* request might be better planned would be charging
      somebody for a feature they did not ask for. The step that decides a
      reading is worth buying is the one that wants it.
    */
    const reading = await readMaterial(job, enriched.transcript, sourceSeconds, say.language, log);

    // Only the assets this plan actually names, and only after each one has
    // been confirmed to belong to this project.
    //
    // The plan carries ids rather than paths precisely so that this lookup
    // exists: an id that is not in the project's own library resolves to
    // nothing and the overlay is dropped with a note, where a path would have
    // been opened. And downloading only what is referenced means a project with
    // forty files does not pay to fetch forty of them for a render that uses
    // one.
    //
    // **Every operation that names one.** This list read `insertBRoll` and
    // `overlayImage` and not `addMusic`, which meant the bed was never
    // downloaded — so the renderer looked the id up in an empty map, found
    // nothing, and wrote "the track this plan names is not in this project"
    // onto a render whose track was sitting in the project the whole time.
    // Music has therefore never once played under a finished edit in
    // production, and nothing said so: the render succeeded, the note was
    // truthful about what it saw, and the only thing wrong was three operation
    // names where there should have been four.
    //
    // Not caught for the same reason it was easy to write: every render suite
    // calls `renderPlan` with an assets map built by hand, so the one place
    // that decides *which files a job fetches* had no test through it at all.
    // `worker-test` seeds an asset and a bucket object now.
    const NAMES_AN_ASSET = new Set(["insertBRoll", "overlayImage", "addMusic"]);
    const wantedAssetIds = [
      ...new Set(
        enriched.plan.operations
          .filter((op) => NAMES_AN_ASSET.has(op.type))
          .map((op) => (op as { assetId: string }).assetId)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ];
    const assets = new Map<string, { file: string; kind: "video" | "image" | "audio" }>();
    /** Assets this project really has and this render could not fetch. */
    const unreachableAssetIds = new Set<string>();
    if (wantedAssetIds.length > 0) {
      await reportProgress(job.id, 9, "Fetching the files you added");
      const rows = await db
        .select()
        .from(assetsTable)
        .where(and(eq(assetsTable.projectId, job.projectId), eq(assetsTable.userId, job.userId)));
      const byId = new Map(rows.map((row) => [row.id, row]));
      // Named, so "we could not fetch it" is not reported as "you do not have
      // it". See the catch below.

      for (const id of wantedAssetIds) {
        const row = byId.get(id);
        if (!row) {
          log.warn({ assetId: id }, "plan named an asset this project does not have");
          continue;
        }
        try {
          const file = path.join(workDir, `asset-${row.id}`);
          await downloadObject(row.path, file);
          assets.set(row.id, { file, kind: row.kind as "video" | "image" | "audio" });
        } catch (error) {
          /*
            One missing overlay is a worse render, not a failed one — and the
            renderer must be able to say which of the two happened.

            Both this and "the row is not there" used to leave the id out of
            the map and nothing else, so the renderer wrote the same sentence
            for both: "skipped the music: asset 4f1c… is not in this project."
            On a transient storage error the track *is* in the project, and the
            customer was sent to look for a file that is sitting there, found
            it, and re-uploaded it.

            Recorded rather than inferred, so the note can tell the truth.
          */
          log.warn({ err: error, assetId: id }, "could not fetch an asset");
          unreachableAssetIds.add(id);
        }
      }
    }

    // ── The fonts this person brought ─────────────────────────────────────
    //
    // Resolved here rather than in the renderer, for the reason every other id
    // in a plan is: by the time a filter graph is being written, "may this job
    // open this file" must already be answered. A renderer that could look up
    // a font by id is one plan away from drawing with somebody else's.
    //
    // Downloaded into the job's own directory and handed to libass as a
    // `fontsdir`, never installed. Two renders run side by side on some
    // machines, and a family name is all it would take for one to draw the
    // other's font.
    const faces = await fetchUploadedFaces(
      job.userId,
      enriched.plan.operations.flatMap((op) =>
        op.type === "autoCaptions" || op.type === "burnCaptions"
          ? [(op as { font?: string }).font, (op as { fontArabic?: string }).fontArabic]
          : [],
      ),
      workDir,
      (fields, message) => log.warn(fields, message),
    );

    // ── Several clips instead of one video ────────────────────────────────
    //
    // A clips plan is expanded here, not in the renderer: each chosen window
    // becomes its own complete render — an extractRange the worker decided on
    // plus everything else the plan asked for — so every clip rides exactly
    // the paths a single render does, review pass included. The project's own
    // pointer keeps meaning "the latest whole-video render" and is not
    // touched; the outputs are their own artifacts in the clips table.
    const clipsOp = enriched.plan.operations.find((op) => op.type === "extractClips");
    if (clipsOp && clipsOp.type === "extractClips") {
      await renderClipSet({
        job,
        clipsOp,
        enriched,
        reading,
        words,
        assets,
        unreachableAssetIds,
        pulledAtStart,
        workDir,
        inputFile,
        sourceSeconds,
        sourceHadAudio: sourceProbe.hasAudio,
        language,
        log,
      });
      return;
    }

    const { output, notes: renderNotes, estimatedSeconds, hasAudioOut, levelled } = await renderPlan(inputFile, enriched.plan, {
      workDir,
      language: say.language,
      words,
      // What the material is, for the one decision in the renderer that is
      // about content rather than about pixels: which stretch a highlight
      // keeps. Everything else in there is arithmetic on this file.
      reading,
      assets,
      unreachableAssetIds,
      ...(faces ? { faces } : {}),
      onProgress: (fraction, stage) => {
        // Download and upload bracket the render; the middle 80% is ffmpeg.
        void reportProgress(job.id, 10 + fraction * 80, stage).catch(() => {});
      },
    });
    const notes = [...reelNotes, ...referenceNotes, ...enriched.notes, ...renderNotes];

    // The look at what actually came out, before anyone else sees it.
    //
    // The plan critic checked the numbers; this checks the file. Its one
    // repair is the loudness correction — a second, linear levelling pass
    // built from measurements of the first, with the video stream copied
    // untouched — and everything else it finds becomes an honest note or a
    // log line. It runs between render and upload on purpose: a corrected
    // master is the one the preview is encoded from and the one that ships.
    // And it is best-effort all the way down — a review that cannot run must
    // not cost anyone the render it was reviewing.
    await reportProgress(job.id, 90, "Checking the result");
    try {
      const review = await reviewOutput(output, {
        operations: enriched.plan.operations,
        language: say.language,
        sourcePath: inputFile,
        sourceHadAudio: sourceProbe.hasAudio,
        expectedAudio: hasAudioOut,
        levelled,
        expectedSeconds: estimatedSeconds,
        workDir,
      });
      notes.push(...review.notes);
      if (review.repaired) log.info({ measuredLufs: review.measuredLufs }, "output repaired after review");
      if (review.warnings.length > 0) log.warn({ warnings: review.warnings }, "output review raised flags");
    } catch (error) {
      log.warn({ err: error }, "output review failed; delivering the file unreviewed");
    }

    await reportProgress(job.id, 92, "Saving the result");
    const outputPath = `${job.userId}/${job.projectId}/edited-${job.id}.mp4`;
    await uploadObject(outputPath, output);

    // A VP9 mirror of the master, so "watch what I made" does not depend on
    // the viewer's operating system shipping a working H.264 decoder — we have
    // watched a real browser sit at readyState 0 forever on the master while
    // claiming it could probably play it. Optional on purpose: a render whose
    // preview fails is a render, and the player falls back to the master.
    try {
      const previewFile = path.join(workDir, "preview.webm");
      await encodePreview(output, previewFile);
      await uploadObject(previewPathFor(outputPath), previewFile);
    } catch (error) {
      log.warn({ err: error }, "preview encode failed; the master is the only copy");
    }

    // The true size of what was produced, measured from the file. The project
    // row's width/height describe the *upload*; the player needs the shape of
    // the file it is actually showing, and on a browser that cannot decode it
    // this stored pair is the only shape it will ever learn.
    let editedSize: { width: number | null; height: number | null } = { width: null, height: null };
    try {
      const probed = await probeSource(output);
      if (probed.width > 0 && probed.height > 0) editedSize = { width: probed.width, height: probed.height };
    } catch {
      // The shape is a nicety; the render is the point.
    }

    // What the plan meter counts. Measured from the finished file rather than
    // predicted from the plan, because the only honest number is the one in the
    // video we are about to hand over — but never left null, because the meter
    // sums this column and SQL skips nulls, so an unmeasurable render used to
    // be a free one. `how` records which answer we ended up with.
    const measured = await measureOutput(() => probeDuration(output), {
      estimate: estimatedSeconds,
      sourceSeconds,
    });
    if (measured.how !== "probe") {
      log.warn({ how: measured.how, seconds: measured.seconds }, "output duration not measured directly");
    }

    await db
      .update(jobsTable)
      .set({
        status: "done",
        progress: 100,
        stage: null,
        error: null,
        // Cleared with it: a retry that succeeded must not leave the console
        // showing the reason the first attempt failed beside a finished job.
        errorDetail: null,
        outputPath,
        notes,
        outputSeconds: measured.seconds,
        // A single render is billed at what it produced. Written explicitly
        // rather than left to the meter's fallback, so the charge is a
        // recorded fact and not an inference.
        billedSeconds: measured.seconds,
        // What this render pulled out of storage. Not billing: the one term of
        // the infrastructure bill that can be counted exactly, and the term
        // that decides where this product's files should live. See the column.
        bytesIn: bytesPulled() - pulledAtStart,
        outputSecondsSource: measured.how,
        sourceSeconds,
        lockedAt: null,
        lockedBy: null,
        finishedAt: new Date(),
      })
      .where(eq(jobsTable.id, job.id));

    await db
      .update(projectsTable)
      .set({
        status: "done",
        editedVideoPath: outputPath,
        editedWidth: editedSize.width,
        editedHeight: editedSize.height,
      })
      .where(and(eq(projectsTable.id, job.projectId), eq(projectsTable.userId, job.userId)));

    // The summary, said in the conversation itself.
    //
    // The editor used to synthesise a "Here's what I did" bubble from the
    // latest job's notes — which meant the summary belonged to the job, not to
    // the conversation, and evaporated the moment the next render started.
    // Someone who asked for three edits over an afternoon had a chat that
    // remembered their three sentences and none of the three answers. Written
    // here, once, at the only moment the notes are fresh, it becomes part of
    // the record the messages endpoint returns forever after.
    //
    // Best-effort on purpose: the render is already saved and paid for, and a
    // failed insert must not turn a finished job into a retried one.
    try {
      await db.insert(messagesTable).values({
        id: randomUUID(),
        userId: job.userId,
        projectId: job.projectId,
        role: "assistant",
        content:
          notes.length > 0
            ? `${say("Here's what I did.", "هذا ما فعلته.")}\n${notes.map((note) => `• ${note}`).join("\n")}`
            : say("Done. Your edit is ready to watch.", "تمّ. تعديلك جاهز للمشاهدة."),
      });
    } catch (error) {
      log.warn({ err: error }, "could not write the summary into the conversation");
    }

    /*
      And told to somebody who is not looking at the screen.

      The mail nobody could send until now, and the one most obviously owed: a
      render takes minutes, so whoever asked for it is somewhere else when it
      lands. Awaited rather than fired off, because this process exits when it
      is told to and an unawaited send is a message lost on a rolling deploy —
      and it cannot throw, so nothing here can turn a finished render into a
      retried one.
    */
    await tellThemTheEditIsReady({
      userId: job.userId,
      jobId: job.id,
      projectId: job.projectId,
      projectTitle: await titleOf(job.projectId, job.userId),
      seconds: measured.seconds,
    });

    log.info({ outputPath, outputSeconds: measured.seconds, how: measured.how, notes }, "render complete");
  } catch (error) {
    /*
      One failure that is not a failure, handled before any of the rest.

      There is nothing wrong with this job, so nothing is written about it: no
      error for the person, no attempt spent, no `failed` on the project. The
      row goes back exactly as it was claimed and another machine — or this one
      after the sweep has room — takes it.

      The pause matters as much as the requeue. Without it this worker claims
      the same row again on the next poll, finds the same full disk, and spins
      through the queue rejecting every job several times a second while
      writing a warning each time. `roomFor` is not going to answer differently
      within a poll interval.
    */
    /*
      Stopped on purpose, which is not a failure of anything.

      Settled here rather than left to the reaper, and settled as `failed`
      because that is what every reader of `status` understands as "not going
      any more" — `cancelled_at` was already written by whoever asked, and it
      is what tells the product, the mail and the retry logic that this was a
      decision rather than a fault. Nothing is retried, nothing is apologised
      for, and the project is not marked failed: a project whose render was
      stopped is a project waiting to be rendered again.
    */
    if (error instanceof CancelledError) {
      log.info({ progress: lastReported?.progress ?? null }, "stopped at the customer's request");
      await db
        .update(jobsTable)
        .set({
          status: "failed",
          error: CANCELLED_MID_RENDER_MESSAGE,
          errorDetail: null,
          stage: null,
          lockedAt: null,
          lockedBy: null,
          finishedAt: new Date(),
        })
        .where(eq(jobsTable.id, job.id));
      return;
    }

    if (error instanceof NoRoomHereError) {
      await db
        .update(jobsTable)
        .set({
          status: "queued",
          stage: null,
          progress: 0,
          lockedAt: null,
          lockedBy: null,
          attempts: Math.max(0, job.attempts - 1),
        })
        .where(eq(jobsTable.id, job.id));
      await rm(workDir, { recursive: true, force: true });
      await sleep(NO_ROOM_PAUSE_MS);
      return;
    }

    // ffmpeg's complaints are specific enough to be worth showing; anything
    // else is infrastructure and the user can do nothing with the detail.
    //
    // A transfer that did not complete is the third kind, and it was being
    // filed under the second. "Rendering failed. We are looking into it." is
    // the right sentence for a filter graph that blew up and the wrong one for
    // a video that arrived two thirds of the way: the first is ours to fix and
    // the second is worth trying again in the next minute, and the person can
    // only tell those apart if we say which happened.
    const message =
      error instanceof PlanEmptiedError ||
      error instanceof SourceTooLongError ||
      error instanceof StorageTransferError
        ? error.message.slice(0, 300)
        : error instanceof FfmpegError
          ? error.message.split("\n")[0].slice(0, 300)
          : "Rendering failed. We are looking into it.";
    // A plan nothing could be done with will be just as impossible next time,
    // and a file will not get shorter.
    /*
      And the same failure again, unedited, for the operations console.

      `message` above is written for the person waiting on the video. The
      console was reading that column and calling it the error, so an operator
      looking up a failed render was shown our own reassurance — "Rendering
      failed. We are looking into it." — while the reason sat in a log line on
      Fly. Logs you have to go and read are the shape the August outage had.

      Name first, because "TypeError" and "FfmpegError" send you to different
      halves of the codebase before a word of the message is read. Truncated
      because a filter graph in an error message can run to kilobytes, and the
      first two thousand characters have always been the ones that matter.
    */
    const detail = (
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    ).slice(0, 2000);

    /*
      Which failures are worth a second run.

      `StorageTransferError` is mostly retryable — a stalled download, an upload
      that timed out — which is why it is not on the list wholesale. The
      exception is a 413 from the bucket, which it now carries as `final`: the
      same plan on the same source produces the same oversize file, so the two
      further attempts were hours of paid compute spent to be refused twice
      more, while the person waited for a verdict the first attempt already gave
      them in words.
    */
    const final =
      error instanceof PlanEmptiedError ||
      error instanceof SourceTooLongError ||
      (error instanceof StorageTransferError && error.final);
    const willRetry = !final && job.attempts < job.maxAttempts;

    log.error({ err: error, attempt: job.attempts, willRetry }, "render failed");

    await db
      .update(jobsTable)
      .set({
        status: willRetry ? "queued" : "failed",
        error: message,
        errorDetail: detail,
        stage: null,
        /*
          And the percentage, which the other two requeue paths clear and this
          one did not.

          The bar is drawn from this column. A render that failed at 62% and is
          going back in the queue leaves it reading 62% under "you can close
          this page, it keeps going" — for as long as it takes another machine
          to claim it, which on a busy queue is minutes. The person is watching
          a number that is not about anything: the attempt it described is over,
          and the attempt that replaces it has not started.

          `requeueStaleJobs` and `releaseHeldJob` both write `progress = 0`
          here. This is the path a retry actually takes, and it was the one
          left out.
        */
        ...(willRetry ? { progress: 0 } : {}),
        lockedAt: null,
        lockedBy: null,
        ...(willRetry ? {} : { finishedAt: new Date() }),
      })
      .where(eq(jobsTable.id, job.id));

    if (!willRetry) {
      await db
        .update(projectsTable)
        .set({ status: "failed" })
        .where(and(eq(projectsTable.id, job.projectId), eq(projectsTable.userId, job.userId)));

      // A final failure is an answer too, and it belongs in the conversation
      // for the same reason the summary does: the person asked in words, and
      // an edit that silently never arrives reads as being ignored. Only on
      // the *final* attempt — a retry that is about to succeed should not
      // leave an apology above its own success.
      try {
        await db.insert(messagesTable).values({
          id: randomUUID(),
          userId: job.userId,
          projectId: job.projectId,
          role: "assistant",
          // The reason comes from ffmpeg or from infrastructure and is written
          // in English at its source. Only the sentence around it is ours to
          // say, so only that is translated: inventing an Arabic reason we did
          // not write would be a different claim about what went wrong.
          content: say(`I couldn't finish that edit: ${message}`, `لم أستطع إنهاء ذلك التعديل: ${message}`),
        });
      } catch (insertError) {
        log.warn({ err: insertError }, "could not write the failure into the conversation");
      }

      // And the same answer to somebody who has closed the tab. Inside
      // `if (!willRetry)` for the reason the message above is: an apology for a
      // render that then succeeds is worse than no mail at all.
      await tellThemItDidNotFinish({
        userId: job.userId,
        jobId: job.id,
        projectId: job.projectId,
        projectTitle: await titleOf(job.projectId, job.userId),
        reason: message,
      });
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The project's reading of its own material, made once and reused.
 *
 * This is the step the product never had. Everything above it can execute an
 * instruction; nothing anywhere knew what the video was about, so "the
 * strongest thirty seconds" meant "where the talking was densest" — a fact
 * about the audio and not about the content, which is why the clips come out
 * plausible and are rarely the right piece. `comprehend.ts` turns the
 * transcript into chapters, claims, questions, peaks and a hook; this writes
 * that down beside the project so the next request starts from it instead of
 * from the sentence alone.
 *
 * Three things keep it cheap and honest.
 *
 * **It is skipped when the words have not changed.** `digest` fingerprints the
 * transcript, not the file: a re-encode of the same recording is a different
 * file and the same material, and paying a model to read it again would buy a
 * second opinion nobody asked for — and a second opinion is worse than no
 * opinion here, because the same project would then have had two different
 * ideas about where its chapters are.
 *
 * **It never throws.** A reading is not a deliverable. Losing one costs the
 * next plan some context; failing a finished render over one would cost a
 * customer their video.
 *
 * **It records how it was made.** With no model configured the structure comes
 * from the shape of the speech, which is a weaker answer that looks exactly the
 * same from the outside — so `how` and the notes say which it was, and the
 * shape path stores no claims and no hook at all.
 */
async function readMaterial(
  job: Job,
  transcript: Awaited<ReturnType<typeof enrichPlan>>["transcript"],
  sourceSeconds: number,
  language: Language,
  log: pino.Logger,
): Promise<Reading | null> {
  if (!transcript) return null;
  try {
    const words = wordsOf(transcript);
    if (words.length === 0) return null;
    const digest = transcriptDigest(words);

    const [stored] = await db
      .select()
      .from(comprehensionsTable)
      .where(
        and(
          eq(comprehensionsTable.projectId, job.projectId),
          eq(comprehensionsTable.userId, job.userId),
        ),
      )
      .limit(1);
    if (stored && stored.digest === digest && stored.version === COMPREHENSION_VERSION) {
      log.info({ how: stored.how }, "the reading of this material is still current");
      return {
        questions: stored.questions ?? [],
        claims: stored.claims ?? [],
        peaks: stored.peaks ?? [],
        hook: stored.hook ?? null,
      };
    }

    const reading = await comprehend({
      transcript,
      durationSeconds: sourceSeconds,
      reader: providers.structureReader,
      unavailable: providers.status.structure,
      language,
    });

    const row = {
      projectId: job.projectId,
      userId: job.userId,
      version: reading.version,
      durationSeconds: reading.durationSeconds,
      language: reading.language,
      how: reading.how,
      source: reading.source,
      digest: reading.digest,
      chapters: reading.chapters,
      claims: reading.claims,
      questions: reading.questions,
      peaks: reading.peaks,
      hook: reading.hook,
      notes: reading.notes,
    };

    await db
      .insert(comprehensionsTable)
      .values({ id: randomUUID(), ...row })
      // One row per project: the second reading of one video is not a history,
      // it is an ambiguity about which one is true.
      .onConflictDoUpdate({
        target: comprehensionsTable.projectId,
        set: { ...row, updatedAt: new Date() },
      });

    log.info(
      {
        how: reading.how,
        source: reading.source,
        chapters: reading.chapters.length,
        claims: reading.claims.length,
        questions: reading.questions.length,
        peaks: reading.peaks.length,
        hook: reading.hook !== null,
        notes: reading.notes,
      },
      "read what this material is",
    );
    return {
      questions: reading.questions,
      claims: reading.claims,
      peaks: reading.peaks,
      hook: reading.hook,
    };
  } catch (error) {
    // Deliberately swallowed. See the doc comment: a render that produced a
    // video must not fail because the step that reads it did.
    log.warn({ err: error }, "could not read this material; the render is unaffected");
    return null;
  }
}

/**
 * One clips job, expanded into one render per chosen window.
 *
 * Runs inside processJob's try, so a throw here fails the job through the
 * same path a single render does. Each clip is a complete render — the
 * worker's chosen extractRange plus everything else the plan asked for — so
 * captions, reframing, levelling, the watermark policy added, and the
 * post-render review all apply to every clip exactly as they would to one.
 *
 * The rows land in `clips`; the job's own outputPath points at the first
 * clip (a job that made files should say so); the project's pointer is left
 * alone, because it means "the latest whole-video render" and none happened.
 */
/**
 * Six clips' worth of render notes, said once each.
 *
 * A clips job runs the whole renderer per clip, so most of what it has to say
 * is the same sentence six times over — "skipped the music: that asset is not
 * in this project" does not become more true for being repeated. Printing them
 * straight would bury the six lines that say what was actually kept under
 * thirty that do not.
 *
 * So: a note every clip produced is stated once, plainly, because it is a fact
 * about the render rather than about a clip. A note only some clips produced
 * is stated with their numbers, because *which* ones is the whole information
 * — "clips 2 and 5: the sound did not survive this edit" is a different
 * sentence from the same words without the numbers.
 *
 * Order is first-appearance, so the sequence a person reads is the sequence
 * the renderer produced.
 */
export function insideEachClip(perClip: readonly (readonly string[])[], language: Language): string[] {
  const total = perClip.length;
  if (total === 0) return [];
  const t = sayIn(language);

  // First appearance wins the position; the set records which clips said it.
  const order: string[] = [];
  const clipsSaying = new Map<string, number[]>();
  perClip.forEach((notesForClip, index) => {
    // Deduplicated within a clip too: one clip repeating itself is one fact.
    for (const note of new Set(notesForClip)) {
      const seen = clipsSaying.get(note);
      if (seen) seen.push(index + 1);
      else {
        clipsSaying.set(note, [index + 1]);
        order.push(note);
      }
    }
  });

  return order.map((note) => {
    const clips = clipsSaying.get(note)!;
    if (clips.length === total) return note;
    const numbers = clips.join(", ");
    return clips.length === 1
      ? t(`clip ${numbers}: ${note}`, `القصاصة ${numbers}: ${note}`)
      : t(`clips ${numbers}: ${note}`, `القصاصات ${numbers}: ${note}`);
  });
}

async function renderClipSet(args: {
  job: Job;
  clipsOp: Extract<EditOperation, { type: "extractClips" }>;
  enriched: Awaited<ReturnType<typeof enrichPlan>>;
  /** What the material is, when something has read it. Null falls back to density. */
  reading: Reading | null;
  words: Array<{ start: number; end: number; filler: boolean; text?: string; speaker?: number }>;
  assets: Map<string, { file: string; kind: "video" | "image" | "audio" }>;
  unreachableAssetIds: ReadonlySet<string>;
  /** Where the job's download counter stood when it started. See `bytesIn`. */
  pulledAtStart: number;
  workDir: string;
  inputFile: string;
  sourceSeconds: number;
  sourceHadAudio: boolean;
  language: Language;
  log: pino.Logger;
}): Promise<void> {
  const { job, clipsOp, enriched, reading, words, assets, unreachableAssetIds, pulledAtStart, workDir, inputFile, sourceSeconds, sourceHadAudio, log } = args;
  const t = sayIn(args.language);

  await reportProgress(job.id, 9, "Choosing the clips");

  /*
    A retry must produce a fresh set, not a second copy of half of one — and it
    must not destroy the set it has before it can produce one.

    This delete used to be here, at 9%, before a window had been chosen or a
    frame encoded. Everything after it can throw: `chooseClips` answers
    `PlanEmptiedError` on a source that now reads short, a provider goes down,
    an upload takes a 413, the machine is OOM-killed mid-encode. When it did,
    the job ended `failed` and the person's clips panel — which had six
    playable clips a minute earlier — was empty. The six objects were still in
    the bucket with no row naming them, invisible to the product and to the
    retention sweep, which only derives clip keys from rows it can read.

    So the old set is read here and removed *after* the first replacement has
    been rendered and uploaded, which is the last moment before an insert could
    make the two sets visible at once. The likeliest failures — choosing
    nothing, and the first clip — now leave the previous clips exactly where
    they were.
  */
  const previous = await db
    .select({ id: clipsTable.id, idx: clipsTable.idx, outputPath: clipsTable.outputPath })
    .from(clipsTable)
    .where(eq(clipsTable.jobId, job.id));
  let previousCleared = false;
  const clearPrevious = async (): Promise<void> => {
    if (previousCleared || previous.length === 0) {
      previousCleared = true;
      return;
    }
    await db.delete(clipsTable).where(eq(clipsTable.jobId, job.id));
    previousCleared = true;
  };

  /*
    Where the clips come from, and why there are now two answers.

    `chooseClips` scores by speech density with a hesitation penalty. On a
    conversation that is answering the wrong question: the strongest forty
    seconds of an interview is not where the talking was busiest, it is where
    somebody asked something real and somebody else answered it. The two often
    coincide, and when they do not, density wins — which is exactly why the
    pieces have always come out plausible and never the ones a person would
    have picked.

    So when the material has been read, the clips are cut from what it *says*:
    a question with its answer, a claim with the line that set it up, a peak
    inside the turn it happened in. Density remains the answer when there is no
    reading, and the note below says which of the two happened rather than
    letting a deployment with no model quietly get the weaker one.
  */
  const conversational =
    reading && words.length > 0
      ? chooseConversationClips({
          reading,
          words,
          duration: sourceSeconds,
          count: clipsOp.count,
          targetSeconds: clipsOp.targetSeconds,
        })
      : [];

  const chosen: { windows: { start: number; end: number }[]; how: "conversation" | "speech" | "divided" | "whole" } =
    conversational.length > 0
      ? { windows: conversational.map((clip) => ({ start: clip.start, end: clip.end })), how: "conversation" }
      : chooseClips(sourceSeconds, clipsOp.count, clipsOp.targetSeconds, words.length > 0 ? words : undefined);

  if (chosen.windows.length === 0) {
    throw new PlanEmptiedError("This video is too short to cut clips of that length from.");
  }

  // The rest of the plan applies to every clip. The other cut operations do
  // not ride along: the clips ARE the cut, and a highlight window chosen on
  // the whole source could escape the very piece it lands in.
  const rest = enriched.plan.operations.filter(
    (op) => op.type !== "extractClips" && op.type !== "extractHighlight" && op.type !== "extractRange",
  );
  const notes: string[] = [...enriched.notes];

  /*
    What ffmpeg and the review said about each clip, which used to be computed
    and thrown away.

    `renderPlan` returns notes and `reviewOutput` returns more, and on this
    path they were destructured into `renderNotes`, appended to, and never
    merged into anything. The single-render path two hundred lines up does
    `[...enriched.notes, ...renderNotes]`; this one did not, and nothing
    failed — the job finished, the clips played, and the honesty layer was
    simply absent from every clips render this product has ever made.

    What was being discarded is not decoration. "skipped the music: that asset
    is not in this project", "3 punches fell in silence that was cut", "burned
    42 captions, but the words came back without their own timings", and — from
    the review — "the sound did not survive this edit. That is a fault on our
    side." A customer was told six clips were made and nothing about what
    happened inside them, including known faults.

    The tell that it had been overlooked rather than decided: the comment at
    the `renderPlan` call below explains that the job's language was threaded
    into these notes and into the review, "so an Arabic clips job came back
    with its own summary in Arabic and every render and review note inside it
    in English". Somebody fixed the language of notes nobody could read.
  */
  const perClipNotes: string[][] = [];
  if (rest.length !== enriched.plan.operations.length - 1) {
    notes.push(
      t("the plan asked for clips and another cut at once. The clips won", "طلبت الخطّة قصاصات وقصًّا آخر معًا، والقصاصات فازت"),
    );
  }
  if (chosen.windows.length < clipsOp.count) {
    notes.push(
      t(
        `the video is ${sourceSeconds.toFixed(0)}s long, which holds ${chosen.windows.length} clip${chosen.windows.length === 1 ? "" : "s"} of ${Math.round(clipsOp.targetSeconds)}s, not the ${clipsOp.count} asked for`,
        `الفيديو طوله ${sourceSeconds.toFixed(0)} ثانية، وهو يسع ${countedAr(chosen.windows.length, AR_NOUNS.clip)} من ${Math.round(clipsOp.targetSeconds)} ثانية، لا ${countedAr(clipsOp.count, AR_NOUNS.clip)} المطلوبة`,
      ),
    );
  }
  /*
    Onto the pauses, which the clips path was not doing at all.

    `extractHighlight` has snapped its window to word boundaries for a long
    time. `extractClips` did not: its windows went straight into an
    `extractRange` sub-plan, and `extractRange` deliberately never snaps —
    a range somebody *named* ("from 1:20 to 2:10") is their choice and honouring
    it exactly is the point. So the same product cut one clip on a word and six
    clips wherever `start + thirty seconds` happened to fall, and nothing
    anywhere said the two features had different standards.

    Now both land on a real pause when one is within reach. The windows are
    walked in order with each start floored at the previous end, because
    `chooseClips` guarantees they do not overlap and a drifting boundary is
    exactly the thing that could break that — two clips sharing a sentence read
    as the same clip posted twice.
  */
  if (words.length > 0 && chosen.how !== "conversation") {
    /*
      Not for the conversational windows.

      Their edges are not arithmetic that happened to land somewhere — the start
      *is* the moment a turn began or a question was asked, and the end *is* the
      pause the answer settled into. Dragging those by a drift budget to find a
      nearby pause can only move a clip off the sentence it was chosen for, and
      the check that would notice is a person watching it.
    */
    const drift = Math.min(4, Math.max(0.75, clipsOp.targetSeconds * 0.15));
    let floor = 0;
    let moved = 0;
    chosen.windows = chosen.windows.map((window) => {
      const snapped = snapToSpeechBreaks(window, words, {
        driftSeconds: drift,
        duration: sourceSeconds,
        notBefore: floor,
      });
      if (Math.abs(snapped.start - window.start) > 0.01 || Math.abs(snapped.end - window.end) > 0.01) moved += 1;
      floor = snapped.end;
      return snapped;
    });
    if (moved > 0) {
      notes.push(
        t(
          `moved ${moved} clip edge${moved === 1 ? "" : "s"} onto a pause, so they start and end on a whole thought`,
          `أزحت ${moved} من حواف القصاصات إلى سكتة، كي تبدأ وتنتهي عند فكرة كاملة`,
        ),
      );
    }
  }

  notes.push(
    chosen.how === "conversation"
      ? t(
          `cut ${chosen.windows.length} pieces from what was said rather than from where the talking was densest`,
          `قصصت ${chosen.windows.length} قطعًا مما قيل، لا من حيث كان الكلام أكثف`,
        )
      : chosen.how === "speech"
        ? t(
            `chose ${chosen.windows.length} stretches where the speech runs densest`,
            `اخترت ${chosen.windows.length} مقاطع حيث الكلام أكثف`,
          )
        : t(
            `we could not hear words in this clip, so it was divided evenly into ${chosen.windows.length}`,
            `لم نستطع سماع كلام في هذا المقطع، فقُسّم بالتساوي إلى ${chosen.windows.length}`,
          ),
  );
  /*
    Why each one, in the order they appear.

    A clip nobody can argue with is a clip nobody can correct. "The strongest
    thirty seconds" is not a reason — it is the name of the feature — whereas
    "opens on the question and runs to where the answer lands" is a sentence a
    person can disagree with, and disagreeing is how the next request gets
    better.
  */
  for (const [index, clip] of conversational.entries()) {
    notes.push(t(`clip ${index + 1}: ${clip.why.en}`, `القصاصة ${index + 1}: ${clip.why.ar}`));
  }
  if (chosen.how !== "conversation" && reading === null) {
    notes.push(
      t(
        "nothing has read this recording for meaning yet, so the pieces were chosen by how densely somebody was talking",
        "لم يقرأ أحد هذا التسجيل قراءةً معنويّة بعد، فاختيرت القطع بكثافة الكلام",
      ),
    );
  }
  // The charge, said where the person will read it. Clips are metered by the
  // source they read, not by the pieces — the whole file was transcribed and
  // scored to choose them — and a charge nobody saw coming is a dispute.
  notes.push(
    t(
      `counted as ${Math.round(sourceSeconds)}s against your minutes. Clips are metered by the source they read, not by the pieces`,
      `حُسبت ${Math.round(sourceSeconds)} ثانية من دقائقك. القصاصات تُحاسب بالمصدر الذي قرأته، لا بالقطع`,
    ),
  );

  const total = chosen.windows.length;
  let outputSecondsSum = 0;
  let weakestMeasure: "probe" | "estimate" | "fallback" = "probe";
  let firstClipPath: string | null = null;

  for (const [i, window] of chosen.windows.entries()) {
    const subDir = path.join(workDir, `clip-${i + 1}`);
    await mkdir(subDir, { recursive: true });
    const subPlan = {
      version: 1 as const,
      operations: [
        { type: "extractRange" as const, startSeconds: window.start, endSeconds: window.end },
        ...rest,
      ],
    };
    const { output, notes: renderNotes, estimatedSeconds, hasAudioOut, levelled } = await renderPlan(inputFile, subPlan, {
      workDir: subDir,
      // `renderClipSet` takes the job's language and uses it for its own notes
      // three lines down, and then dropped it here and at the review below —
      // so an Arabic clips job came back with its own summary in Arabic and
      // every render and review note inside it in English.
      language: args.language,
      words,
      assets,
      unreachableAssetIds,
      onProgress: (fraction, stage) => {
        void reportProgress(
          job.id,
          10 + ((i + fraction) / total) * 78,
          `Clip ${i + 1} of ${total}: ${stage}`,
        ).catch(() => {});
      },
    });

    // The same look every single render gets, per clip. Best-effort for the
    // same reason: a review that cannot run must not cost the render.
    try {
      const review = await reviewOutput(output, {
        operations: subPlan.operations,
        language: args.language,
        sourcePath: inputFile,
        sourceHadAudio,
        expectedAudio: hasAudioOut,
        levelled,
        expectedSeconds: estimatedSeconds,
        workDir: subDir,
      });
      renderNotes.push(...review.notes);
      if (review.warnings.length > 0) {
        log.warn({ clip: i + 1, warnings: review.warnings }, "clip review raised flags");
      }
    } catch (error) {
      log.warn({ err: error, clip: i + 1 }, "clip review failed; delivering unreviewed");
    }

    // Kept, because the whole point of them is that somebody reads them. See
    // `insideEachClip` below for why they are not pushed straight onto `notes`.
    perClipNotes.push(renderNotes);

    const outputPath = `${job.userId}/${job.projectId}/clip-${job.id}-${i + 1}.mp4`;
    await uploadObject(outputPath, output);
    // The previous set goes now: a replacement exists, and the next statement
    // in this loop is the insert that would otherwise put two sets in front of
    // the person at once. See `clearPrevious`.
    await clearPrevious();
    firstClipPath ??= outputPath;

    // The same VP9 mirror every master gets, same naming convention, same
    // optionality: a clip whose preview fails is a clip.
    try {
      const previewFile = path.join(subDir, "preview.webm");
      await encodePreview(output, previewFile);
      await uploadObject(previewPathFor(outputPath), previewFile);
    } catch (error) {
      log.warn({ err: error, clip: i + 1 }, "clip preview encode failed; the master is the only copy");
    }

    // The poster, from the middle of what was actually rendered rather than
    // of the source window: a clip whose silences were cut is shorter than
    // its window, and the middle of the window could be past its end.
    let thumbnailPath: string | null = null;
    try {
      const posterFile = path.join(subDir, "poster.jpg");
      const grabbed = await grabPosterFrame(output, (estimatedSeconds || 1) / 2, posterFile);
      if (grabbed) {
        const key = outputPath.replace(/\.mp4$/i, "") + ".jpg";
        await uploadObject(key, grabbed);
        thumbnailPath = key;
      }
    } catch (error) {
      log.warn({ err: error, clip: i + 1 }, "clip poster upload failed; the row keeps no still");
    }

    const measured = await measureOutput(() => probeDuration(output), {
      estimate: estimatedSeconds,
      sourceSeconds: window.end - window.start,
    });
    outputSecondsSum += measured.seconds;
    if (measured.how === "fallback" || (measured.how === "estimate" && weakestMeasure === "probe")) {
      weakestMeasure = measured.how;
    }

    const clipNote =
      chosen.how === "speech" ? "the speech runs densest here" : "an even division of the video";

    // Whether the silences came out is a fact about the plan, not about the
    // wording of a note. It used to be read with /silence/ over the render's
    // own notes, which worked only for as long as those notes were guaranteed
    // to be English — and they are not, from this round on.
    const cutSilence = subPlan.operations.some((op) => op.type === "removeSilence");
    await db.insert(clipsTable).values({
      id: randomUUID(),
      projectId: job.projectId,
      userId: job.userId,
      jobId: job.id,
      idx: i + 1,
      startSeconds: window.start,
      endSeconds: window.end,
      outputPath,
      outputSeconds: measured.seconds,
      note: clipNote,
      /*
        The clip's own name for itself.

        A question is the best title a conversation clip can have — it is what
        the piece is *about*, said by the person in it — so the conversational
        chooser's title wins where it has one. The opening words remain the
        answer everywhere else, and both are the speaker's own words: a title
        this product invented would be the one part of a clip nobody said.
      */
      title: conversational[i]?.title ?? clipTitle(window, words),
      thumbnailPath,
    });

    notes.push(
      t(
        `clip ${i + 1}: kept ${clock(window.start)}–${clock(window.end)} (${measured.seconds.toFixed(1)}s${cutSilence ? ", silences cut" : ""})`,
        `القصاصة ${i + 1}: أُبقي ${clock(window.start)}–${clock(window.end)} (${measured.seconds.toFixed(1)} ثانية${cutSilence ? "، مع قصّ الصمت" : ""})`,
      ),
    );
  }

  notes.push(...insideEachClip(perClipNotes, args.language));

  await reportProgress(job.id, 95, "Saving the clips");

  /*
    And the tail of a longer previous set, which no row names any more.

    The keys carry the index — `clip-<job>-1.mp4` … `clip-<job>-6.mp4` — so a
    retry that chooses four windows overwrites 1..4 and leaves 5 and 6 in the
    bucket with nothing pointing at them. They are invisible to the product and
    to the retention sweep, which derives clip keys from rows, so they would
    have been reclaimed only when the whole project was deleted.
  */
  const surplus = previous
    .map((row) => row.idx)
    .filter((idx) => typeof idx === "number" && idx > chosen.windows.length);
  if (surplus.length > 0) {
    const keys = surplus.flatMap((idx) => {
      const master = `${job.userId}/${job.projectId}/clip-${job.id}-${idx}.mp4`;
      return [master, previewPathFor(master), master.replace(/\.mp4$/i, "") + ".jpg"];
    });
    try {
      await objectStoreFrom().remove(keys);
      log.info({ clips: surplus.length }, "removed the tail of a longer previous clip set");
    } catch (error) {
      // Orphaned bytes are a bill, not a broken render. The set that exists is
      // correct either way.
      log.warn({ err: error, clips: surplus.length }, "could not remove the tail of the previous clip set");
    }
  }

  await db
    .update(jobsTable)
    .set({
      status: "done",
      progress: 100,
      stage: null,
      error: null,
      errorDetail: null,
      outputPath: firstClipPath,
      notes,
      outputSeconds: outputSecondsSum,
      // A clips render reads the whole source — transcribes it, scores every
      // window, renders each piece — so the source is what it is billed at,
      // and the note below says so before anyone reads it off an invoice.
      billedSeconds: sourceSeconds,
      bytesIn: bytesPulled() - pulledAtStart,
      outputSecondsSource: weakestMeasure,
      sourceSeconds,
      lockedAt: null,
      lockedBy: null,
      finishedAt: new Date(),
    })
    .where(eq(jobsTable.id, job.id));

  // Status only. editedVideoPath keeps meaning "the latest whole-video
  // render", and this job made pieces, not a whole.
  await db
    .update(projectsTable)
    .set({ status: "done" })
    .where(and(eq(projectsTable.id, job.projectId), eq(projectsTable.userId, job.userId)));

  try {
    await db.insert(messagesTable).values({
      id: randomUUID(),
      userId: job.userId,
      projectId: job.projectId,
      role: "assistant",
      content: `${t("Here's what I did.", "هذا ما فعلته.")}\n${notes.map((note) => `• ${note}`).join("\n")}`,
    });
  } catch (error) {
    log.warn({ err: error }, "could not write the summary into the conversation");
  }

  log.info(
    { clips: total, outputSeconds: outputSecondsSum, notes },
    "clip set complete",
  );
}

/**
 * The opening words spoken inside a window — the clip's own name for itself.
 *
 * The speaker's words, never invented copy: the same rule motion titles live
 * by. Fillers are skipped (a clip titled "um, so, uh" is a clip titled by its
 * worst moment), the cut is at a word boundary, and null means nothing was
 * heard — a made-up title would be the product pretending to have listened.
 */
function clipTitle(
  window: { start: number; end: number },
  words: Array<{ start: number; end: number; filler: boolean; text?: string }>,
): string | null {
  const spoken = words
    .filter((w) => !w.filler && typeof w.text === "string" && w.text.trim().length > 0)
    .filter((w) => w.start < window.end && w.end > window.start);
  if (spoken.length === 0) return null;
  const parts: string[] = [];
  for (const word of spoken) {
    const next = [...parts, word.text!.trim()].join(" ");
    if (next.length > 42) break;
    parts.push(word.text!.trim());
  }
  if (parts.length === 0) return null;
  return parts.join(" ") + (parts.length < spoken.length ? "\u2026" : "");
}

/** Seconds as m:ss, because "80s" is a number and "1:20" is a moment. */
function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * The scheduled-post sweep, wrapped so it can never take the worker down.
 *
 * Its own try/catch rather than the loop's, and that is deliberate: a failure
 * in here must not stop renders from being claimed. A person waiting on an
 * export and a person waiting on a post are two different people, and one of
 * them being blocked by the other's problem is not a trade this worker gets to
 * make.
 */
/*
  How often each half of the sweep runs.

  The render loop polls every five seconds, and hanging both of these off it
  meant twenty-four queries a minute, forever, against a table that is empty —
  on a database whose plan is measured in connections and rows read.

  Fifteen seconds for the due sweep is granularity nobody can feel: a post
  cannot be scheduled less than a minute ahead, and the console does not call
  one overdue until two minutes past. Five minutes for the stranded sweep,
  because it looks for rows that have been sitting for fifteen — asking twelve
  times a minute is asking a question whose answer cannot have changed.
*/
const DUE_SWEEP_EVERY_MS = 15_000;
const STRANDED_SWEEP_EVERY_MS = 5 * 60_000;
let lastDueSweep = 0;
let lastStrandedSweep = 0;

async function sendDuePosts(): Promise<void> {
  const now = Date.now();
  if (now - lastDueSweep < DUE_SWEEP_EVERY_MS) return;
  lastDueSweep = now;

  try {
    if (now - lastStrandedSweep >= STRANDED_SWEEP_EVERY_MS) {
      lastStrandedSweep = now;
      const stranded = await surfaceStrandedPosts();
      if (stranded > 0) {
        logger.warn({ stranded }, "posts were mid-flight when a publisher stopped; marked for review");
      }
    }

    const done = await publishDuePosts();
    if (done.claimed > 0) logger.info(done, "published due posts");
  } catch (error) {
    logger.error({ err: error }, "the scheduled-post sweep failed; renders continue");
  }
}

/**
 * Fonts somebody uploaded, prepared and measured.
 *
 * Wrapped like the post sweep is, and for the same reason: a font that cannot
 * be prepared must never stop this worker rendering. The failure is written
 * onto the row that caused it — see `font-prepare.ts` — so a person gets a
 * refusal they can act on rather than a spinner that never stops.
 */
async function prepareFonts(): Promise<void> {
  try {
    const done = await prepareUploadedFaces((fields, message) => logger.info(fields, message));
    if (done > 0) logger.info({ prepared: done }, "prepared uploaded fonts");
  } catch (error) {
    logger.error({ err: error }, "the font sweep failed; renders continue");
  }
}

/*
  How often the retention sweep looks, and why it is once an hour.

  Nothing it removes is urgent. The windows are measured in weeks, so a file
  that becomes eligible at 03:12 and goes at 04:00 is exactly as swept as one
  that goes at 03:12 — and the cost of asking is a full scan of `projects` with
  a join per project. Once an hour is the cheapest cadence that still finishes
  the work of a day inside a day.
*/
const RETENTION_SWEEP_EVERY_MS = 60 * 60_000;
let lastRetentionSweep = 0;
const retention = retentionFrom();

/**
 * Files nobody has come back for, aged out.
 *
 * Wrapped like the post and font sweeps, for the same reason and one more: this
 * is the only thing in the worker that *deletes*, and the only acceptable
 * failure mode for it is doing nothing. So a query that will not run, a store
 * that will not answer, a database that has gone away — all of them end here,
 * in a log line, with the renders continuing.
 *
 * The floor is the point of the first query. `chooseRemovals` ages from the
 * latest of `last_opened_at`, `updated_at` and the moment migration 0040 was
 * applied — and if the ledger has no row for that file, this returns without
 * choosing anything at all. A sweep that guessed a date instead would, on its
 * first run against a database migrated some other way, decide that every
 * project in it had been cold since its creation.
 */
/**
 * The largest share of the estate one sweep may take before it refuses.
 *
 * Half, which is far above anything a working sweep produces — ageing is a
 * trickle by construction — and far below what every failure mode this file
 * has looks like, all of which select everything at once.
 */
const MAX_SWEEP_SHARE = 0.5;

async function sweepAgedFiles(): Promise<void> {
  const now = Date.now();
  if (retention.mode === "off") return;
  if (now - lastRetentionSweep < RETENTION_SWEEP_EVERY_MS) return;
  lastRetentionSweep = now;

  try {
    /*
      The database's clock, not this machine's.

      Every timestamp in the comparison — `last_opened_at`, `updated_at`, the
      migration floor — is written by Postgres `now()`, and `coldDays` was
      measured against `Date.now()` on a Fly VM. `chooseRemovals` guards the
      backwards direction, which is the harmless one: a negative age is skipped.
      There was no ceiling in the other direction, and no ceiling on how much
      one pass may remove.

      So a machine that resumed from a snapshot, or came up before chronyd
      settled, or took an NTP step forward, computed `coldDays` in the hundreds
      for every row at once — and in `on` mode that is every preview and every
      never-rendered source in the estate, in a single pass, with per-key
      retries that a healthy store answers happily.

      Asking Postgres for its own clock removes the whole class rather than
      bounding it: the two sides of the subtraction now come from the same
      clock, which is what "days since it was last opened" always meant.
    */
    const { rows: floorRows } = await pool.query<{ applied_at: Date; server_now: Date }>(
      "SELECT applied_at, now() AS server_now FROM schema_migrations WHERE filename = '0040_last_opened.sql'",
    );
    const floor = floorRows[0]?.applied_at;
    const serverNow = floorRows[0]?.server_now ?? new Date(now);
    if (!floor) {
      logger.warn(
        "the retention sweep found no ledger row for migration 0040, so it has no floor to age from and did nothing",
      );
      return;
    }

    const { rows: projects } = await pool.query<SweepableProject & Record<string, unknown>>(
      `SELECT p.id,
              p.user_id                                    AS "userId",
              p.edited_video_path                          AS "editedVideoPath",
              p.video_path                                 AS "videoPath",
              p.thumbnail_path                             AS "thumbnailPath",
              p.last_opened_at                             AS "lastOpenedAt",
              p.updated_at                                 AS "updatedAt",
              (SELECT count(*)::int FROM jobs j WHERE j.project_id = p.id) AS renders
         FROM projects p`,
    );
    const { rows: clips } = await pool.query<SweepableClip & Record<string, unknown>>(
      `SELECT c.id, c.project_id AS "projectId", c.output_path AS "outputPath", c.thumbnail_path AS "thumbnailPath"
         FROM clips c`,
    );

    const removals = chooseRemovals({
      projects: projects as SweepableProject[],
      clips: clips as SweepableClip[],
      now: serverNow,
      floor,
      config: retention,
    });
    if (removals.length === 0) return;

    /*
      And a pass that wants to remove most of the estate is a bug, not a sweep.

      Nothing here is urgent — a file that ages out today can age out tomorrow —
      so refusing a suspiciously large pass costs a day and catches every
      remaining way this could go wrong at once: a clock this check could not
      anticipate, a floor read from a restored ledger, a window that somehow
      arrived as zero. It is the difference between losing a night's uploads and
      losing the estate.
    */
    const estate = projects.length + clips.length;
    if (estate > 0 && removals.length > estate * MAX_SWEEP_SHARE) {
      logger.error(
        { removals: removals.length, estate, share: MAX_SWEEP_SHARE },
        "the retention sweep wanted to remove most of the estate in one pass and refused; something is wrong with a clock or a window",
      );
      return;
    }

    // Through the seam, never through an address built here. This is the first
    // caller in the product that deletes, which makes it the first real test of
    // whether `lib/object-store` is a seam or a decoration.
    const store = objectStoreFrom();
    await applyRemovals(removals, retention, {
      remove: (keys) => store.remove(keys),
      clearColumn: async (table, id, column) => {
        // The identifiers here are the module's own literals, never anything
        // that came out of a row — see `Removal.clear`, whose type admits two
        // tables and two columns and nothing else.
        await pool.query(`UPDATE ${table} SET ${column} = NULL WHERE id = $1`, [id]);
      },
      log: (fields, message) => logger.info(fields, message),
    });
  } catch (error) {
    logger.error({ err: error }, "the retention sweep failed; renders continue");
  }
}

/**
 * The project's name, or null.
 *
 * Best-effort: a letter with no title still sends, and it says "your project".
 * A render that finished must not be held up by the row that names it.
 */
async function titleOf(projectId: string, userId: string): Promise<string | null> {
  try {
    const rows = await db
      .select({ title: projectsTable.title })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)))
      .limit(1);
    return rows[0]?.title ?? null;
  } catch {
    return null;
  }
}

/*
  Answered by this process, so a deploy can tell a working copy from a started
  one.

  Set up before the first database call and marked ready after it: Fly's check
  has to be able to *fail*, and a listener that only exists once everything
  already worked can only ever say yes. See health.ts for why the heartbeat row
  is the wrong signal here.
*/
const health = serveHealth(HEALTH_PORT, (error) =>
  logger.error({ err: String(error), port: HEALTH_PORT }, "health listener could not start"),
);

/**
 * How often the work somebody is waiting on is looked at.
 *
 * Independent of the render loop, which is the whole point of it. These two
 * sweeps used to sit at the top of that loop with a comment saying that
 * putting them before `claimJob()` "bounds the lateness by the poll interval
 * rather than by the longest render in the queue".
 *
 * It does not. It bounds the lateness *within one iteration*, and the next
 * iteration begins when `processJob` returns — which is minutes later, and up
 * to four hours later at the render ceiling. So the sweep ran, then the loop
 * blocked for the length of a render, and a post due in the middle of that
 * went out whenever the render finished.
 *
 * Worse, being late is terminal: `TOO_LATE_MINUTES` is twenty, and past it the
 * row is written `missed` with a sentence explaining that posting it now would
 * put it in front of people at a time nobody chose. Nothing retries a missed
 * row. So a 25-minute render starting at 20:44 did not delay a 21:00 post — it
 * cancelled it, silently, and the only log line was the sweep reporting it had
 * claimed nothing.
 *
 * A timer works because none of this is CPU-bound: a render is spent awaiting
 * ffmpeg subprocesses and network, so the event loop is free the entire time.
 * The guard is re-entrancy, not concurrency — one sweep at a time, and a slow
 * one is skipped rather than stacked.
 */
const ATTEND_EVERY_MS = 15_000;
let attendingNow = false;

async function attendToWaitingWork(): Promise<void> {
  if (attendingNow || shuttingDown) return;
  /*
    Not while a render is in the machine.

    `fly.toml` sizes this box on one measurement — one render fills most of a
    gigabyte, and a second thing inside it is not slower, it is OOM-killed —
    and then this timer ran font preparation (python plus an ffmpeg pass) and
    the social publisher (which downloads a finished master and buffers chunks
    of it) *beside* the render. The invariant was enforced against renders and
    against nothing else.

    A render takes minutes; these two are checked every fifteen seconds. The
    person waiting for their font waits for the current render rather than for
    a machine that was killed halfway through somebody else's.
  */
  if (heldJobId !== null) return;
  attendingNow = true;
  try {
    /*
      Both, whatever happens to either.

      They ran in sequence with a single `await` chain — `sendDuePosts()` then
      `prepareFonts()` — and a send takes up to `PUBLISH_TIMEOUT_MS`, fifteen
      minutes, plus the download of the master before it. So a slow or hung
      upload to one platform held the font in front of somebody who is looking
      at the screen *right now* for the whole of it, which is the exact wait
      the comment below was written about: they conclude it is broken and
      upload it again.

      `allSettled` rather than two awaits: these are unrelated pieces of work
      that share only a timer, and one of them failing is not a reason for the
      other not to run. The catch below still exists for anything thrown
      outside them.

      A post due at 21:00 still goes out at 21:00, and the font is prepared in
      the same pass rather than after it.
    */
    const done = await Promise.allSettled([sendDuePosts(), prepareFonts()]);
    for (const outcome of done) {
      if (outcome.status === "rejected") {
        logger.error({ err: outcome.reason }, "one half of the sweep for waiting work failed");
      }
    }
  } catch (error) {
    // Never allowed to take the process down: this runs on a timer, outside
    // the loop's own try, so an unhandled rejection here is an exit.
    logger.error({ err: error }, "the sweep for work people are waiting on failed");
  } finally {
    attendingNow = false;
  }
}

/**
 * A video from photographs, for a project that has none.
 *
 * The whole of the stills feature's integration, and it is deliberately one
 * function with one caller: everything it does happens before the first probe,
 * so from the renderer's point of view this job is indistinguishable from
 * somebody's phone upload. `stills.ts` owns how a reel is made; this owns
 * which files go into one and what the person is told about it.
 *
 * The photographs are resolved by id against this project's own library, the
 * same rule b-roll and music follow, and for the same reason: an id that is
 * not in the project resolves to nothing, where a path would have been opened.
 */
async function assembleReel(
  job: Job,
  reelOp: Extract<EditOperation, { type: "stillsReel" }>,
  plan: EditPlan,
  workDir: string,
  log: pino.Logger,
  say: (en: string, ar: string) => string,
  notes: string[],
): Promise<string> {
  const rows = await db
    .select()
    .from(assetsTable)
    .where(and(eq(assetsTable.projectId, job.projectId), eq(assetsTable.userId, job.userId)));
  const byId = new Map(rows.map((row) => [row.id, row]));

  const stills: { file: string; width: number; height: number }[] = [];
  let missing = 0;
  for (const id of reelOp.assetIds) {
    const row = byId.get(id);
    // Not an image is the same answer as not in this project: the kind is
    // re-derived from the bytes at upload, so a video here is a plan asking to
    // hold a moving picture still, not a mislabelled file.
    if (!row || row.kind !== "image") {
      missing += 1;
      log.warn({ assetId: id, kind: row?.kind ?? null }, "the reel named something that is not a photograph in this project");
      continue;
    }
    const file = path.join(workDir, `still-src-${stills.length}`);
    try {
      await downloadObject(row.path, file);
    } catch (error) {
      missing += 1;
      log.warn({ err: error, assetId: id }, "could not fetch a photograph for the reel");
      continue;
    }
    /*
      Measured from the file, not read from the row. `assets.width`/`height`
      are written by the browser and are nullable, and they decide whether a
      photograph fills the frame or sits inside it — a decision made from a
      missing number is a soft, over-cropped advertisement that nothing
      anywhere reports as wrong.
    */
    const size = await imageSize(file);
    stills.push({ file, width: size.width, height: size.height });
  }

  if (stills.length === 0) {
    // Final rather than retried: the same ids will resolve to the same nothing
    // next time, and the sentence is the customer's to act on.
    throw new PlanEmptiedError(
      say(
        "None of the photographs in that request are in this project, so there was nothing to build a video from.",
        "لا شيء من الصور في ذلك الطلب موجود في هذا المشروع، فلم يكن هناك ما أبني منه فيديو.",
      ),
    );
  }

  /*
    The reel is built at the shape the edit is going to be, not at some neutral
    size that gets cropped again afterwards. Two crops of the same photograph
    is the difference between a product with its edges and a product without
    them, and the second crop would be invisible to everything that measures
    this pipeline.
  */
  const reframe = plan.operations.find((op) => op.type === "formatForPlatform");
  const shape = shapeFor(reframe?.type === "formatForPlatform" ? reframe.platform : null);
  const frame = frameFor(defaultHeightFor(shape), shape);

  const reel = await buildStillsReel(stills, {
    width: frame.w,
    height: frame.h,
    // A decision, not a measurement: there is no camera here to have chosen a
    // rate. 30 is what every feed re-encodes to, so it is the rate that costs
    // the picture nothing on the way out.
    fps: 30,
    targetSeconds: reelOp.targetSeconds,
    motion: reelOp.motion,
    workDir,
    onProgress: (fraction) => {
      void reportProgress(job.id, 1 + fraction * 4, "Building a video from your photos").catch(() => {});
    },
  });

  notes.push(
    say(
      `built a ${reel.seconds.toFixed(0)}s video from ${reel.used} of your photos`,
      `بنيت فيديو ${reel.seconds.toFixed(0)} ثانية من ${reel.used} من صورك`,
    ),
  );
  /*
    Every reduction is said. A merchant who uploaded twenty photographs and got
    twelve of them has not been cheated, but they have been *edited* — and a
    tool that silently drops eight of somebody's product shots and reports
    success is the exact failure this repository is written against.
  */
  if (reel.dropped > 0) {
    notes.push(
      say(
        `there was no room for ${reel.dropped} more at this length: a photo held under 1.2s is a flash rather than a shot`,
        `لا متّسع لـ${reel.dropped} أخرى بهذا الطول: صورة تبقى أقلّ من 1.2 ثانية ومضة لا لقطة`,
      ),
    );
  }
  if (reel.padded > 0) {
    notes.push(
      say(
        `${reel.padded} of them sit inside the frame on a blurred copy of themselves, because filling it would have cropped the product or enlarged it past sharpness`,
        `${reel.padded} منها تجلس داخل الكادر فوق نسخة مموّهة من نفسها، لأن ملء الكادر كان سيقصّ المنتج أو يكبّره حتى تذهب حدّته`,
      ),
    );
  }
  if (missing > 0) {
    notes.push(
      say(
        `${missing} of the photos in that request are not in this project, so they were left out`,
        `${missing} من الصور في ذلك الطلب ليست في هذا المشروع، فتُركت`,
      ),
    );
  }

  log.info({ used: reel.used, dropped: reel.dropped, padded: reel.padded, seconds: reel.seconds }, "reel assembled");
  return reel.file;
}

async function main(): Promise<void> {
  await db.execute(sql`select 1`);
  // Names of models, never keys. If captions are missing in production, this
  // line is the first place to look and it should answer the question outright.
  // The mail package is silent until a process claims it. This one does the
  // sending for renders, so it says so here rather than at import: a library
  // that writes to stdout on its own appears in the logs of a process that
  // never called it.
  mailLogsTo(logger);
  logger.info(
    {
      pollIntervalMs: POLL_INTERVAL_MS,
      transcription: providers.transcriber?.name ?? "unavailable",
      vision: providers.sceneReader?.name ?? "unavailable",
      // Which mode the thing that deletes is in, on the line anybody reads
      // first. `dry` is the default and the only safe one to ship with; a
      // worker that is quietly in `on` is the thing this line exists to stop
      // being a surprise.
      retention: `${retention.mode} (previews ${retention.previewDays}d, unused sources ${retention.unusedSourceDays}d, thumbnails ${retention.thumbnailDays === 0 ? "never" : `${retention.thumbnailDays}d`})`,
      // Named here for the same reason as the other two: when the chapters on
      // a project look like a list of pauses rather than a list of subjects,
      // this line is the first place to look and it answers outright.
      comprehension: providers.structureReader?.name ?? "unavailable",
    },
    "worker ready",
  );

  /*
    What the last machine to live here left behind.

    On Fly a restarted machine keeps its filesystem, and a copy that was
    OOM-killed or SIGKILLed mid-render never reached the `finally` that removes
    its work directory. Each of those is the size of a render — source,
    intermediates and output — so two of them is a machine with no room for a
    third, failing every job it claims for a reason that is nowhere in its own
    logs.

    Only at boot, and only directories older than an hour, because a rolling
    deploy has two copies running at once and taking the other one's work
    mid-render would be a far worse bug than this one.
  */
  const reclaimed = await sweepStaleWork();
  if (reclaimed > 0) {
    logger.warn(
      { bytes: reclaimed },
      "cleared work left by a machine that did not shut down cleanly",
    );
  }

  // After the log line and not before it: everything above this point can
  // throw, and a machine that fails here should fail its check rather than be
  // promoted and then die.
  health.ready();

  // The work people are waiting on, on a clock of its own.
  const attending = setInterval(() => void attendToWaitingWork(), ATTEND_EVERY_MS);
  await attendToWaitingWork();

  while (!shuttingDown) {
    try {
      // Before anything else in the loop: a worker that is failing to claim is
      // still a worker that is here, and the difference matters to whoever is
      // watching a queue that is not moving.
      await heartbeat();

      await forgetDepartedWorkers();
      const requeued = await requeueStaleJobs();
      if (requeued > 0) logger.warn({ requeued }, "returned abandoned jobs to the queue");
      await failExhaustedJobs();

      // The two sweeps people are waiting on are not here any more; they run
      // on their own timer. See `attendToWaitingWork`.
      //
      // This one stays, because it is the opposite of both: nothing it does is
      // urgent, and the one thing it must never do is delay something that is.
      // It is also the only sweep that deletes, and between renders is the
      // right time to delete.
      await sweepAgedFiles();

      const job = await claimJob();
      if (!job) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      heldJobId = job.id;
      // A new job starts from nothing, whatever the last one reached — and
      // whatever the last one was asked to do. `stopRequestedFor` holds a job
      // id rather than a flag for this reason, and clearing it here as well
      // means a request that arrived as the previous job settled cannot follow
      // the machine into the next one.
      lastReported = null;
      stopRequestedFor = null;
      try {
        await withLockKeptAlive(job.id, () => withinJobDeadline(job.id, () => processJob(job)));
      } finally {
        heldJobId = null;
      }
    } catch (error) {
      // The loop must survive anything, including the database going away.
      logger.error({ err: error }, "worker loop error");
      await sleep(POLL_INTERVAL_MS);
    }
  }

  clearInterval(attending);
  logger.info("shutting down");
  // Its row stays — the timestamp on it is what says when this copy went, which
  // is more useful than a gap where a worker used to be.
  await pool.end();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1);
    logger.info({ signal }, "stopping: handing back anything in flight");
    shuttingDown = true;
    // Said out loud, so a rolling deploy stops routing checks at this copy
    // while it puts down what it is holding.
    health.leaving();
    /*
      A render cannot be finished on demand and the platform is not waiting.
      See `releaseHeldJob`: the job goes back to the queue, uncharged, and this
      copy leaves. `kill_timeout` in fly.toml is what buys the seconds this
      takes — without it the default is five, and this query would sometimes
      not land.
    */
    void releaseHeldJob().finally(() => {
      process.exit(0);
    });
  });
}

main().catch((error) => {
  logger.fatal({ err: error }, "worker could not start");
  process.exit(1);
});
