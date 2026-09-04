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
import { and, asc, count, desc, eq, inArray, notInArray } from "drizzle-orm";
import {
  db,
  socialAccountsTable,
  scheduledPostsTable,
  projectsTable,
  exportsTable,
  jobsTable,
} from "@workspace/db";
import { currentUserId } from "../middlewares/auth";
import { rateLimit, rateLimitByIp, LIMITS } from "../lib/rate-limit";
import {
  SCHEDULED_POSTS_LIMIT,
  platformCatalogue,
  isSocialPlatform,
  SOCIAL_LABEL,
  refusalsFor,
  scheduleRefusal,
  configuredPlatforms,
  SchedulePostBody,
} from "@workspace/api-zod";
import { badRequest } from "../lib/bad-request";
import {
  signState,
  readState,
  pkcePair,
  bindingNonce,
  stateBoundToBrowser,
  authorizeUrlFor,
  exchangeCode,
  ENDPOINTS,
  VERIFIER_COOKIE,
  BINDING_COOKIE,
} from "../lib/social-oauth";
import {
  identityFor,
  isMeta,
  metaTargetsFor,
  chooseSinglePage,
  pageChoicesFrom,
  metaPagesFor,
} from "../lib/social-identity";
import { appOrigin } from "../lib/allowed-origins";

const router: IRouter = Router();

/**
 * The one route here that cannot be behind authentication.
 *
 * An OAuth callback is a browser navigation *from the platform*: it carries no
 * bearer token and never can. So it is its own router, mounted before
 * `requireAuth` — the same shape the billing webhook has, and for the same
 * reason. Who this is comes from the signed state instead, which is why that
 * state is an HMAC and not a nonce in a table somebody has to clean up.
 */
export const socialCallbackRouter: IRouter = Router();

/** One cookie out of the header, without a dependency for it. */
function cookieFrom(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}


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
  /*
    Which Page a Meta connection posts to, and the Pages it could post to.

    Named one at a time like everything else here, and the tokens are not among
    them: `page_access_token` is a credential and this response is read by a
    browser. What the screen needs is a name to show and a list to choose from.
  */
  pageId: socialAccountsTable.pageId,
  pageName: socialAccountsTable.pageName,
  pageChoices: socialAccountsTable.pageChoices,
  createdAt: socialAccountsTable.createdAt,
} as const;

router.get("/social/platforms", async (_req, res): Promise<void> => {
  // No auth-specific data: this is what the *deployment* can do, and it is the
  // same answer for everybody. It is behind the auth middleware anyway because
  // everything under /api is, and there is no reason to widen that.
  res.json({ platforms: platformCatalogue(process.env) });
});


/**
 * Start connecting an account.
 *
 * Returns a URL rather than redirecting, and that is the whole reason this is
 * a JSON endpoint. The browser reaches every route in this API with an
 * `Authorization` header, and a 302 from `fetch` is followed with that header
 * still attached — which would send this person's Editly bearer token to
 * Facebook. The page opens the URL itself.
 */
router.post("/social/connect/:platform", rateLimit(LIMITS.schedulePost), async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const platform = req.params["platform"];
  if (!isSocialPlatform(platform)) {
    res.status(404).json({ error: "No such platform." });
    return;
  }
  if (!configuredPlatforms(process.env)[platform]) {
    // The same answer the catalogue already gives, said again at the moment
    // somebody presses the button — because a screen can be stale and a
    // "Connect" that silently does nothing is worse than one that explains.
    res.status(503).json({
      error: `${SOCIAL_LABEL[platform]} is not switched on for this deployment yet.`,
    });
    return;
  }

  /*
    A nonce that binds this flow to this browser.

    The signed state proves who it was minted for; it does not prove that the
    browser finishing the flow is the one that started it, and without that a
    valid state can be walked into a victim's browser so their account's tokens
    are written under the attacker's id. So a random nonce goes into the state
    *and* into an httpOnly cookie here, and the callback refuses a state whose
    nonce the returning browser cannot present. Set for every platform, not just
    the two that use PKCE — see `StateClaims.nonce`.
  */
  const nonce = bindingNonce();
  res.cookie(BINDING_COOKIE, nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 10 * 60 * 1000,
    path: "/api/social",
  });

  const state = signState({ userId, platform, expiresAt: Date.now() + 10 * 60 * 1000, nonce });
  let challenge: string | null = null;
  if (ENDPOINTS[platform].pkce) {
    const pair = pkcePair();
    challenge = pair.challenge;
    /*
      httpOnly, and that is what makes PKCE worth doing at all. A verifier
      readable by script, or carried in the state on the URL, has been seen by
      the browser's history, the referrer and every proxy on the path — which
      is the exact interception PKCE exists to survive.

      `lax` rather than `strict`: the callback arrives as a top-level
      navigation *from the platform*, and `strict` would withhold the cookie on
      exactly that request.
    */
    res.cookie(VERIFIER_COOKIE, pair.verifier, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 10 * 60 * 1000,
      path: "/api/social",
    });
  }

  res.json({ url: authorizeUrlFor(platform, state, challenge) });
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

/**
 * Which Page this Meta connection posts to.
 *
 * The screen asks only when there is something to ask: one Page is the answer
 * and is stored at connection. Several is a question, and this is where the
 * answer lands.
 *
 * The Page's *token* is fetched from Meta here rather than taken from the
 * request, and that is the whole security shape of this endpoint. The browser
 * sends an id it was offered; the server goes to Meta with the connection's own
 * credential and takes the token for the Page with that id, or refuses. A page
 * token arriving from a browser would be a credential this server accepted from
 * outside, which is not a thing that should ever be possible.
 */
router.patch("/social/accounts/:id/page", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const id = String(req.params.id);
  const pageId = typeof req.body?.pageId === "string" ? req.body.pageId : "";
  if (!pageId) {
    res.status(400).json({ error: "Which Page?" });
    return;
  }

  const [account] = await db
    .select({
      id: socialAccountsTable.id,
      platform: socialAccountsTable.platform,
      accessToken: socialAccountsTable.accessToken,
    })
    .from(socialAccountsTable)
    .where(and(eq(socialAccountsTable.id, id), eq(socialAccountsTable.userId, userId)))
    .limit(1);

  if (!account) {
    res.status(404).json({ error: "That account is not connected." });
    return;
  }
  if (!isSocialPlatform(account.platform) || !isMeta(account.platform)) {
    res.status(400).json({ error: "Only Facebook and Instagram post through a Page." });
    return;
  }

  try {
    const pages = await metaPagesFor(account.accessToken);
    const page = pages.find((candidate) => candidate.id === pageId);
    if (!page) {
      /*
        Re-read rather than trusted, so an id that is no longer one of this
        account's Pages is refused. Between connecting and choosing, somebody
        can lose access to a Page — and writing the id anyway would give a
        connection that looks settled and fails at the moment it is used.
      */
      res.status(400).json({ error: "That Page is not one this account manages any more." });
      return;
    }

    await db
      .update(socialAccountsTable)
      .set({
        pageId: page.id,
        pageName: page.name,
        pageAccessToken: page.token,
        instagramUserId: page.instagramUserId,
        status: "ok",
        statusDetail: null,
        updatedAt: new Date(),
      })
      .where(and(eq(socialAccountsTable.id, id), eq(socialAccountsTable.userId, userId)));

    res.json({ pageId: page.id, pageName: page.name });
  } catch (error) {
    // Meta's own words, like everywhere else here: "this token has expired" is
    // something to act on and "could not save" is not.
    res.status(502).json({ error: String((error as Error).message ?? "Meta could not be asked just now.") });
  }
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

/**
 * How many posts one read may return, and which ones they are.
 *
 * The cap itself is fine — nobody reads a thousand rows. What was wrong is the
 * two things a cap has to get right and this one got both backwards.
 *
 * *Which end.* The list was ordered newest-first across everything, so an
 * account with three hundred future posts got the three hundredth-furthest
 * first and the ones going out tonight fell off the end. On the screen whose
 * two questions are "is that still going out" and "can I stop it", the rows it
 * dropped were exactly the answerable ones. So what has not gone yet is read
 * separately and soonest-first, and history fills whatever room is left,
 * newest-first — the only ordering where the top of the list is the next thing
 * to happen and the rest is a receipt.
 *
 * *And saying so.* A list that quietly stops is indistinguishable from having
 * lost something. `total` is counted, not inferred from the length, because
 * `posts.length === 200` is also what exactly two hundred posts looks like.
 */
const POSTS_LIMIT = SCHEDULED_POSTS_LIMIT;

/** Not yet gone: still cancellable, still worth leading with. */
const PENDING_STATUSES = ["scheduled", "publishing"];

router.get("/social/posts", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const projectId = typeof req.query["projectId"] === "string" ? req.query["projectId"] : null;

  const where = projectId
    ? and(eq(scheduledPostsTable.userId, userId), eq(scheduledPostsTable.projectId, projectId))
    : eq(scheduledPostsTable.userId, userId);

  const pending = await db
    .select()
    .from(scheduledPostsTable)
    .where(and(where, inArray(scheduledPostsTable.status, PENDING_STATUSES)))
    .orderBy(asc(scheduledPostsTable.scheduledFor))
    .limit(POSTS_LIMIT);

  // If somebody really has two hundred posts queued, they see two hundred
  // queued posts and no history. That is the right way round: history can be
  // read later, tonight cannot.
  const roomLeft = POSTS_LIMIT - pending.length;
  const history =
    roomLeft <= 0
      ? []
      : await db
          .select()
          .from(scheduledPostsTable)
          .where(and(where, notInArray(scheduledPostsTable.status, PENDING_STATUSES)))
          .orderBy(desc(scheduledPostsTable.scheduledFor))
          .limit(roomLeft);

  const [counted] = await db.select({ n: count() }).from(scheduledPostsTable).where(where);

  const posts = [...pending, ...history];

  res.json({
    total: Number(counted?.n ?? posts.length),
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
router.post("/social/posts", rateLimit(LIMITS.schedulePost), async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  /*
    Parsed, not narrowed.

    This was a dozen `typeof x === "string" ? x : ""` guards over
    `req.body as { … unknown }`, which reads as careful and is the opposite:
    each one narrows a type and none of them bounds a size. An `accountIds`
    array of any length went into an `IN (…)`; `hashtags` of any length went
    into a row every publisher later joins into one string. See
    `SchedulePostBody` for the wall those numbers now sit behind.
  */
  const parsed = SchedulePostBody.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error);
    return;
  }

  const { projectId, accountIds, caption, hashtags } = parsed.data;
  const overrides: Record<string, unknown> = parsed.data.captions ?? {};

  const when = new Date(parsed.data.scheduledFor);
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
  const [finished] = parsed.data.exportId
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
        .where(and(eq(exportsTable.id, parsed.data.exportId), eq(exportsTable.userId, userId)))
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

/**
 * Where the platform sends them back.
 *
 * A browser navigation, not an API call, so it answers with a redirect to a
 * page rather than JSON — and it carries no bearer token, which is why the
 * state has to say who this is. Everything that can go wrong ends on the same
 * screen with a reason on the query string, because a person staring at a
 * blank page after signing in to Instagram has no idea whether it worked.
 */
/*
  Rate limited by address, and it is the only route in this file that has to be.

  It is a plain GET anybody can cause, mounted above `requireAuth` because a
  platform redirects a browser here with no token of ours — so "who is this"
  comes from the signed state on the URL and there is nobody to count against.
  Every hit costs a signature verification and, past that, a token exchange with
  the platform, which is our rate budget at Google and Meta being spent from
  outside.
*/
socialCallbackRouter.get("/social/callback/:platform", rateLimitByIp(LIMITS.socialCallback), async (req, res): Promise<void> => {
  const platform = req.params["platform"];
  const back = (params: Record<string, string>) =>
    res.redirect(`${appOrigin()}/scheduled?${new URLSearchParams(params).toString()}`);

  if (!isSocialPlatform(platform)) {
    back({ connected: "no", why: "That link is not one of ours." });
    return;
  }

  // The platform's own refusal — somebody pressed "Cancel", or the app is not
  // approved for a scope. Reported before anything else, because it is the
  // commonest outcome that is not an error on our side.
  const denied = req.query["error_description"] ?? req.query["error"];
  if (denied) {
    back({ connected: "no", platform, why: String(denied).slice(0, 200) });
    return;
  }

  const claims = readState(String(req.query["state"] ?? ""));
  /*
    Two checks, one message.

    The signature and expiry are `readState`'s; the browser binding is here,
    because it is the cookie that carries it. A state is refused unless the
    browser presenting it also presents the nonce that was set when the flow
    began — which is what stops a valid state, minted for the attacker, being
    completed in a victim's browser and attaching the victim's tokens to the
    attacker's account. The binding cookie is cleared either way, so a stale one
    cannot be reused.

    One message for every kind of bad state, and deliberately so: a reply that
    said *which* part was wrong — bad signature, expired, wrong browser — would
    be an oracle for building one that is not.
  */
  const boundNonce = cookieFrom(req.headers.cookie, BINDING_COOKIE);
  res.clearCookie(BINDING_COOKIE, { path: "/api/social" });
  if (!claims || claims.platform !== platform || !stateBoundToBrowser(claims, boundNonce)) {
    back({ connected: "no", platform, why: "That connection link has expired. Try again." });
    return;
  }

  const code = String(req.query["code"] ?? "");
  if (!code) {
    back({ connected: "no", platform, why: "The platform sent us back without an authorization code." });
    return;
  }

  const verifier = cookieFrom(req.headers.cookie, VERIFIER_COOKIE);
  res.clearCookie(VERIFIER_COOKIE, { path: "/api/social" });

  try {
    const tokens = await exchangeCode(platform, code, verifier);
    // Who this is, before the row exists. A row without a real external id
    // makes every reconnection a second account, and "publish to both" then
    // sends one clip twice to one feed.
    const who = await identityFor(platform, tokens.accessToken);

    /*
      Meta needs three more answers before this connection can post anything,
      and all three are fixed at connection time.

      The token the code exchange returned is short-lived and Meta issues no
      refresh token, so it is traded here for the long-lived one and its expiry
      is written down — the column existed and was null for these rows, which is
      the database saying "this does not expire" about the one credential that
      does.

      And both Meta destinations go through a Page, which was previously
      resolved on every send by taking the *first* one Meta listed. One Page is
      the answer; several is a question, and the question is asked on the screen
      rather than answered by whichever order Meta happened to use.
    */
    let meta: Awaited<ReturnType<typeof metaTargetsFor>> | null = null;
    let chosen = null;
    if (isMeta(platform)) {
      meta = await metaTargetsFor(platform, tokens.accessToken);
      if (meta.pages.length === 0) {
        // Said while somebody is connecting rather than when a post is due,
        // because it is a thing they can go and fix in Meta right now.
        throw new Error(
          "That Facebook account manages no Page, and both Instagram and Facebook posts go to a Page. " +
            "Create one in Meta, then connect again.",
        );
      }
      chosen = chooseSinglePage(meta.pages);
    }

    const shared = {
      handle: who.handle,
      displayName: who.displayName,
      avatarUrl: who.avatarUrl,
      accessToken: meta?.accessToken ?? tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: meta ? meta.expiresAt : tokens.expiresAt,
      pageId: chosen?.id ?? null,
      pageName: chosen?.name ?? null,
      pageAccessToken: chosen?.token ?? null,
      instagramUserId: chosen?.instagramUserId ?? null,
      pageChoices: meta ? pageChoicesFrom(meta.pages) : null,
      /*
        A connection that still needs a Page picked is connected and not usable,
        and those are different states. `needs_page` says so on the same field
        the screen already reads for "reconnect me", so a person sees one
        outstanding thing in one place rather than a working-looking account
        that fails at nine in the evening.
      */
      status: meta && !chosen ? "needs_page" : "ok",
      statusDetail:
        meta && !chosen
          ? "Choose which Page this posts to. Your account manages more than one."
          : null,
    };

    await db
      .insert(socialAccountsTable)
      .values({
        id: randomUUID(),
        userId: claims.userId,
        platform,
        externalId: who.externalId,
        ...shared,
      })
      .onConflictDoUpdate({
        target: [socialAccountsTable.userId, socialAccountsTable.platform, socialAccountsTable.externalId],
        set: { ...shared, updatedAt: new Date() },
      });

    back({ connected: "yes", platform, handle: who.handle });
  } catch (error) {
    /*
      The platform's own words, forwarded.

      "redirect_uri mismatch" is a thing somebody can fix in ten minutes and
      "could not connect" is not. Logged too, because the person reading the
      screen is not always the person who can fix it.
    */
    const why = error instanceof Error ? error.message : "The platform refused the connection.";
    req.log?.warn({ platform, err: why }, "a social connection failed");
    back({ connected: "no", platform, why: why.slice(0, 200) });
  }
});

export default router;
