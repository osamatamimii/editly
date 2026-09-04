import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { eq, desc, and } from "drizzle-orm";
import { db, exportsTable, projectsTable, jobsTable, subscriptionsTable, type Job } from "@workspace/db";
import {
  StartExportBody,
  StartExportParams,
  GetExportStatusParams,
  GetExportStatusResponse,
  EditPlan,
  type EditOperation,
  type Platform, MAX_PLAN_OPERATIONS } from "@workspace/api-zod";
import { serializeExport } from "../lib/transformers";
import { planKeyFrom, referenceForPlan } from "../lib/plan-limits";
import { usageFor, usageNotConsulted } from "../lib/usage";
import { decideRender } from "../lib/render-policy";
import { currentUserId } from "../middlewares/auth";
import { isDuplicateActiveJob, ALREADY_RENDERING } from "../lib/one-active-job";
import { rateLimit, LIMITS } from "../lib/rate-limit";
import { badRequest } from "../lib/bad-request";

const router: IRouter = Router();

/**
 * What an export is a render *of*.
 *
 * It used to be a render of the original upload with two operations bolted on:
 * cut the silences, frame it for the platform. Which meant the button sitting
 * beside the finished edit, under a heading that says "Export Project", handed
 * back **a different video** — no captions, no punches, no music, no titles,
 * none of the work the person had just done in the chat. Nothing failed and
 * nothing said so; the file simply was not the one on screen a moment earlier.
 *
 * An export is the same edit, framed for somewhere else. So it carries the
 * operations of the last render that finished, changing only what has to
 * change:
 *
 * - **`formatForPlatform` is replaced**, because choosing the platform is the
 *   entire point of the screen.
 * - **`watermark` is dropped**, because the mark is not the plan's to carry:
 *   `decideRender` adds it from the subscription on every path, and a plan that
 *   brought its own would either double it or smuggle one past a paying
 *   customer.
 * - **`extractClips` is dropped**, because an export is one file. A clips plan
 *   asks for several, and the clips already exist as their own artifacts.
 *
 * Everything else is carried exactly, and the render starts from the original
 * upload — which is what the operations were written against. Re-rendering the
 * *edited* file instead would cut silences out of a video whose silences were
 * already cut.
 */
const NOT_THE_PLAN_S_TO_CARRY = new Set(["watermark", "extractClips"]);

/** What the export falls back to when this project has never been rendered. */
const FIRST_EXPORT: EditOperation[] = [
  { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 },
];

function carryForward(previous: EditOperation[] | null, platform: Platform): EditOperation[] | null {
  const kept = (previous ?? FIRST_EXPORT).filter((op) => !NOT_THE_PLAN_S_TO_CARRY.has(op.type));
  const framed: EditOperation = { type: "formatForPlatform", platform };
  const at = kept.findIndex((op) => op.type === "formatForPlatform");
  if (at >= 0) {
    // In place, so the reframe still happens where the edit expected it to.
    return [...kept.slice(0, at), framed, ...kept.slice(at + 1)];
  }
  // No room, rather than a silent drop. Twelve is the plan's ceiling and the
  // worker refuses a thirteenth outright, so quietly losing an operation here
  // would be an export that is missing something nobody was told about.
  if (kept.length >= MAX_OPERATIONS) return null;
  return [...kept, framed];
}

/** `EditPlan` allows twelve. The worker parses with it and refuses a thirteenth. */
const MAX_OPERATIONS = MAX_PLAN_OPERATIONS;


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
    badRequest(res, params.error);
    return;
  }

  const parsed = StartExportBody.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error);
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

  // Read before anything about the project is judged, and refused before it
  // too — the same ordering `start-render` argues for, and for the same reason:
  // an account that has been stopped and is told "upload a video first" will
  // upload a video and be stopped anyway. The refusal itself is `decideRender`'s
  // now; this is only the point at which the question gets asked.
  const [sub] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);

  if (sub?.suspendedAt) {
    const stopped = decideRender({
      plan: planKeyFrom(sub.plan),
      usage: usageNotConsulted(),
      operations: [],
      suspendedAt: sub.suspendedAt,
    });
    if (!stopped.allowed) {
      res.status(stopped.status).json(stopped.body);
      return;
    }
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


  // The mark, the meter and the upload ceiling are one decision, and it lives
  // in `render-policy` so this route and the editor's cannot drift apart. They
  // had already drifted once: this one checked the allowance and that one did
  // not, which made the free plan's limit a limit only on this button.
  const planKey = planKeyFrom(sub?.plan);
  /**
   * The last render that finished, and what it did.
   *
   * `latest` above is the newest job whichever way it went — the right row for
   * "is something already running". This is a different question: what is the
   * edit this project *is*, which only a job that finished can answer.
   */
  const [lastDone] = await db
    .select({ plan: jobsTable.plan })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.projectId, project.id),
        eq(jobsTable.userId, userId),
        eq(jobsTable.status, "done"),
      ),
    )
    .orderBy(desc(jobsTable.finishedAt))
    .limit(1);

  const previous = EditPlan.safeParse(lastDone?.plan);
  const carried = carryForward(
    previous.success ? previous.data.operations : null,
    parsed.data.platform,
  );
  if (!carried) {
    res.status(409).json({
      error:
        "This edit already uses every operation a plan can hold, so there is no room to add the platform framing. Ask for one fewer change and export again.",
    });
    return;
  }

  const decision = decideRender({
    plan: planKey,
    usage: await usageFor(userId, planKey),
    sourceDurationSeconds: project.duration,
    operations: carried,
    suspendedAt: sub?.suspendedAt,
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
        // Gated on the plan, not just snapshotted: a reference set while paying
        // must not still be applied after a downgrade. See referenceForPlan.
        referencePath: referenceForPlan(planKey, project.referenceVideoPath),
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
    badRequest(res, params.error);
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
        // The finished edit's length, measured by the worker from the file it
        // wrote.
        //
        // Only when it was really measured. `outputSecondsSource` is `probe`
        // for an ffprobe reading, `estimate` for the plan's arithmetic, and
        // `fallback` for the source length — and that column exists precisely
        // because a measurement and a guess were once indistinguishable once
        // written. The scheduling screen refuses posts against this number, and
        // refusing on a guess is refusing for a reason nobody can see, so a
        // guess is reported as "not known" instead.
        outputSeconds: job?.outputSecondsSource === "probe" ? (job.outputSeconds ?? null) : null,
        notes: Array.isArray(job?.notes) ? job.notes : [],
      }),
    ),
  );
});

export default router;
