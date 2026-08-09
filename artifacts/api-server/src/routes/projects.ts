import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { eq, desc, gte, count, and, inArray } from "drizzle-orm";
import { db, projectsTable, subscriptionsTable, jobsTable } from "@workspace/db";
import {
  CreateProjectBody,
  UpdateProjectBody,
  GetProjectParams,
  UpdateProjectParams,
  DeleteProjectParams,
  GetProjectResponse,
  ListProjectsResponse,
  UpdateProjectResponse,
} from "@workspace/api-zod";
import { serializeProject } from "../lib/transformers";
import { PLAN_LIMITS, isPlanKey } from "../lib/plan-limits";
import { currentUserId } from "../middlewares/auth";
import { deleteProjectObjects, isOwnedObjectPath } from "../lib/storage";
import { isUnclaimed } from "../lib/queue-health";

/**
 * Which of these projects are waiting on a machine that is not there?
 *
 * A project sits at "processing" for as long as its render is unfinished, which
 * is correct — but on the dashboard that badge has no way to say whether the
 * queue is busy or empty. Two of these have been "processing" for two days. The
 * card should say which it is.
 */
async function stalledProjectIds(userId: string, projectIds: string[]): Promise<Set<string>> {
  if (projectIds.length === 0) return new Set();
  const jobs = await db
    .select({
      projectId: jobsTable.projectId,
      status: jobsTable.status,
      createdAt: jobsTable.createdAt,
      lockedAt: jobsTable.lockedAt,
    })
    .from(jobsTable)
    .where(and(eq(jobsTable.userId, userId), inArray(jobsTable.projectId, projectIds)));

  const stalled = new Set<string>();
  for (const job of jobs) if (isUnclaimed(job)) stalled.add(job.projectId);
  return stalled;
}

const router: IRouter = Router();

router.get("/projects", async (req, res): Promise<void> => {
  const userId = currentUserId(req);

  const projects = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.userId, userId))
    .orderBy(desc(projectsTable.createdAt));

  const stalled = await stalledProjectIds(userId, projects.map((p) => p.id));
  res.json(
    ListProjectsResponse.parse(
      projects.map((p) => serializeProject({ ...p, renderStalled: stalled.has(p.id) })),
    ),
  );
});

router.post("/projects", async (req, res): Promise<void> => {
  const userId = currentUserId(req);

  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [sub] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);

  const planKey = sub && isPlanKey(sub.plan) ? sub.plan : "starter";
  const limits = PLAN_LIMITS[planKey];

  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  // Quota is per user, not global.
  const [{ value: videosThisMonth }] = await db
    .select({ value: count() })
    .from(projectsTable)
    .where(
      and(
        eq(projectsTable.userId, userId),
        gte(projectsTable.createdAt, startOfMonth),
      ),
    );

  if (videosThisMonth >= limits.videosPerMonth) {
    res.status(429).json({
      error: `You've reached your ${planKey} plan limit of ${limits.videosPerMonth} videos this month. Upgrade to create more.`,
      limitReached: true,
      plan: planKey,
    });
    return;
  }

  const id = randomUUID();
  const [project] = await db
    .insert(projectsTable)
    .values({ id, userId, title: parsed.data.title, status: "ready" })
    .returning();

  res.status(201).json(GetProjectResponse.parse(serializeProject({ ...project, renderStalled: false })));
});

router.get("/projects/:id", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(
      and(
        eq(projectsTable.id, params.data.id),
        eq(projectsTable.userId, userId),
      ),
    );

  // Someone else's project is reported as absent rather than forbidden, so the
  // endpoint cannot be used to probe which project ids exist.
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const stalled = await stalledProjectIds(userId, [project.id]);
  res.json(
    GetProjectResponse.parse(serializeProject({ ...project, renderStalled: stalled.has(project.id) })),
  );
});

router.patch("/projects/:id", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateProjectParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Storage keys come from the browser, so the server confirms they point
  // inside this user's folder for this project before recording them.
  for (const field of ["videoPath", "editedVideoPath", "thumbnailPath"] as const) {
    const value = parsed.data[field];
    if (value !== undefined && !isOwnedObjectPath(value, userId, params.data.id)) {
      res.status(400).json({ error: `${field} must be inside this project's own storage folder` });
      return;
    }
  }

  const [project] = await db
    .update(projectsTable)
    .set(parsed.data)
    .where(
      and(
        eq(projectsTable.id, params.data.id),
        eq(projectsTable.userId, userId),
      ),
    )
    .returning();

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const stalled = await stalledProjectIds(userId, [project.id]);
  res.json(
    UpdateProjectResponse.parse(serializeProject({ ...project, renderStalled: stalled.has(project.id) })),
  );
});

router.delete("/projects/:id", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteProjectParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [project] = await db
    .delete(projectsTable)
    .where(
      and(
        eq(projectsTable.id, params.data.id),
        eq(projectsTable.userId, userId),
      ),
    )
    .returning();

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // The row is gone either way; reclaiming the bytes is best-effort.
  await deleteProjectObjects(userId, project.id);

  res.sendStatus(204);
});

export default router;
