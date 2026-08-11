import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { eq, and, desc } from "drizzle-orm";
import { db, projectsTable, jobsTable } from "@workspace/db";
import {
  StartRenderParams,
  StartRenderBody,
  StartRenderResponse,
  GetRenderStatusParams,
  GetRenderStatusResponse,
} from "@workspace/api-zod";
import { currentUserId } from "../middlewares/auth";
import { serializeJob } from "../lib/transformers";
import type { EditOperation } from "@workspace/api-zod";
import { TEMPLATES, findTemplate, evenlySpacedPunches } from "../lib/templates";
import { planKeyFrom } from "../lib/plan-limits";
import { usageFor } from "../lib/usage";
import { decideRender } from "../lib/render-policy";
import { isUnclaimed } from "../lib/queue-health";
import { subscriptionsTable } from "@workspace/db";

const router: IRouter = Router();

function annotateStaleQueue(job: Record<string, unknown>): Record<string, unknown> {
  if (!isUnclaimed(job as unknown as { status: string; createdAt: Date | string })) return job;
  return {
    ...job,
    stage: "Still waiting for a render machine — nothing has picked this up yet.",
  };
}

/**
 * Enqueue a render.
 *
 * This endpoint deliberately does no work: it validates, writes a row, and
 * returns. The ffmpeg worker picks it up. A serverless function has neither the
 * binary nor the lifetime to render video, and pretending otherwise is what the
 * original five-second `setTimeout` did.
 */
router.post("/projects/:id/render", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = StartRenderParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = StartRenderBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
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
    res.status(409).json({ error: "Upload a video before rendering." });
    return;
  }

  // One render at a time per project: a second one would race the first for the
  // same output key, and the user has no way to tell which result they got.
  const [pending] = await db
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.projectId, project.id), eq(jobsTable.userId, userId)))
    .orderBy(desc(jobsTable.createdAt))
    .limit(1);

  if (pending && (pending.status === "queued" || pending.status === "running")) {
    res.status(409).json({ error: "This project is already rendering.", jobId: pending.id });
    return;
  }

  let requested: EditOperation[];
  if ("templateId" in body.data) {
    const template = findTemplate(body.data.templateId);
    if (!template) {
      res.status(400).json({ error: `Unknown template "${body.data.templateId}".` });
      return;
    }
    requested = template.build({
      platform: (project.platform ?? "tiktok") as "tiktok" | "reels" | "shorts",
      // Templates place their punches proportionally. When nothing has measured
      // this file, they are told so rather than told "30 seconds".
      durationSeconds: project.duration ?? null,
      // The mark is not the template's decision. `decideRender` adds it from the
      // plan, so a template cannot accidentally watermark a paying customer or
      // accidentally fail to watermark a free one.
      watermark: false,
    });
  } else {
    // A plan can arrive with punch timestamps left empty — the chat knows you
    // want emphasis but not where the interesting moments are. Space them out
    // over whatever the clip actually is.
    requested = body.data.plan.operations.map((op) =>
      op.type === "zoomPunch" && op.at.length === 0
        ? { ...op, at: evenlySpacedPunches(project.duration ?? null, 4) }
        : op,
    );
  }

  // Everything above this line is what the caller *asked for*. Everything below
  // is what the plan they pay for actually allows — and the browser has no vote
  // in it. This route used to trust the operations it was handed, which meant
  // the watermark could be removed from the free plan by deleting one object
  // from a JSON body, and the month's allowance was never checked at all.
  const [sub] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);

  const planKey = planKeyFrom(sub?.plan);
  const decision = decideRender({
    plan: planKey,
    usage: await usageFor(userId, planKey),
    sourceDurationSeconds: project.duration,
    operations: requested,
  });

  if (!decision.allowed) {
    res.status(decision.status).json(decision.body);
    return;
  }

  if (decision.corrections.length) {
    req.log?.info({ userId, plan: planKey, corrections: decision.corrections }, "render plan corrected by policy");
  }

  const plan = { version: 1 as const, operations: decision.operations };

  const [job] = await db
    .insert(jobsTable)
    .values({
      id: randomUUID(),
      userId,
      projectId: project.id,
      status: "queued",
      plan,
      inputPath: project.videoPath,
      // Snapshotted so that changing or clearing the reference while this sits
      // in the queue cannot quietly alter a render already accepted.
      referencePath: project.referenceVideoPath ?? null,
      // The worker re-checks this against the file it actually downloads. The
      // duration the policy layer saw came from the browser and can be a lie;
      // this number cannot.
      maxSourceSeconds: decision.maxSourceSeconds,
      priority: decision.priority,
    })
    .returning();

  await db
    .update(projectsTable)
    .set({ status: "processing" })
    .where(and(eq(projectsTable.id, project.id), eq(projectsTable.userId, userId)));

  res.status(202).json(StartRenderResponse.parse(serializeJob(job)));
});

/** The most recent render for a project, or null if it has never been rendered. */
router.get("/projects/:id/render/status", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetRenderStatusParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [project] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, params.data.id), eq(projectsTable.userId, userId)));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [job] = await db
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.projectId, project.id), eq(jobsTable.userId, userId)))
    .orderBy(desc(jobsTable.createdAt))
    .limit(1);

  res.json(GetRenderStatusResponse.parse(job ? serializeJob(annotateStaleQueue(job)) : null));
});

/** The named looks. Public shape, no per-user data — but still behind auth. */
router.get("/templates", async (_req, res): Promise<void> => {
  res.json(
    TEMPLATES.map(({ id, name, description, bestFor }) => ({ id, name, description, bestFor })),
  );
});

export default router;
