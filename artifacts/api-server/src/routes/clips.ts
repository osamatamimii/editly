/**
 * The pieces clips renders have cut from this project's video.
 *
 * Read-only on purpose: clips are made by the worker and die with the
 * project. There is nothing for a client to register or amend — the one
 * honest mutation, "delete this clip", can arrive when someone asks for it,
 * with the storage sweep that must ride along.
 *
 * Unlike the asset library, the storage path IS in the response. The rule
 * behind hiding asset paths was "the browser already knows where it put the
 * file, so echoing paths back only feeds a future enumeration bug" — but the
 * worker wrote these files, so the browser has no other way to learn where
 * they are, and the project row already returns `editedVideoPath` to its
 * verified owner on exactly this reasoning. Ownership is checked the same
 * way, and a wrong id gets the same 404 whether it exists or not.
 */
import { Router, type IRouter } from "express";
import { and, desc, asc, eq } from "drizzle-orm";
import { db, clipsTable, projectsTable } from "@workspace/db";
import { ListClipsParams, ListClipsResponse } from "@workspace/api-zod";
import { currentUserId } from "../middlewares/auth";

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
    createdAt: row.createdAt.toISOString(),
  };
}

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

export default router;
