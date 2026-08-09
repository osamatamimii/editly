import { Router, type IRouter } from "express";
import { desc, eq, and, inArray } from "drizzle-orm";
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
  const processingCount = allProjects.filter((p) => p.status === "processing").length;
  const doneCount = allProjects.filter((p) => p.status === "done").length;
  const recent = allProjects.slice(0, 4);
  // Same reconciliation the project routes do: a card that says "processing"
  // has to be able to say whether anything is actually working on it.
  const stalled = new Set<string>();
  if (recent.length > 0) {
    const jobs = await db
      .select({
        projectId: jobsTable.projectId,
        status: jobsTable.status,
        createdAt: jobsTable.createdAt,
        lockedAt: jobsTable.lockedAt,
      })
      .from(jobsTable)
      .where(and(eq(jobsTable.userId, userId), inArray(jobsTable.projectId, recent.map((p) => p.id))));
    for (const job of jobs) if (isUnclaimed(job)) stalled.add(job.projectId);
  }
  const recentProjects = recent.map((p) =>
    serializeProject({ ...p, renderStalled: stalled.has(p.id) }),
  );

  res.json(
    GetDashboardStatsResponse.parse({
      totalProjects,
      processingCount,
      doneCount,
      recentProjects,
    })
  );
});

export default router;
