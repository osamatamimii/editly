import { Router, type IRouter } from "express";
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
import { TEMPLATES, findTemplate } from "../lib/templates";
import { isUnattended } from "../lib/queue-health";
import { newestWorkerSeenAt } from "../lib/worker-presence";
import { startRenderForProject } from "../lib/start-render";
import { rateLimit, LIMITS } from "../lib/rate-limit";

const router: IRouter = Router();

function annotateStaleQueue(
  job: Record<string, unknown>,
  workerLastSeenAt: Date | null,
): Record<string, unknown> {
  if (!isUnattended(job as unknown as { status: string; createdAt: Date | string }, workerLastSeenAt)) return job;
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
router.post("/projects/:id/render", rateLimit(LIMITS.render), async (req, res): Promise<void> => {
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
    requested = body.data.plan.operations;
  }

  // What "asked" becomes "queued" through lives in one place — the same place
  // the chat door uses — so the browser has no vote in the allowance, the
  // watermark, or the one-render-at-a-time rule whichever door was used.
  const outcome = await startRenderForProject(userId, project, requested, req.log);
  if (!outcome.ok) {
    res.status(outcome.status).json(outcome.body);
    return;
  }

  res.status(202).json(StartRenderResponse.parse(serializeJob(outcome.job)));
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

  const workerLastSeenAt = job ? await newestWorkerSeenAt() : null;
  res.json(GetRenderStatusResponse.parse(job ? serializeJob(annotateStaleQueue(job, workerLastSeenAt)) : null));
});

/** The named looks. Public shape, no per-user data — but still behind auth. */
router.get("/templates", async (_req, res): Promise<void> => {
  res.json(
    TEMPLATES.map(({ id, name, description, bestFor }) => ({ id, name, description, bestFor })),
  );
});

export default router;
