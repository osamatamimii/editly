/**
 * Redeeming a code.
 *
 * One endpoint, and the only one in the product where a person gains a paid
 * plan without paying. That is the whole reason it is written as carefully as
 * it is: the door is guessable by construction — a short word typed into a
 * box — so what protects it is the limiter above it, the size of the alphabet
 * the mint draws from, and the fact that every refusal happens before a seat
 * is spent.
 *
 * The rules it applies are in `lib/promo.ts`, deliberately apart from the
 * writing, so they can be read and tested without a database. What lives here
 * is the part only a database can do: claiming one of a code's seats in a way
 * two simultaneous requests cannot both win.
 */
import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, promoCodesTable, promoRedemptionsTable, subscriptionsTable } from "@workspace/db";
import { RedeemPromoBody, RedeemPromoResponse } from "@workspace/api-zod";
import { currentUserId } from "../middlewares/auth";
import { rateLimit, LIMITS } from "../lib/rate-limit";
import { badRequest } from "../lib/bad-request";
import { DEFAULT_PLAN } from "../lib/plan-limits";
import { grantFrom, normaliseCode, refuseRedemption, type CodeRow } from "../lib/promo";
import { applyRedemption } from "../lib/promo-grant";

const router: IRouter = Router();

router.post("/promo/redeem", rateLimit(LIMITS.promoRedeem), async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const parsed = RedeemPromoBody.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error);
    return;
  }

  const code = normaliseCode(parsed.data.code);
  const now = new Date();

  const [row] = await db.select().from(promoCodesTable).where(eq(promoCodesTable.code, code)).limit(1);
  const [sub] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);
  const [mine] = await db
    .select({ id: promoRedemptionsTable.id })
    .from(promoRedemptionsTable)
    .where(and(eq(promoRedemptionsTable.code, code), eq(promoRedemptionsTable.userId, userId)))
    .limit(1);

  const refusal = refuseRedemption(
    (row as CodeRow | undefined) ?? null,
    {
      plan: sub?.plan ?? DEFAULT_PLAN,
      planExpiresAt: sub?.planExpiresAt ?? null,
      licenseId: sub?.licenseId ?? null,
      usedThisCode: Boolean(mine),
    },
    now,
  );
  if (refusal || !row) {
    const answer = refusal ?? { status: 404, reason: "unknown" as const, error: "That is not a code we know." };
    req.log?.info({ userId, code, reason: answer.reason }, "a promo code was refused");
    res.status(answer.status).json({ error: answer.error, reason: answer.reason });
    return;
  }

  const grant = grantFrom(row as CodeRow, now);

  // The seat, the redemption and the plan, in one transaction — `promo-grant.ts`
  // says why it is not written here and why the race it settles is run for real
  // in `tools/promo-test.mjs` rather than described.
  const { outcome } = await applyRedemption(db, { code, userId, grant, now });

  if (outcome === "already-used") {
    res.status(409).json({ error: "This account has already used that code.", reason: "already-used" });
    return;
  }
  if (outcome === "used-up") {
    // Between the check above and the claim, somebody else took the last seat
    // or an operator withdrew the code. Both are the same answer to the person
    // standing here.
    res.status(409).json({ error: "That code has already been used.", reason: "used-up" });
    return;
  }

  req.log?.info({ userId, code, plan: grant.plan, until: grant.expiresAt }, "a promo code was redeemed");

  res.json(
    RedeemPromoResponse.parse({
      plan: grant.plan,
      planExpiresAt: grant.expiresAt.toISOString(),
      months: row.months,
      code,
    }),
  );
});

export default router;
