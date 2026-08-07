import { Router, type IRouter } from "express";
import { eq, gte, count } from "drizzle-orm";
import { db, subscriptionsTable, projectsTable } from "@workspace/db";
import { GetSubscriptionResponse, UpdateSubscriptionBody, UpdateSubscriptionResponse } from "@workspace/api-zod";
import { PLAN_LIMITS, isPlanKey } from "../lib/plan-limits";

const router: IRouter = Router();

function startOfCurrentMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function getOrCreateSubscription() {
  const [existing] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.id, "default"))
    .limit(1);

  if (existing) return existing;

  const [created] = await db
    .insert(subscriptionsTable)
    .values({ id: "default", plan: "starter" })
    .onConflictDoNothing()
    .returning();

  if (created) return created;

  const [row] = await db.select().from(subscriptionsTable).limit(1);
  return row;
}

async function buildUsageResponse(plan: string) {
  const validPlan = isPlanKey(plan) ? plan : "starter";
  const limits = PLAN_LIMITS[validPlan];

  const [{ value: videosUsed }] = await db
    .select({ value: count() })
    .from(projectsTable)
    .where(gte(projectsTable.createdAt, startOfCurrentMonth()));

  return {
    plan: validPlan,
    videoLimitPerMonth: limits.videosPerMonth,
    videosUsedThisMonth: videosUsed,
    editsPerVideo: limits.editsPerVideo,
    pricePerMonth: limits.pricePerMonth,
  };
}

router.get("/subscription", async (req, res): Promise<void> => {
  const sub = await getOrCreateSubscription();
  const usage = await buildUsageResponse(sub.plan);
  res.json(GetSubscriptionResponse.parse(usage));
});

router.patch("/subscription", async (req, res): Promise<void> => {
  const parsed = UpdateSubscriptionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { plan } = parsed.data;

  await db
    .insert(subscriptionsTable)
    .values({ id: "default", plan })
    .onConflictDoUpdate({ target: subscriptionsTable.id, set: { plan, updatedAt: new Date() } });

  const usage = await buildUsageResponse(plan);
  res.json(UpdateSubscriptionResponse.parse(usage));
});

export default router;
