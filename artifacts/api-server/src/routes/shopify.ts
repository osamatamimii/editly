/**
 * The Shopify surface: a merchant picks a product, and a video of it gets made.
 *
 * Two routers, and the split is the security boundary.
 *
 * `shopifyWebhookRouter` is **public**. Shopify calls it from the open internet
 * with no session, exactly as Freemius does — so it is mounted above
 * `requireAuth`, its bodies are kept raw (see `lib/body-parsers.ts`), and its
 * only authentication is the signature over those bytes. Three of its four
 * endpoints are the mandatory compliance webhooks, which every app on the App
 * Store must answer whether or not it touches customer data, and which must
 * answer **401** to a bad signature rather than ignoring it.
 *
 * The default router is authenticated by the ID token App Bridge mints, and by
 * nothing else. It deliberately does not go through `requireAuth`: that
 * middleware is the Supabase door, this is the Shopify door, and a middleware
 * that had to understand both would be the one place where confusing them
 * becomes possible. They meet at a single value — an account id — and the two
 * kinds can never collide in it, because a shop's is a UUID version 5 and a
 * person's is a version 4.
 */
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import express from "express";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db, projectsTable, assetsTable, shopifyShopsTable } from "@workspace/db";
import { Platform } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { putObject, storageAdminConfigured } from "../lib/storage";
import { startRenderForProject } from "../lib/start-render";
import { deleteAccount } from "../lib/account-deletion";
import { erasureStepsFor } from "../lib/user-erasure";
import { asShopDomain, accountIdForShop } from "../lib/shopify/domain";
import { verifyWebhook } from "../lib/shopify/hmac";
import { verifySessionToken } from "../lib/shopify/session-token";
import { credentials, exchangeToken, adminGraphql, PRODUCT_MEDIA_QUERY } from "../lib/shopify/admin";
import { readProduct, isAllowedMediaUrl, MAX_IMAGES } from "../lib/shopify/product";
import { planForProductAd } from "../lib/product-ad";
import { rateLimitBy, LIMITS } from "../lib/rate-limit";

// ── The public half ─────────────────────────────────────────────────────────

export const shopifyWebhookRouter: IRouter = Router();

/** Every path here reaches its handler with the request stream untouched. */
export const SHOPIFY_WEBHOOK_PATHS = [
  "/api/shopify/webhooks/customers/data_request",
  "/api/shopify/webhooks/customers/redact",
  "/api/shopify/webhooks/shop/redact",
  "/api/shopify/webhooks/app/uninstalled",
] as const;

const rawBody = express.raw({ type: "*/*", limit: "1mb" });

interface VerifiedWebhook {
  shop: string;
  topic: string;
  payload: Record<string, unknown>;
}

/**
 * The signature check every webhook shares.
 *
 * Answers the response itself on failure rather than returning a flag, because
 * a helper that hands back "not verified" is a helper whose callers eventually
 * disagree about what to do with it — and one of those disagreements is a 200.
 */
function verified(req: Request, res: Response): VerifiedWebhook | null {
  const creds = credentials();
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ""));

  if (!verifyWebhook(raw, req.get("x-shopify-hmac-sha256"), creds?.clientSecret)) {
    /*
      401, and Shopify says so in as many words for the compliance webhooks: an
      app that receives an invalid HMAC "must return a 401 Unauthorized". Which
      is worth obeying beyond the letter — silently returning 200 to a forged
      redaction request is an endpoint that deletes a shop on demand, and
      silently dropping it is an endpoint whose failures nobody can see.
    */
    logger.warn({ topic: req.get("x-shopify-topic") }, "a Shopify webhook arrived unsigned or wrongly signed");
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }

  const shop = asShopDomain(req.get("x-shopify-shop-domain"));
  if (!shop) {
    res.status(400).json({ error: "No shop." });
    return null;
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return { shop, topic: req.get("x-shopify-topic") ?? "", payload };
}

/**
 * "Give me the personal data you hold on this customer."
 *
 * We hold none. This app reads products and nothing else: it never asks for
 * `read_customers`, it has opted out of protected customer data, and no order,
 * name, address or email of a shopper has ever reached this database. So the
 * honest response is an acknowledgement, and the log line is the record that
 * the request was received and answered.
 *
 * Answering 200 without holding anything is not a shortcut. Shopify requires
 * every app to subscribe and respond regardless of what it stores, and an app
 * that invented a data export to look thorough would be making a claim about
 * its own systems that is false in the other direction.
 */
shopifyWebhookRouter.post("/shopify/webhooks/customers/data_request", rawBody, (req, res): void => {
  const hook = verified(req, res);
  if (!hook) return;
  logger.info({ shop: hook.shop }, "customer data request: this app holds no customer data");
  res.status(200).json({ ok: true, holds: "nothing" });
});

/** The same, for erasure. Nothing held is nothing to erase. */
shopifyWebhookRouter.post("/shopify/webhooks/customers/redact", rawBody, (req, res): void => {
  const hook = verified(req, res);
  if (!hook) return;
  logger.info({ shop: hook.shop }, "customer redaction: this app holds no customer data");
  res.status(200).json({ ok: true, erased: "nothing" });
});

/**
 * "Erase everything you hold for this shop." Sent 48 hours after an uninstall.
 *
 * This one has real work behind it, and it is the same work as a person
 * deleting their account — the same order, the same refusal when storage
 * cannot be reached, the same rule that bytes go before the rows that name
 * them. `lib/user-erasure.ts` exists because there are now two callers and one
 * list of tables.
 *
 * A storage outage returns 500 on purpose. Shopify retries, and thirty days is
 * a long window: answering 200 while a merchant's videos are still on our
 * disks would close the obligation with the files still here, which is the one
 * outcome nobody could correct afterwards.
 */
shopifyWebhookRouter.post("/shopify/webhooks/shop/redact", rawBody, async (req, res): Promise<void> => {
  const hook = verified(req, res);
  if (!hook) return;

  const userId = accountIdForShop(hook.shop);
  const result = await deleteAccount(erasureStepsFor(userId, { hasLogin: false }));

  if (!result.deleted) {
    logger.error({ shop: hook.shop }, "shop redaction refused: storage is not reachable");
    res.status(500).json({ error: "not now" });
    return;
  }

  await db.delete(shopifyShopsTable).where(eq(shopifyShopsTable.shop, hook.shop));
  logger.info({ shop: hook.shop, projects: result.projects }, "shop redacted");
  res.status(200).json({ ok: true, projects: result.projects });
});

/**
 * The app was removed from the store.
 *
 * The token is dead the moment this arrives, so it is cleared — a dead
 * credential kept is a credential to explain in an audit. The row itself
 * stays: `shop/redact` is 48 hours away and is what removes the data, and in
 * between a merchant who reinstalls gets their projects back rather than an
 * empty account. Most uninstalls in this category are somebody trying to fix
 * something.
 */
shopifyWebhookRouter.post("/shopify/webhooks/app/uninstalled", rawBody, async (req, res): Promise<void> => {
  const hook = verified(req, res);
  if (!hook) return;
  await db
    .update(shopifyShopsTable)
    .set({ uninstalledAt: new Date(), accessToken: "" })
    .where(eq(shopifyShopsTable.shop, hook.shop));
  logger.info({ shop: hook.shop }, "app uninstalled");
  res.status(200).json({ ok: true });
});

// ── The authenticated half ──────────────────────────────────────────────────

const router: IRouter = Router();

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * The shop, on every request that passed `requireShop`.
       *
       * Its own field rather than reusing `userId`. The two doors resolve to
       * the same account id in the end, and keeping the *evidence* separate is
       * what stops a handler being written that works under either one without
       * its author having decided that it should.
       */
      shopifyShop?: string;
    }
  }
}

/**
 * The Shopify door.
 *
 * Its own middleware rather than a branch inside `requireAuth`, because the two
 * doors authenticate different things and share only their answer. Keeping them
 * apart means no request can be half-way through both.
 */
function requireShop(req: Request, res: Response, next: NextFunction): void {
  const creds = credentials();
  const header = req.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const result = verifySessionToken(token, {
    clientId: creds?.clientId,
    secret: creds?.clientSecret,
  });
  if (!result.ok) {
    // The reason is logged and never returned. "Expired" is useful to us and
    // is a hint to somebody probing; the app's own answer to a 401 is to ask
    // App Bridge for a fresh token, which needs no explanation.
    logger.warn({ reason: result.reason }, "a Shopify request did not authenticate");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.shopifyShop = result.token.shop;
  next();
}

router.use("/shopify", requireShop);

/**
 * The shop's access token, exchanged on first use and kept.
 *
 * Managed installation grants the scopes; nothing here implements OAuth. What
 * this does is turn the ID token the browser already has into one that can read
 * the catalogue, and store it — an *offline* token, because the render it
 * starts finishes minutes after the merchant has closed the tab.
 */
async function tokenFor(shop: string, idToken: string): Promise<string | null> {
  const creds = credentials();
  if (!creds) return null;

  const [existing] = await db.select().from(shopifyShopsTable).where(eq(shopifyShopsTable.shop, shop));
  if (existing?.accessToken) return existing.accessToken;

  const exchanged = await exchangeToken(shop, idToken, creds);
  if (!exchanged.ok) {
    logger.error({ shop, reason: exchanged.reason }, "could not exchange the session token");
    return null;
  }

  const userId = accountIdForShop(shop);
  await db
    .insert(shopifyShopsTable)
    .values({ shop, userId, accessToken: exchanged.accessToken, scopes: exchanged.scopes })
    .onConflictDoUpdate({
      target: shopifyShopsTable.shop,
      set: {
        accessToken: exchanged.accessToken,
        scopes: exchanged.scopes,
        // Coming back is not a new install as far as their projects are
        // concerned, but it is the end of being uninstalled.
        uninstalledAt: null,
        userId,
      },
    });
  return exchanged.accessToken;
}

/** No image is worth more than this to an advertisement. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * One product photograph, fetched from Shopify's CDN into our bucket.
 *
 * Bounded twice: the host is checked (a URL in a JSON response is not a promise
 * about where it points, and this server holds credentials) and the size is
 * capped by reading the length the CDN declares. A merchant is waiting on this
 * request, so a photograph that will not arrive is a shorter advertisement
 * rather than a failed one.
 */
async function fetchImage(url: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!isAllowedMediaUrl(url)) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_IMAGE_BYTES) return null;
    const buffer = new Uint8Array(await response.arrayBuffer());
    // Checked again after reading, because `content-length` is a claim and a
    // chunked response makes no claim at all.
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) return null;
    const contentType = response.headers.get("content-type") ?? "image/jpeg";
    return { bytes: buffer, contentType: contentType.split(";")[0]!.trim() };
  } catch {
    return null;
  }
}

/** `image/jpeg` becomes `jpg`, and anything unfamiliar becomes `jpg` too. */
function extensionFor(contentType: string): string {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "jpg";
}

/**
 * Make a video of this product.
 *
 * The whole merchant-facing surface, for now, is this one call: an id from the
 * resource picker goes in, a queued render comes out. Everything between is
 * plumbing that already existed — the plan goes through the same policy that
 * every other render goes through, so the month's allowance, the free-plan
 * watermark and the one-render-at-a-time rule apply here exactly as they do to
 * a person pressing a button, and none of them had to learn what Shopify is.
 */
/*
  Counted against the same window a person pressing "New Project" is counted
  against, and keyed on the shop's own account id so the two doors cannot be
  alternated for a double budget. `rateLimit` cannot be used here: it keys on
  `req.userId`, which this door deliberately never sets.
*/
router.post("/shopify/ads", rateLimitBy(LIMITS.createProject, (req) => (req.shopifyShop ? accountIdForShop(req.shopifyShop) : null)), async (req, res): Promise<void> => {
  const shop = req.shopifyShop as string;
  const userId = accountIdForShop(shop);

  if (!storageAdminConfigured) {
    res.status(503).json({ error: "We can't fetch your product photos just now. Please try again shortly." });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const productId = typeof body["productId"] === "string" ? body["productId"] : "";
  // The global id Shopify's own resource picker returns. Checked rather than
  // interpolated hopefully: it goes into a GraphQL variable, and a value that
  // is not a product id is a query about something else.
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) {
    res.status(400).json({ error: "That is not a product." });
    return;
  }
  const platform = Platform.safeParse(body["platform"]).data ?? "tiktok";

  const header = req.get("authorization") ?? "";
  const accessToken = await tokenFor(shop, header.slice(7).trim());
  if (!accessToken) {
    res.status(502).json({ error: "We couldn't reach your store. Please try again." });
    return;
  }

  const answer = await adminGraphql(shop, accessToken, PRODUCT_MEDIA_QUERY, { id: productId });
  if (!answer.ok) {
    // A dead token means the app was removed or the scopes changed. Clearing it
    // here is what makes the next attempt re-exchange rather than repeat a
    // request that cannot work.
    if (answer.status === 401 || answer.status === 403) {
      await db.update(shopifyShopsTable).set({ accessToken: "" }).where(eq(shopifyShopsTable.shop, shop));
    }
    logger.error({ shop, reason: answer.reason }, "the product could not be read");
    res.status(answer.retryable ? 503 : 502).json({ error: "We couldn't read that product. Please try again." });
    return;
  }

  const ad = readProduct(answer.data["product"]);
  if (!ad) {
    /*
      The honest refusal, and the one a merchant can act on. A product page with
      no photographs is a real and common state — a supplier import that has not
      finished, or a product added by hand — and "add a photo to this product
      and I will make the video" is a sentence that gets them a video.
    */
    res.status(422).json({ error: "That product has no photos yet. Add one and I'll make the video." });
    return;
  }

  const projectId = randomUUID();
  const stored: { id: string; path: string; bytes: number; width: number; height: number }[] = [];

  for (const [index, image] of ad.images.slice(0, MAX_IMAGES).entries()) {
    const fetched = await fetchImage(image.url);
    if (!fetched) continue;
    const key = `${userId}/${projectId}/product-${String(index).padStart(2, "0")}.${extensionFor(fetched.contentType)}`;
    const put = await putObject(key, fetched.bytes, fetched.contentType);
    if (!put.stored) {
      logger.warn({ shop, key, reason: put.reason }, "a product photo could not be stored");
      continue;
    }
    stored.push({
      id: randomUUID(),
      path: key,
      bytes: fetched.bytes.byteLength,
      width: image.width,
      height: image.height,
    });
  }

  if (stored.length === 0) {
    res.status(502).json({ error: "We couldn't fetch that product's photos. Please try again." });
    return;
  }

  const targetSeconds = 15;
  await db.insert(projectsTable).values({
    id: projectId,
    userId,
    title: ad.title.slice(0, 200),
    status: "ready",
    /*
      The first photograph, and this column means what it has always meant: the
      object this project's renders start from. For a reel that is exactly what
      it is — the worker replaces it with the assembled clip before the first
      probe, and never opens it.
    */
    videoPath: stored[0]!.path,
    // What the source *will* be. The ceiling and allowance checks are made
    // against this, and they should be: it is the length that gets billed.
    duration: targetSeconds,
    platform,
  });

  await db.insert(assetsTable).values(
    stored.map((row) => ({
      id: row.id,
      projectId,
      userId,
      path: row.path,
      kind: "image",
      label: null,
      bytes: row.bytes,
      width: row.width || null,
      height: row.height || null,
    })),
  );

  const outcome = await startRenderForProject(
    userId,
    (await db.select().from(projectsTable).where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId))))[0]!,
    /*
      Photographs only, from here.

      A Shopify product's videos are counted and reported (`ad.videos`) and not
      yet downloaded, so this door hands the plan builder no clips and gets the
      stills reel. The moment that download exists, the clips go in `clipIds`
      and this merchant gets the same footage-first advertisement the signed-in
      door already builds.
    */
    planForProductAd(
      ad,
      { clipIds: [], photoIds: stored.map((row) => row.id), sourceSeconds: null },
      { platform, targetSeconds },
    ),
    req.log,
  );

  if (!outcome.ok) {
    res.status(outcome.status).json(outcome.body);
    return;
  }

  logger.info(
    { shop, projectId, photos: stored.length, videosNotUsed: ad.videos },
    "a product ad was queued",
  );

  res.status(202).json({
    projectId,
    jobId: outcome.job.id,
    photos: stored.length,
    /*
      Said in the answer, not only in the logs. A merchant whose product has a
      supplier video and who gets a slideshow of the stills has been given
      something worse than what their page already had, and finding that out by
      watching it is the complaint every app in this category collects.
    */
    videosNotUsed: ad.videos,
  });
});

export default router;
