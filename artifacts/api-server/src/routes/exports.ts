import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { eq, desc, and } from "drizzle-orm";
import { db, exportsTable, projectsTable, jobsTable, subscriptionsTable, type Job } from "@workspace/db";
import {
  StartExportBody,
  StartExportParams,
  GetExportStatusParams,
  GetExportStatusResponse,
} from "@workspace/api-zod";
import { serializeExport } from "../lib/transformers";
import { planKeyFrom } from "../lib/plan-limits";
import { usageFor } from "../lib/usage";
import { decideRender } from "../lib/render-policy";
import { currentUserId } from "../middlewares/auth";
import { isDuplicateActiveJob, ALREADY_RENDERING } from "../lib/one-active-job";
import { rateLimit, LIMITS } from "../lib/rate-limit";

const router: IRouter = Router();

/**
 * An export is a render, framed for one platform.
 *
 * This used to invent its own progress: five hardcoded step labels and a
 * download URL pointing at example.com, flipped to "done" five seconds after
 * the request. It now enqueues a real job and reports what the worker is
 * actually doing.
 */
type ExportStep = { label: string; status: "pending" | "active" | "done" };

/**
 * Turns the worker's single stage string into the step list the UI expects.
 * Kept deliberately coarse — claiming finer granularity than the worker
 * reports would put us back where we started.
 */
function stepsForJob(job: Job | undefined): ExportStep[] {
  const labels = ["Queued", "Cutting and reframing", "Saving the result"];
  if (!job) return labels.map((label) => ({ label, status: "pending" }));

  if (job.status === "queued") {
    return labels.map((label, i) => ({ label, status: i === 0 ? "active" : "pending" }));
  }
  if (job.status === "done") {
    return labels.map((label) => ({ label, status: "done" }));
  }
  if (job.status === "failed") {
    return labels.map((label, i) => ({ label, status: i === 0 ? "done" : "pending" }));
  }

  // running: the third step only begins once the worker starts uploading.
  const uploading = job.progress >= 92;
  return [
    { label: labels[0], status: "done" },
    { label: job.stage ?? labels[1], status: uploading ? "done" : "active" },
    { label: labels[2], status: uploading ? "active" : "pending" },
  ];
}

function exportStatusFor(job: Job | undefined): "pending" | "processing" | "done" | "failed" {
  if (!job) return "pending";
  if (job.status === "queued" || job.status === "running") return "processing";
  return job.status === "done" ? "done" : "failed";
}

router.post("/projects/:id/export", rateLimit(LIMITS.render), async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = StartExportParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = StartExportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, params.data.id), eq(projectsTable.userId, userId)));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!project.videoPath) {
    res.status(409).json({ error: "Upload a video before exporting." });
    return;
  }

  const [latest] = await db
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.projectId, project.id), eq(jobsTable.userId, userId)))
    .orderBy(desc(jobsTable.createdAt))
    .limit(1);

  if (latest && (latest.status === "queued" || latest.status === "running")) {
    res.status(409).json({ error: ALREADY_RENDERING, jobId: latest.id });
    return;
  }

  const [sub] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);

  // The mark, the meter and the upload ceiling are one decision, and it lives
  // in `render-policy` so this route and the editor's cannot drift apart. They
  // had already drifted once: this one checked the allowance and that one did
  // not, which made the free plan's limit a limit only on this button.
  const planKey = planKeyFrom(sub?.plan);
  const decision = decideRender({
    plan: planKey,
    usage: await usageFor(userId, planKey),
    sourceDurationSeconds: project.duration,
    operations: [
      { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 },
      { type: "formatForPlatform", platform: parsed.data.platform },
    ],
  });

  if (!decision.allowed) {
    res.status(decision.status).json(decision.body);
    return;
  }

  const operations = decision.operations;

  const jobId = randomUUID();

  // Both rows or neither.
  //
  // These were two independent inserts in the order that loses: the job first,
  // the export row that reports on it second. If the second failed — a pool
  // with three connections and a burst is enough — the caller got a bare 500
  // while the job was already in the queue. The worker rendered it, the
  // customer's minutes were spent, and `GET /export/status` answered
  // "No export found for this project" forever afterwards: a 404 for something
  // that did happen and was paid for.
  let exportJob;
  try {
    exportJob = await db.transaction(async (tx) => {
      await tx.insert(jobsTable).values({
        id: jobId,
        userId,
        projectId: project.id,
        status: "queued",
        plan: { version: 1, operations },
        inputPath: project.videoPath as string,
        referencePath: project.referenceVideoPath ?? null,
        // Enforced for real by the worker, which has the file. See render.ts.
        maxSourceSeconds: decision.maxSourceSeconds,
        // And the balance, for the same reason: the ceiling survives a missing
        // duration because the worker re-measures, and the allowance did not.
        remainingSeconds: decision.remainingSeconds,
        priority: decision.priority,
      });

      const [row] = await tx
        .insert(exportsTable)
        .values({
          id: randomUUID(),
          userId,
          projectId: project.id,
          jobId,
          status: "processing",
          platform: parsed.data.platform,
          steps: stepsForJob(undefined),
        })
        .returning();
      return row;
    });
  } catch (error) {
    // The same race the SELECT above cannot close, answered the same way.
    if (!isDuplicateActiveJob(error)) throw error;
    res.status(409).json({ error: ALREADY_RENDERING });
    return;
  }

  await db
    .update(projectsTable)
    .set({ status: "processing", platform: parsed.data.platform })
    .where(and(eq(projectsTable.id, project.id), eq(projectsTable.userId, userId)));

  res.status(202).json(GetExportStatusResponse.parse(serializeExport({ ...exportJob, steps: stepsForJob(undefined) })));
});

router.get("/projects/:id/export/status", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetExportStatusParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [exportJob] = await db
    .select()
    .from(exportsTable)
    .where(and(eq(exportsTable.projectId, params.data.id), eq(exportsTable.userId, userId)))
    .orderBy(desc(exportsTable.createdAt))
    .limit(1);

  if (!exportJob) {
    res.status(404).json({ error: "No export found for this project" });
    return;
  }

  // Older rows predate the queue and have no job to report on.
  const [job] = exportJob.jobId
    ? await db
        .select()
        .from(jobsTable)
        .where(and(eq(jobsTable.id, exportJob.jobId), eq(jobsTable.userId, userId)))
        .limit(1)
    : [undefined];

  const status = exportStatusFor(job);
  const steps = stepsForJob(job);

  // Persist so the row is not permanently out of date, but answer from the job
  // either way — the worker is the only thing that knows the truth here.
  if (exportJob.status !== status) {
    await db
      .update(exportsTable)
      .set({ status, steps })
      .where(and(eq(exportsTable.id, exportJob.id), eq(exportsTable.userId, userId)));
  }

  res.json(
    GetExportStatusResponse.parse(
      serializeExport({
        ...exportJob,
        status,
        steps,
        // The output lives in a private bucket, so the browser signs its own
        // URL rather than being handed one that would expire before it was
        // used — but it signs *this job's* output key, which travels with the
        // status. It used to sign the project's `editedVideoPath` from a copy
        // fetched before the export existed, which was still null, so the
        // fallback handed people their original upload under a card saying the
        // edit was ready.
        downloadUrl: null,
        outputPath: job?.outputPath ?? null,
        notes: Array.isArray(job?.notes) ? job.notes : [],
      }),
    ),
  );
});

export default router;
