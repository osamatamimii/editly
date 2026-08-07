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
import { db, pool, jobsTable, projectsTable, type Job } from "@workspace/db";
import { EditPlan } from "@workspace/api-zod";
import { downloadObject, uploadObject } from "./storage";
import { renderPlan, FfmpegError } from "./ffmpeg";

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
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [WORKER_ID],
  );
  if (rows.length === 0) return null;
  const row = rows[0] as Record<string, unknown>;
  return {
    ...(row as unknown as Job),
    userId: row["user_id"] as string,
    projectId: row["project_id"] as string,
    inputPath: row["input_path"] as string,
    outputPath: row["output_path"] as string | null,
    maxAttempts: row["max_attempts"] as number,
  };
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

    const { output, notes } = await renderPlan(inputFile, plan, {
      workDir,
      onProgress: (fraction, stage) => {
        // Download and upload bracket the render; the middle 80% is ffmpeg.
        void reportProgress(job.id, 10 + fraction * 80, stage).catch(() => {});
      },
    });

    await reportProgress(job.id, 92, "Saving the result");
    const outputPath = `${job.userId}/${job.projectId}/edited-${job.id}.mp4`;
    await uploadObject(outputPath, output);

    await db
      .update(jobsTable)
      .set({
        status: "done",
        progress: 100,
        stage: null,
        error: null,
        outputPath,
        lockedAt: null,
        lockedBy: null,
        finishedAt: new Date(),
      })
      .where(eq(jobsTable.id, job.id));

    await db
      .update(projectsTable)
      .set({ status: "done", editedVideoPath: outputPath })
      .where(and(eq(projectsTable.id, job.projectId), eq(projectsTable.userId, job.userId)));

    log.info({ outputPath, notes }, "render complete");
  } catch (error) {
    // ffmpeg's complaints are specific enough to be worth showing; anything
    // else is infrastructure and the user can do nothing with the detail.
    const message =
      error instanceof FfmpegError
        ? error.message.split("\n")[0].slice(0, 300)
        : "Rendering failed. We are looking into it.";
    const willRetry = job.attempts < job.maxAttempts;

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
  logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, "worker ready");

  while (!shuttingDown) {
    try {
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
