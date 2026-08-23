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
import { db, pool, jobsTable, projectsTable, assetsTable, messagesTable, clipsTable, workerHeartbeatsTable, type Job } from "@workspace/db";
import { EditPlan, type EditOperation } from "@workspace/api-zod";
import { downloadObject, uploadObject } from "./storage";
import { renderPlan, probeDuration, probeSource, FfmpegError } from "./ffmpeg";
import { encodePreview, previewPathFor } from "./preview";
import { reviewOutput } from "./review";
import { chooseClips } from "./highlight";
import { measureOutput, exceedsCeiling, tooLongMessage, exceedsAllowance, overAllowanceMessage } from "./duration";
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
    remainingSeconds: row["remaining_seconds"] as number | null,
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
const LOCK_RENEW_EVERY_MS = 20_000;

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
      await pool.query(`UPDATE jobs SET locked_at = now(), updated_at = now() WHERE id = $1 AND locked_by = $2`, [
        jobId,
        WORKER_ID,
      ]);
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

async function reportProgress(jobId: string, progress: number, stage: string): Promise<void> {
  await db
    .update(jobsTable)
    .set({ progress: Math.max(0, Math.min(99, Math.round(progress))), stage })
    .where(eq(jobsTable.id, jobId));
  // Progress is also proof of life. The renewal timer covers the silent
  // stretches; this covers everything else without waiting for the next tick.
  await heartbeat();
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
    if (exceedsAllowance(sourceSeconds, job.remainingSeconds)) {
      await db.update(jobsTable).set({ sourceSeconds }).where(eq(jobsTable.id, job.id));
      throw new SourceTooLongError(overAllowanceMessage(sourceSeconds, job.remainingSeconds as number));
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

    // Only the assets this plan actually names, and only after each one has
    // been confirmed to belong to this project.
    //
    // The plan carries ids rather than paths precisely so that this lookup
    // exists: an id that is not in the project's own library resolves to
    // nothing and the overlay is dropped with a note, where a path would have
    // been opened. And downloading only what is referenced means a project with
    // forty files does not pay to fetch forty of them for a render that uses
    // one.
    const wantedAssetIds = [
      ...new Set(
        enriched.plan.operations
          .filter((op) => op.type === "insertBRoll" || op.type === "overlayImage")
          .map((op) => (op as { assetId: string }).assetId),
      ),
    ];
    const assets = new Map<string, { file: string; kind: "video" | "image" | "audio" }>();
    if (wantedAssetIds.length > 0) {
      await reportProgress(job.id, 9, "Fetching the files you added");
      const rows = await db
        .select()
        .from(assetsTable)
        .where(and(eq(assetsTable.projectId, job.projectId), eq(assetsTable.userId, job.userId)));
      const byId = new Map(rows.map((row) => [row.id, row]));
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
          // One missing overlay is a worse render, not a failed one.
          log.warn({ err: error, assetId: id }, "could not fetch an asset");
        }
      }
    }

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
        words,
        assets,
        workDir,
        inputFile,
        sourceSeconds,
        sourceHadAudio: sourceProbe.hasAudio,
        log,
      });
      return;
    }

    const { output, notes: renderNotes, estimatedSeconds } = await renderPlan(inputFile, enriched.plan, {
      workDir,
      words,
      assets,
      onProgress: (fraction, stage) => {
        // Download and upload bracket the render; the middle 80% is ffmpeg.
        void reportProgress(job.id, 10 + fraction * 80, stage).catch(() => {});
      },
    });
    const notes = [...enriched.notes, ...renderNotes];

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
        sourcePath: inputFile,
        sourceHadAudio: sourceProbe.hasAudio,
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
        outputPath,
        notes,
        outputSeconds: measured.seconds,
        // A single render is billed at what it produced. Written explicitly
        // rather than left to the meter's fallback, so the charge is a
        // recorded fact and not an inference.
        billedSeconds: measured.seconds,
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
            ? `Here's what I did.\n${notes.map((note) => `• ${note}`).join("\n")}`
            : "Done — your edit is ready to watch.",
      });
    } catch (error) {
      log.warn({ err: error }, "could not write the summary into the conversation");
    }

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
          content: `I couldn't finish that edit — ${message}`,
        });
      } catch (insertError) {
        log.warn({ err: insertError }, "could not write the failure into the conversation");
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
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
async function renderClipSet(args: {
  job: Job;
  clipsOp: Extract<EditOperation, { type: "extractClips" }>;
  enriched: Awaited<ReturnType<typeof enrichPlan>>;
  words: Array<{ start: number; end: number; filler: boolean }>;
  assets: Map<string, { file: string; kind: "video" | "image" | "audio" }>;
  workDir: string;
  inputFile: string;
  sourceSeconds: number;
  sourceHadAudio: boolean;
  log: pino.Logger;
}): Promise<void> {
  const { job, clipsOp, enriched, words, assets, workDir, inputFile, sourceSeconds, sourceHadAudio, log } = args;

  await reportProgress(job.id, 9, "Choosing the clips");

  // A retry must produce a fresh set, not a second copy of half of one.
  await db.delete(clipsTable).where(eq(clipsTable.jobId, job.id));

  const chosen = chooseClips(
    sourceSeconds,
    clipsOp.count,
    clipsOp.targetSeconds,
    words.length > 0 ? words : undefined,
  );
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
  if (rest.length !== enriched.plan.operations.length - 1) {
    notes.push("the plan asked for clips and another cut at once — the clips won");
  }
  if (chosen.windows.length < clipsOp.count) {
    notes.push(
      `the video is ${sourceSeconds.toFixed(0)}s long, which holds ${chosen.windows.length} clip${chosen.windows.length === 1 ? "" : "s"} of ${Math.round(clipsOp.targetSeconds)}s — not the ${clipsOp.count} asked for`,
    );
  }
  notes.push(
    chosen.how === "speech"
      ? `chose ${chosen.windows.length} stretches where the speech runs densest`
      : `we could not hear words in this clip, so it was divided evenly into ${chosen.windows.length}`,
  );
  // The charge, said where the person will read it. Clips are metered by the
  // source they read, not by the pieces — the whole file was transcribed and
  // scored to choose them — and a charge nobody saw coming is a dispute.
  notes.push(
    `counted as ${Math.round(sourceSeconds)}s against your minutes — clips are metered by the source they read, not by the pieces`,
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
    const { output, notes: renderNotes, estimatedSeconds } = await renderPlan(inputFile, subPlan, {
      workDir: subDir,
      words,
      assets,
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
        sourcePath: inputFile,
        sourceHadAudio,
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

    const outputPath = `${job.userId}/${job.projectId}/clip-${job.id}-${i + 1}.mp4`;
    await uploadObject(outputPath, output);
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
    });

    notes.push(
      `clip ${i + 1}: kept ${clock(window.start)}–${clock(window.end)} (${measured.seconds.toFixed(1)}s${renderNotes.some((n) => /silence/.test(n)) ? ", silences cut" : ""})`,
    );
  }

  await reportProgress(job.id, 95, "Saving the clips");

  await db
    .update(jobsTable)
    .set({
      status: "done",
      progress: 100,
      stage: null,
      error: null,
      outputPath: firstClipPath,
      notes,
      outputSeconds: outputSecondsSum,
      // A clips render reads the whole source — transcribes it, scores every
      // window, renders each piece — so the source is what it is billed at,
      // and the note below says so before anyone reads it off an invoice.
      billedSeconds: sourceSeconds,
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
      content: `Here's what I did.\n${notes.map((note) => `• ${note}`).join("\n")}`,
    });
  } catch (error) {
    log.warn({ err: error }, "could not write the summary into the conversation");
  }

  log.info(
    { clips: total, outputSeconds: outputSecondsSum, notes },
    "clip set complete",
  );
}

/** Seconds as m:ss, because "80s" is a number and "1:20" is a moment. */
function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
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
      await withLockKeptAlive(job.id, () => processJob(job));
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
