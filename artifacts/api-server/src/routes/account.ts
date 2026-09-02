/**
 * Leaving.
 *
 * Every other route in this folder helps somebody use the product. This one
 * helps them stop, and it was the last obvious gap: until now there was no way
 * at all to get your data out of here, and "email us" is not a delete button.
 *
 * The decisions live in `lib/account-deletion` — what order things go in, and
 * when to refuse rather than half-finish — because those are the properties
 * that matter and they are invisible in an integration test that passes. This
 * file is the adapter: it says what each step *is* for this deployment, and
 * nothing about what they mean.
 */
import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import {
  db,
  projectsTable,
  messagesTable,
  exportsTable,
  jobsTable,
  subscriptionsTable,
  scheduledPostsTable,
  socialAccountsTable,
  captionFacesTable,
  renderFollowupsTable,
} from "@workspace/db";
import { currentUserId } from "../middlewares/auth";
import { rateLimit, LIMITS } from "../lib/rate-limit";
import { deleteAccount } from "../lib/account-deletion";
import { deleteAccountObjects, deleteProjectObjects, storageAdminConfigured, deleteAuthUser } from "../lib/storage";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/*
  Limited, which it was not.

  One `DELETE` with no confirmation step, no re-authentication and no soft
  delete window is already the most irreversible thing a person can do here.
  Without a limiter beside it, it was also the cheapest to trigger in a loop —
  and with no `X-Frame-Options` on the app until this week, one clickjack away
  from being triggered by somebody else.
*/
router.delete("/account", rateLimit(LIMITS.write), async (req, res): Promise<void> => {
  const userId = currentUserId(req);

  const result = await deleteAccount({
    storageConfigured: storageAdminConfigured,

    listProjects: async () =>
      (
        await db
          .select({ id: projectsTable.id })
          .from(projectsTable)
          .where(eq(projectsTable.userId, userId))
      ).map((row) => row.id),

    removeObjects: async (projectId) => (await deleteProjectObjects(userId, projectId)).removed,

    removeAccountObjects: async () => (await deleteAccountObjects(userId)).removed,

    // This comment used to say none of these tables has a foreign key. Three of
    // them do, and one of those — jobs cascading from projects — was quietly
    // undoing the rule that a render which happened stays counted. Migration
    // 0011 removed it; messages and exports still cascade, which is correct
    // and makes their explicit deletion below a belt to that braces.
    //
    // Ownership is denormalised onto every row so that no query here needs a
    // join, so this order is about what a partial failure leaves behind rather
    // than about constraints. Children first: a job whose project is gone is
    // still the record of minutes produced, a project whose jobs are gone is a
    // project whose bill has been forgotten.
    removeRows: async () => {
      await db.delete(jobsTable).where(eq(jobsTable.userId, userId));
      await db.delete(exportsTable).where(eq(exportsTable.userId, userId));
      await db.delete(messagesTable).where(eq(messagesTable.userId, userId));
      await db.delete(projectsTable).where(eq(projectsTable.userId, userId));
      await db.delete(subscriptionsTable).where(eq(subscriptionsTable.userId, userId));

      /*
        And the five tables that were never on this list.

        None of them has a foreign key to anything — ownership is denormalised
        onto every row so no query needs a join — so nothing cascaded and
        nothing complained. What survived a deletion was:

        `social_accounts`, which holds **live access and refresh tokens** for
        YouTube, Meta, TikTok, X and Snapchat. Retaining a platform credential
        after the person deleted their account breaks every one of those
        platforms' developer terms, and it is exactly what an app review looks
        for. It is also the one item here that is somebody else's account.

        `scheduled_posts`, which is a queue of things to publish on their
        behalf — rows that a sweep could, in principle, act on.

        `caption_faces`, `render_followups`, and their mail rows, which are
        smaller and no less theirs.

        The account screen says "every project, every upload and every render,
        removed for good, and there is no copy kept". It was not true.
      */
      await db.delete(scheduledPostsTable).where(eq(scheduledPostsTable.userId, userId));
      await db.delete(socialAccountsTable).where(eq(socialAccountsTable.userId, userId));
      await db.delete(captionFacesTable).where(eq(captionFacesTable.userId, userId));
      await db.delete(renderFollowupsTable).where(eq(renderFollowupsTable.userId, userId));
      await db.execute(sql`delete from mail_sends where user_id = ${userId}`);
      await db.execute(sql`delete from mail_settings where user_id = ${userId}`);
    },

    removeLogin: () => deleteAuthUser(userId),
  });

  if (!result.deleted) {
    logger.warn({ userId }, "account deletion refused: storage credentials are not configured");
    res.status(result.status).json({ error: result.error });
    return;
  }

  logger.info(
    { userId, projects: result.projects, loginRemoved: result.loginRemoved },
    "account deleted",
  );
  res.json(result);
});

export default router;
