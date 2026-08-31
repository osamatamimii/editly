/**
 * Sending the scheduled posts that are due.
 *
 * The queue this sits beside renders video: a job that runs twice wastes a
 * minute of compute and produces the same file. This one is different, and the
 * difference is the whole design. **A post that goes out twice cannot be taken
 * back.** There is no idempotency key on somebody's Instagram; there is a
 * second identical Reel on their feed at 9pm, and the only person who can
 * remove it is them.
 *
 * So every rule below falls the same way: when this module is unsure, nothing
 * is sent.
 *
 *   - A row is *claimed* before it is touched, in one statement, under
 *     `FOR UPDATE SKIP LOCKED`. Two workers polling the same second get
 *     disjoint sets, and there is no window between reading a row and marking
 *     it as taken.
 *   - A row already in `publishing` is never re-claimed by the sweep. A render
 *     that dies mid-flight is returned to the queue after thirty minutes,
 *     because re-rendering is free; a *post* that died mid-flight may already
 *     have reached the platform, so it is surfaced for a person to look at
 *     instead of retried.
 *   - A post that is very late is not sent. See `TOO_LATE_MINUTES`.
 *
 * ## What this cannot do yet, and says so
 *
 * Actually handing a file to a platform needs an app that platform has
 * reviewed and credentials on this deployment. Neither exists yet, and the
 * honest shape of that is a publisher that claims the row, discovers there is
 * no way to send it, and writes down why in a sentence the person can read —
 * rather than a publisher that marks it `published` and shows a green tick
 * over a post that does not exist. The second one is the failure this whole
 * codebase is organised against, and it would be one line shorter to write.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { configuredPlatforms, isSocialPlatform, SOCIAL_LABEL, type SocialPlatform } from "@workspace/api-zod";
import { usableToken, TokenError } from "./social-token.js";
import { publishToYouTube, PublishError, type Published } from "./publish-youtube.js";
import { publishToTikTok } from "./publish-tiktok.js";
import { publishToInstagram, publishToFacebook } from "./publish-meta.js";

/**
 * How late is too late.
 *
 * A post scheduled for 9pm that goes out at 9:02 is the product working. The
 * same post going out at 6am the next morning, because the worker was down all
 * night and then caught up, is worse than it never going out at all: the
 * person chose 9pm for a reason, they have no idea it is about to appear, and
 * the first they hear of it is a notification.
 *
 * Twenty minutes is the window in which "it went out a bit late" is still
 * true. Past it the row is marked `missed`, with the time it was due, and it
 * waits for a person to decide.
 */
export const TOO_LATE_MINUTES = 20;

/**
 * How many due posts one pass takes.
 *
 * Small on purpose. Each one is a network call to somebody else's API, and a
 * worker holding forty rows in `publishing` while the twelfth times out is a
 * worker whose crash strands twenty-eight posts nobody can account for.
 */
export const PUBLISH_BATCH = 5;

/** A post the publisher now owns. */
export interface ClaimedPost {
  id: string;
  userId: string;
  projectId: string;
  exportId: string | null;
  accountId: string;
  platform: string;
  caption: string;
  hashtags: string[];
  scheduledFor: Date;
  attempts: number;
  /** The account it is going to, resolved in the same statement. */
  handle: string | null;
  accountStatus: string | null;
  accountStatusDetail: string | null;
}

/**
 * Take ownership of everything due, in one statement.
 *
 * The subselect picks the rows and the outer UPDATE marks them, so there is no
 * moment where a row has been read as due and not yet marked as taken. That
 * moment is the entire bug: two workers, both polling every five seconds, both
 * read the same row, both post it.
 *
 * `SKIP LOCKED` rather than waiting, because a second worker should take the
 * *next* five posts rather than queue behind the first. And the join onto
 * `social_accounts` is a LEFT join: an account disconnected between scheduling
 * and now leaves a post with nowhere to go, and that must come back as a row
 * with a null handle to be refused honestly — not silently vanish from the
 * result because an inner join dropped it.
 */
export async function claimDuePosts(
  now: Date = new Date(),
  limit: number = PUBLISH_BATCH,
): Promise<ClaimedPost[]> {
  const claimed = await db.execute<{
    id: string;
    user_id: string;
    project_id: string;
    export_id: string | null;
    account_id: string;
    platform: string;
    caption: string;
    hashtags: unknown;
    scheduled_for: Date;
    attempts: number;
    handle: string | null;
    account_status: string | null;
    account_status_detail: string | null;
  }>(sql`
    with taken as (
      update scheduled_posts p
         set status = 'publishing',
             attempts = p.attempts + 1,
             updated_at = now()
       where p.id in (
         select id
           from scheduled_posts
          where status = 'scheduled'
            and scheduled_for <= ${now}
          order by scheduled_for asc
          limit ${limit}
            for update skip locked
       )
      returning p.*
    )
    select t.id, t.user_id, t.project_id, t.export_id, t.account_id, t.platform,
           t.caption, t.hashtags, t.scheduled_for, t.attempts,
           a.handle          as handle,
           a.status          as account_status,
           a.status_detail   as account_status_detail
      from taken t
      left join social_accounts a on a.id = t.account_id
     order by t.scheduled_for asc
  `);

  return claimed.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    exportId: row.export_id,
    accountId: row.account_id,
    platform: row.platform,
    caption: row.caption,
    hashtags: Array.isArray(row.hashtags) ? (row.hashtags as string[]) : [],
    scheduledFor: new Date(row.scheduled_for),
    attempts: Number(row.attempts),
    handle: row.handle,
    accountStatus: row.account_status,
    accountStatusDetail: row.account_status_detail,
  }));
}

export type PostOutcome =
  | { kind: "published"; externalPostId: string | null; externalUrl: string | null }
  | { kind: "failed"; reason: string }
  | { kind: "missed"; reason: string };

/**
 * Whether this post can be sent at all, decided before anything is sent.
 *
 * Returns the reason it cannot, or null. Every branch is a thing that was true
 * when the post was scheduled and is not true now — which is exactly the set of
 * failures a check at scheduling time cannot catch, and the reason this
 * function exists in addition to the scheduling checks rather than instead of it.
 */
export function refusalToSend(post: ClaimedPost, now: Date = new Date()): PostOutcome | null {
  const lateBy = (now.getTime() - post.scheduledFor.getTime()) / 60000;
  if (lateBy > TOO_LATE_MINUTES) {
    /*
      No timestamp in the sentence.

      It read "This was due at 2026-08-28T19:00:00.000Z and is 121 minutes
      late" — an ISO string in prose somebody is meant to read, and a *second*
      copy of a time the screen already shows directly above it, in their own
      timezone. The row knows when it was due; what the row cannot work out is
      how late is too late and why nothing went out, which is all this sentence
      owes anybody.
    */
    const late = Math.round(lateBy);
    return {
      kind: "missed",
      reason:
        `This was ${late} ${late === 1 ? "minute" : "minutes"} late, so it was not sent. ` +
        `Posting it now would put it in front of people at a time you did not choose. ` +
        `Schedule it again when you want it to go.`,
    };
  }

  if (post.handle === null) {
    return {
      kind: "failed",
      reason: "The account this was going to is no longer connected, so there was nowhere to send it.",
    };
  }

  const label = isSocialPlatform(post.platform) ? SOCIAL_LABEL[post.platform] : post.platform;

  if (post.accountStatus !== "ok") {
    return {
      kind: "failed",
      reason:
        post.accountStatusDetail ??
        `${label} needs reconnecting before anything can go out to ${post.handle}.`,
    };
  }

  if (!isSocialPlatform(post.platform) || configuredPlatforms(process.env)[post.platform] !== true) {
    return {
      kind: "failed",
      // Named plainly, because the alternative — a green tick over a post that
      // was never sent — is the one thing this module exists to prevent.
      reason:
        `${label} posting is not switched on for this deployment, so this could not be sent. ` +
        `Nothing was posted. The file is still in your exports.`,
    };
  }

  return null;
}

/** Write down what happened. The row leaves `publishing` in every branch. */
export async function settle(postId: string, outcome: PostOutcome): Promise<void> {
  if (outcome.kind === "published") {
    await db.execute(sql`
      update scheduled_posts
         set status = 'published',
             external_post_id = ${outcome.externalPostId},
             external_url = ${outcome.externalUrl},
             error = null,
             published_at = now(),
             updated_at = now()
       where id = ${postId}
    `);
    return;
  }

  await db.execute(sql`
    update scheduled_posts
       set status = ${outcome.kind},
           error = ${outcome.reason},
           updated_at = now()
     where id = ${postId}
  `);
}

/**
 * Posts left in `publishing` by a worker that died.
 *
 * Deliberately *not* returned to the queue. The render queue requeues a stale
 * lock because rendering twice costs a minute; this row may already be a post
 * on somebody's feed, and the two possible mistakes are not symmetric. So it
 * is marked `failed` with a sentence that says what is uncertain and what to
 * check, and a person decides.
 */
export async function surfaceStrandedPosts(staleMinutes = 15): Promise<number> {
  const stranded = await db.execute<{ id: string }>(sql`
    update scheduled_posts
       set status = 'failed',
           error = 'This was being sent when the publisher stopped, so it is not known whether it went out. Check the account before scheduling it again.',
           updated_at = now()
     where status = 'publishing'
       and updated_at < now() - ${sql.raw(`interval '${Number(staleMinutes)} minutes'`)}
    returning id
  `);
  return stranded.rows.length;
}


/**
 * The platforms that can actually be sent to, and how each one takes a file.
 *
 * Two shapes, and the difference is not cosmetic. YouTube and TikTok want the
 * **bytes**, so the worker downloads the finished render and streams it up.
 * Instagram and Facebook want a **link**, and fetch it themselves — so those
 * two never download anything, and what they need instead is a URL that
 * outlives Meta's own fetch.
 *
 * A platform with no entry falls through to a refusal that says so, rather than
 * to a branch that pretends. The two still missing — X and Snapchat — arrive
 * when their uploads are written.
 */
type Uploader =
  | { takes: "file"; send: (a: FileUpload) => Promise<Published> }
  | { takes: "url"; send: (a: UrlUpload) => Promise<Published> };

interface FileUpload {
  file: string;
  caption: string;
  hashtags: string[];
  accessToken: string;
}

interface UrlUpload {
  videoUrl: string;
  caption: string;
  hashtags: string[];
  accessToken: string;
}

const UPLOADERS: Partial<Record<SocialPlatform, Uploader>> = {
  youtube: { takes: "file", send: publishToYouTube },
  tiktok: { takes: "file", send: publishToTikTok },
  instagram: { takes: "url", send: publishToInstagram },
  facebook: { takes: "url", send: publishToFacebook },
};

/**
 * How long a link handed to Meta stays good for.
 *
 * Half an hour, and it is a fetch budget rather than a guess: Meta downloads
 * and transcodes on its own schedule, and a link that expires while it is
 * reading produces a container stuck in `IN_PROGRESS` and then `ERROR` — a
 * failure whose cause is nowhere in its own message.
 */
const LINK_SECONDS = 30 * 60;

/**
 * Where this post's video actually is.
 *
 * From the export's job when the post names one, and from the project's own
 * pointer otherwise — the same two places the export screen reads, because a
 * post scheduled from a finished render and a post scheduled from "the latest"
 * are two different asks and both are real.
 */
async function filePathFor(post: ClaimedPost): Promise<string | null> {
  if (post.exportId) {
    const found = await db.execute(sql`
      select j.output_path as path
        from exports e
        left join jobs j on j.id = e.job_id
       where e.id = ${post.exportId} and e.user_id = ${post.userId}
       limit 1
    `);
    const row = found.rows[0] as { path: string | null } | undefined;
    if (row?.path) return row.path;
  }
  const project = await db.execute(sql`
    select edited_video_path as path
      from projects
     where id = ${post.projectId} and user_id = ${post.userId}
     limit 1
  `);
  return ((project.rows[0] as { path: string | null } | undefined)?.path) ?? null;
}

/** The credential for this post's account, read at the moment it is needed. */
async function credentialFor(accountId: string) {
  const found = await db.execute(sql`
    select access_token, refresh_token, expires_at
      from social_accounts
     where id = ${accountId}
     limit 1
  `);
  const row = found.rows[0] as
    | { access_token: string; refresh_token: string | null; expires_at: string | null }
    | undefined;
  if (!row) return null;
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
  };
}

/**
 * One post, sent.
 *
 * Every failure here is `failed` rather than thrown, and every one of them
 * carries a sentence: a post that did not go out is a thing somebody has to
 * decide what to do about, and "failed" on its own is not a thing anybody can
 * act on.
 *
 * The file is downloaded to this worker rather than streamed from a signed URL
 * because the platform APIs want a body, not a link — and because a signed URL
 * that expires halfway through a slow upload fails in the middle of a file
 * that is already partly on somebody's channel.
 */
async function send(post: ClaimedPost): Promise<PostOutcome> {
  const platform = post.platform as SocialPlatform;
  const uploader = UPLOADERS[platform];
  if (!uploader) {
    return {
      kind: "failed",
      reason: `Editly cannot send to ${SOCIAL_LABEL[platform] ?? post.platform} yet. Nothing was posted.`,
    };
  }

  const key = await filePathFor(post);
  if (!key) {
    return {
      kind: "failed",
      reason: "The finished video for this post could not be found. Nothing was posted.",
    };
  }

  const credential = await credentialFor(post.accountId);
  if (!credential) {
    return { kind: "failed", reason: "That account was disconnected before this went out." };
  }

  /*
    Imported here rather than at the top of the file, and it is the same reason
    the habits reader defers its database: `storage.ts` throws on import when
    `SUPABASE_URL` is unset, and everything above this line — which platform can
    be sent to, whether the file exists, whether the account is still there — is
    a decision a suite should be able to check without credentials. The
    credentials are needed to *send*, and this is where sending starts.
  */
  const { downloadObject } = await import("./storage.js");
  const { objectStoreFrom } = await import("@workspace/object-store");

  const work = await mkdtemp(path.join(tmpdir(), "editly-post-"));
  try {
    const token = await usableToken(post.accountId, platform, credential);
    let landed: Published;
    if (uploader.takes === "url") {
      /*
        Nothing is downloaded for these two. Meta fetches the file itself, so
        the worker's part is a link it can read without a credential of ours —
        signed by the object store, short-lived, and long enough to outlive
        Meta's own fetch and transcode.
      */
      const videoUrl = await objectStoreFrom().signedGet(key, LINK_SECONDS);
      if (!videoUrl) {
        return {
          kind: "failed",
          reason: "The finished video could not be made readable for this platform. Nothing was posted.",
        };
      }
      landed = await uploader.send({
        videoUrl,
        caption: post.caption,
        hashtags: post.hashtags,
        accessToken: token,
      });
    } else {
      const file = path.join(work, "post.mp4");
      await downloadObject(key, file);
      landed = await uploader.send({
        file,
        caption: post.caption,
        hashtags: post.hashtags,
        accessToken: token,
      });
    }
    return { kind: "published", externalPostId: landed.externalPostId, externalUrl: landed.externalUrl };
  } catch (error) {
    /*
      Three kinds, and they read differently to whoever is looking.

      A token problem is something the person fixes by reconnecting, and the
      account row already says so. A platform refusal is the platform's own
      sentence. Anything else is ours, and saying "nothing was posted" matters
      more than saying what broke — because the first question after a failed
      post is always whether it went out twice.
    */
    if (error instanceof TokenError) return { kind: "failed", reason: error.message };
    if (error instanceof PublishError) {
      return { kind: "failed", reason: `${SOCIAL_LABEL[platform]} refused it: ${error.message}` };
    }
    return {
      kind: "failed",
      reason: "Something went wrong on our side while sending this. Nothing was posted.",
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * One pass. Returns what it did, for the log line.
 *
 * Nothing here throws on a single bad post: one destination failing is the
 * ordinary case this feature was built around, and it must not stop the other
 * four from going.
 */
export async function publishDuePosts(now: Date = new Date()): Promise<{
  claimed: number;
  published: number;
  failed: number;
  missed: number;
}> {
  const posts = await claimDuePosts(now);
  let published = 0;
  let failed = 0;
  let missed = 0;

  for (const post of posts) {
    const refusal = refusalToSend(post, now);
    if (refusal) {
      await settle(post.id, refusal);
      if (refusal.kind === "missed") missed += 1;
      else failed += 1;
      continue;
    }

    const outcome = await send(post);
    await settle(post.id, outcome);
    if (outcome.kind === "published") published += 1;
    else if (outcome.kind === "missed") missed += 1;
    else failed += 1;
  }

  return { claimed: posts.length, published, failed, missed };
}
