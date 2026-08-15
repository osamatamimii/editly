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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { sql, eq, and } from "drizzle-orm";
import pino from "pino";
import { db, pool, jobsTable, projectsTable, workerHeartbeatsTable, type Job } from "@workspace/db";
import { EditPlan } from "@workspace/api-zod";
import { downloadObject, uploadObject } from "./storage";
import { renderPlan, probeDuration, probeSource, FfmpegError } from "./ffmpeg";
import { measureOutput, exceedsCeiling, tooLongMessage } from "./duration";
import { enrichPlan } from "./enrich";
import { resolveProviders } from "./providers";

const WORKER_ID = `${hostname()}-${randomUUID().slice(0, 8)}`;
const POLL_INTERVAL_MS = Number(process.env["POLL_INTERVAL_MS"] ?? 5000);
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
  return toJob(rows[0] as Record<string, unknown>);
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
    priority: row["priority"] as number,
    maxAttempts: row["max_attempts"] as number,
  };
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

/** Returns jobs abandoned by a dead worker to the queue. */
async function requeueStaleJobs(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL, updated_at = now()
     WHERE status = 'running'
       AND locked_at < now() - ($1 || ' minutes')::interval
       AND attempts < max_attempts`,
    [String(STALE_LOCK_MINUTES)],
  );
  return rowCount ?? 0;
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

async function reportProgress(jobId: string, progress: number, stage: string): Promise<void> {
  await db
    .update(jobsTable)
    .set({ progress: Math.max(0, Math.min(99, Math.round(progress))), stage })
    .where(eq(jobsTable.id, jobId));
}

async function processJob(job: Job): Promise<void> {
  const log = logger.child({ jobId: job.id, projectId: job.projectId });
  const workDir = await mkdtemp(path.join(tmpdir(), "editly-render-"));

  try {
    const plan = EditPlan.parse(job.plan);

    log.info({ operations: plan.operations.map((o) => o.type) }, "claimed job");

    await reportProgress(job.id, 5, "Fetching your video");
    const inputFile = path.join(workDir, "input.mp4");
    await downloadObject(job.inputPath, inputFile);

    // The first honest measurement of this file anyone has made. Everything
    // before now — the ceiling check in the API, the punch placement in a
    // template — worked from a number the browser supplied and could omit.
    const sourceSeconds = (await probeSource(inputFile)).duration;
    if (exceedsCeiling(sourceSeconds, job.maxSourceSeconds)) {
      await db.update(jobsTable).set({ sourceSeconds }).where(eq(jobsTable.id, job.id));
      throw new SourceTooLongError(tooLongMessage(sourceSeconds, job.maxSourceSeconds as number));
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
    if (job.referencePath) {
      await reportProgress(job.id, 7, "Fetching the video you want to match");
      try {
        referenceFile = path.join(workDir, "reference.mp4");
        await downloadObject(job.referencePath, referenceFile);
      } catch (error) {
        // The reference is an improvement to the edit, not a precondition for
        // it. Losing it costs the match and nothing else.
        referenceFile = null;
        log.warn({ err: error }, "could not fetch the reference video");
      }
    }

    // Whatever the plan could not know without the file — the words, where the
    // emphasis fell, what the reference looks like — is filled in here. It
    // degrades rather than fails, and every degradation comes back as a note.
    const enriched = await enrichPlan(inputFile, plan, {
      providers,
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
      })),
    );

    const { output, notes: renderNotes, estimatedSeconds } = await renderPlan(inputFile, enriched.plan, {
      workDir,
      words,
      onProgress: (fraction, stage) => {
        // Download and upload bracket the render; the middle 80% is ffmpeg.
        void reportProgress(job.id, 10 + fraction * 80, stage).catch(() => {});
      },
    });
    const notes = [...enriched.notes, ...renderNotes];

    await reportProgress(job.id, 92, "Saving the result");
    const outputPath = `${job.userId}/${job.projectId}/edited-${job.id}.mp4`;
    await uploadObject(outputPath, output);

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
        outputPath,
        notes,
        outputSeconds: measured.seconds,
        outputSecondsSource: measured.how,
        sourceSeconds,
        lockedAt: null,
        lockedBy: null,
        finishedAt: new Date(),
      })
      .where(eq(jobsTable.id, job.id));

    await db
      .update(projectsTable)
      .set({ status: "done", editedVideoPath: outputPath })
      .where(and(eq(projectsTable.id, job.projectId), eq(projectsTable.userId, job.userId)));

    log.info({ outputPath, outputSeconds: measured.seconds, how: measured.how, notes }, "render complete");
  } catch (error) {
    // ffmpeg's complaints are specific enough to be worth showing; anything
    // else is infrastructure and the user can do nothing with the detail.
    const message =
      error instanceof PlanEmptiedError || error instanceof SourceTooLongError
        ? error.message.slice(0, 300)
        : error instanceof FfmpegError
          ? error.message.split("\n")[0].slice(0, 300)
          : "Rendering failed. We are looking into it.";
    // A plan nothing could be done with will be just as impossible next time,
    // and a file will not get shorter.
    const final = error instanceof PlanEmptiedError || error instanceof SourceTooLongError;
    const willRetry = !final && job.attempts < job.maxAttempts;

    log.error({ err: error, attempt: job.attempts, willRetry }, "render failed");

    await db
      .update(jobsTable)
      .set({
        status: willRetry ? "queued" : "failed",
        error: message,
        stage: null,
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
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main(): Promise<void> {
  await db.execute(sql`select 1`);
  // Names of models, never keys. If captions are missing in production, this
  // line is the first place to look and it should answer the question outright.
  logger.info(
    {
      pollIntervalMs: POLL_INTERVAL_MS,
      transcription: providers.transcriber?.name ?? "unavailable",
      vision: providers.sceneReader?.name ?? "unavailable",
    },
    "worker ready",
  );

  while (!shuttingDown) {
    try {
      // Before anything else in the loop: a worker that is failing to claim is
      // still a worker that is here, and the difference matters to whoever is
      // watching a queue that is not moving.
      await heartbeat();

      const requeued = await requeueStaleJobs();
      if (requeued > 0) logger.warn({ requeued }, "returned abandoned jobs to the queue");
      await failExhaustedJobs();

      const job = await claimJob();
      if (!job) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      await processJob(job);
    } catch (error) {
      // The loop must survive anything, including the database going away.
      logger.error({ err: error }, "worker loop error");
      await sleep(POLL_INTERVAL_MS);
    }
  }

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
    logger.info({ signal }, "finishing the current job before exiting");
    shuttingDown = true;
  });
}

main().catch((error) => {
  logger.fatal({ err: error }, "worker could not start");
  process.exit(1);
});
