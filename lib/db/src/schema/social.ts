import {
  pgTable,
  text,
  integer,
  timestamp,
  uuid,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * The accounts somebody has connected, and the posts they have scheduled to
 * them.
 *
 * A finished edit is not the end of the job. The person still has to download
 * it, open five apps, upload it five times and write the caption five times —
 * which is most of the work they were trying to avoid and all of the reason a
 * good clip sits in a folder for a week. So the product ends where the work
 * ends: the edit goes out.
 *
 * Two tables, and the split matters. An **account** is a standing connection —
 * a token, a handle, a platform — and there can be several per platform,
 * because people run more than one. A **post** is one edit going to one
 * account at one time, which is why a single "publish to four places" is four
 * rows: they succeed and fail independently, and telling somebody "it went out"
 * when it went out to three of four is the kind of lie this codebase keeps
 * finding.
 */

/**
 * One connected account.
 *
 * The token lives here and nowhere else. It is never returned by any endpoint
 * — the API answers with the handle and the platform and whether the
 * connection still works, which is everything a person needs to decide what to
 * post where and nothing an attacker could use. `select()` on this table
 * without naming columns is therefore a bug; every read in `routes/social.ts`
 * names them.
 */
export const socialAccountsTable = pgTable(
  "social_accounts",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id").notNull(),

    /** instagram | facebook | tiktok | x | snapchat | youtube */
    platform: text("platform").notNull(),

    /**
     * The account's id *on that platform*, which is what the platform's API
     * takes and what makes reconnecting the same account an update rather than
     * a duplicate. The handle changes; this does not.
     */
    externalId: text("external_id").notNull(),

    /** @handle, for the person. Refreshed on every reconnect. */
    handle: text("handle").notNull(),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),

    /**
     * The credential, and the only reason this table is not readable by the
     * browser under any policy.
     */
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    /** When the access token stops working. Null means it does not expire. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    /**
     * What the platform said the last time we tried to use it.
     *
     * A token that has been revoked is indistinguishable from a working one
     * until something is posted with it, and finding out at the moment a
     * scheduled post was due is finding out too late. Written by the worker
     * and shown in the UI, so "reconnect Instagram" appears before the post
     * that needed it rather than after.
     */
    status: text("status").notNull().default("ok"),
    statusDetail: text("status_detail"),

    /**
     * Which Facebook Page this connection posts to, and its own token.
     *
     * Both Meta destinations go through a Page: a Facebook video is posted with
     * the *Page's* token rather than the user's, and an Instagram Reel goes to
     * the business account attached to a Page. `identityFor` stores a Facebook
     * *user*, which neither of them will accept, so these were resolved on
     * every send — two Graph calls per post for a pair of values that do not
     * change between posts.
     *
     * Worse than the cost: the resolution took the *first* Page Meta listed.
     * Somebody managing two Pages got their video on whichever one Meta ordered
     * first, and that ordering is not a promise. Nothing failed; only the owner
     * could tell it was the wrong Page.
     *
     * Null on a row connected before this existed, and null while somebody who
     * manages several Pages has not chosen one yet. The renderer falls back to
     * resolving from the token in both cases, so nothing that worked stops.
     */
    pageId: text("page_id"),
    pageName: text("page_name"),
    pageAccessToken: text("page_access_token"),
    /** The Instagram business account attached to that Page, if there is one. */
    instagramUserId: text("instagram_user_id"),
    /**
     * The Pages this account manages, `{id, name}` only, so the connect screen
     * can ask which one without a round trip to Meta with a token the browser
     * must never see.
     *
     * Without the Page tokens on purpose. This is read to draw a list of
     * choices, and a list of choices does not need credentials in it; the
     * chosen Page's token is fetched from Meta at the moment of choosing.
     */
    pageChoices: jsonb("page_choices").$type<Array<{ id: string; name: string }>>(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("social_accounts_user_idx").on(table.userId),
    // Reconnecting the same account replaces it. Without this, pressing
    // "connect" twice gives you two of the same account and a post scheduled
    // to "both" goes out twice.
    uniqueIndex("social_accounts_identity_idx").on(table.userId, table.platform, table.externalId),
  ],
);

/**
 * One edit, going to one account, at one time.
 *
 * Deliberately not "one post to many accounts". Four destinations is four
 * rows, because they fail independently: a token expires on one platform, a
 * file is too long for another, a third rejects the caption. A single row with
 * a list inside it has exactly one status field and would have to lie about at
 * least one of them.
 */
export const scheduledPostsTable = pgTable(
  "scheduled_posts",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id").notNull(),

    /** What is being posted. The export is the finished file. */
    projectId: text("project_id").notNull(),
    exportId: text("export_id"),

    /** Where it is going. Kept even if the account is later disconnected. */
    accountId: text("account_id").notNull(),
    platform: text("platform").notNull(),

    /**
     * The words.
     *
     * Per row rather than per post, because the same clip wants a different
     * caption on a platform with a 280-character limit than on one that reads
     * hashtags. Writing one and copying it everywhere is what the person does
     * today; the point is to stop having to.
     */
    caption: text("caption").notNull().default(""),
    /** ["#editing", "#reels"] — kept apart from the caption so limits can be counted. */
    hashtags: jsonb("hashtags").notNull().default(sql`'[]'::jsonb`),

    /** When it should go out. Stored in UTC; the browser shows local time. */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),

    /**
     * scheduled → publishing → published | failed | cancelled | missed
     *
     * `missed` is its own ending rather than a kind of failure. Nothing went
     * wrong: the post was simply too late to be worth sending, because the
     * publisher was down when it came due. Filing that under "failed" would
     * put it beside expired tokens and rejected captions, which are things to
     * fix; this is a thing to re-schedule.
     */
    status: text("status").notNull().default("scheduled"),

    /** What the platform gave back, so the person can open the post. */
    externalPostId: text("external_post_id"),
    externalUrl: text("external_url"),

    /**
     * Why it did not go out, in words a person can act on.
     *
     * The same rule as `jobs.error`: a platform's raw refusal is a slug and a
     * request id. What goes here is the sentence somebody reads.
     */
    error: text("error"),
    /**
     * How many times the publisher has picked this row up.
     *
     * An integer, and that is not pedantry — it was `text NOT NULL DEFAULT '0'`,
     * which reads perfectly and sorts `'10' < '3'`. A retry ceiling written
     * against it would have let a post that failed ten times keep trying and
     * stopped one that failed three, and every row involved would have looked
     * completely normal.
     */
    attempts: integer("attempts").notNull().default(0),

    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("scheduled_posts_user_idx").on(table.userId),
    index("scheduled_posts_project_idx").on(table.projectId),
    // The publisher's claim query: everything due, oldest first.
    index("scheduled_posts_due_idx").on(table.status, table.scheduledFor),
  ],
);
