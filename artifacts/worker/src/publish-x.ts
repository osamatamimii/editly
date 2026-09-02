/**
 * Putting a finished edit on somebody's X account.
 *
 * The fifth platform, and the one with the tightest limits by a wide margin:
 * 280 characters and 140 seconds, against TikTok's 2200 and ten minutes. Those
 * two numbers are the whole personality of this file.
 *
 * ## The upload is not the post, and it is not one call either
 *
 * X takes video in three commands on one endpoint — INIT, then APPEND once per
 * chunk, then FINALIZE — and hands back a media id. That id is not a post. The
 * post is a separate call to `/2/tweets` carrying the id, and between the two
 * there is a **transcode** that has to be waited for.
 *
 * FINALIZE answers with `processing_info.state`, and it is `pending` far more
 * often than not. Tweeting a media id that is still `pending` produces a post
 * with a video that does not play — accepted, recorded, visibly broken to
 * everyone but us. So the state is polled to `succeeded` before anything is
 * posted, and `failed` carries X's own reason rather than ours.
 *
 * This is the same lesson `publish-tiktok.ts` paid for in its own currency —
 * every byte accepted and the assembly failing afterwards — arriving here in a
 * different shape. It is written down twice because it is the shape of failure
 * this whole area has.
 *
 * ## A refusal we can make is worth more than one they make
 *
 * A video over 140 seconds is refused *here*, before a byte moves, with a
 * sentence that says how long it is and how long it may be. The alternative is
 * a rejection from X arriving as a numbered error against a post that has
 * already had a file uploaded for it — which tells the person nothing they can
 * act on, and costs the upload.
 *
 * The length is measured from the file rather than taken from the row. The
 * scheduling screen already refuses on the duration it knows, and the duration
 * it knows came from the browser and is nullable; this is the number nobody can
 * omit.
 *
 * ## And the caption is trimmed at a word, at 280
 *
 * Not because trimming is nice, but because 281 characters is a refusal of the
 * whole post. `captionFor` here is `publish-tiktok.ts`'s, with a different
 * ceiling and one difference that matters: hashtags are dropped one at a time
 * before the text is cut, because at this ceiling a hashtag block can be most
 * of the post and what somebody wrote is worth more than the tags on it.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { PublishError, type Published } from "./publish-youtube";
import { probeDuration } from "./ffmpeg";

const API = "https://api.x.com";

/** X's caption ceiling. 281 characters is a refusal of the post, not a trim. */
export const CAPTION_LIMIT = 280;

/** And its video ceiling, in seconds. */
export const MAX_SECONDS = 140;

/**
 * Bytes per APPEND.
 *
 * X documents five megabytes as the per-chunk maximum. Four is used here, and
 * the gap is deliberate rather than timid: a chunk that is over the limit is
 * refused on that chunk, in the middle of a file already partly uploaded, and
 * the saving from the last megabyte is one fewer request on a video that is
 * capped at 140 seconds anyway.
 */
export const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * How long to wait for X to finish transcoding.
 *
 * The wait is theirs. Reporting a post as failed while its video is still being
 * processed would be the one outcome worse than a slow one, because the next
 * thing somebody does is post it again by hand.
 */
const STATUS_DEADLINE_MS = 10 * 60 * 1000;
const STATUS_FALLBACK_MS = 5_000;

export interface XUpload {
  file: string;
  caption: string;
  hashtags: string[];
  accessToken: string;
  /** Injectable so the whole flow can be driven without a network. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Injectable so the length check can be driven without ffprobe. */
  durationOf?: (file: string) => Promise<number>;
}

/**
 * The caption, with the hashtags on it, inside 280 characters.
 *
 * Hashtags come off the end one at a time before the text is touched. At this
 * ceiling five tags can be a third of the post, and the person wrote the
 * sentence; they picked the tags from a list. Cutting the sentence to keep the
 * tags would be preferring our furniture to their words.
 *
 * What is left is trimmed at a word, because the last thing on somebody's post
 * should not be half of one.
 */
export function captionFor(caption: string, hashtags: string[], limit = CAPTION_LIMIT): string {
  const text = caption.trim();
  const tags = hashtags
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => (t.startsWith("#") ? t : `#${t}`));

  for (let keep = tags.length; keep > 0; keep -= 1) {
    const whole = `${text}\n\n${tags.slice(0, keep).join(" ")}`;
    if (whole.length <= limit) return whole;
  }
  if (text.length <= limit) return text;

  const cut = text.slice(0, limit - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export interface ChunkRange {
  index: number;
  start: number;
  end: number;
}

/**
 * The file cut into APPEND-sized pieces.
 *
 * Simpler than TikTok's, and deliberately not the same shape: X takes a
 * `segment_index` and each chunk stands alone, so there is no minimum, no
 * remainder riding on the last piece, and no total to declare up front beyond
 * the byte count. A pure function because it is the only part of this file a
 * suite can check exactly.
 */
export function chunkRanges(bytes: number, chunkBytes = CHUNK_BYTES): ChunkRange[] {
  if (bytes <= 0) throw new PublishError("There is nothing in that file to post.");
  const ranges: ChunkRange[] = [];
  for (let start = 0, index = 0; start < bytes; start += chunkBytes, index += 1) {
    ranges.push({ index, start, end: Math.min(bytes, start + chunkBytes) - 1 });
  }
  return ranges;
}

/**
 * One call, with X's error shape read rather than its status code.
 *
 * X answers a refusal with a status *and* a body, and the body is where the
 * reason is: `errors[].message` on the v2 endpoints, `detail` and `title` on a
 * problem document. Reporting "X answered 400" and nothing else is how a post
 * that was too long, or an app that lost a scope, become the same sentence.
 */
async function call(
  doFetch: typeof fetch,
  url: string,
  token: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await doFetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new PublishError(reasonFrom(payload, response.status));
  }
  return payload;
}

/** X's several ways of saying why, in one sentence. */
export function reasonFrom(payload: Record<string, unknown>, status: number): string {
  const errors = payload["errors"];
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as Record<string, unknown>;
    const message = first["message"] ?? first["detail"] ?? first["title"];
    if (message) return String(message).slice(0, 200);
  }
  const detail = payload["detail"] ?? payload["title"] ?? payload["error"];
  if (detail) return String(detail).slice(0, 200);
  return `X answered ${status} with no reason attached`;
}

/**
 * What the media id is called, whichever spelling came back.
 *
 * The command endpoint answers `media_id_string`, the newer one answers
 * `data.id`, and both are in circulation in X's own documentation. Reading only
 * one of them would work until the day it did not, and the symptom would be
 * "X accepted the details and returned nowhere to send the file" against an
 * upload that was fine.
 */
export function mediaIdFrom(payload: Record<string, unknown>): string | null {
  const data = payload["data"] as Record<string, unknown> | undefined;
  const candidate = payload["media_id_string"] ?? payload["media_id"] ?? data?.["id"] ?? data?.["media_id_string"];
  return candidate ? String(candidate) : null;
}

export interface Processing {
  done: boolean;
  failed: string | null;
  /** Seconds X asked us to wait, when it said. */
  checkAfterMs: number;
}

/**
 * What FINALIZE and STATUS say about the transcode.
 *
 * **No `processing_info` at all means done.** X omits it for media that needed
 * no processing, and treating a missing field as "not ready" would poll until
 * the deadline and then report a post as uncertain when it was ready the whole
 * time.
 */
export function readProcessing(payload: Record<string, unknown>): Processing {
  const data = (payload["data"] as Record<string, unknown> | undefined) ?? payload;
  const info = data["processing_info"] as Record<string, unknown> | undefined;
  if (!info) return { done: true, failed: null, checkAfterMs: 0 };

  const state = String(info["state"] ?? "");
  const after = Number(info["check_after_secs"]);
  const checkAfterMs = Number.isFinite(after) && after > 0 ? after * 1000 : STATUS_FALLBACK_MS;

  if (state === "succeeded") return { done: true, failed: null, checkAfterMs };
  if (state === "failed") {
    const error = info["error"] as Record<string, unknown> | undefined;
    const reason = error?.["message"] ?? error?.["name"] ?? "no reason given";
    return { done: true, failed: String(reason), checkAfterMs };
  }
  return { done: false, failed: null, checkAfterMs };
}

/** One chunk's bytes, read from the file rather than from a copy of it. */
async function readRange(file: string, range: ChunkRange): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of createReadStream(file, { start: range.start, end: range.end })) {
    parts.push(part as Buffer);
  }
  return Buffer.concat(parts);
}

export async function publishToX(upload: XUpload): Promise<Published> {
  const doFetch = upload.fetchImpl ?? fetch;
  const sleep = upload.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = upload.now ?? (() => Date.now());
  const durationOf = upload.durationOf ?? probeDuration;

  /*
    Ours to refuse, and refused before a byte moves.

    Measured from the file rather than read off the row: the row's duration came
    from the browser and can be absent, and the whole point of refusing here is
    that the number cannot be omitted.

    A failure to measure is not a refusal. ffprobe not answering is our problem,
    and turning it into "your video is too long" would be inventing a reason —
    so the length check is skipped and X gets to decide, which is exactly where
    this stood before.
  */
  let seconds: number | null = null;
  try {
    seconds = await durationOf(upload.file);
  } catch {
    seconds = null;
  }
  if (seconds !== null && seconds > MAX_SECONDS + 0.5) {
    throw new PublishError(
      `X takes videos up to ${MAX_SECONDS} seconds and this one is ${Math.round(seconds)}. ` +
        "Nothing was posted. Trim it, or post it somewhere with more room.",
    );
  }

  const bytes = (await stat(upload.file)).size;
  const ranges = chunkRanges(bytes);

  const init = await call(doFetch, `${API}/2/media/upload`, upload.accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      command: "INIT",
      media_type: "video/mp4",
      media_category: "tweet_video",
      total_bytes: String(bytes),
    }),
  });
  const mediaId = mediaIdFrom(init);
  if (!mediaId) throw new PublishError("X accepted the details and returned no media id");

  for (const range of ranges) {
    /*
      Read into memory, one chunk at a time, and that is a decision rather than
      laziness.

      APPEND is multipart/form-data with the bytes as a named part, and a
      multipart body cannot be streamed out of a file range without building the
      envelope by hand. Four megabytes is what that costs, once, on a worker
      whose budget is measured in hundreds — where TikTok's chunks can be
      sixty-four and are streamed for exactly that reason. The whole video is
      capped at 140 seconds here, so the number of chunks is small and bounded.
    */
    const chunk = await readRange(upload.file, range);
    const form = new FormData();
    form.set("command", "APPEND");
    form.set("media_id", mediaId);
    form.set("segment_index", String(range.index));
    form.set("media", new Blob([chunk as unknown as ArrayBuffer]), "chunk");

    const response = await doFetch(`${API}/2/media/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${upload.accessToken}` },
      body: form,
    });
    /*
      APPEND answers 204 with no body when it works, so the body is only read
      when it did not — `response.json()` on an empty 204 throws, and a throw
      here would turn every successful chunk into a failed post.
    */
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      throw new PublishError(
        `X refused part ${range.index + 1} of ${ranges.length}: ${reasonFrom(payload, response.status)}`,
      );
    }
  }

  const finalized = await call(doFetch, `${API}/2/media/upload`, upload.accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ command: "FINALIZE", media_id: mediaId }),
  });

  /*
    Uploaded is not posted, and finalized is not ready.

    X transcodes after FINALIZE and says so in `processing_info`. A tweet
    carrying a media id that is still `pending` is a post with a video that does
    not play — accepted by X, recorded as published by us, and broken to
    everybody who sees it.
  */
  let state = readProcessing(finalized);
  const startedAt = now();
  while (!state.done) {
    if (now() - startedAt > STATUS_DEADLINE_MS) {
      throw new PublishError(
        "X took the whole file and has not finished processing it. It may still appear. Nothing was sent twice.",
      );
    }
    await sleep(state.checkAfterMs);
    const status = await call(
      doFetch,
      `${API}/2/media/upload?command=STATUS&media_id=${encodeURIComponent(mediaId)}`,
      upload.accessToken,
      { method: "GET" },
    );
    state = readProcessing(status);
  }
  if (state.failed) throw new PublishError(`X could not process the video: ${state.failed}`);

  const posted = await call(doFetch, `${API}/2/tweets`, upload.accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: captionFor(upload.caption, upload.hashtags),
      media: { media_ids: [mediaId] },
    }),
  });

  const data = (posted["data"] as Record<string, unknown> | undefined) ?? {};
  const id = data["id"] ? String(data["id"]) : null;
  if (!id) throw new PublishError("X accepted the post and returned no id for it");
  return { externalPostId: id, externalUrl: `https://x.com/i/status/${id}` };
}
