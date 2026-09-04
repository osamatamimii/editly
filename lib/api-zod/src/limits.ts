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
/**
 * The largest font file this product will take.
 *
 * Here rather than only in `upload-policy.ts` because two doors enforce it and
 * one of them is a zod schema in this package. `RegisterFaceBody.bytes` allowed
 * twenty million — two and a half times the real ceiling — and the register
 * route writes that number straight into `caption_faces.bytes` with no
 * re-check. So the shared schema declared a limit that was not the product's,
 * and the size the picker and the console display was a client's claim
 * validated against the wrong number.
 *
 * A text face is under two megabytes; eight is a CJK family nobody burns
 * captions with. `tools/uploads-test.mjs` asserts the two doors agree.
 */
export const MAX_FONT_BYTES = 8 * 1024 * 1024;

/**
 * The most caption cues one render will accept, and the most words in one cue.
 *
 * `burnCaptions.cues` had `.min(1)` and no ceiling, and each cue carried an
 * optional `words` array with no ceiling either. Nothing validated the size of
 * the thing, so `POST /render` would take a plan holding a million cues, hold
 * it in this process while zod walked every one, write it into the job row, and
 * hand it to a worker that turns each into a line of ASS and asks libass to
 * lay them out. The failure is not a rejected request — it is a machine that
 * stops answering, and a `jobs` row big enough to matter on a 500 MB database.
 *
 * The numbers come from the product's own ceiling rather than from taste. The
 * longest video this product will render is four hours; a caption cue is a
 * phrase, so one per second across that whole length is already an implausible
 * transcript, and twenty thousand is comfortably past it. A cue's text is
 * capped at 300 characters, which cannot honestly be more than a hundred
 * words even in the shortest-worded language here.
 *
 * A refusal is the right answer at this size: a plan that exceeds these is not
 * a long video, it is a mistake or a probe.
 */
export const MAX_CAPTION_CUES = 20_000;
export const MAX_CAPTION_WORDS_PER_CUE = 100;

export const UPLOAD_CONTENT_TYPES = [
  // What a person films, and what a render writes back.
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  /*
    Three more the renderer has always been able to read.

    `.avi` is what a decade of camcorders and screen recorders write, `.3gp`
    is what a cheap phone writes, and a `.gif` is a piece of b-roll people
    actually have. ffmpeg demuxes all three — verified against the version in
    the worker's image, not assumed — and every one of them was refused by the
    browser with "that file is not a video". The refusal was ours and there was
    nothing behind it.
  */
  "video/x-msvideo",
  "video/3gpp",
  "image/gif",
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
    avi: "video/x-msvideo",
    "3gp": "video/3gpp", "3g2": "video/3gpp",
    gif: "image/gif",
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

/**
 * Which extensions in that table are video.
 *
 * Exported because the browser needs the same answer and had been keeping its
 * own: a literal `["video/mp4", "video/quicktime", "video/webm"]` and a
 * `/\.(mp4|mov|webm)$/i` beside it, at three call sites. The table above has
 * taken `.mkv` — OBS's default container — and `.m4v` for a long time, and the
 * bucket accepts both, so the client was refusing files the server would have
 * stored. Nothing failed; the upload never happened.
 */
export const VIDEO_UPLOAD_EXTENSIONS = ["mp4", "m4v", "mov", "qt", "webm", "mkv", "avi", "3gp", "3g2"] as const;

/** What an uploaded file is *for*, derived from the same one table. */
export function uploadKindFor(filename: string): "video" | "image" | "audio" | "font" | null {
  const type = uploadContentTypeFor(filename);
  if (!type) return null;
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  return "font";
}

/**
 * The longest sentence anybody can send the planner.
 *
 * The field was `z.string().min(1)` with no ceiling, and every one of these
 * becomes a prompt: `planner.ts` puts the message into a model call, so the
 * bound on this field is the bound on what a single free account can spend of
 * ours. Forty calls per ten minutes is the rate limit, and at 96 kB a call
 * that is about a million tokens every ten minutes — for one account, with no
 * per-user budget anywhere in the project to stop it.
 *
 * Two thousand characters is far more than the instructions this product
 * receives ("cut the silences, caption it, and open on the strongest bit" is
 * seventy) and it comfortably holds the other thing that arrives here: the
 * marks a person places on the timeline, which the browser turns into a
 * sentence of "at 1:23" — about two hundred and fifty of them.
 */
export const MAX_MESSAGE_LENGTH = 2000;


/**
 * Three lists that had no ceiling at all.
 *
 * Every other list in this file was capped when it was written. These were
 * not, and they are the three that grow with use rather than with a plan: a
 * person's projects, one project's conversation, one project's uploaded files.
 * A `SELECT` with a `WHERE` and no `LIMIT` is a promise that the row count
 * stays small — and this API runs as one serverless invocation per request,
 * where the row count and the memory are the same number.
 *
 * Nothing fails at a hundred rows. What happens is that the account that has
 * been using the product longest is the one whose dashboard gets slower, and
 * then one day does not load — the failure lands on the best customer first,
 * and it lands as a timeout with no error to read.
 *
 * Each is far above what anybody has: the numbers are here to bound the worst
 * case, not to ration the ordinary one, and the page compares against them so
 * "this is everything" and "this is where we stopped" are not the same screen.
 */

/** Everything somebody has ever made, newest first. */
export const PROJECTS_LIMIT = 500;

/** One project's conversation. Capped from the newest end — see the route. */
export const PROJECT_MESSAGES_LIMIT = 500;

/** The files uploaded into one project: beds, logos, b-roll. */
export const PROJECT_ASSETS_LIMIT = 200;

/**
 * What a person reads when they stopped a render themselves.
 *
 * Here, in the package both sides import, because both sides write it: the API
 * settles a job that was still queued, and the worker settles one it was in
 * the middle of. Two copies of a sentence is two sentences the day one of them
 * is reworded, and this one is the difference between "you did this" and an
 * apology for a failure that never happened.
 */
export const CANCELLED_MESSAGE = "You stopped this render. Nothing has been charged for it.";

/**
 * And the one for a render that was already under way.
 *
 * Deliberately silent about the charge. A render stopped at 90% has read the
 * whole source and the meter charges what was read; one stopped at 5% has not.
 * "Nothing was charged" would be a promise we cannot keep, and "you were
 * charged" would be wrong most of the time — so it says the true part and
 * leaves the meter to say the rest, where the number is.
 */
export const CANCELLED_MID_RENDER_MESSAGE = "You stopped this render.";
