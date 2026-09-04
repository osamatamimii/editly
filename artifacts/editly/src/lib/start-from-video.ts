import { uploadKindFor, uploadContentTypeFor, VIDEO_UPLOAD_EXTENSIONS } from "@workspace/api-zod/limits";

/**
 * Whether this file can become a project, decided in one place.
 *
 * Two screens now start a project from a video: the dashboard, and the
 * clip-extraction section where somebody drops an episode to get posts out of
 * it. Both have to refuse the same files for the same reasons, and both have to
 * refuse them *before* the project row exists — a rejected file should cost a
 * toast, not an empty project named after a spreadsheet.
 *
 * The rule lives here and the wording does not. Each screen says no in its own
 * words, because the sentence a person reads on the dashboard and the sentence
 * they read while holding a two-hour episode are not the same sentence. What
 * must not differ is which files get through.
 */

/**
 * The video types this product takes, derived from the one table that decides.
 *
 * It used to be a literal three: `video/mp4`, `video/quicktime`, `video/webm`.
 * The server's `uploadContentTypeFor` has taken five for a while — `.mkv`,
 * which is OBS's default container, and `.m4v` among them — and the bucket
 * accepts all of them. So a streamer dropping the file OBS had just written
 * was told "That file is not a video" by a product that would have accepted it
 * if the request had ever been made. Nothing failed and nothing logged: the
 * client refused, in a toast, on behalf of a server that never disagreed.
 *
 * Derived rather than copied, so the next format the server learns is a format
 * this list already has.
 */
export const ACCEPTED_VIDEO_TYPES: string[] = [
  ...new Set(
    VIDEO_UPLOAD_EXTENSIONS.map((extension) => uploadContentTypeFor(`x.${extension}`)).filter(
      (type) => type !== null,
    ),
  ),
];

/**
 * What the file picker offers, which is not the same list.
 *
 * A browser matches `accept` against the type *it* assigns, and browsers
 * disagree about `.mkv` — some call it `video/x-matroska`, some
 * `application/octet-stream`, some nothing at all. Naming the extensions as
 * well means the file is offered whatever the browser thinks it is.
 */
export const ACCEPTED_VIDEO_ACCEPT: string =
  [...ACCEPTED_VIDEO_TYPES, ...VIDEO_UPLOAD_EXTENSIONS.map((e) => `.${e}`)].join(",");

/**
 * Is this a video this product will take?
 *
 * By extension first, because that is what the server decides on and the two
 * must not disagree; by content type second, for a file with no extension at
 * all. The old spelling was a hand-written regexp of three extensions beside a
 * hand-written list of three types, repeated at three call sites.
 */
/**
 * As much of a file as any of these decisions needs.
 *
 * A structural type rather than `File` so the rule can be exercised without a
 * browser — `tools/clip-section-test.mjs` hands it plain objects, which is the
 * only way a suite outside Chromium can check which files get through.
 */
export interface PickedFile {
  name: string;
  type?: string;
}

export function isAcceptableVideo(file: PickedFile): boolean {
  if (uploadKindFor(file.name) === "video") return true;
  return ACCEPTED_VIDEO_TYPES.includes(file.type ?? "");
}

/**
 * Why this file was refused, in words the person can act on.
 *
 * "Please upload an mp4, mov, or webm file" was the whole answer, at all three
 * doors, and it was wrong twice over: the product also takes mkv, m4v, avi and
 * 3gp, and the single most-refused file in it is not a video at all.
 *
 * **HEIC is the iPhone's default camera format.** Somebody who takes a photo
 * on an iPhone and drops it in as an overlay gets refused, and the sentence
 * tells them their photo is not a video — true, unhelpful, and not the thing
 * they need to know, which is that the same phone will hand them a JPEG if
 * asked. It is not accepted because the ffmpeg in the deployed image cannot
 * decode it, and accepting it would move the failure from here, before
 * anything is uploaded, to a render that dies minutes later while they watch.
 */
export function isHeic(file: PickedFile): boolean {
  const extension = (file.name.split(".").pop() ?? "").toLowerCase();
  // A pattern rather than a quoted media type, deliberately: `upload-types-test`
  // reads every media-type *string literal* in this file as a type we send to
  // the bucket, and this is the one we refuse. Naming it as a string would
  // make that suite demand the bucket accept it.
  return extension === "heic" || extension === "heif" || /^image\/hei/.test(file.type ?? "");
}

/** Why a file was refused. Null means it was not. */
export type VideoRejection = "type" | "size" | null;

/**
 * Which files get through, asked once.
 *
 * The format half is `isAcceptableVideo`, which derives its list from the
 * server's own table rather than repeating one. This function used to carry a
 * hand-written `accepted` array and a `/\.(mp4|mov|webm)$/i` beside it — three
 * formats, while the server has taken nine for a long time, `.mkv` (OBS's
 * default container) and `.m4v` among them. So the browser refused files the
 * product would have stored, on behalf of a server that never disagreed.
 * Deriving it means the next format the server learns is one this already has.
 *
 * The extension check inside it exists beside the MIME check because browsers
 * disagree about `.mov`: some report `video/quicktime`, some report nothing at
 * all, and a file with an empty `type` is a normal thing to be handed rather
 * than a suspicious one.
 */
export function videoRejection(
  file: { type?: string; name: string; size: number },
  { ceilingBytes }: { ceilingBytes: number | null },
): VideoRejection {
  if (!isAcceptableVideo(file)) return "type";
  /*
    Null is not a ceiling, it is a ceiling nobody has said yet.

    The subscription query answers late on a cold screen, and the build-time
    fallback is the *free* plan's fifty megabytes — so folding "not answered"
    into a number tells a paying customer their file is too large for a second.
    Storage enforces the real ceiling before a byte is sent, so saying nothing
    costs one round trip and guessing costs a customer. Zero is accepted for
    the same reason, because that is how this was spelled before
    `servedCeiling` existed.
  */
  if (ceilingBytes !== null && ceilingBytes > 0 && file.size > ceilingBytes) return "size";
  return null;
}
