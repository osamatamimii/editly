/**
 * A project's library — the files it can put on screen.
 *
 * The browser uploads straight to Storage with its own session, exactly as it
 * already does for the source video, and then tells us where it put it. That
 * means this endpoint's job is not to receive bytes; it is to **refuse to
 * believe** the two things a client should never be believed about:
 *
 *   1. **Where the file is.** A path is a claim. `isOwnedObjectPath` checks the
 *      claim against the signed-in user and the project in the URL, so
 *      "someone else's folder" and "../.." are not merely rejected, they are
 *      unspellable.
 *   2. **What the file is.** The `kind` sent from the browser is a hint. A file
 *      named `logo.png` that is really a four-gigabyte video turns an image
 *      overlay into an out-of-memory kill, so the worker re-derives the kind
 *      from the bytes before it composites anything.
 */
import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, assetsTable, projectsTable } from "@workspace/db";
import {
  ListAssetsParams,
  ListAssetsResponse,
  RegisterAssetParams,
  RegisterAssetBody,
  RegisterAssetResponse,
  DeleteAssetParams,
} from "@workspace/api-zod";
import { currentUserId } from "../middlewares/auth";
import { isOwnedObjectPath } from "../lib/storage";
import { rateLimit, LIMITS } from "../lib/rate-limit";

const router: IRouter = Router();

/**
 * How many files one project may hold. A library, not a backup drive.
 *
 * Exported because the upload route enforces the same number one step earlier,
 * before the bytes rather than after them, and two copies of it would mean an
 * upload authorised here and refused there.
 */
export const MAX_ASSETS_PER_PROJECT = 60;

function serialize(row: typeof assetsTable.$inferSelect): unknown {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    label: row.label,
    bytes: row.bytes,
    durationSeconds: row.durationSeconds,
    width: row.width,
    height: row.height,
    createdAt: row.createdAt.toISOString(),
    // The path is deliberately not returned. The browser already knows where it
    // put the file and can sign its own URL; echoing storage paths back turns
    // an enumeration bug in any future endpoint into a data leak.
    url: null,
  };
}

/** Does this project exist, and does it belong to the person asking? */
async function ownsProject(userId: string, projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)))
    .limit(1);
  return Boolean(row);
}

router.get("/projects/:id/assets", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const params = ListAssetsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!(await ownsProject(userId, params.data.id))) {
    // 404 rather than 403: whether a project id exists is not something a
    // stranger should be able to learn by watching status codes.
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const rows = await db
    .select()
    .from(assetsTable)
    .where(eq(assetsTable.projectId, params.data.id))
    .orderBy(desc(assetsTable.createdAt));

  res.json(ListAssetsResponse.parse(rows.map(serialize)));
});

router.post("/projects/:id/assets", rateLimit(LIMITS.write), async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const params = RegisterAssetParams.safeParse(req.params);
  const body = RegisterAssetBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: (params.success ? body : params).error!.message });
    return;
  }
  if (!(await ownsProject(userId, params.data.id))) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  // The one check that matters. Everything else here is bookkeeping.
  if (!isOwnedObjectPath(body.data.path, userId, params.data.id)) {
    res.status(400).json({ error: "That file is not in this project's folder." });
    return;
  }

  const existing = await db
    .select({ id: assetsTable.id })
    .from(assetsTable)
    .where(eq(assetsTable.projectId, params.data.id));
  if (existing.length >= MAX_ASSETS_PER_PROJECT) {
    res.status(409).json({
      error: `A project can hold ${MAX_ASSETS_PER_PROJECT} files. Remove one before adding another.`,
    });
    return;
  }

  // A retried upload registers the same object twice. The unique index on
  // `path` makes that a conflict rather than a duplicate; answering with the
  // row that is already there is what the caller wanted either way.
  const [row] = await db
    .insert(assetsTable)
    .values({
      id: randomUUID(),
      projectId: params.data.id,
      userId,
      path: body.data.path,
      kind: body.data.kind,
      label: body.data.label ?? null,
      bytes: body.data.bytes,
      durationSeconds: body.data.durationSeconds ?? null,
      width: body.data.width ?? null,
      height: body.data.height ?? null,
    })
    .onConflictDoUpdate({
      target: assetsTable.path,
      set: { label: body.data.label ?? null, bytes: body.data.bytes },
    })
    .returning();

  res.status(201).json(RegisterAssetResponse.parse(serialize(row!)));
});

router.delete("/projects/:id/assets/:assetId", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const params = DeleteAssetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Scoped by user *and* project *and* asset: an id guessed from another
  // account deletes nothing.
  const removed = await db
    .delete(assetsTable)
    .where(
      and(
        eq(assetsTable.id, params.data.assetId),
        eq(assetsTable.projectId, params.data.id),
        eq(assetsTable.userId, userId),
      ),
    )
    .returning({ id: assetsTable.id });

  if (removed.length === 0) {
    res.status(404).json({ error: "Asset not found." });
    return;
  }

  // The storage object is left alone on purpose: deleting the project removes
  // the whole folder in one call, and a per-asset delete that half-succeeds is
  // how you end up with a row pointing at nothing.
  res.status(204).end();
});

export default router;
