import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { eq, desc, gte, count } from "drizzle-orm";
import { db, projectsTable, subscriptionsTable } from "@workspace/db";
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

const router: IRouter = Router();

router.get("/projects", async (req, res): Promise<void> => {
  const projects = await db
    .select()
    .from(projectsTable)
    .orderBy(desc(projectsTable.createdAt));
  res.json(ListProjectsResponse.parse(projects.map(serializeProject)));
});

router.post("/projects", async (req, res): Promise<void> => {
  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [sub] = await db.select().from(subscriptionsTable).limit(1);
  const planKey = sub && isPlanKey(sub.plan) ? sub.plan : "starter";
  const limits = PLAN_LIMITS[planKey];

  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  const [{ value: videosThisMonth }] = await db
    .select({ value: count() })
    .from(projectsTable)
    .where(gte(projectsTable.createdAt, startOfMonth));

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
    .values({ id, title: parsed.data.title, status: "ready" })
    .returning();

  res.status(201).json(GetProjectResponse.parse(serializeProject(project)));
});

router.get("/projects/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, params.data.id));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json(GetProjectResponse.parse(serializeProject(project)));
});

router.patch("/projects/:id", async (req, res): Promise<void> => {
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

  const [project] = await db
    .update(projectsTable)
    .set(parsed.data)
    .where(eq(projectsTable.id, params.data.id))
    .returning();

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json(UpdateProjectResponse.parse(serializeProject(project)));
});

router.delete("/projects/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteProjectParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [project] = await db
    .delete(projectsTable)
    .where(eq(projectsTable.id, params.data.id))
    .returning();

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
