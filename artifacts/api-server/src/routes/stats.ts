import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, projectsTable, jobsTable, workerHeartbeatsTable } from "@workspace/db";
import { GetDashboardStatsResponse } from "@workspace/api-zod";
import { serializeProject } from "../lib/transformers";
import { currentUserId } from "../middlewares/auth";
import { isUnattended, workerOnline } from "../lib/queue-health";

const router: IRouter = Router();

router.get("/stats/dashboard", async (req, res): Promise<void> => {
  const userId = currentUserId(req);

  /*
    Counted in the database, not in this process.

    This screen shows four numbers and four cards, and it used to get them by
    selecting *every* project row this account owns — every column, including
    the plan and state documents — and every job row, and then filtering the
    lot in JavaScript. Nothing failed and nothing ever will in a test: the
    founder's account has a dozen projects, so the query is instant and the
    arrays are small. It is a query whose cost is the customer's whole history,
    on the one screen every customer loads first, on a database whose entire
    plan is 500 MB of RAM. The heaviest user is the one it breaks for, which is
    the wrong way round.

    `count(*) filter (…)` does the same arithmetic where the rows already are.
  */
  const [tally] = await db
    .select({
      total: sql<number>`count(*)`,
      done: sql<number>`count(*) filter (where ${projectsTable.status} = 'done')`,
    })
    .from(projectsTable)
    .where(eq(projectsTable.userId, userId));

  const totalProjects = Number(tally?.total ?? 0);
  const doneCount = Number(tally?.done ?? 0);

  /*
    Same reconciliation the project routes do, and it still has to cover every
    project rather than the four on the cards, because the counter above them
    claims to describe the whole library.

    But only the jobs that could possibly answer yes. `isUnattended` refuses
    anything that is not `queued` with no lock, so reading a finished render
    from 2024 to ask a question whose answer is already known is the unbounded
    half of this route: jobs are the row that never gets deleted, one per
    render forever. The predicate is written here as well as there on purpose —
    the two must agree, and the check in `queue-test` is what holds them
    together.
  */
  const jobs = await db
    .select({
      projectId: jobsTable.projectId,
      status: jobsTable.status,
      createdAt: jobsTable.createdAt,
      lockedAt: jobsTable.lockedAt,
    })
    .from(jobsTable)
    .where(
      and(eq(jobsTable.userId, userId), eq(jobsTable.status, "queued"), isNull(jobsTable.lockedAt)),
    );

  // Read before the queue is judged, because it is what the judgement turns on:
  // a queue behind a working machine is a queue, and only a queue behind no
  // machine at all is stalled.
  const [newest] = await db
    .select({
      lastSeenAt: workerHeartbeatsTable.lastSeenAt,
      transcription: workerHeartbeatsTable.transcription,
      vision: workerHeartbeatsTable.vision,
    })
    .from(workerHeartbeatsTable)
    .orderBy(desc(workerHeartbeatsTable.lastSeenAt))
    .limit(1);

  const stalled = new Set<string>();
  for (const job of jobs) if (isUnattended(job, newest?.lastSeenAt)) stalled.add(job.projectId);

  /*
    "Currently processing: 2" beside two cards reading "waiting for a machine"
    is the counter contradicting the cards. A render nobody has picked up is not
    being processed, so it is counted separately and named for what it is.

    Both of these are bounded by the queue rather than by the library: the
    processing rows are the ones a worker is on right now, and the stalled ids
    come out of the job read above. The projects table is asked which of those
    ids it still has, because a job can outlive its project — the cascade was
    removed in migration 0011 so that a render which happened stays counted —
    and a card for a project that is gone is not a card.
  */
  const processingProjects = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(and(eq(projectsTable.userId, userId), eq(projectsTable.status, "processing")));
  const processingCount = processingProjects.filter((p) => !stalled.has(p.id)).length;

  const stalledIds = [...stalled];
  const stalledCount =
    stalledIds.length === 0
      ? 0
      : (
          await db
            .select({ id: projectsTable.id })
            .from(projectsTable)
            .where(and(eq(projectsTable.userId, userId), inArray(projectsTable.id, stalledIds)))
        ).length;

  // Whether anything is listening. Global rather than per-user, and reported as
  // a fact rather than inferred from the queue — the inference cannot say
  // anything for five minutes and cannot say anything at all when nothing is
  // queued, which is exactly the state right after a first deploy.
  //
  // The worker's id is deliberately not returned: it carries a hostname, and
  // nobody outside needs it to know the answer.
  const worker = {
    online: workerOnline(newest?.lastSeenAt),
    lastSeenAt: newest?.lastSeenAt ? new Date(newest.lastSeenAt).toISOString() : null,
    transcription: newest?.transcription ?? null,
    vision: newest?.vision ?? null,
  };

  // Four cards, four rows. `slice(0, 4)` over the whole library was the same
  // read done twice: once to count and once to throw away.
  const newestProjects = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.userId, userId))
    .orderBy(desc(projectsTable.createdAt))
    .limit(4);

  const recentProjects = newestProjects.map((p) =>
    serializeProject({ ...p, renderStalled: stalled.has(p.id) }),
  );

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
