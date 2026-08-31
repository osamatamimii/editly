/**
 * The fonts a person brought themselves.
 *
 * Three endpoints and none of them touches a font file. The browser uploads
 * straight to Storage with its own session — the same way it already does for
 * video, images and audio — and then tells us where it put it. So what this
 * router does is refuse to believe the two claims a client must never be
 * believed about:
 *
 *   1. **Where the file is.** `isOwnedFontPath` checks the path against the
 *      signed-in user, so "somebody else's folder" is not merely rejected, it
 *      is unspellable.
 *   2. **What the file is.** Nothing here opens it. Whether those bytes are a
 *      font, whether it draws anything, and what its three numbers are, is
 *      decided by rendering with it on the machine that will burn with it —
 *      see `artifacts/worker/src/font-intake.ts`. A serverless function has no
 *      libass and could only guess.
 *
 * Which is why a face arrives `pending` and becomes usable a few seconds
 * later. The row is the queue; the worker sweeps it beside its render loop.
 */
import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, captionFacesTable } from "@workspace/db";
import { RegisterFaceBody, DeleteFaceParams } from "@workspace/api-zod";
import { currentUserId } from "../middlewares/auth";
import { isOwnedFontPath } from "../lib/storage";
import { rateLimit, LIMITS } from "../lib/rate-limit";

const router: IRouter = Router();

/**
 * How many fonts one person may keep.
 *
 * A brand has a typeface, maybe three. This is a picker, and a picker with
 * forty entries is a search problem rather than a choice — and every one of
 * them is a file a render may have to fetch.
 *
 * Exported because the upload route enforces the same number one step earlier,
 * before the bytes rather than after them.
 */
export const MAX_FACES = 24;

function serialize(row: typeof captionFacesTable.$inferSelect, language: string) {
  return {
    id: row.id,
    label: row.label,
    declared: row.declared,
    script: row.script,
    status: row.status,
    capRatio: row.capRatio,
    widthScale: row.widthScale,
    // The preview path *is* returned, unlike an asset's. The browser has to
    // fetch it to draw the sample, it is the person's own object, and they
    // signed the upload themselves — there is nothing here they do not know.
    previewPath: row.previewPath,
    // One string, already in the reader's language. The row keeps both so that
    // changing language does not change what a refusal says it was.
    refusal: language === "ar" ? row.refusalAr : row.refusalEn,
    bytes: row.bytes,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Which language a refusal should come back in. */
function languageOf(req: { headers: Record<string, unknown> }): string {
  const header = String(req.headers["accept-language"] ?? "");
  return /(^|,)\s*ar\b/i.test(header) ? "ar" : "en";
}

router.get("/fonts", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const rows = await db
    .select()
    .from(captionFacesTable)
    .where(eq(captionFacesTable.userId, userId))
    .orderBy(desc(captionFacesTable.createdAt));
  res.json({ faces: rows.map((row) => serialize(row, languageOf(req))) });
});

router.post("/fonts", rateLimit(LIMITS.registerFont), async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const body = RegisterFaceBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  if (!isOwnedFontPath(body.data.path, userId)) {
    // Not "forbidden": the shape of a path somebody else could own is not
    // something to be learned from an error message.
    res.status(400).json({ error: "That is not a path this account can write to." });
    return;
  }

  const mine = await db
    .select({ id: captionFacesTable.id, path: captionFacesTable.sourcePath })
    .from(captionFacesTable)
    .where(eq(captionFacesTable.userId, userId));

  const already = mine.find((row) => row.path === body.data.path);
  if (already) {
    // The same file uploaded twice is one face. Pressing the button again
    // after a slow response should not produce two identical picker entries.
    const [row] = await db
      .select()
      .from(captionFacesTable)
      .where(eq(captionFacesTable.id, already.id))
      .limit(1);
    res.status(200).json(serialize(row!, languageOf(req)));
    return;
  }

  if (mine.length >= MAX_FACES) {
    res.status(409).json({
      error: `You can keep ${MAX_FACES} fonts. Remove one to add another.`,
    });
    return;
  }

  const id = randomUUID();
  const [row] = await db
    .insert(captionFacesTable)
    .values({
      id,
      userId,
      label: body.data.label,
      script: body.data.script,
      sourcePath: body.data.path,
      bytes: body.data.bytes,
      rights: body.data.rights,
      status: "pending",
    })
    .returning();

  // 202, not 201. The row exists; the font is not usable yet, and a status
  // that says "created" would be describing something that has not finished.
  res.status(202).json(serialize(row!, languageOf(req)));
});

router.delete("/fonts/:id", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const params = DeleteFaceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const deleted = await db
    .delete(captionFacesTable)
    .where(and(eq(captionFacesTable.id, params.data.id), eq(captionFacesTable.userId, userId)))
    .returning({ id: captionFacesTable.id });

  if (deleted.length === 0) {
    res.status(404).json({ error: "Font not found." });
    return;
  }
  /*
    The row goes; the objects stay until the storage sweep takes them.

    Deleting them here would mean three calls that can each fail halfway, on a
    path a person triggers by pressing a small × — and an edit already rendered
    with this face is not re-rendered, so nothing is served from these bytes
    after the row is gone. A file nobody references costs a few hundred
    kilobytes; a half-deleted face costs a picker entry that cannot be removed.
  */
  res.status(204).end();
});

export default router;
