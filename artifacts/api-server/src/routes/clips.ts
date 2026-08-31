/**
 * The pieces clips renders have cut from this project's video.
 *
 * Nothing here registers or amends: clips are made by the worker. The one
 * client mutation is deleting a piece someone decided against keeping.
 *
 * Unlike the asset library, the storage path IS in the response. The rule
 * behind hiding asset paths was "the browser already knows where it put the
 * file, so echoing paths back only feeds a future enumeration bug" — but the
 * worker wrote these files, so the browser has no other way to learn where
 * they are, and the project row already returns `editedVideoPath` to its
 * verified owner on exactly this reasoning. Ownership is checked the same
 * way, and a wrong id gets the same 404 whether it exists or not.
 */
import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, count, desc, asc, eq } from "drizzle-orm";
import { db, clipsTable, projectsTable, subscriptionsTable } from "@workspace/db";
import {
  DeleteClipParams,
  GetProjectResponse,
  ListClipsParams,
  ListClipsResponse,
  PromoteClipParams,
} from "@workspace/api-zod";
import { currentUserId } from "../middlewares/auth";
import { copyObject, deleteObjects, storageAdminConfigured } from "../lib/storage";
import { serializeProject } from "../lib/transformers";
import { rateLimit, LIMITS } from "../lib/rate-limit";
import { planKeyFrom } from "../lib/plan-limits";
import { usageFor, exhaustedMessage } from "../lib/usage";
import { decideRender } from "../lib/render-policy";

const router: IRouter = Router();

function serialize(row: typeof clipsTable.$inferSelect): unknown {
  return {
    id: row.id,
    projectId: row.projectId,
    jobId: row.jobId,
    idx: row.idx,
    startSeconds: row.startSeconds,
    endSeconds: row.endSeconds,
    outputPath: row.outputPath,
    outputSeconds: row.outputSeconds,
    note: row.note,
    title: row.title,
    thumbnailPath: row.thumbnailPath,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Every clip this person owns, newest first.
 *
 * The per-project route below is what an editor asks — "what came out of
 * *this* take". This is what a clipper asks, which is a different question:
 * "what have I got to post". Somebody recording a weekly show has clips in
 * eleven projects and no way to see them as one library, so the output of the
 * thing they use this product for is scattered across the screens they used to
 * make it.
 *
 * The project's title travels with each row. A list of clips titled by what
 * was said in them, with no way to tell which recording each came out of, is a
 * pile rather than a library.
 */
/**
 * How many tiles the library sends at once.
 *
 * Every one of them signs a storage URL and draws a video element, and nobody
 * scrolls a thousand. The number is here rather than inline so the page can be
 * told what it is, which is the difference between a cap and a truncation.
 */
const LIBRARY_LIMIT = 200;

router.get("/clips", async (req, res): Promise<void> => {
  const userId = currentUserId(req);

  const rows = await db
    .select({
      clip: clipsTable,
      projectTitle: projectsTable.title,
    })
    .from(clipsTable)
    .innerJoin(projectsTable, eq(clipsTable.projectId, projectsTable.id))
    // Both, and not because one implies the other. The join is on the project
    // id alone, so without this a clip could be read through somebody else's
    // project row if a project id were ever reused.
    .where(and(eq(clipsTable.userId, userId), eq(projectsTable.userId, userId)))
    .orderBy(desc(clipsTable.createdAt), asc(clipsTable.idx))
    .limit(LIBRARY_LIMIT);

  /*
    And how many there are, which is not always how many were sent.

    The cap is right — nobody scrolls a thousand tiles, and every one of them
    signs a URL. What was wrong is that the cap said nothing: an account with
    three hundred clips got the newest two hundred and no sign that the rest
    existed, on the screen whose whole job is "what have I got to post". A
    library that quietly stops is worse than one that says where it stops.

    Counted rather than inferred from the length, because `rows.length === 200`
    is also what an account with exactly two hundred clips looks like.
  */
  const [counted] = await db
    .select({ n: count() })
    .from(clipsTable)
    .innerJoin(projectsTable, eq(clipsTable.projectId, projectsTable.id))
    .where(and(eq(clipsTable.userId, userId), eq(projectsTable.userId, userId)));

  res.json({
    clips: rows.map((row) => ({
      ...(serialize(row.clip) as Record<string, unknown>),
      projectTitle: row.projectTitle,
    })),
    total: Number(counted?.n ?? rows.length),
  });
});

router.get("/projects/:id/clips", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const params = ListClipsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [project] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, params.data.id), eq(projectsTable.userId, userId)))
    .limit(1);
  if (!project) {
    // 404 rather than 403: whether a project id exists is not something a
    // stranger should be able to learn by watching status codes.
    res.status(404).json({ error: "Project not found." });
    return;
  }

  // Newest set first, source order within a set. The user filter is belt to
  // the ownership check's braces: a clip row must match both the project in
  // the URL and the person asking.
  const rows = await db
    .select()
    .from(clipsTable)
    .where(and(eq(clipsTable.projectId, params.data.id), eq(clipsTable.userId, userId)))
    .orderBy(desc(clipsTable.createdAt), asc(clipsTable.idx))
    .limit(60);

  res.json(ListClipsResponse.parse(rows.map(serialize)));
});

/**
 * Deleting a clip is row-first, storage-best-effort — the asset route's
 * reasoning, inherited: a half-succeeded per-file delete must never leave a
 * row pointing at nothing, because a row with no file is a broken player,
 * while a file with no row is invisible bytes that the project's own deletion
 * sweeps later. The attempt is still made immediately — clips are whole
 * videos, and "reclaimed eventually" should be the fallback, not the plan.
 */
router.delete("/projects/:id/clips/:clipId", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const params = DeleteClipParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Scoped by user *and* project *and* clip: an id guessed from another
  // account deletes nothing, and gets the same 404 as an id that never was.
  const removed = await db
    .delete(clipsTable)
    .where(
      and(
        eq(clipsTable.id, params.data.clipId),
        eq(clipsTable.projectId, params.data.id),
        eq(clipsTable.userId, userId),
      ),
    )
    .returning({ outputPath: clipsTable.outputPath });

  if (removed.length === 0) {
    res.status(404).json({ error: "Clip not found." });
    return;
  }

  // The master and its VP9 mirror, by the same naming convention the worker
  // wrote them under. Best-effort: a failure here leaves orphan bytes that
  // deleting the project reclaims, not a lie in the response.
  const master = removed[0].outputPath;
  const stem = master.replace(/\.mp4$/i, "");
  void deleteObjects([master, `${stem}.preview.webm`, `${stem}.jpg`]);

  res.status(204).end();
});

/**
 * Opening a clip as a project of its own.
 *
 * Until now a clip was a dead end: play it, download it, delete it. But a
 * clip is a video, and everything this product does it does to a video — so
 * the piece the worker chose should be able to become the thing being
 * edited, captioned, reframed and rendered.
 *
 * The bytes are copied, never shared. Pointing the new project's row at the
 * clip's existing key would be one line shorter and would mean two projects
 * owning one file: deleting either would break the other, and the bug would
 * surface weeks later as "my video disappeared". Every object in this bucket
 * belongs to exactly one "<userId>/<projectId>/" prefix, and that invariant
 * is what makes deleting a project mean deleting its bytes and nobody else's.
 *
 * Order is row-then-bytes, the inverse of deletion, and for the same reason
 * read the other way round: bytes written under a project id that has no row
 * are invisible and unreclaimable, while a row whose copy failed is something
 * we can — and do — take back before answering.
 */
router.post("/projects/:id/clips/:clipId/open", rateLimit(LIMITS.createProject), async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const params = PromoteClipParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Refused rather than half-done: without the service role key the copy
  // cannot happen, and a project row whose video is not there would be a
  // worse answer than "not on this deployment".
  if (!storageAdminConfigured) {
    res.status(503).json({ error: "This deployment cannot copy stored video, so a clip cannot be opened on its own." });
    return;
  }

  /*
   * The same two questions `POST /projects` asks, asked here for the same
   * reasons, because this is the same act under another name.
   *
   * This endpoint had neither. It creates a project row and copies a video
   * file, and it was the only path in the product that could do both without
   * being counted or refused: a suspended account could keep making projects
   * through it, and a loop over a render's clips could mint one project and one
   * stored copy per call, indefinitely, on a free plan. `POST /projects` is
   * rate-limited and refuses an exhausted allowance; this was reachable by
   * anyone who had ever run a clips render.
   *
   * It shares `LIMITS.createProject` rather than getting a window of its own,
   * deliberately: a budget per endpoint is not a budget, because the loop just
   * alternates between them. One name, one window, both doors.
   *
   * Order matters. Both checks happen before the row is written and before a
   * byte is copied, so a refusal leaves nothing behind to take back.
   */
  const [sub] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);
  const planKey = planKeyFrom(sub?.plan);

  if (sub?.suspendedAt) {
    const stopped = decideRender({
      plan: planKey,
      usage: { minutesUsed: 0, minutesIncluded: 0, minutesGranted: 0, minutesRemaining: 0, exhausted: false },
      operations: [],
      suspendedAt: sub.suspendedAt,
    });
    if (!stopped.allowed) {
      res.status(stopped.status).json(stopped.body);
      return;
    }
  }

  // Same reasoning as project creation: the meter is minutes of finished
  // video, so an exhausted allowance is refused at the door rather than
  // charged for. Unlike creating an empty project, this one also costs
  // storage, which is the second reason it cannot be the one hole in the fence.
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

  const [clip] = await db
    .select()
    .from(clipsTable)
    .where(
      and(
        eq(clipsTable.id, params.data.clipId),
        eq(clipsTable.projectId, params.data.id),
        eq(clipsTable.userId, userId),
      ),
    )
    .limit(1);
  if (!clip) {
    res.status(404).json({ error: "Clip not found." });
    return;
  }

  // The parent is read for what the clip cannot know about itself: the frame
  // it was rendered at, and the name it should be recognisable by.
  const [parent] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, params.data.id), eq(projectsTable.userId, userId)))
    .limit(1);
  if (!parent) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  // The clip's own words when it has them, its position when it does not —
  // never a title nobody said. Trimmed to something that fits a project card.
  const title = (clip.title?.trim() ? `${clip.title.trim()}` : `${parent.title} - clip ${clip.idx}`).slice(0, 120);

  const id = randomUUID();
  const destination = `${userId}/${id}/source.mp4`;
  const [project] = await db
    .insert(projectsTable)
    .values({
      id,
      userId,
      title,
      // "uploading" until the bytes are actually there, which is what the
      // word means everywhere else in this product.
      status: "uploading",
      duration: clip.outputSeconds,
      // The clip came out of a render, so the render's frame is its frame.
      width: parent.editedWidth ?? parent.width,
      height: parent.editedHeight ?? parent.height,
      platform: parent.platform,
    })
    .returning();

  const copied = await copyObject(clip.outputPath, destination);
  if (!copied.copied) {
    // Take the row back rather than leave a project that cannot play. No clip
    // or job points at it yet, so this deletes cleanly.
    await db.delete(projectsTable).where(eq(projectsTable.id, id));
    res.status(503).json({ error: "The clip could not be copied into a new project. Nothing was changed." });
    return;
  }

  // The VP9 mirror, on the same naming convention the player already looks
  // for. Best-effort on purpose: without it a browser that cannot decode
  // H.264 loses the preview, which is a smaller loss than refusing the whole
  // thing over a file that is itself only a fallback.
  const clipStem = clip.outputPath.replace(/\.mp4$/i, "");
  void copyObject(`${clipStem}.preview.webm`, `${userId}/${id}/source.preview.webm`);

  /**
   * The clip's own still becomes the new project's poster, so its card on the
   * dashboard shows the piece rather than a grey box until a browser happens to
   * open it and make one.
   *
   * **Awaited, unlike the mirror above.** Nothing in any row names the `.webm`
   * — the player derives that name by convention and falls back when it is not
   * there — so starting it and moving on costs nothing. This path is different:
   * it is written into `projects.thumbnail_path`, and the row was being written
   * before the copy had happened and whether or not it succeeded. A row that
   * names a file which is not there is a card with a broken image on it and
   * nothing anywhere that would notice.
   *
   * A poster is a nicety, so a failed copy leaves the column null and the
   * project opens anyway. What it must never do is claim one.
   */
  const poster = clip.thumbnailPath ? `${userId}/${id}/thumb.jpg` : null;
  const posterLanded = clip.thumbnailPath
    ? (await copyObject(clip.thumbnailPath, poster as string)).copied
    : false;

  const [ready] = await db
    .update(projectsTable)
    .set({
      videoPath: destination,
      thumbnailPath: posterLanded ? poster : null,
      status: "ready",
      updatedAt: new Date(),
    })
    .where(eq(projectsTable.id, id))
    .returning();

  res.status(201).json(GetProjectResponse.parse(serializeProject({ ...(ready ?? project), renderStalled: false })));
});

export default router;
