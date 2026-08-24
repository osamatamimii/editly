import { Router, type IRouter } from "express";
import { eq, gte, count, and } from "drizzle-orm";
import { db, subscriptionsTable, projectsTable } from "@workspace/db";
import { GetSubscriptionResponse, UpdateSubscriptionBody, UpdateSubscriptionResponse } from "@workspace/api-zod";
import { DEFAULT_PLAN, PLAN_LIMITS, planKeyFrom, type PlanKey } from "../lib/plan-limits";
import { usageFor } from "../lib/usage";
import { currentUserId, currentUserEmail } from "../middlewares/auth";
import { claimPaidEvents } from "../lib/claim-paid-events";

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
  const plan = await claimPaidEvents(userId, currentUserEmail(req), sub.plan);

  const usage = await buildUsageResponse(userId, plan);
  res.json(GetSubscriptionResponse.parse(usage));
});

router.patch("/subscription", async (req, res): Promise<void> => {
  const userId = currentUserId(req);

  const parsed = UpdateSubscriptionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
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
      error: "Upgrades go through checkout — this is where a plan is chosen, not where it is granted.",
      currentPlan,
      requestedPlan: plan,
      checkout: "/billing/checkout",
    });
    return;
  }

  await db
    .update(subscriptionsTable)
    .set({ plan, updatedAt: new Date() })
    .where(eq(subscriptionsTable.userId, userId));

  const usage = await buildUsageResponse(userId, plan);
  res.json(UpdateSubscriptionResponse.parse(usage));
});

export default router;
