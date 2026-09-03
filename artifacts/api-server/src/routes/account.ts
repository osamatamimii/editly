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
import { erasureStepsFor } from "../lib/user-erasure";
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

  /*
    The steps live in `lib/user-erasure.ts` now, because a second caller
    appeared: Shopify's `shop/redact` webhook asks for exactly this, with a
    thirty-day legal clock on it. Two lists of tables to delete from is a list
    that eventually has a table added to one of them.
  */
  const result = await deleteAccount(erasureStepsFor(userId, { hasLogin: true }));

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
