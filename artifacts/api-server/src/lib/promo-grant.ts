/**
 * The writing half of a redemption: the part only a database can do.
 *
 * `lib/promo.ts` decides whether a code may be used, from values alone. What
 * cannot be decided from values is whether *this* request is the one that gets
 * the last seat, because the answer depends on what another request is doing at
 * the same instant. That is this file, and it is separate from the route so the
 * race can be run for real in a test rather than described in a comment.
 *
 * Two guarantees, and they are worth naming because both were easy to write
 * without:
 *
 *   **A seat is never handed out twice.** The claim is one statement whose
 *   WHERE clause contains `redeemed_count < max_redemptions`; Postgres
 *   evaluates it inside the same statement that increments, so two requests for
 *   a one-seat code cannot both come back with a row.
 *
 *   **The count and the redemptions cannot disagree.** Everything happens in
 *   one transaction, so the unique index on (code, user_id) — which is what
 *   stops one account taking two seats of the same code by asking twice at
 *   once — rolls the increment back with it when it fires.
 */
import { randomUUID } from "crypto";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db, promoCodesTable, promoRedemptionsTable, subscriptionsTable } from "@workspace/db";
import type { PlanKey } from "./plan-limits";

export interface Grant {
  plan: PlanKey;
  expiresAt: Date;
}

export type RedemptionOutcome =
  /** The seat was taken and the plan written. */
  | { outcome: "granted" }
  /** Somebody else took the last seat, or the code was withdrawn between the check and here. */
  | { outcome: "used-up" }
  /** This account already holds a seat of this code — the unique index fired. */
  | { outcome: "already-used" };

/** Postgres' unique violation, which on this transaction can only be one index. */
const UNIQUE_VIOLATION = "23505";

/**
 * Whether a thrown thing is that violation, looked for down the cause chain.
 *
 * Reading `error.code` alone is not enough and the difference is a 500 on a
 * perfectly ordinary double-click: the driver's error arrives wrapped, so the
 * code sits on `cause` rather than on the error the `catch` receives. Walking
 * the chain rather than reaching one level down, because how many wrappers sit
 * between here and the driver is a detail of two dependencies.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let at: unknown = error, depth = 0; at && depth < 5; depth += 1) {
    if ((at as { code?: string }).code === UNIQUE_VIOLATION) return true;
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}

export async function applyRedemption(
  database: typeof db,
  input: { code: string; userId: string; grant: Grant; now: Date },
): Promise<RedemptionOutcome> {
  const { code, userId, grant, now } = input;
  let claimed = true;

  try {
    await database.transaction(async (tx) => {
      const seat = await tx
        .update(promoCodesTable)
        .set({ redeemedCount: sql`${promoCodesTable.redeemedCount} + 1`, updatedAt: now })
        .where(
          and(
            eq(promoCodesTable.code, code),
            isNull(promoCodesTable.revokedAt),
            sql`${promoCodesTable.redeemedCount} < ${promoCodesTable.maxRedemptions}`,
            or(isNull(promoCodesTable.expiresAt), gt(promoCodesTable.expiresAt, now)),
          ),
        )
        .returning({ code: promoCodesTable.code });

      if (seat.length === 0) {
        claimed = false;
        return;
      }

      await tx.insert(promoRedemptionsTable).values({
        id: randomUUID(),
        code,
        userId,
        plan: grant.plan,
        grantExpiresAt: grant.expiresAt,
        redeemedAt: now,
      });

      /*
        `license_id` is left exactly alone.

        It is null on every account a code can be redeemed on — `refuseRedemption`
        turns away anything with a licence and no end date — and on the one case
        where it is not, a *lapsed* paid subscription, it is the record of what
        Freemius last said about this person. Overwriting it would blind the
        ordering rule that stops a redelivered cancellation undoing a live plan.

        `plan_source_at` is stamped, though, because that rule compares dates: a
        grant made now is the newest thing known about this account, and a
        cancellation from before it is stale news about a subscription that has
        already ended.
      */
      await tx
        .insert(subscriptionsTable)
        .values({ userId, plan: grant.plan, planExpiresAt: grant.expiresAt, promoCode: code, planSourceAt: now })
        .onConflictDoUpdate({
          target: subscriptionsTable.userId,
          set: {
            plan: grant.plan,
            planExpiresAt: grant.expiresAt,
            promoCode: code,
            planSourceAt: now,
            updatedAt: now,
          },
        });
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { outcome: "already-used" };
    throw error;
  }

  return claimed ? { outcome: "granted" } : { outcome: "used-up" };
}
