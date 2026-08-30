/**
 * Connected accounts, and posts scheduled to them.
 *
 * Three things live here and they are deliberately separate:
 *
 *   GET  /social/platforms            what this deployment can post to at all
 *   GET  /social/accounts             what this person has connected
 *   DELETE /social/accounts/:id       disconnect one
 *   GET  /social/posts                what is scheduled, and what happened
 *   POST /social/posts                schedule an edit to one or more accounts
 *   DELETE /social/posts/:id          call one back before it goes
 *
 * The thing that is *not* here is the OAuth dance. Connecting an account means
 * sending somebody to a platform, receiving a code, and exchanging it for a
 * token — and none of the five platforms will issue that token until the app
 * has been reviewed. The code for it belongs beside the credentials it needs,
 * so it is written when they exist; what this file does is make the rest of the
 * product true in the meantime, and say plainly which platforms are off rather
 * than showing a button that cannot work.
 *
 * The token never leaves this process. Every read of `social_accounts` names
 * its columns; `select()` with no argument on that table is a bug, and the one
 * that would leak a credential to a browser.
 */
import { randomUUID } from "crypto";
import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  socialAccountsTable,
  scheduledPostsTable,
  projectsTable,
  exportsTable,
  jobsTable,
} from "@workspace/db";
import { currentUserId } from "../middlewares/auth";
import { rateLimit, LIMITS } from "../lib/rate-limit";
import {
  platformCatalogue,
  isSocialPlatform,
  SOCIAL_LABEL,
  refusalsFor,
  scheduleRefusal,
} from "@workspace/api-zod";

const router: IRouter = Router();

/**
 * The columns of a connected account that may leave this process.
 *
 * Written out rather than `select()`, and this is the only defence that
 * matters: the table holds an access token, and the difference between a
 * feature and an incident is whether somebody remembered to name columns on
 * the one endpoint that got added in a hurry.
 */
const ACCOUNT_COLUMNS = {
  id: socialAccountsTable.id,
  platform: socialAccountsTable.platform,
  handle: socialAccountsTable.handle,
  displayName: socialAccountsTable.displayName,
  avatarUrl: socialAccountsTable.avatarUrl,
  status: socialAccountsTable.status,
  statusDetail: socialAccountsTable.statusDetail,
  createdAt: socialAccountsTable.createdAt,
} as const;

router.get("/social/platforms", async (_req, res): Promise<void> => {
  // No auth-specific data: this is what the *deployment* can do, and it is the
  // same answer for everybody. It is behind the auth middleware anyway because
  // everything under /api is, and there is no reason to widen that.
  res.json({ platforms: platformCatalogue(process.env) });
});

router.get("/social/accounts", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const accounts = await db
    .select(ACCOUNT_COLUMNS)
    .from(socialAccountsTable)
    .where(eq(socialAccountsTable.userId, userId))
    .orderBy(asc(socialAccountsTable.platform), asc(socialAccountsTable.handle));

  res.json({
    accounts: accounts.map((account) => ({
      ...account,
      createdAt: account.createdAt.toISOString(),
    })),
  });
});

router.delete("/social/accounts/:id", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const id = String(req.params.id);

  // Scheduled posts are *not* deleted with the account.
  //
  // They are cancelled, and they say why. Silently dropping them would mean a
  // person who disconnects one account loses a week of scheduling they set up
  // for it and is never told — and the first they would know is a post that
  // did not appear. Cancelling leaves the row, the caption and the reason.
  const [account] = await db
    .select({ id: socialAccountsTable.id, platform: socialAccountsTable.platform })
    .from(socialAccountsTable)
    .where(and(eq(socialAccountsTable.id, id), eq(socialAccountsTable.userId, userId)))
    .limit(1);

  if (!account) {
    res.status(404).json({ error: "That account is not connected." });
    return;
  }

  const cancelled = await db
    .update(scheduledPostsTable)
    .set({
      status: "cancelled",
      error: `${SOCIAL_LABEL[isSocialPlatform(account.platform) ? account.platform : "x"]} was disconnected before this went out.`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(scheduledPostsTable.userId, userId),
        eq(scheduledPostsTable.accountId, id),
        eq(scheduledPostsTable.status, "scheduled"),
      ),
    )
    .returning({ id: scheduledPostsTable.id });

  await db
    .delete(socialAccountsTable)
    .where(and(eq(socialAccountsTable.id, id), eq(socialAccountsTable.userId, userId)));

  res.json({ disconnected: true, cancelledPosts: cancelled.length });
});

router.get("/social/posts", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const projectId = typeof req.query["projectId"] === "string" ? req.query["projectId"] : null;

  const where = projectId
    ? and(eq(scheduledPostsTable.userId, userId), eq(scheduledPostsTable.projectId, projectId))
    : eq(scheduledPostsTable.userId, userId);

  const posts = await db
    .select()
    .from(scheduledPostsTable)
    .where(where)
    .orderBy(desc(scheduledPostsTable.scheduledFor))
    .limit(200);

  res.json({
    posts: posts.map((post) => ({
      id: post.id,
      projectId: post.projectId,
      exportId: post.exportId,
      accountId: post.accountId,
      platform: post.platform,
      caption: post.caption,
      hashtags: Array.isArray(post.hashtags) ? (post.hashtags as string[]) : [],
      scheduledFor: post.scheduledFor.toISOString(),
      status: post.status,
      externalUrl: post.externalUrl,
      error: post.error,
      publishedAt: post.publishedAt ? post.publishedAt.toISOString() : null,
    })),
  });
});

/**
 * Schedule one edit to one or more accounts.
 *
 * One request, several rows — and either all of them are written or none is.
 * A partial success here is the worst answer available: the person is told
 * "scheduled", three of four went out, and the fourth is missing with nothing
 * anywhere saying so. So every destination is checked against its platform's
 * rules *before* anything is written, and the whole request is refused with the
 * reasons, per platform, if any of them cannot go.
 */
router.post("/social/posts", rateLimit(LIMITS.createProject), async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const body = req.body as {
    projectId?: unknown;
    exportId?: unknown;
    accountIds?: unknown;
    caption?: unknown;
    hashtags?: unknown;
    /** Per-platform overrides: { x: "shorter words" }. */
    captions?: unknown;
    scheduledFor?: unknown;
  };

  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  const accountIds = Array.isArray(body.accountIds)
    ? body.accountIds.filter((id): id is string => typeof id === "string")
    : [];
  const caption = typeof body.caption === "string" ? body.caption : "";
  const hashtags = Array.isArray(body.hashtags)
    ? body.hashtags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const overrides =
    body.captions && typeof body.captions === "object"
      ? (body.captions as Record<string, unknown>)
      : {};

  if (!projectId || accountIds.length === 0) {
    res.status(400).json({ error: "Pick a project and at least one account." });
    return;
  }

  const when = new Date(String(body.scheduledFor ?? ""));
  const whenRefusal = scheduleRefusal(when);
  if (whenRefusal) {
    res.status(400).json({ error: whenRefusal });
    return;
  }

  // Ownership, before anything else. A project id is not a capability.
  const [project] = await db
    .select({
      id: projectsTable.id,
      editedWidth: projectsTable.editedWidth,
      editedHeight: projectsTable.editedHeight,
      width: projectsTable.width,
      height: projectsTable.height,
    })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)))
    .limit(1);

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const accounts = await db
    .select({
      id: socialAccountsTable.id,
      platform: socialAccountsTable.platform,
      handle: socialAccountsTable.handle,
      status: socialAccountsTable.status,
    })
    .from(socialAccountsTable)
    .where(and(eq(socialAccountsTable.userId, userId), inArray(socialAccountsTable.id, accountIds)));

  if (accounts.length !== accountIds.length) {
    res.status(404).json({ error: "One of those accounts is not connected any more." });
    return;
  }

  // The finished file, when there is one. Its shape and length are what the
  // platforms judge, not the source clip's — a 16:9 take reframed to 9:16 is
  // vertical, and refusing it on the source's shape would refuse the very
  // thing the product just did.
  const [finished] = body.exportId
    ? await db
        .select({
          id: exportsTable.id,
          // Joined rather than looked up after, because the length of the
          // *rendered* file is the number the platforms judge and it lives on
          // the job. The route used to use `projects.duration` — the upload's
          // length, written by the browser — so a three-minute take cut to
          // ninety seconds was refused for X on a limit it does not break.
          // That failure has no symptom: nothing errors, the person simply
          // cannot post something that would have been fine.
          outputSeconds: jobsTable.outputSeconds,
          outputSecondsSource: jobsTable.outputSecondsSource,
        })
        .from(exportsTable)
        .leftJoin(jobsTable, eq(jobsTable.id, exportsTable.jobId))
        .where(and(eq(exportsTable.id, String(body.exportId)), eq(exportsTable.userId, userId)))
        .limit(1)
    : [];

  const width = project.editedWidth ?? project.width ?? null;
  const height = project.editedHeight ?? project.height ?? null;
  /**
   * The finished edit's length when it was really measured, and null when it
   * was not.
   *
   * Null, deliberately, rather than falling back to the source. `refusalsFor`
   * treats an unknown duration as no reason to refuse — because refusing on a
   * field we do not have blocks correct posts for a reason nobody can see —
   * and the source length is not a worse measurement of the edit, it is a
   * measurement of a different file.
   */
  const durationSeconds =
    finished?.outputSecondsSource === "probe" ? (finished.outputSeconds ?? null) : null;

  const refusals: Array<{ accountId: string; handle: string; platform: string; message: string }> = [];
  for (const account of accounts) {
    if (!isSocialPlatform(account.platform)) continue;
    if (account.status !== "ok") {
      refusals.push({
        accountId: account.id,
        handle: account.handle,
        platform: account.platform,
        message: `${SOCIAL_LABEL[account.platform]} needs reconnecting before anything can go out to ${account.handle}.`,
      });
      continue;
    }
    const captionFor =
      typeof overrides[account.platform] === "string"
        ? (overrides[account.platform] as string)
        : caption;
    for (const refusal of refusalsFor({
      platform: account.platform,
      caption: captionFor,
      hashtags,
      durationSeconds,
      width,
      height,
    })) {
      refusals.push({
        accountId: account.id,
        handle: account.handle,
        platform: account.platform,
        message: refusal.message,
      });
    }
  }

  if (refusals.length > 0) {
    // 400 with the reasons, not a partial write. See the note above the route.
    res.status(400).json({
      error: "Some of these cannot go out as written.",
      refusals,
    });
    return;
  }

  const now = new Date();
  const rows = accounts.map((account) => ({
    id: randomUUID(),
    userId,
    projectId,
    exportId: finished?.id ?? null,
    accountId: account.id,
    platform: account.platform,
    caption:
      typeof overrides[account.platform] === "string"
        ? (overrides[account.platform] as string)
        : caption,
    hashtags,
    scheduledFor: when,
    status: "scheduled",
    createdAt: now,
    updatedAt: now,
  }));

  const written = await db.insert(scheduledPostsTable).values(rows).returning({
    id: scheduledPostsTable.id,
    platform: scheduledPostsTable.platform,
  });

  res.status(201).json({ scheduled: written });
});

router.delete("/social/posts/:id", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const id = String(req.params.id);

  // Only a post that has not left. "publishing" is a row the worker is holding
  // right now, and cancelling it here would leave the two of us disagreeing
  // about whether it went out.
  const cancelled = await db
    .update(scheduledPostsTable)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(scheduledPostsTable.id, id),
        eq(scheduledPostsTable.userId, userId),
        eq(scheduledPostsTable.status, "scheduled"),
      ),
    )
    .returning({ id: scheduledPostsTable.id });

  if (cancelled.length === 0) {
    res.status(409).json({
      error: "That post has already gone out or is going out now, so it cannot be called back.",
    });
    return;
  }

  res.json({ cancelled: true });
});

export default router;
