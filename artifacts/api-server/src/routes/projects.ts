import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { eq, desc, gte, count, and, inArray, sql } from "drizzle-orm";
import {
  db,
  projectsTable,
  subscriptionsTable,
  jobsTable,
  messagesTable,
  exportsTable,
  scheduledPostsTable,
} from "@workspace/db";
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
import { PROJECTS_LIMIT } from "@workspace/api-zod/limits";
import { checkUploadedObject } from "../lib/uploaded-file";
import { cancelRendersFor } from "../lib/cancel-render";
import { serializeProject } from "../lib/transformers";
import { planKeyFrom, PLAN_LIMITS } from "../lib/plan-limits";
import { usageFor, exhaustedMessage } from "../lib/usage";
import { currentUserId } from "../middlewares/auth";
import { deleteProjectObjects, isOwnedObjectPath } from "../lib/storage";
import { isUnattended } from "../lib/queue-health";
import { newestWorkerSeenAt } from "../lib/worker-presence";
import { rateLimit, LIMITS } from "../lib/rate-limit";
import { badRequest } from "../lib/bad-request";

/** Said instead of a 204 that would not be true. */
const COULD_NOT_DELETE_STORAGE =
  "We couldn\u2019t remove this project\u2019s video files just now, so nothing has been deleted \u2014 we won\u2019t tell you your work is gone while it is still here. Please try again shortly.";

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
  const workerLastSeenAt = await newestWorkerSeenAt();
  for (const job of jobs) if (isUnattended(job, workerLastSeenAt)) stalled.add(job.projectId);
  return stalled;
}

const router: IRouter = Router();

router.get("/projects", async (req, res): Promise<void> => {
  const userId = currentUserId(req);

  /*
    Newest first, and bounded.

    This had no `LIMIT`, so it returned everything the account had ever made —
    into a serverless invocation, where the row count and the memory are the
    same number, and then through `serializeProject` and a zod parse of the
    whole array. Nothing fails at a hundred; the account that has used the
    product longest is simply the one whose dashboard gets slower, until one
    day it times out with nothing to read. The failure lands on the best
    customer first.

    `PROJECTS_LIMIT` is shared with the page, which is the rule this codebase
    already follows for every other list: a cap the screen does not know about
    makes "this is everything you have" and "this is where I stopped" the same
    screen.
  */
  const projects = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.userId, userId))
    .orderBy(desc(projectsTable.createdAt))
    .limit(PROJECTS_LIMIT);

  const stalled = await stalledProjectIds(userId, projects.map((p) => p.id));
  res.json(
    ListProjectsResponse.parse(
      projects.map((p) => serializeProject({ ...p, renderStalled: stalled.has(p.id) })),
    ),
  );
});

router.post("/projects", rateLimit(LIMITS.createProject), async (req, res): Promise<void> => {
  const userId = currentUserId(req);

  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error);
    return;
  }

  const [sub] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);

  const planKey = planKeyFrom(sub?.plan);

  // The meter is minutes of finished video, not projects created. Creating a
  // project costs us nothing, so it is not the thing to charge for, and
  // refusing it is the wrong place to say no. What gets refused is a render
  // that would go past the allowance.
  const usage = await usageFor(userId, planKey);
  if (usage.exhausted) {
    res.status(429).json({
      error: exhaustedMessage(planKey, usage),
      limitReached: true,
      plan: planKey,
      minutesUsed: usage.minutesUsed,
      minutesIncluded: usage.minutesIncluded,
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
    badRequest(res, params.error);
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

  /*
    When they last opened it, which is the clock the retention sweep ages from.

    This request *is* "somebody opened a project" — it is what the editor makes
    when the page loads — so it is the only honest place to stamp it. Written
    with raw SQL rather than through the query builder on purpose: the builder
    would also move `updated_at`, and the whole reason `last_opened_at` exists
    is that `updated_at` answers a different question. A project the worker
    wrote a thumbnail onto last night has been touched; it has not been opened.

    ## And it is awaited, because losing it is not free

    This was `void db.execute(…).catch(() => {})`, with a note saying a missed
    stamp "leaves a project looking colder by one visit, and colder still means
    it waits". Colder does not mean it waits. Colder means it is swept
    **sooner** — that is the whole direction of the clock — so a dropped stamp
    moves an irreplaceable upload closer to deletion, not further from it.

    And it was the *only* writer of this column in the product. `GET /projects`
    does not stamp, and `updated_at` deliberately does not move here, so for
    the one project shape the sweep may take a source from — uploaded, never
    rendered — the only thing between the customer's video and a delete was a
    fire-and-forget write whose failure was designed to be invisible. On a
    serverless runtime the invocation can be frozen the moment the response is
    written, so a dropped stamp is not even unlikely.

    Awaited now: it is one indexed UPDATE on the row we have just read, on a
    page load that is already several round trips. Still never allowed to fail
    the request — a project somebody can see must not become a 500 over
    housekeeping — but a failure is logged rather than swallowed, because the
    thing it silently costs is a customer's footage.
  */
  try {
    await db.execute(
      sql`update projects set last_opened_at = now() where id = ${project.id} and user_id = ${userId}`,
    );
  } catch (error) {
    req.log?.warn(
      { err: error, projectId: project.id },
      "could not stamp last_opened_at; this project will age as if it had not been opened",
    );
  }

  const stalled = await stalledProjectIds(userId, [project.id]);
  res.json(
    GetProjectResponse.parse(serializeProject({ ...project, renderStalled: stalled.has(project.id) })),
  );
});

router.patch("/projects/:id", rateLimit(LIMITS.write), async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateProjectParams.safeParse({ id: raw });
  if (!params.success) {
    badRequest(res, params.error);
    return;
  }

  const parsed = UpdateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error);
    return;
  }

  // Storage keys come from the browser, so the server confirms they point
  // inside this user's folder for this project before recording them.
  for (const field of ["videoPath", "editedVideoPath", "thumbnailPath", "referenceVideoPath"] as const) {
    const value = parsed.data[field];
    if (typeof value === "string" && !isOwnedObjectPath(value, userId, params.data.id)) {
      res.status(400).json({ error: `${field} must be inside this project's own storage folder` });
      return;
    }
  }

  /*
    And then: is anything actually there?

    The loop above checks that the path is *ours*. Nothing checked that a file
    exists at it — so a project could be recorded `ready`, with a length and a
    shape the browser supplied, pointing at an upload that failed, a zero-byte
    object from a cancelled one, or a `.txt` renamed `.mp4`. The product then
    showed a finished project with a Generate button, and the first thing to
    discover the truth was the worker, minutes later, failing the render as
    ours.

    One HEAD per path that changed, and only for paths — the other fields are
    the browser's word and stay the browser's word, because the worker measures
    the file it downloads and writes the truth back over them.
  */
  for (const field of ["videoPath", "referenceVideoPath"] as const) {
    const value = parsed.data[field];
    if (typeof value !== "string") continue;
    const verdict = await checkUploadedObject(value);
    if (!verdict.ok) {
      res.status(400).json({ error: verdict.reason });
      return;
    }
  }

  // Matching a reference is what the paid plans are actually being bought for,
  // so the check is here rather than in the browser — where the pricing card is
  // drawn and where anyone can edit a request. Clearing it is always allowed:
  // nobody should be locked out of removing something after a downgrade.
  if (typeof parsed.data.referenceVideoPath === "string") {
    const [sub] = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.userId, userId))
      .limit(1);
    const planKey = planKeyFrom(sub?.plan);
    if (!PLAN_LIMITS[planKey].referenceStyle) {
      res.status(402).json({
        error:
          "Matching another video's look is part of the paid plans. Creator and up read your reference and edit to it.",
        requiresPlan: "creator",
        plan: planKey,
      });
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
    badRequest(res, params.error);
    return;
  }

  // Bytes before rows, and a refusal rather than a false confirmation.
  //
  // This used to delete the row first and then reclaim the storage best-effort,
  // discarding the answer — so a deployment with no service role key, or
  // Storage having a bad minute, returned 204 and told the customer their video
  // was gone while every byte of it stayed on our disks with nothing left
  // pointing at it. `account-deletion.ts` has refused in this exact situation
  // from the start, for the reason written there: a refusal can be acted on, a
  // false confirmation cannot. Deleting a project is the path people actually
  // use, and it was the one that lied.
  const [project] = await db
    .select({
      id: projectsTable.id,
      videoPath: projectsTable.videoPath,
      editedVideoPath: projectsTable.editedVideoPath,
      thumbnailPath: projectsTable.thumbnailPath,
      referenceVideoPath: projectsTable.referenceVideoPath,
    })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, params.data.id), eq(projectsTable.userId, userId)))
    .limit(1);

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // Whether this project has anything in the bucket to lose. A project that
  // was created and never uploaded to has nothing, so refusing to delete it
  // because the storage credentials are absent would be refusing to do
  // something that cannot go wrong.
  const holdsBytes = Boolean(
    project.videoPath ?? project.editedVideoPath ?? project.thumbnailPath ?? project.referenceVideoPath,
  );

  /*
    Stop the render first, before a byte is reclaimed.

    A render in flight is writing into the storage this is about to empty, and
    reading a project row that is about to go. Until this line, deleting a
    project left its job holding its lock, its slot in the account's
    concurrency cap and its place in the queue — encoding a video with nowhere
    to put it, failing at the upload, being retried twice more, and settling
    three attempts later as "Rendering failed. We are looking into it." against
    a project that no longer exists. Nothing reported it, because from every
    instrument's point of view a render ran and failed.

    Before the reclaim rather than after, so the worker's own upload cannot
    land between the sweep and the delete and leave an object with nothing
    pointing at it. A running job is asked rather than stopped — the worker is
    inside ffmpeg and reads the request at its next progress report — which is
    the one window this does not close, and it is seconds rather than hours.
  */
  await cancelRendersFor(userId, project.id);

  const reclaimed = await deleteProjectObjects(userId, project.id);
  if (!reclaimed.removed && holdsBytes) {
    res.status(503).json({ error: COULD_NOT_DELETE_STORAGE });
    return;
  }

  /*
    Every row this project owns, in one transaction.

    They were four separate awaits, and this runs on a platform that can end an
    invocation between any two of them — a function timeout, a deploy, an OOM.
    Every partial outcome is a state nothing reconciles and nothing reports: a
    project whose conversation is gone but whose exports remain, or whose rows
    all survive while its bytes do not, with a player that 404s and a person who
    can only press delete again and hope.

    One transaction removes every one of those states except the last, which is
    inherent: the bucket is not in the database, so "bytes gone, rows intact"
    stays reachable. That one is at least repairable by pressing delete again —
    the sweep finds nothing and the rows go — and it is the only remaining
    window rather than one of six.
  */
  const cancelled = await db.transaction(async (tx) => {
    // Nothing here has a foreign key — ownership is denormalised onto every row
    // so no query ever needs a join — which means nothing cascades and every
    // child has to be named. Until this was written, deleting a project deleted
    // one row: the conversation about a video the person had just removed stayed
    // in the database indefinitely, and nobody could see it happening.
    await tx
      .delete(messagesTable)
      .where(and(eq(messagesTable.projectId, project.id), eq(messagesTable.userId, userId)));
    await tx
      .delete(exportsTable)
      .where(and(eq(exportsTable.projectId, project.id), eq(exportsTable.userId, userId)));

  // Jobs deliberately survive.
  //
  // The meter sums `output_seconds` over finished jobs this month, so deleting
  // them here would make "delete your projects" a way to reset your allowance
  // and render for nothing — the same class of hole the render policy exists to
  // close. Minutes that were produced were produced; removing the project
  // afterwards does not un-produce them. The rows are orphaned by design and
  // are only ever read as a sum.

  /*
    Anything queued to go out is cancelled, and said out loud.

    `scheduled_posts` has no foreign key on `project_id` — deliberately, and
    the migration says why — so a delete left posts sitting at
    `status = 'scheduled'` pointing at a project and an export whose rows and
    bytes were both gone. Nothing failed: the delete returned 204. Days later
    the worker reached each post at its hour, could not resolve a file, and
    failed it, with no connection in the person's mind to the deletion.

    `DELETE /social/accounts/:id` already does exactly this and returns the
    count, on the argument that "silently dropping them would mean a person is
    never told". The same argument applies here and was not being made.

    Cancelled rather than deleted: the row is the record that something was
    going to be posted and now is not, and the reason is written on it.
  */
    const stopped = await tx
      .update(scheduledPostsTable)
      .set({
        status: "cancelled",
        error: "The project this was made from was deleted, so there was nothing left to post.",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(scheduledPostsTable.userId, userId),
          eq(scheduledPostsTable.projectId, project.id),
          eq(scheduledPostsTable.status, "scheduled"),
        ),
      )
      .returning({ id: scheduledPostsTable.id });

    await tx
      .delete(projectsTable)
      .where(and(eq(projectsTable.id, project.id), eq(projectsTable.userId, userId)));

    return stopped;
  });

  /*
    204 when nothing was queued, and a body when something was.

    A 204 that quietly cancelled three posts is the silence this change exists
    to remove, and a body on every delete would change a contract every caller
    already handles. So the shape follows the fact.
  */
  if (cancelled.length === 0) {
    res.sendStatus(204);
    return;
  }
  res.status(200).json({ deleted: true, cancelledPosts: cancelled.length });
});

export default router;
