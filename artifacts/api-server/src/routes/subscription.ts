import { Router, type IRouter } from "express";
import { eq, gte, count, and } from "drizzle-orm";
import { db, subscriptionsTable, projectsTable } from "@workspace/db";
import { GetSubscriptionResponse, UpdateSubscriptionBody, UpdateSubscriptionResponse } from "@workspace/api-zod";
import { PLAN_LIMITS, isPlanKey, type PlanKey } from "../lib/plan-limits";
import { currentUserId } from "../middlewares/auth";

const router: IRouter = Router();

/**
 * Cheapest first. Moving down this list costs the user nothing and can be
 * self-served; moving up must go through billing, which does not exist yet.
 */
const PLAN_RANK: Record<PlanKey, number> = { starter: 0, pro: 1, scale: 2 };

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

  const [created] = await db
    .insert(subscriptionsTable)
    .values({ userId, plan: "starter" })
    .onConflictDoNothing()
    .returning();

  if (created) return created;

  // Lost the insert race against a concurrent request for the same user.
  const [row] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);

  return row;
}

async function buildUsageResponse(userId: string, plan: string) {
  const validPlan = isPlanKey(plan) ? plan : "starter";
  const limits = PLAN_LIMITS[validPlan];

  const [{ value: videosUsed }] = await db
    .select({ value: count() })
    .from(projectsTable)
    .where(
      and(
        eq(projectsTable.userId, userId),
        gte(projectsTable.createdAt, startOfCurrentMonth()),
      ),
    );

  return {
    plan: validPlan,
    videoLimitPerMonth: limits.videosPerMonth,
    videosUsedThisMonth: videosUsed,
    editsPerVideo: limits.editsPerVideo,
    pricePerMonth: limits.pricePerMonth,
  };
}

router.get("/subscription", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const sub = await getOrCreateSubscription(userId);
  const usage = await buildUsageResponse(userId, sub.plan);
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
  const currentPlan: PlanKey = isPlanKey(current.plan) ? current.plan : "starter";

  // Until a payment provider is wired up, an upgrade here would hand out paid
  // capacity for free. Downgrades stay self-service because they only ever
  // reduce what the user is entitled to.
  if (PLAN_RANK[plan] > PLAN_RANK[currentPlan]) {
    res.status(402).json({
      error:
        "Upgrading requires a payment method. Billing is not enabled on this deployment yet.",
      currentPlan,
      requestedPlan: plan,
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
