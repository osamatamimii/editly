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
import { eq } from "drizzle-orm";
import {
  db,
  projectsTable,
  messagesTable,
  exportsTable,
  jobsTable,
  subscriptionsTable,
} from "@workspace/db";
import { currentUserId } from "../middlewares/auth";
import { deleteAccount } from "../lib/account-deletion";
import { deleteProjectObjects, storageAdminConfigured, deleteAuthUser } from "../lib/storage";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.delete("/account", async (req, res): Promise<void> => {
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

    removeObjects: (projectId) => deleteProjectObjects(userId, projectId),

    // None of these tables has a foreign key — ownership is denormalised onto
    // every row precisely so that no query here needs a join — so this order is
    // about what a partial failure leaves behind, not about constraints.
    // Children first: a job whose project is gone is unreachable garbage, a
    // project whose jobs are gone is merely a project with no history.
    removeRows: async () => {
      await db.delete(jobsTable).where(eq(jobsTable.userId, userId));
      await db.delete(exportsTable).where(eq(exportsTable.userId, userId));
      await db.delete(messagesTable).where(eq(messagesTable.userId, userId));
      await db.delete(projectsTable).where(eq(projectsTable.userId, userId));
      await db.delete(subscriptionsTable).where(eq(subscriptionsTable.userId, userId));
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
