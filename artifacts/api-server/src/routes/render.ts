import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { eq, and, desc } from "drizzle-orm";
import { db, projectsTable, jobsTable, messagesTable, renderFollowupsTable, assetsTable } from "@workspace/db";
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
import { isUnattended, waitEstimate } from "../lib/queue-health";
import { newestWorkerSeenAt, renderCapacity, workAheadOf } from "../lib/worker-presence";
import { startRenderForProject } from "../lib/start-render";
import { withCaptionFonts, myFaceIds } from "../lib/caption-fonts";
import { rateLimit, LIMITS } from "../lib/rate-limit";

const router: IRouter = Router();

function annotateStaleQueue(
  job: Record<string, unknown>,
  workerLastSeenAt: Date | null,
): Record<string, unknown> {
  if (!isUnattended(job as unknown as { status: string; createdAt: Date | string }, workerLastSeenAt)) return job;
  return {
    ...job,
    stage: "Still waiting for a render machine, nothing has picked this up yet.",
  };
}

/**
 * How long this job will wait, when that can be answered honestly.
 *
 * Only for a job that is actually queued, and that is a cost decision as much
 * as a correctness one: this route is polled every few seconds by every open
 * editor, and somebody watching a render that is already running has nothing to
 * learn from a queue depth. Two extra reads, on the people who are waiting.
 *
 * Null wherever the number would be invented — too little history to have a
 * typical render, no worker to divide by, nothing ahead. `waitEstimate` decides
 * which, and every one of those cases already has a truer sentence attached to
 * it somewhere else on the screen.
 */
async function withWait(job: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (job["status"] !== "queued") return job;
  const [{ workers, rate }, aheadSourceSeconds] = await Promise.all([
    renderCapacity(),
    workAheadOf(String(job["id"])),
  ]);
  if (aheadSourceSeconds === null) return job;
  return { ...job, waitSeconds: waitEstimate({ aheadSourceSeconds, workers, rate }) };
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
    /**
     * The track this project has, if it has one.
     *
     * Read before the template is built rather than inside it, because one
     * template cannot be built at all without a track and the refusal belongs
     * here — before anything is queued, billed, or half-rendered. Newest first,
     * matching every other place in the product that picks "your music" out of
     * a library without being told which.
     */
    const [track] = await db
      .select({ id: assetsTable.id })
      .from(assetsTable)
      .where(and(eq(assetsTable.projectId, project.id), eq(assetsTable.kind, "audio")))
      .orderBy(desc(assetsTable.createdAt))
      .limit(1);

    if (template.needs === "music" && !track) {
      res.status(400).json({
        error:
          "This look cuts to a track, and this project has no audio file yet. Upload one and press it again.",
      });
      return;
    }

    requested = template.build({
      musicAssetId: track?.id ?? null,
      platform: (project.platform ?? "tiktok") as "tiktok" | "reels" | "shorts" | "youtube" | "square",
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

  // The chosen faces, applied once, after the plan exists and whichever way it
  // was made. Only the caption operations, and only where the plan has not
  // already named a face itself.
  requested = withCaptionFonts({ version: 1, operations: requested }, body.data.fonts, await myFaceIds(userId)).operations;

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

  // The whole row, not just the id: a settled render may have a follow-up to
  // start, and starting one needs the same project the other doors read.
  const [project] = await db
    .select()
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

  // The moment the poll sees the render settle is the moment "I'll fold this
  // in once it finishes" comes due. The DELETE .. RETURNING is the claim:
  // concurrent polls race here, exactly one gets the row, so one follow-up
  // starts however many tabs are watching. This poll still answers with the
  // *settled* job — the screen gets to show what just finished (and refetch
  // the project and the conversation) — and the next poll finds the new job.
  if (job && (job.status === "done" || job.status === "failed")) {
    const [pending] = await db
      .delete(renderFollowupsTable)
      .where(and(eq(renderFollowupsTable.projectId, project.id), eq(renderFollowupsTable.userId, userId)))
      .returning();

    if (pending) {
      let content: string;
      if (job.status === "failed") {
        // Folding a follow-up into a failure would render on top of a problem
        // nobody has looked at yet. Saying so beats silently dropping it.
        content =
          "That render failed, so I left your follow-up unstarted. Send it again once you've had a look.";
      } else {
        const outcome = await startRenderForProject(
          userId,
          project,
          pending.operations as EditOperation[],
          req.log,
        );
        content = outcome.ok
          ? "That render landed. Starting the follow-up you asked for. It's rendering now."
          : `That render landed, but I couldn't start your follow-up: ${String(outcome.body["error"] ?? "it could not be started.")}`;
      }
      // Into the conversation, like every other answer: the promise was made
      // in the chat, so the chat is where keeping it must be visible.
      await db.insert(messagesTable).values({
        id: randomUUID(),
        userId,
        projectId: project.id,
        role: "assistant",
        content,
      });
    }
  }

  const workerLastSeenAt = job ? await newestWorkerSeenAt() : null;
  res.json(
    GetRenderStatusResponse.parse(
      job ? serializeJob(await withWait(annotateStaleQueue(job, workerLastSeenAt))) : null,
    ),
  );
});

/**
 * The named looks. Public shape, no per-user data — but still behind auth.
 *
 * One side of each pair, chosen by the header, so the shape on the wire is
 * unchanged and the OpenAPI file still describes three strings. Storing both
 * and choosing in the browser would put a second language into a response
 * every client then has to know about, for the one screen that shows them.
 *
 * `Accept-Language` is what the app sends: `lib/api-client-react` attaches the
 * *product's* chosen language rather than the operating system's, because a
 * phone set to English is not an answer about what somebody reads. Anything
 * that does not ask for Arabic gets English, which is what every other client
 * of this route already got.
 */
router.get("/templates", async (req, res): Promise<void> => {
  const arabic = /(^|,)\s*ar\b/i.test(String(req.headers["accept-language"] ?? ""));
  res.json(
    TEMPLATES.map(({ id, name, nameAr, description, descriptionAr, bestFor, bestForAr, needs }) => ({
      id,
      name: arabic ? nameAr : name,
      description: arabic ? descriptionAr : description,
      bestFor: arabic ? bestForAr : bestFor,
      needs: needs ?? null,
    })),
  );
});

export default router;
