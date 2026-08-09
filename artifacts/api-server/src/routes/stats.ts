import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, projectsTable, jobsTable } from "@workspace/db";
import { GetDashboardStatsResponse } from "@workspace/api-zod";
import { serializeProject } from "../lib/transformers";
import { currentUserId } from "../middlewares/auth";
import { isUnclaimed } from "../lib/queue-health";

const router: IRouter = Router();

router.get("/stats/dashboard", async (req, res): Promise<void> => {
  const userId = currentUserId(req);

  const allProjects = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.userId, userId))
    .orderBy(desc(projectsTable.createdAt));

  const totalProjects = allProjects.length;
  const doneCount = allProjects.filter((p) => p.status === "done").length;
  // Same reconciliation the project routes do — and it has to cover every
  // project, not just the four on the cards, because the counter above them
  // claims to describe the whole library.
  const jobs = await db
    .select({
      projectId: jobsTable.projectId,
      status: jobsTable.status,
      createdAt: jobsTable.createdAt,
      lockedAt: jobsTable.lockedAt,
    })
    .from(jobsTable)
    .where(eq(jobsTable.userId, userId));

  const stalled = new Set<string>();
  for (const job of jobs) if (isUnclaimed(job)) stalled.add(job.projectId);

  // "Currently processing: 2" beside two cards reading "waiting for a machine"
  // is the counter contradicting the cards. A render nobody has picked up is
  // not being processed, so it is counted separately and named for what it is.
  const processingCount = allProjects.filter(
    (p) => p.status === "processing" && !stalled.has(p.id),
  ).length;
  const stalledCount = allProjects.filter((p) => stalled.has(p.id)).length;

  const recentProjects = allProjects
    .slice(0, 4)
    .map((p) => serializeProject({ ...p, renderStalled: stalled.has(p.id) }));

  res.json(
    GetDashboardStatsResponse.parse({
      totalProjects,
      processingCount,
      stalledCount,
      doneCount,
      recentProjects,
    })
  );
});

export default router;
