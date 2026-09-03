/**
 * Removing everything one account owns, in the one order that is safe.
 *
 * Extracted from the delete-my-account route the day a second caller appeared:
 * Shopify's `shop/redact` webhook, which is a legal obligation with a
 * thirty-day clock on it and asks for exactly the same thing. Two lists of
 * tables to delete from is a list that eventually gets a table added to one of
 * them, and the half that was forgotten is the half nobody notices, because
 * what is left behind is invisible by definition.
 *
 * That is not hypothetical here. This file was first written against a shorter
 * list, and by the time it landed the route had grown five more tables and a
 * second storage sweep. Had the two stayed apart, a shop's erasure would have
 * left its social tokens and its scheduled posts behind while answering that
 * everything was gone.
 *
 * The order is the interesting part. Children first: a job whose project is
 * gone is still the record of minutes produced, while a project whose jobs are
 * gone is a project whose bill has been forgotten. Storage before rows,
 * because rows are what name the objects: deleting them first leaves bytes on
 * our disks that nothing points at.
 *
 * `deleteAccount` in `account-deletion.ts` is what enforces that order and
 * refuses when storage cannot be reached. This file only says what the steps
 * are, so the module holding the decisions stays free of a database and
 * therefore testable without one.
 */
import { eq, sql } from "drizzle-orm";
import {
  db,
  projectsTable,
  jobsTable,
  messagesTable,
  exportsTable,
  subscriptionsTable,
  scheduledPostsTable,
  socialAccountsTable,
  captionFacesTable,
  renderFollowupsTable,
} from "@workspace/db";
import type { DeletionSteps } from "./account-deletion";
import {
  deleteProjectObjects,
  deleteAccountObjects,
  storageAdminConfigured,
  deleteAuthUser,
} from "./storage";

export interface ErasureOptions {
  /**
   * Whether there is a sign-in to remove.
   *
   * A person has one. A Shopify shop does not: its account id is derived from
   * the domain and no `auth.users` row was ever made for it, so "the login
   * survived" would be a note about something that never existed. Reported as
   * removed in that case, because nothing is left — which is the true answer to
   * the question that note is asking.
   */
  hasLogin: boolean;
}

export function erasureStepsFor(userId: string, options: ErasureOptions): DeletionSteps {
  return {
    storageConfigured: storageAdminConfigured,

    listProjects: async () =>
      (await db.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.userId, userId))).map(
        (row) => row.id,
      ),

    removeObjects: async (projectId) => (await deleteProjectObjects(userId, projectId)).removed,

    // Uploaded caption faces live at `${userId}/fonts/…`, outside every
    // project, so the per-project sweep above walks straight past them.
    removeAccountObjects: async () => (await deleteAccountObjects(userId)).removed,

    // This comment used to say none of these tables has a foreign key. Three of
    // them do, and one of those — jobs cascading from projects — was quietly
    // undoing the rule that a render which happened stays counted. Migration
    // 0011 removed it; messages and exports still cascade, which is correct and
    // makes their explicit deletion below a belt to that braces.
    //
    // Ownership is denormalised onto every row so that no query here needs a
    // join, so this order is about what a partial failure leaves behind rather
    // than about constraints.
    removeRows: async () => {
      await db.delete(jobsTable).where(eq(jobsTable.userId, userId));
      await db.delete(exportsTable).where(eq(exportsTable.userId, userId));
      await db.delete(messagesTable).where(eq(messagesTable.userId, userId));
      await db.delete(projectsTable).where(eq(projectsTable.userId, userId));
      await db.delete(subscriptionsTable).where(eq(subscriptionsTable.userId, userId));

      /*
        And the five tables that were never on the original list.

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

    removeLogin: () => (options.hasLogin ? deleteAuthUser(userId) : Promise.resolve(true)),
  };
}
