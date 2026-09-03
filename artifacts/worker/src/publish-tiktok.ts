/**
 * Putting a finished edit on somebody's TikTok.
 *
 * The second platform, and the first one whose API disagrees with the shape of
 * this product in ways worth writing down.
 *
 * ## It answers 200 when it refuses
 *
 * Every TikTok response carries an `error` object, and a *successful* one has
 * `error.code === "ok"`. A refusal — a bad token, a video too long, a scope the
 * app was never granted — arrives as HTTP 200 with a different code inside.
 * Checking `response.ok` and moving on is the exact shape of failure this
 * codebase keeps finding: nothing throws, nothing logs, and the post is marked
 * published having never existed. So the envelope is read every time, and it is
 * read before the payload.
 *
 * ## It will not take the file from us in one piece
 *
 * The upload is chunked, and the chunk arithmetic is not obvious: chunks are
 * between 5MB and 64MB, the count is a *floor* division, and the remainder goes
 * onto the **last** chunk rather than into a chunk of its own — so a final
 * chunk can be nearly twice the size of the others. A video under 5MB is a
 * single chunk of exactly its own size. Getting this wrong produces an upload
 * TikTok accepts and then fails to assemble, hours later, silently.
 *
 * `chunkPlan` is therefore a pure function with its own tests, because it is
 * the only part of this file that can be checked without a network.
 *
 * ## And it will post privately if you let it
 *
 * An app that has not passed TikTok's audit may only post `SELF_ONLY` — visible
 * to the creator and nobody else. The API says so honestly, in
 * `creator_info/query`, and it would happily accept the post.
 *
 * **That is refused here.** Scheduling a post means publishing it, and a post
 * that went out visible to nobody, recorded as published, is worse than one
 * that did not go out: the person finds out from an audience that never saw it.
 * The refusal names the reason, which turns an app-review gate into a sentence
 * somebody can act on instead of a mystery.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { PublishError, type Published } from "./publish-youtube";
import { withDeadline } from "./providers/deadline";

const API = "https://open.tiktokapis.com/v2";

/** TikTok's caption ceiling. Longer is refused rather than trimmed by them. */
const CAPTION_LIMIT = 2200;

/** The chunk bounds, from TikTok's own documentation. */
export const MIN_CHUNK_BYTES = 5 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
/** And the ceiling on how many there may be. */
export const MAX_CHUNKS = 1000;

/**
 * How long to wait for TikTok to finish assembling the video.
 *
 * Generous, because the wait is theirs and not ours, and because the only
 * alternative to waiting is reporting a post as failed while it is on its way
 * to somebody's feed — which is the one outcome worse than a slow one.
 */
const STATUS_DEADLINE_MS = 10 * 60 * 1000;
const STATUS_INTERVAL_MS = 5_000;

export interface TikTokUpload {
  file: string;
  caption: string;
  hashtags: string[];
  accessToken: string;
  /** Injectable so the whole flow can be driven without a network. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * The caption, with the hashtags on it, inside TikTok's ceiling.
 *
 * One field, unlike YouTube: TikTok has no separate title, so the hashtags go
 * on the end of the same text where they will actually be read as hashtags.
 * Trimmed rather than refused, and trimmed at a word so the last thing on
 * somebody's post is not half a word.
 */
export function captionFor(caption: string, hashtags: string[], limit = CAPTION_LIMIT): string {
  const tags = hashtags
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => (t.startsWith("#") ? t : `#${t}`));
  const whole = tags.length > 0 ? `${caption.trim()}\n\n${tags.join(" ")}` : caption.trim();
  if (whole.length <= limit) return whole;
  const cut = whole.slice(0, limit - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export interface ChunkPlan {
  chunkSize: number;
  totalChunks: number;
  /** Byte ranges, inclusive at both ends, as `Content-Range` wants them. */
  ranges: Array<{ start: number; end: number }>;
}

/**
 * How to cut the file up, and where each piece begins and ends.
 *
 * The rules, in the order they matter:
 *
 * A file smaller than the minimum chunk is **one chunk of its own size**, not
 * one chunk padded to 5MB. TikTok rejects a declared chunk size larger than the
 * file.
 *
 * The count is `floor(size / chunkSize)`, and the leftover is **added to the
 * last chunk** rather than becoming a chunk of its own. This is the part that
 * is easy to get wrong by writing the obvious `ceil`, and the symptom is an
 * upload that is accepted, assembled hours later, and fails there.
 *
 * And the count is capped: past a thousand chunks the chunk size grows instead,
 * which is what keeps a very large file inside both limits at once.
 */
export function chunkPlan(bytes: number): ChunkPlan {
  if (bytes <= 0) throw new PublishError("There is nothing in that file to post.");

  if (bytes < MIN_CHUNK_BYTES) {
    return { chunkSize: bytes, totalChunks: 1, ranges: [{ start: 0, end: bytes - 1 }] };
  }

  let chunkSize = MIN_CHUNK_BYTES;
  // Grow the chunk until the count fits, rather than letting the count grow
  // past what TikTok accepts. Both bounds hold at once or neither does.
  if (Math.floor(bytes / chunkSize) > MAX_CHUNKS) {
    chunkSize = Math.min(MAX_CHUNK_BYTES, Math.ceil(bytes / MAX_CHUNKS));
  }
  const totalChunks = Math.max(1, Math.min(MAX_CHUNKS, Math.floor(bytes / chunkSize)));

  const ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < totalChunks; i += 1) {
    const start = i * chunkSize;
    // The remainder rides on the last chunk. See above.
    const end = i === totalChunks - 1 ? bytes - 1 : start + chunkSize - 1;
    ranges.push({ start, end });
  }
  return { chunkSize, totalChunks, ranges };
}

interface Envelope {
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string; log_id?: string };
}

/**
 * One call, with TikTok's envelope read rather than its status code.
 *
 * `error.code === "ok"` is what success looks like. Everything else is a
 * refusal, whatever the HTTP status says — and the code is kept in the message
 * because it is the part somebody can search for.
 */
async function call(
  doFetch: typeof fetch,
  path: string,
  token: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await doFetch(`${API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as Envelope;
  const code = payload.error?.code;
  if (code && code !== "ok") {
    throw new PublishError(`${code}: ${payload.error?.message ?? "no reason given"}`.slice(0, 200));
  }
  if (!response.ok) {
    throw new PublishError(`TikTok answered ${response.status} with no reason attached`);
  }
  return payload.data ?? {};
}

/**
 * Which privacy levels this creator's account will accept from this app.
 *
 * Asked rather than assumed, because the answer depends on TikTok's audit of
 * *our* app and on the creator's own settings, and neither is knowable from
 * here. An unaudited app is offered `SELF_ONLY` and nothing else.
 */
export function choosePrivacy(options: string[]): string | null {
  if (options.includes("PUBLIC_TO_EVERYONE")) return "PUBLIC_TO_EVERYONE";
  /*
    Nothing public on offer means this app has not passed TikTok's audit, and
    the only thing it can do is post where nobody will see it. Refused, loudly.
    A post recorded as published and visible to its author alone is worse than
    one that did not go out: the person finds out from an audience that never
    saw it.
  */
  return null;
}

/** What the status endpoint can say, and what each one means for us. */
function readStatus(data: Record<string, unknown>): { done: boolean; failed: string | null; postId: string | null } {
  const status = String(data["status"] ?? "");
  const ids = data["publicaly_available_post_id"] as unknown[] | undefined;
  const postId = Array.isArray(ids) && ids.length > 0 ? String(ids[0]) : null;
  if (status === "PUBLISH_COMPLETE") return { done: true, failed: null, postId };
  if (status === "FAILED") {
    const reason = data["fail_reason"] ? String(data["fail_reason"]) : "no reason given";
    return { done: true, failed: reason, postId: null };
  }
  return { done: false, failed: null, postId };
}

export async function publishToTikTok(upload: TikTokUpload): Promise<Published> {
  const doFetch = upload.fetchImpl ?? withDeadline(fetch);
  const sleep = upload.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = upload.now ?? (() => Date.now());

  const creator = await call(doFetch, "/post/publish/creator_info/query/", upload.accessToken, {});
  const options = (creator["privacy_level_options"] as string[] | undefined) ?? [];
  const privacy = choosePrivacy(options);
  if (!privacy) {
    throw new PublishError(
      "TikTok will only let this app post where nobody but you can see it, which is not what scheduling a post means. " +
        "Nothing was posted. This lifts when the app's TikTok review passes.",
    );
  }

  const bytes = (await stat(upload.file)).size;
  const plan = chunkPlan(bytes);

  const init = await call(doFetch, "/post/publish/video/init/", upload.accessToken, {
    post_info: {
      title: captionFor(upload.caption, upload.hashtags),
      privacy_level: privacy,
      /*
        Nothing is disabled. Duets, stitches and comments are the creator's
        settings to make on their own account, and a product that quietly turned
        them off on every post it sent would be changing how somebody's account
        behaves without being asked.
      */
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
    },
    source_info: {
      source: "FILE_UPLOAD",
      video_size: bytes,
      chunk_size: plan.chunkSize,
      total_chunk_count: plan.totalChunks,
    },
  });

  const uploadUrl = init["upload_url"] ? String(init["upload_url"]) : null;
  const publishId = init["publish_id"] ? String(init["publish_id"]) : null;
  if (!uploadUrl || !publishId) {
    throw new PublishError("TikTok accepted the details and returned nowhere to send the file");
  }

  for (const range of plan.ranges) {
    const length = range.end - range.start + 1;
    const response = await doFetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(length),
        "Content-Range": `bytes ${range.start}-${range.end}/${bytes}`,
      },
      /*
        A stream over exactly this range, never the whole file. This worker has
        one gigabyte and has been measured going over it on renders; reading a
        finished export into memory to post it would be the same ceiling from
        the other side.
      */
      body: Readable.toWeb(
        createReadStream(upload.file, { start: range.start, end: range.end }),
      ) as unknown as ReadableStream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    if (!response.ok) {
      throw new PublishError(
        `TikTok refused part ${plan.ranges.indexOf(range) + 1} of ${plan.totalChunks} with ${response.status}`,
      );
    }
  }

  /*
    Uploaded is not posted.

    TikTok assembles the video after the last chunk, and that is where a file it
    cannot process fails — after every byte was accepted. Returning at the end
    of the upload would mark a post published that TikTok is about to reject.
  */
  const startedAt = now();
  for (;;) {
    const data = await call(doFetch, "/post/publish/status/fetch/", upload.accessToken, {
      publish_id: publishId,
    });
    const state = readStatus(data);
    if (state.failed) throw new PublishError(`TikTok could not process the video: ${state.failed}`);
    if (state.done) {
      return {
        externalPostId: state.postId ?? publishId,
        externalUrl: state.postId ? `https://www.tiktok.com/video/${state.postId}` : "https://www.tiktok.com/",
      };
    }
    if (now() - startedAt > STATUS_DEADLINE_MS) {
      /*
        Said as uncertainty, not as failure, because that is what it is: every
        byte is at TikTok and they have not finished with it. The first question
        after a failed post is always whether it went out anyway, and this is
        the one case where the honest answer is "possibly".
      */
      throw new PublishError(
        "TikTok took the whole file and has not finished processing it. It may still appear. Nothing was sent twice.",
      );
    }
    await sleep(STATUS_INTERVAL_MS);
  }
}
