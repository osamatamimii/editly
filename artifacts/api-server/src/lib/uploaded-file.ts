/**
 * Is the thing the browser says it uploaded actually there?
 *
 * `PATCH /projects/:id` takes `videoPath`, `duration`, `width`, `height` and
 * `status` from the browser and writes them down. Every one of those is the
 * browser's word, and the server checked exactly one property of it: that the
 * path sits inside this user's own folder. Whether anything is *at* that path
 * was nobody's question.
 *
 * So a project could be marked `ready`, with a length and a shape, pointing at:
 *
 *   - an object that does not exist, because the upload failed and the browser
 *     recorded it anyway;
 *   - a zero-byte object, which is what a cancelled upload leaves behind;
 *   - a `.txt` renamed `.mp4`, or a PDF, or anything else.
 *
 * In every case the product shows a finished project with a thumbnail slot and
 * a Generate button, and the first thing that discovers the truth is the
 * worker, minutes later, with a customer watching a progress bar. The render
 * then fails as *ours* — "Rendering failed. We are looking into it." — for a
 * file that was never a video.
 *
 * ## What this can and cannot check
 *
 * It is one HEAD against the object store. That answers three questions
 * honestly — does it exist, does it have bytes, and what content type was it
 * stored with — and it cannot answer the fourth, which is whether the bytes
 * decode. There is no ffmpeg on this platform and there never will be: the API
 * runs as a serverless function with a bundle ceiling and a timeout measured in
 * seconds, which is the whole reason the worker exists.
 *
 * That is fine, because the two are different jobs. This is the cheap door
 * that stops a project being marked ready when there is nothing behind it; the
 * worker's `probeSource` is the real measurement, and it stays the authority
 * on length, shape and whether there is a picture at all.
 *
 * ## Why it never refuses on doubt
 *
 * A store that will not answer is not evidence. Returning "fine" when the HEAD
 * itself failed is deliberate: refusing somebody's upload because our metadata
 * call timed out would be a worse product than the one this replaces, and the
 * worker still checks the file it downloads.
 */
import { objectStoreFrom } from "@workspace/object-store";
import { UPLOAD_CONTENT_TYPES } from "@workspace/api-zod/limits";

export type UploadVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/** Content types this product ever stores, as a set for one lookup. */
const ACCEPTED = new Set<string>(UPLOAD_CONTENT_TYPES);

/**
 * What the store says is at this key.
 *
 * Never throws, and answers `{ ok: true }` whenever it cannot tell — see the
 * header. The reason strings are written for the person who uploaded the file.
 */
export async function checkUploadedObject(key: string): Promise<UploadVerdict> {
  let found: Awaited<ReturnType<ReturnType<typeof objectStoreFrom>["head"]>>;
  try {
    found = await objectStoreFrom().head(key);
  } catch {
    // The store did not answer. Not evidence of anything.
    return { ok: true };
  }

  if (!found) {
    return {
      ok: false,
      reason: "That upload did not finish: there is no file at that address yet. Try uploading it again.",
    };
  }
  if (found.bytes === 0) {
    return {
      ok: false,
      reason: "That upload arrived empty. It usually means it was interrupted; uploading it again fixes it.",
    };
  }

  /*
    The content type, only when the store recorded one.

    Supabase reports `application/octet-stream` for an object uploaded without
    a type, and R2 does the same — which is not a wrong file, it is a missing
    header. Refusing on it would refuse legitimate uploads from any client that
    forgets to set one, so an unknown type passes and a *known wrong* one does
    not.
  */
  const type = (found.contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (type && type !== "application/octet-stream" && !ACCEPTED.has(type)) {
    return {
      ok: false,
      reason: `That file is a ${type}, which is not something we can edit. Send a video, an image, or an audio file.`,
    };
  }

  return { ok: true };
}
