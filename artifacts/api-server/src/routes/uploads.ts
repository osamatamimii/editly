/**
 * Permission to upload, minted here, one file at a time.
 *
 * This is the endpoint that puts our own server back on the path of an upload.
 * Everything else in this product already worked that way: the browser sends
 * bytes to Storage and then tells us where it put them, and each of those
 * "tells us" endpoints exists to refuse to believe the claim. This one exists
 * because a claim checked *after* the transfer is a claim checked too late.
 *
 * Two costs were being paid for that, and both were paid more than once.
 *
 * The first is the migration. R2 has no row-level security, no JWT and no row
 * policies, so the arrangement the browser uses today has no equivalent
 * anywhere else. The only portable spelling of "you may write this object" is a
 * URL our API signs, which means the seam in `lib/object-store` cannot actually
 * be crossed until this route exists.
 *
 * The second is paid every day it does not. The bucket refuses a content type
 * it does not hold, or a file above a ceiling that lives in a Supabase setting,
 * and the answer is a 400 to a browser on a request no log of ours records. The
 * two worst bugs this product has had were that exact shape: a PNG logo that
 * could not be uploaded at all while `overlayImage` was built and tested, and a
 * panel promising 512 MB against a bucket that stopped at 50.
 *
 * ## What is decided here
 *
 * Four things, in this order, and every one of them before anything is signed:
 *
 *   1. **Ownership.** The project is looked up against the verified user id,
 *      and a project that is not theirs answers 404 rather than 403, because
 *      whether an id exists is not something to learn from a status code. The
 *      key is then *built* from that same user id rather than accepted from the
 *      request, so another account's folder is unspellable and not merely
 *      refused.
 *   2. **Quota.** The two limits this product already had are moved to where
 *      they cost nothing: a project's sixty files and an account's twenty-four
 *      faces were both enforced at registration, which is to say after somebody
 *      had waited for the bytes.
 *   3. **Type**, from the extension through the one shared table.
 *   4. **Size**, against the smaller of the bucket's ceiling and this
 *      product's own for the purpose.
 *
 * The decisions themselves live in `lib/upload-policy.ts` as a pure function,
 * so the whole table of them is checkable without a bucket or a database. What
 * is here is the wiring: the lookups, the signature, and the log line.
 *
 * ## Why a refusal is logged and a success is too
 *
 * "Every rejection has a line in our log and a sentence on the screen" is the
 * entire point of the route. The line carries a reason code rather than the
 * sentence, so a month of refusals can be counted by cause: a wall of
 * `too-large` is a pricing conversation and a wall of `unknown-type` is a
 * missing format.
 */
import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { and, eq, count } from "drizzle-orm";
import { db, assetsTable, captionFacesTable, projectsTable, subscriptionsTable } from "@workspace/db";
import { UploadTicketBody, type UploadTicket } from "@workspace/api-zod/uploads";
import { objectStoreFrom } from "@workspace/object-store";
import { currentUserId } from "../middlewares/auth";
import { logger } from "../lib/logger";
import { rateLimit, LIMITS } from "../lib/rate-limit";
import { effectiveUploadLimitBytes } from "../lib/storage-limits";
import { planKeyFrom, uploadCeiling, type PlanKey } from "../lib/plan-limits";
import { MAX_ASSETS_PER_PROJECT } from "./assets";
import { MAX_FACES } from "./fonts";
import {
  planUpload,
  worthResuming,
  ticketTtlFor,
  type UploadQuota,
} from "../lib/upload-policy";

const router: IRouter = Router();

/** Does this project exist, and does it belong to the person asking? */
async function ownsProject(userId: string, projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)))
    .limit(1);
  return Boolean(row);
}

/**
 * How full the relevant shelf already is, for the two purposes that have one.
 *
 * The numbers are imported from the routes that also enforce them at
 * registration rather than restated here. One of them changing and the other
 * not would mean an upload signed and then refused, which is worse than either
 * limit being wrong.
 */
async function quotaFor(
  purpose: string,
  userId: string,
  projectId: string | undefined,
): Promise<UploadQuota | undefined> {
  if (purpose === "asset" && projectId) {
    const [row] = await db
      .select({ used: count() })
      .from(assetsTable)
      .where(eq(assetsTable.projectId, projectId));
    return { used: Number(row?.used ?? 0), allowed: MAX_ASSETS_PER_PROJECT, noun: "files in a project" };
  }
  if (purpose === "font") {
    const [row] = await db
      .select({ used: count() })
      .from(captionFacesTable)
      .where(eq(captionFacesTable.userId, userId));
    return { used: Number(row?.used ?? 0), allowed: MAX_FACES, noun: "fonts" };
  }
  return undefined;
}

/**
 * Which plan this account is on.
 *
 * Its own read rather than a value threaded from somewhere, because this door
 * is reached before a project exists and there is nothing else here that knows.
 * A missing row is the free plan, which is what a brand new account has anyway —
 * a throw here would turn "I chose a file" into a 500.
 */
async function planFor(userId: string): Promise<PlanKey> {
  try {
    const [row] = await db
      .select({ plan: subscriptionsTable.plan })
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.userId, userId))
      .limit(1);
    return planKeyFrom(row?.plan);
  } catch {
    return planKeyFrom(null);
  }
}

router.post("/uploads", rateLimit(LIMITS.write), async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const body = UploadTicketBody.safeParse(req.body);
  if (!body.success) {
    logger.warn({ userId, reason: "malformed" }, "refused an upload");
    res.status(400).json({ error: "That upload request could not be read." });
    return;
  }
  const { purpose, filename, bytes, projectId } = body.data;

  if (projectId && !(await ownsProject(userId, projectId))) {
    logger.warn({ userId, purpose, reason: "not-your-project" }, "refused an upload");
    res.status(404).json({ error: "Project not found." });
    return;
  }

  /*
    The ceiling that applies to this person, which is two promises meeting.

    Until now this door applied one of them — what the bucket will accept — to
    everybody, so the free plan and Pro were refused at exactly the same size
    while the pricing page sold ten minutes against four hours. The plan's own
    number is the other, and the smaller wins. Which one won is carried along
    because it decides what the refusal may offer: an upgrade cannot lift a
    bucket limit, and offering one there sells a plan that refuses the same file.
  */
  const ceiling = uploadCeiling(await planFor(userId), await effectiveUploadLimitBytes());

  const decision = planUpload(
    { purpose, filename, bytes, projectId },
    {
      userId,
      ceilingBytes: ceiling.bytes,
      ceilingBound: ceiling.bound,
      quota: await quotaFor(purpose, userId, projectId),
      // A uuid rather than a timestamp and a random suffix. Two files dropped
      // in the same millisecond is a thing a person does by selecting both.
      stamp: randomUUID(),
    },
  );

  if (!decision.ok) {
    logger.warn(
      { userId, purpose, bytes, reason: decision.refusal.reason },
      "refused an upload",
    );
    res.status(decision.refusal.status).json({ error: decision.refusal.message });
    return;
  }

  const { key, contentType, maxBytes } = decision.plan;

  let store;
  try {
    store = objectStoreFrom();
  } catch (error) {
    // Half-configured storage is a deployment fault, not the person's. It gets
    // a 503 and a loud line, because a 400 here would read to them as a
    // problem with their file and they would try smaller ones all afternoon.
    logger.error({ err: error, userId, purpose }, "cannot sign an upload: no object store");
    res.status(503).json({ error: "Uploads are not available right now. Nothing was lost, try again shortly." });
    return;
  }

  /*
    The one branch that knows which provider it is talking to.

    Supabase's resumable endpoint speaks tus and has no signed form: a large
    file goes up with the person's own session or it goes up as a single
    request that starts again from zero when a train enters a tunnel. The
    second is not a trade worth making, so the transfer stays as it is and the
    *decision* moves here regardless. On a provider whose multipart upload can
    be signed per part this branch is never taken, and neither side has to
    learn anything new for that to be true.
  */
  if (store.provider === "supabase" && worthResuming(bytes)) {
    const base = (process.env["SUPABASE_URL"] ?? "").replace(/\/+$/, "");
    const ticket: UploadTicket = {
      path: key,
      contentType,
      maxBytes,
      // No `expiresAt`: a resumable upload has no deadline to name. It goes to
      // the tus endpoint with the person's own bearer token and `x-upsert`,
      // and nothing about that arrangement goes stale on a clock. The field
      // was here, computed exactly as the signed branch computes its real one,
      // and it described a moment that does not exist.
      //
      // The other branch of this merge kept the field and moved it onto the
      // per-purpose TTL, `ticketTtlFor(purpose)` — a faithful adaptation of the
      // old line, but it makes the number *more* believable rather than true,
      // and a client that trusts it will abandon a transfer that was still
      // perfectly resumable. The per-purpose TTL still governs the signed
      // branch below, where there is a signature that really does expire.
      transfer: {
        mode: "resumable",
        url: `${base}/storage/v1/upload/resumable`,
        headers: { "x-upsert": "true" },
        metadata: {
          bucketName: store.bucket,
          objectName: key,
          contentType,
          cacheControl: "3600",
        },
      },
    };
    logger.info({ userId, purpose, bytes, mode: "resumable" }, "authorised an upload");
    res.status(201).json(ticket);
    return;
  }

  const signed = await store.signedPut(key, {
    // Short for the small purposes. The declared ceiling is advice the storage
    // provider does not enforce, so the window is what bounds a replay.
    expiresInSeconds: ticketTtlFor(purpose),
    contentType,
    // An upload replaces what was there. A person re-recording their take and
    // finding the old one still playing would be the worse surprise.
    upsert: true,
  });

  if (!signed) {
    logger.error({ userId, purpose, provider: store.provider }, "storage would not sign an upload");
    res.status(503).json({ error: "Uploads are not available right now. Nothing was lost, try again shortly." });
    return;
  }

  const ticket: UploadTicket = {
    path: key,
    contentType,
    maxBytes,
    expiresAt: signed.expiresAt,
    transfer: {
      mode: "signed",
      url: signed.url,
      method: signed.method,
      headers: signed.headers,
    },
  };
  logger.info({ userId, purpose, bytes, mode: "signed" }, "authorised an upload");
  res.status(201).json(ticket);
});

export default router;
