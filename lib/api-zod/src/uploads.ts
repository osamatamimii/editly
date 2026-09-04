/**
 * Asking our own API for permission to upload, and what it answers.
 *
 * Until this existed the browser uploaded straight into Storage carrying the
 * signed-in user's JWT, and the permission to write was a row-level policy
 * inside Supabase. That works, and it has two costs that were paid twice each.
 *
 * The first is a migration cost: R2 has no RLS, no JWT and no row policies, so
 * there is no equivalent of that arrangement anywhere else. The only portable
 * form of "you may write this object" is a URL our own server signs. Until the
 * API mints one, changing storage provider is a rewrite rather than a variable.
 *
 * The second is paid every day. A refusal from Storage arrives at a browser on
 * a request our server never saw: the bucket refuses `image/png`, or a file
 * five megabytes over a ceiling nobody here can read, and the person gets a 400
 * with no sentence while every log we own stays silent. Two of the worst bugs
 * this product has had were exactly that shape.
 *
 * So the browser now asks first. It says what it is about to send; the server
 * decides **where it goes and whether it may go at all**, and the two claims a
 * client must never be believed about are no longer even asked for:
 *
 *   - **Where.** The key is not in the request. It is built here from the
 *     verified user id, so somebody else's folder is unspellable rather than
 *     merely rejected.
 *   - **What.** The content type is derived from the filename by the one table
 *     in `limits.ts`, not taken from `file.type`, because browsers disagree
 *     about fonts and several audio formats and a type that works on one
 *     machine and 400s on another is the same silent failure in a hat.
 *
 * ## Two transfer modes, and why the second one is not a cop-out
 *
 * `signed` is the point of all this: a URL our server minted, which the browser
 * PUTs the bytes to and which carries no credential of ours.
 *
 * `resumable` exists because Supabase's resumable endpoint speaks tus and has
 * no signed form: there is one way to upload a large file to it and it is with
 * the user's own session. Refusing to use it would mean every upload over six
 * megabytes becomes a single request that starts again from zero when a train
 * goes into a tunnel, which is how an upload fails three times and the person
 * leaves. So the transfer stays as it was and *the decision does not*: the key,
 * the type and the ceiling are still settled and logged here before a byte
 * moves. On a provider whose multipart upload can be signed per part, this mode
 * is simply never chosen, and nothing on either side has to change for that.
 */
import { z } from "zod";

/**
 * What an upload is for.
 *
 * Not a free-form path and not a "kind": the purpose is what decides the key,
 * the ceiling and which content types are acceptable, and those three answers
 * differ per purpose in ways no single rule covers. A reference clip is capped
 * far below the bucket because only its first two minutes are ever read; a
 * poster frame is a JPEG this product wrote itself; a font belongs to the
 * person rather than to a project.
 */
export const UPLOAD_PURPOSES = ["source", "asset", "reference", "thumbnail", "font"] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

export const UploadTicketBody = z.object({
  purpose: z.enum(UPLOAD_PURPOSES),
  /**
   * The name of the file on the person's machine, which decides the content
   * type and the extension and nothing else.
   *
   * It never becomes part of the key. A filename is the one part of an upload
   * an attacker controls completely, and the leaf is generated here instead.
   */
  filename: z.string().min(1).max(255),
  /** What the browser is about to send, checked against the ceiling before signing. */
  bytes: z.number().int().positive(),
  /**
   * Which project, for the four purposes that live inside one.
   *
   * Optional in the shape and required by the purpose: a font has no project,
   * and a schema that demanded one would make the caller invent a value.
   */
  projectId: z.string().min(1).max(100).optional(),
});
export type UploadTicketBody = z.infer<typeof UploadTicketBody>;

/** A URL our server signed. The browser sends the bytes and no credential of ours. */
export const SignedTransfer = z.object({
  mode: z.literal("signed"),
  url: z.string(),
  /** Supabase writes an object with POST and S3 with PUT, so the verb is part of the address. */
  method: z.enum(["PUT", "POST"]),
  headers: z.record(z.string()),
});
export type SignedTransfer = z.infer<typeof SignedTransfer>;

/** The tus endpoint, for a file large enough to be worth resuming. */
export const ResumableTransfer = z.object({
  mode: z.literal("resumable"),
  url: z.string(),
  headers: z.record(z.string()),
  /**
   * What the create request must carry, already decided here.
   *
   * The browser base64s these into `upload-metadata` and sends them; it does
   * not choose them. The bucket compares `contentType` against its allow-list
   * and refuses a miss mid-upload, on a file somebody has already spent
   * minutes sending.
   */
  metadata: z.record(z.string()),
});
export type ResumableTransfer = z.infer<typeof ResumableTransfer>;

export const UploadTicket = z.object({
  /** The storage key, chosen here. What the browser reports back once the bytes land. */
  path: z.string(),
  contentType: z.string(),
  /**
   * The ceiling this ticket was measured against, said back out loud.
   *
   * So the screen can name a real number instead of a build-time constant that
   * was right last quarter.
   */
  maxBytes: z.number().int().positive(),
  /**
   * When this ticket stops working — on the tickets that have such a moment.
   *
   * A signed PUT really does expire, and the signature carries the deadline.
   * A resumable upload does not: the tus endpoint takes the user's own bearer
   * token and `x-upsert`, and nothing about it goes stale on a clock. This
   * field was written on both, computed the same way, and on the resumable
   * branch it was simply a sentence about a deadline that does not exist —
   * true-looking, unread, and exactly the kind of thing somebody builds a
   * countdown out of two years later.
   *
   * Absent means there is nothing to expire.
   */
  expiresAt: z.string().optional(),
  transfer: z.discriminatedUnion("mode", [SignedTransfer, ResumableTransfer]),
});
export type UploadTicket = z.infer<typeof UploadTicket>;

/**
 * Bytes as a person reads them.
 *
 * Here rather than in the browser because the sentence that names a ceiling is
 * now written on the server, and the same file printing two different sizes on
 * the two sides of one refusal is the kind of small wrongness that makes a
 * person distrust the number entirely.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
