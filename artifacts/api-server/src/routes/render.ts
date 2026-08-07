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

const router: IRouter = Router();

/**
 * A job nobody has claimed after this long means no worker is running, not that
 * the queue is busy. Saying so beats a progress bar that never moves.
 */
const NO_WORKER_AFTER_MS = 5 * 60 * 1000;

function annotateStaleQueue(job: Record<string, unknown>): Record<string, unknown> {
  if (job["status"] !== "queued") return job;
  const createdAt = new Date(job["createdAt"] as string | Date).getTime();
  if (Date.now() - createdAt < NO_WORKER_AFTER_MS) return job;
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

  const [job] = await db
    .insert(jobsTable)
    .values({
      id: randomUUID(),
      userId,
      projectId: project.id,
      status: "queued",
      plan: body.data.plan,
      inputPath: project.videoPath,
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

export default router;
