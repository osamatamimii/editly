/**
 * How many rows a list endpoint sends at once.
 *
 * These live here, shared, for one reason: a cap is only honest if the screen
 * showing the list knows what it is. A limit written as a literal in a route
 * is invisible to the page, so the page cannot tell "this is everything you
 * have" apart from "this is where I stopped" — and the two look identical to
 * whoever is reading it.
 *
 * Where an endpoint can afford to count, it sends a `total` and the page needs
 * no constant. Where it cannot — a bare array, a shape other clients already
 * depend on — the page compares against the cap itself, and these numbers have
 * to be the same number in both places or the notice appears at the wrong time.
 *
 * No zod here on purpose, so the browser can import it without pulling a
 * validation library into the bundle for two integers.
 */

/** The clips library: every tile signs a URL and draws a video element. */
export const CLIPS_LIBRARY_LIMIT = 200;

/** The clips of one project, shown grouped by the run that made them. */
export const PROJECT_CLIPS_LIMIT = 60;

/** What is scheduled, and what happened to what has gone. */
export const SCHEDULED_POSTS_LIMIT = 200;

/**
 * Every content type this product ever uploads, and the only ones it accepts.
 *
 * A Supabase bucket carries an `allowed_mime_types` list and **rejects
 * anything else** — a 400 from Storage at the moment somebody presses a
 * button. Not a crash, not a log: a feature that does not work, on a
 * deployment where every suite passed because no suite talks to the real
 * bucket.
 *
 * The bucket allowed four types. The upload code accepted `video/*`,
 * `image/*` and `audio/*` and sent whatever the browser called the file. So:
 * a PNG logo was refused, an MP3 bed was refused, a WebP was refused — and
 * `addMusic` and `overlayImage`, both built and both tested, could not be fed
 * a file at all on the live product. Nothing anywhere said so.
 *
 * Hence one list, and the client mapping a file to a member of it by
 * **extension** rather than passing `file.type` through: browsers disagree
 * about fonts and about several audio formats, and a type that works on one
 * machine and 400s on another is the same silent failure wearing a different
 * hat.
 *
 * Changing this list means changing the bucket in the same breath:
 *
 *     update storage.buckets set allowed_mime_types = ARRAY[...] where id = 'videos';
 *
 * Wider than the four it replaces, and deliberately not `*` / `*`: this bucket
 * holds one person's private files behind signed URLs, and a list that admits
 * anything makes it a place to keep anything.
 */
export const UPLOAD_CONTENT_TYPES = [
  // What a person films, and what a render writes back.
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  // Overlays, logos, thumbnails. `image/jpeg` is also what the worker writes
  // for a clip's poster frame.
  "image/jpeg",
  "image/png",
  "image/webp",
  // Music beds. `audio/mpeg` is mp3; the two `mp4` spellings are both what
  // browsers call an m4a, depending on the browser.
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/wav",
  "audio/ogg",
  // Fonts somebody brought: the upload, the repaired face the worker writes,
  // and the subset the picker draws its sample in.
  "font/ttf",
  "font/otf",
  "font/woff2",
] as const;

export type UploadContentType = (typeof UPLOAD_CONTENT_TYPES)[number];

/**
 * A filename to the one content type this product will send for it.
 *
 * By extension, and null for anything else. The point is that the answer is
 * *ours*: a refusal a person can read, before a byte leaves their machine,
 * instead of a 400 from Storage with no sentence attached.
 */
export function uploadContentTypeFor(filename: string): UploadContentType | null {
  const extension = (filename.split(".").pop() ?? "").toLowerCase();
  const byExtension: Record<string, UploadContentType> = {
    mp4: "video/mp4", m4v: "video/mp4",
    mov: "video/quicktime", qt: "video/quicktime",
    webm: "video/webm",
    mkv: "video/x-matroska",
    jpg: "image/jpeg", jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    mp3: "audio/mpeg",
    m4a: "audio/mp4", aac: "audio/aac",
    wav: "audio/wav",
    ogg: "audio/ogg", oga: "audio/ogg",
    ttf: "font/ttf", ttc: "font/ttf",
    otf: "font/otf",
    woff2: "font/woff2",
  };
  return byExtension[extension] ?? null;
}

/** What an uploaded file is *for*, derived from the same one table. */
export function uploadKindFor(filename: string): "video" | "image" | "audio" | "font" | null {
  const type = uploadContentTypeFor(filename);
  if (!type) return null;
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  return "font";
}
