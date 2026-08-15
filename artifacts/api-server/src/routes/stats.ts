import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, projectsTable, jobsTable, workerHeartbeatsTable } from "@workspace/db";
import { GetDashboardStatsResponse } from "@workspace/api-zod";
import { serializeProject } from "../lib/transformers";
import { currentUserId } from "../middlewares/auth";
import { isUnclaimed, workerOnline } from "../lib/queue-health";

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

  // Whether anything is listening. Global rather than per-user, and reported as
  // a fact rather than inferred from the queue — the inference cannot say
  // anything for five minutes and cannot say anything at all when nothing is
  // queued, which is exactly the state right after a first deploy.
  //
  // The worker's id is deliberately not returned: it carries a hostname, and
  // nobody outside needs it to know the answer.
  const [newest] = await db
    .select({
      lastSeenAt: workerHeartbeatsTable.lastSeenAt,
      transcription: workerHeartbeatsTable.transcription,
      vision: workerHeartbeatsTable.vision,
    })
    .from(workerHeartbeatsTable)
    .orderBy(desc(workerHeartbeatsTable.lastSeenAt))
    .limit(1);

  const worker = {
    online: workerOnline(newest?.lastSeenAt),
    lastSeenAt: newest?.lastSeenAt ? new Date(newest.lastSeenAt).toISOString() : null,
    transcription: newest?.transcription ?? null,
    vision: newest?.vision ?? null,
  };

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
      worker,
    })
  );
});

export default router;
