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
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { configuredPlatforms, isSocialPlatform, SOCIAL_LABEL } from "@workspace/api-zod";

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
    return {
      kind: "missed",
      reason:
        `This was due at ${post.scheduledFor.toISOString()} and is ${Math.round(lateBy)} minutes late, ` +
        `so it was not sent. Posting it now would put it in front of people at a time you did not choose. ` +
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

    // The send itself. Every platform's client lands here when its credentials
    // do, and until then `refusalToSend` above has already returned for every
    // reachable post — so this branch is unreachable rather than untrue.
    await settle(post.id, {
      kind: "failed",
      reason: "There is no way to send to this platform yet. Nothing was posted.",
    });
    failed += 1;
  }

  return { claimed: posts.length, published, failed, missed };
}
