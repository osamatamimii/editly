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
 *
 * `multipart` is that provider, arrived: on R2 a large file is cut into parts
 * and each part gets its own signed URL, so a dropped connection costs one part
 * instead of the file and nothing of the person's session leaves for the
 * storage host. The driver could always do it — `beginMultipart`, `signPart`,
 * `completeMultipart` and `abortMultipart` have been in `lib/object-store`
 * since R2 was added — and no route asked, so every large upload to R2 went as
 * one request that started again from zero. A three-gigabyte source is forty
 * minutes of that.
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

/**
 * One part of a large file, and where it goes.
 *
 * The URL is signed the same way the single PUT is — it carries the part
 * number and the upload id, and no credential of ours.
 */
export const SignedUploadPart = z.object({
  /** One-based, and the order the provider assembles them in. */
  partNumber: z.number().int().positive(),
  url: z.string(),
});
export type SignedUploadPart = z.infer<typeof SignedUploadPart>;

/**
 * A file cut into parts, each with its own signed URL.
 *
 * This is what `resumable` above was a substitute for. Supabase's tus endpoint
 * exists because its multipart upload cannot be signed per part; S3's can, so
 * on R2 a large file goes up as a hundred independent PUTs that our server
 * authorised in one decision — a dropped connection costs one part rather than
 * the whole transfer, and no session token ever leaves for the storage host.
 *
 * The completion is deliberately *not* a URL in here. Assembling the parts is a
 * signed POST carrying an XML document of every part's ETag, and a browser that
 * could mint it could also assemble somebody else's upload. So the browser
 * reports the ETags to `POST /api/uploads/complete` and our server does the
 * assembling — which is also the moment the object exists, so it is the right
 * place to be sure the key belonged to the person all along.
 */
export const MultipartTransfer = z.object({
  mode: z.literal("multipart"),
  /** The provider's handle for this upload, echoed back on complete and abort. */
  uploadId: z.string(),
  /** How many bytes go in every part but the last. The browser slices on it. */
  partBytes: z.number().int().positive(),
  parts: z.array(SignedUploadPart).min(2).max(10_000),
});
export type MultipartTransfer = z.infer<typeof MultipartTransfer>;

/** What the browser reports once every part has landed. */
export const CompleteUploadBody = z.object({
  path: z.string().min(1).max(500),
  uploadId: z.string().min(1).max(500),
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().positive(),
        /**
         * As the provider returned it on that part's response.
         *
         * The browser can only read this header if the bucket exposes it —
         * `ExposeHeaders: ["etag"]` in the CORS policy. A bucket that does not
         * is the one configuration mistake that lets every part succeed and
         * the assembly fail, so the route says exactly that rather than
         * repeating the provider's own sentence about a malformed request.
         */
        etag: z.string().min(1).max(200),
      }),
    )
    .min(1)
    .max(10_000),
});
export type CompleteUploadBody = z.infer<typeof CompleteUploadBody>;

/**
 * Permission to *read* one object, which is the other half of this file.
 *
 * The write half moved to signed tickets so that changing storage provider
 * would be a variable rather than a rewrite. The read half did not, and the
 * cost of that was exact: the browser went on asking Supabase for a playback
 * URL with `supabase.storage.createSignedUrl`, so on R2 every upload succeeded
 * and then nothing could be seen. No poster, no player, no download — the
 * project row correct, the object present, and `null` where the URL goes.
 *
 * There is nothing provider-specific a browser can be taught here, because the
 * two stores sign reads in genuinely different ways — S3 covers the whole
 * query string and Supabase mints a token for the object alone. So the browser
 * stops choosing and asks us, exactly as it now does to upload.
 */
export const ReadUrlBody = z.object({
  /** The object's key, which the browser was given when it wrote it. */
  path: z.string().min(1).max(500),
  /**
   * The name to save it as, when this is a download rather than playback.
   *
   * Its presence is what makes the difference: with it the store is asked to
   * answer `Content-Disposition: attachment`, and that decision is baked into
   * the signature, so it cannot be added to a URL afterwards.
   */
  download: z.string().min(1).max(200).optional(),
});
export type ReadUrlBody = z.infer<typeof ReadUrlBody>;

/** Giving up on one, so the provider stops holding its parts. */
export const AbortUploadBody = z.object({
  path: z.string().min(1).max(500),
  uploadId: z.string().min(1).max(500),
});
export type AbortUploadBody = z.infer<typeof AbortUploadBody>;

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
  transfer: z.discriminatedUnion("mode", [SignedTransfer, ResumableTransfer, MultipartTransfer]),
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
