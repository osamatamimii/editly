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
  assetsTable,
  clipsTable,
  billingEventsTable,
  comprehensionsTable,
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
import { currentUserId, currentUserEmail } from "../middlewares/auth";
import { rateLimit, LIMITS } from "../lib/rate-limit";
import { deleteAccount } from "../lib/account-deletion";
import {
  deleteAccountObjects,
  deleteProjectObjects,
  listAccountObjects,
  storageAdminConfigured,
  deleteAuthUser,
} from "../lib/storage";
import {
  redactRows,
  exportFilename,
  NOT_INCLUDED,
  type AccountExport,
} from "../lib/account-export";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Everything we hold about the person asking, as one file.
 *
 * The header of this file has said since it was written that "there was no way
 * at all to get your data out of here", and it was describing deletion. The
 * other half of that sentence is the right of access, and it is the one people
 * actually exercise: "what do you have on me" is a question a customer, a
 * platform reviewer and a regulator can each ask, and the answer was somebody
 * reading rows out of a database by hand.
 *
 * Every table is queried by `userId` and nothing else. There is no join to a
 * project and no `IN` over ids gathered elsewhere, because that is how an
 * export grows a path to a row that is not the caller's: one query per table,
 * one predicate, the same one every time.
 *
 * `redactRows` is not optional decoration. See lib/account-export.ts — an
 * export containing a live YouTube refresh token is a credential leak wearing a
 * compliance feature's clothes.
 */
router.get("/account/export", rateLimit(LIMITS.dataExport), async (req, res): Promise<void> => {
  const userId = currentUserId(req);

  const [projects, messages, jobs, exports, subscriptions, socialAccounts, scheduledPosts,
         captionFaces, followups, assets, clips, billing, comprehensions] = await Promise.all([
    db.select().from(projectsTable).where(eq(projectsTable.userId, userId)),
    db.select().from(messagesTable).where(eq(messagesTable.userId, userId)),
    db.select().from(jobsTable).where(eq(jobsTable.userId, userId)),
    db.select().from(exportsTable).where(eq(exportsTable.userId, userId)),
    db.select().from(subscriptionsTable).where(eq(subscriptionsTable.userId, userId)),
    db.select().from(socialAccountsTable).where(eq(socialAccountsTable.userId, userId)),
    db.select().from(scheduledPostsTable).where(eq(scheduledPostsTable.userId, userId)),
    db.select().from(captionFacesTable).where(eq(captionFacesTable.userId, userId)),
    db.select().from(renderFollowupsTable).where(eq(renderFollowupsTable.userId, userId)),
    db.select().from(assetsTable).where(eq(assetsTable.userId, userId)),
    db.select().from(clipsTable).where(eq(clipsTable.userId, userId)),
    db.select().from(billingEventsTable).where(eq(billingEventsTable.userId, userId)),
    db.select().from(comprehensionsTable).where(eq(comprehensionsTable.userId, userId)),
  ]);

  /*
    The files, or a refusal.

    A listing that failed and came back short would be an export saying we hold
    fewer of somebody's videos than we do — the one failure this feature cannot
    have, because the whole point is that the answer is complete. So the
    listing throws, and this refuses rather than shipping a document with a
    quiet gap in it.
  */
  let files: string[] = [];
  try {
    files = await listAccountObjects(userId, projects.map((project) => project.id));
  } catch (error) {
    logger.error({ err: error, userId }, "could not list storage for a data export");
    res.status(503).json({
      error:
        "We could not read the list of your files just now, and an export that is missing some of them would be worse than none. Please try again in a few minutes.",
    });
    return;
  }

  const body: AccountExport = {
    exportedAt: new Date().toISOString(),
    account: { id: userId, email: currentUserEmail(req) },
    notIncluded: NOT_INCLUDED,
    tables: {
      projects: redactRows(projects),
      messages: redactRows(messages),
      renders: redactRows(jobs),
      exports: redactRows(exports),
      subscription: redactRows(subscriptions),
      socialAccounts: redactRows(socialAccounts),
      scheduledPosts: redactRows(scheduledPosts),
      captionFaces: redactRows(captionFaces),
      renderFollowups: redactRows(followups),
      assets: redactRows(assets),
      clips: redactRows(clips),
      billingEvents: redactRows(billing),
      comprehensions: redactRows(comprehensions),
    },
    files,
  };

  // Named, so a browser saves it rather than rendering it, and dated, so two
  // exports in the same folder are two files.
  res.setHeader("Content-Disposition", `attachment; filename="${exportFilename()}"`);
  res.json(body);
});

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
