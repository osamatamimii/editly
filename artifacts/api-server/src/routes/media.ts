/**
 * Permission to look at one object, which is the half of the storage seam that
 * was never built.
 *
 * `uploads.ts` exists so that the browser asks us before it writes: we choose
 * the key, we check the type and the size, and we hand back a URL our own
 * server signed. The whole point of it was that changing storage provider
 * becomes a variable rather than a rewrite.
 *
 * Reading stayed where it always was. `video-storage.ts` in the browser called
 * `supabase.storage.from(VIDEOS_BUCKET).createSignedUrl(path)` — the Supabase
 * client, the Supabase bucket, the Supabase signature — for the poster on a
 * card, the source in the player, the finished render, and the download
 * button. On Supabase that was correct and invisible. On R2 it is a request to
 * a store the object is not in: Supabase answers "not found", the helper
 * returns `null`, and the screen shows nothing at all.
 *
 * What that looks like to a person is the thing worth writing down. The upload
 * finishes. The project row is right — path, width, height, duration, poster
 * key, all of it. Every log says success. And the card has no picture, the
 * player has no video, and the download button does nothing. Nothing failed,
 * so nothing is reported, and the first guess is always that the upload is
 * broken, because that is the step you just watched.
 *
 * The browser cannot be taught to sign a read itself, and should not be: S3
 * covers the entire query string in its signature while Supabase mints a token
 * for the object alone, so "how do I sign a read" has two answers that share
 * no shape. It is the same reason the write moved. So the browser stops
 * choosing and asks here.
 *
 * ## What is checked
 *
 * One thing, and it is the only one that matters: the key is inside the asking
 * account's own folder. Every key this product mints begins with the verified
 * user id — `<user>/<project>/source.mp4`, `<user>/fonts/<id>.woff2` — so
 * ownership is readable from the key itself, and `isOwnedObjectPrefix` is the
 * check that reads it. A path that is not theirs is a 404 rather than a 403,
 * for the reason every other door here gives: whether an object exists is not
 * something to learn from a status code.
 *
 * Deliberately *not* checked: whether the object is there. A signed URL for a
 * key with nothing behind it is a 404 from the store, which is the truth and
 * costs no round trip here. Asking first would double the latency of every
 * poster on a dashboard to convert one error into a different error.
 */
import { Router, type IRouter } from "express";
import { ReadUrlBody } from "@workspace/api-zod/uploads";
import { objectStoreFrom } from "@workspace/object-store";
import { currentUserId } from "../middlewares/auth";
import { logger } from "../lib/logger";
import { rateLimit, LIMITS } from "../lib/rate-limit";
import { isOwnedObjectPrefix } from "../lib/storage";

const router: IRouter = Router();

/**
 * How long a read URL is good for.
 *
 * An hour, which is the number the browser already assumed — `RESIGN_EVERY_MS`
 * in `video-storage.ts` mints a fresh one every forty-five minutes precisely so
 * that a player never reaches the end of one. Changing it here without changing
 * that would be a video that stops mid-watch, so the two are named to each
 * other rather than merely equal.
 */
const READ_TTL_SECONDS = 3600;

router.post("/media/url", rateLimit(LIMITS.read), async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const body = ReadUrlBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "That request could not be read." });
    return;
  }
  const { path, download } = body.data;

  if (!isOwnedObjectPrefix(path, userId)) {
    logger.warn({ userId, reason: "not-your-object" }, "refused a read url");
    res.status(404).json({ error: "Not found." });
    return;
  }

  let url: string | null;
  try {
    url = await objectStoreFrom().signedGet(path, READ_TTL_SECONDS, download ? { download } : undefined);
  } catch (error) {
    // Half-configured storage is a deployment fault, not the person's, and it
    // gets the same 503 the upload door gives it for the same reason: a 404
    // here would tell somebody their video is gone.
    logger.error({ err: error, userId }, "cannot sign a read");
    res.status(503).json({ error: "That file cannot be reached right now. Nothing has been lost, try again shortly." });
    return;
  }

  if (!url) {
    logger.error({ userId }, "storage would not sign a read");
    res.status(503).json({ error: "That file cannot be reached right now. Nothing has been lost, try again shortly." });
    return;
  }

  res.json({ url, expiresAt: new Date(Date.now() + READ_TTL_SECONDS * 1000).toISOString() });
});

export default router;
