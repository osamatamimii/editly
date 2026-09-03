/**
 * Putting a finished edit on somebody's YouTube channel.
 *
 * The first platform this product can actually send to, and it is first for a
 * reason: Google's verification is the most predictable of the six, its API is
 * the least surprising, and a YouTube upload is one request rather than the
 * three-step container dance Meta requires.
 *
 * ## The title is not the caption
 *
 * Every other platform here takes one blob of text. YouTube takes a **title**
 * of 100 characters and a **description** of 5000, and they are not the same
 * thing: a description trimmed at 5000 is fine, and a title trimmed at 100 is
 * a sentence cut in half on somebody's channel.
 *
 * So the title is the caption's first line, cut at a word boundary, and the
 * description is the whole caption with the hashtags under it. Nothing is
 * invented — the same rule a clip's title follows. A caption whose first line
 * is already too long gets an ellipsis, which is honest; a generated title
 * would be this product putting words in somebody's mouth on their own
 * channel.
 *
 * ## And it goes out public
 *
 * Because that is what scheduling a post means. Uploading it private would be
 * doing something other than what was asked, at the moment nobody is watching,
 * and the person would find out by looking for a video that is not there.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { withDeadline } from "./providers/deadline";

/** YouTube's own limits, and the reason each one is here. */
const TITLE_LIMIT = 100;
const DESCRIPTION_LIMIT = 5000;

export interface YouTubeUpload {
  file: string;
  caption: string;
  hashtags: string[];
  accessToken: string;
  /** Injected by tests; production gets a fetch with a deadline. */
  fetchImpl?: typeof fetch;
}

export interface Published {
  externalPostId: string;
  externalUrl: string;
}

export class PublishError extends Error {}

/**
 * The first line of the caption, whole words only, under a hundred characters.
 *
 * Exported because it is the part worth checking without a network: everything
 * else in this file is one HTTP call, and this is the piece with a decision in
 * it.
 */
export function titleFrom(caption: string): string {
  const firstLine = caption.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (firstLine.length <= TITLE_LIMIT) return firstLine || "Untitled";

  // Cut at the last space that fits, so the title ends on a word. Falling back
  // to a hard cut only for text with no spaces in it at all, which is a hashtag
  // wall or a language that does not use them.
  const room = TITLE_LIMIT - 1;
  const cut = firstLine.slice(0, room);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > room * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** The caption in full, with the hashtags under it, inside YouTube's ceiling. */
export function descriptionFrom(caption: string, hashtags: string[]): string {
  const tags = hashtags.filter((t) => t.trim().length > 0).map((t) => (t.startsWith("#") ? t : `#${t}`));
  const whole = tags.length > 0 ? `${caption}\n\n${tags.join(" ")}` : caption;
  return whole.length <= DESCRIPTION_LIMIT ? whole : `${whole.slice(0, DESCRIPTION_LIMIT - 1)}…`;
}

async function readError(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; errors?: Array<{ reason?: string }> };
  };
  const reason = payload.error?.errors?.[0]?.reason;
  const message = payload.error?.message ?? response.statusText;
  /*
    Google's `reason` is the part somebody can act on — `quotaExceeded`,
    `youtubeSignupRequired`, `uploadLimitExceeded` — and its `message` is the
    prose around it. Both, because either alone has been the difference between
    a person fixing this in a minute and writing to us.
  */
  return `${reason ? `${reason}: ` : ""}${message}`.slice(0, 200);
}

/**
 * Upload the file and return where it landed.
 *
 * Resumable in two steps, which is the documented path for video: the first
 * request carries the metadata and gets back a URL, the second carries the
 * bytes. Streamed from disk rather than read into memory — this worker has one
 * gigabyte and has already been measured going over it on six-piece renders.
 */
export async function publishToYouTube(upload: YouTubeUpload): Promise<Published> {
  const bytes = (await stat(upload.file)).size;
  // No request to Google without a deadline. This worker sends on the same
  // process that renders, and a socket Google accepts and never answers would
  // block the publish loop on this one row for as long as the operating system
  // holds it — which is the exact wedge `providers/deadline.ts` exists to stop.
  const doFetch = upload.fetchImpl ?? withDeadline(fetch);

  const start = await doFetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${upload.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(bytes),
        "X-Upload-Content-Type": "video/mp4",
      },
      body: JSON.stringify({
        snippet: {
          title: titleFrom(upload.caption),
          description: descriptionFrom(upload.caption, upload.hashtags),
        },
        status: {
          // What scheduling a post means. See the header.
          privacyStatus: "public",
          // Required by YouTube since 2020, and getting it wrong is a channel
          // strike rather than an error: every upload has to declare whether it
          // is made for children. Ours is not, and this product has no way to
          // ask — so it declares the truth it can know.
          selfDeclaredMadeForKids: false,
        },
      }),
    },
  );

  if (!start.ok) throw new PublishError(await readError(start));
  const location = start.headers.get("location");
  if (!location) throw new PublishError("YouTube accepted the details but returned nowhere to send the file");

  const put = await doFetch(location, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${upload.accessToken}`,
      "Content-Type": "video/mp4",
      "Content-Length": String(bytes),
    },
    /*
      A stream, not a buffer. This worker has one gigabyte and has already been
      measured going over it; reading a finished render into memory to post it
      would be the same ceiling from the other side.

      `duplex: "half"` is required by Node to send a stream as a body, and its
      absence is a runtime error rather than a type one — so the cast is here
      and not the flag.
    */
    body: Readable.toWeb(createReadStream(upload.file)) as unknown as ReadableStream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  if (!put.ok) throw new PublishError(await readError(put));
  const video = (await put.json().catch(() => ({}))) as { id?: string };
  if (!video.id) throw new PublishError("YouTube took the file and did not say what it became");

  return {
    externalPostId: video.id,
    externalUrl: `https://www.youtube.com/watch?v=${video.id}`,
  };
}
