import { Router, type IRouter } from "express";
import { eq, gte, count, and } from "drizzle-orm";
import { db, subscriptionsTable, projectsTable } from "@workspace/db";
import { GetSubscriptionResponse, UpdateSubscriptionBody, UpdateSubscriptionResponse } from "@workspace/api-zod";
import { DEFAULT_PLAN, PLAN_LIMITS, planKeyFrom, uploadCeiling, type PlanKey } from "../lib/plan-limits";
import { usageFor } from "../lib/usage";
import { currentUserId, verifiedUserEmail } from "../middlewares/auth";
import { claimPaidEvents } from "../lib/claim-paid-events";
import { effectiveUploadLimitBytes } from "../lib/storage-limits";
import { badRequest } from "../lib/bad-request";

const router: IRouter = Router();

/**
 * Cheapest first. Moving down this list costs the user nothing and can be
 * self-served; moving up must go through billing, which does not exist yet.
 */
const PLAN_RANK: Record<PlanKey, number> = { free: 0, creator: 1, pro: 2, studio: 3 };

function startOfCurrentMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function getOrCreateSubscription(userId: string) {
  const [existing] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);

  if (existing) return existing;

  // DEFAULT_PLAN, not a literal. This line said "starter" — a name the rename
  // turned into an alias for *creator*, so every account created after that
  // rename was handed sixty minutes, no watermark and reference styling, for
  // nothing. Nobody would have reported it.
  const [created] = await db
    .insert(subscriptionsTable)
    .values({ userId, plan: DEFAULT_PLAN })
    .onConflictDoNothing()
    .returning();

  if (created) return created;

  // Lost the insert race against a concurrent request for the same user.
  const [row] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);

  // Losing the race *and* the re-read is not a state that should exist — the
  // row is either there or we just made it — but `row` is typed as possibly
  // undefined and every caller reads `.plan` off it, so the impossible case was
  // a TypeError and a bare 500 on the endpoint that tells somebody what they
  // are paying for. Answer with the default rather than crashing: it is the
  // plan a brand new account has anyway.
  return row ?? { userId, plan: DEFAULT_PLAN, licenseId: null, planSourceAt: null, createdAt: new Date(), updatedAt: new Date() };
}

async function buildUsageResponse(userId: string, plan: string) {
  const validPlan = planKeyFrom(plan);
  const limits = PLAN_LIMITS[validPlan];
  const usage = await usageFor(userId, validPlan);

  return {
    plan: validPlan,
    minutesIncluded: usage.minutesIncluded,
    minutesGranted: usage.minutesGranted,
    minutesUsedThisMonth: usage.minutesUsed,
    minutesRemaining: usage.minutesRemaining,
    maxUploadMinutes: limits.maxUploadMinutes,
    // The smaller of what the plan was sold as and what the bucket will take.
    // It was the bucket's alone, which meant every plan reported the same
    // ceiling and the page said 50 MB to somebody paying for four-hour
    // episodes. `uploadCeiling` also says which of the two bound it; the
    // browser does not need that, but the upload door does.
    maxUploadBytes: uploadCeiling(validPlan, await effectiveUploadLimitBytes()).bytes,
    watermark: limits.watermark,
    referenceStyle: limits.referenceStyle,
    pricePerMonth: limits.pricePerMonth,
  };
}

router.get("/subscription", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const sub = await getOrCreateSubscription(userId);

  // If somebody paid before this account existed — or paid with the address on
  // this token while signed up under it — the event has been sitting in
  // `billing_events` unclaimed. This is the moment it can be handed over, and
  // it is the moment they are most likely to be looking for it. Never throws:
  // a failure here leaves them on the plan they had and is retried on the next
  // read.
  //
  // The *verified* address, not merely the one on the token: this hands over
  // a plan somebody paid for, and Supabase issues a session before an address
  // is confirmed. See `verifiedUserEmail`.
  const plan = await claimPaidEvents(userId, verifiedUserEmail(req), sub.plan);

  const usage = await buildUsageResponse(userId, plan);
  res.json(GetSubscriptionResponse.parse(usage));
});

router.patch("/subscription", async (req, res): Promise<void> => {
  const userId = currentUserId(req);

  const parsed = UpdateSubscriptionBody.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error);
    return;
  }

  const { plan } = parsed.data;
  const current = await getOrCreateSubscription(userId);
  const currentPlan: PlanKey = planKeyFrom(current.plan);

  // An upgrade is never granted here, and that is permanent rather than a
  // temporary state of the deployment. The only thing that may raise a plan is
  // a signed Freemius webhook, because that is the only evidence anyone paid.
  // This endpoint is authenticated, which proves who is asking — not that they
  // bought anything. Downgrades stay self-service: they only ever reduce what
  // the user is entitled to, so wanting one is proof enough.
  if (PLAN_RANK[plan] > PLAN_RANK[currentPlan]) {
    res.status(402).json({
      error: "Upgrades go through checkout. This is where a plan is chosen, not where it is granted.",
      currentPlan,
      requestedPlan: plan,
      checkout: "/billing/checkout",
    });
    return;
  }

  /*
    This changes what the account may do. It does not stop the card.

    Freemius is the merchant of record, and nothing in this codebase calls it:
    there is no Freemius client here, only signature verification and the
    public checkout config. So a Pro subscriber who presses "Switch to Creator"
    gets Creator's allowance immediately and goes on being charged $29 a month
    until they cancel at Freemius themselves.

    It is also unstable in the other direction. The Pro licence is still live,
    so the next renewal webhook writes `plan = pro` back — which will read to
    them as the downgrade having been undone by us.

    Two things follow, and only one of them is code. The response now carries
    `billingUnchanged` and where to go, so the screen can say it; and until a
    Freemius client exists, this route must not be the only place that knows.
  */
  await db
    .update(subscriptionsTable)
    .set({ plan, updatedAt: new Date() })
    .where(eq(subscriptionsTable.userId, userId));

  req.log?.info({ userId, from: currentPlan, to: plan }, "a plan was reduced from inside the product");

  const usage = await buildUsageResponse(userId, plan);
  res.json(
    UpdateSubscriptionResponse.parse({
      ...usage,
      // Only when there was something to stop. Moving between free and free
      // has no card behind it and saying otherwise would be noise.
      ...(currentPlan === "free"
        ? {}
        : {
            billingUnchanged: {
              was: currentPlan,
              message:
                "Your plan here is now smaller, and your card has not been stopped. Editly does not take the payment, so the subscription has to be cancelled where it was bought.",
              where: "https://users.freemius.com/",
            },
          }),
    }),
  );
});

export default router;
