import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, projectsTable } from "@workspace/db";
import { GetDashboardStatsResponse } from "@workspace/api-zod";
import { serializeProject } from "../lib/transformers";
import { currentUserId } from "../middlewares/auth";

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
  const recentProjects = allProjects.slice(0, 4).map(serializeProject);

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
