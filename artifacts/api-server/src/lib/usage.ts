/**
 * How much of this month's allowance a person has actually used.
 *
 * One question, one place. Three routes ask it — creating a project, reading
 * the subscription, starting a render — and if they answered it differently the
 * user would be told two contradictory things about the same number, which is
 * the sort of bug people never report and never forgive.
 *
 * What counts is a **finished** render. Not a queued one, not a failed one, not
 * a project created and abandoned. We charge for video that exists, so a render
 * that died on our side is our problem, not the customer's balance.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { db, jobsTable, adminActionsTable } from "@workspace/db";
import { exhaustedMessage as messageFor, minutesFrom, PLAN_LIMITS, type PlanKey } from "./plan-limits";

export interface Usage {
  minutesUsed: number;
  /**
   * The plan's minutes plus anything granted by hand this month.
   *
   * One number rather than two, because every reader of this — the render
   * gate, the subscription route, the interface — asks the same question:
   * how much may this person render. A grant that only some of them knew
   * about would let the console promise minutes the gate then refuses.
   */
  minutesIncluded: number;
  /** Of `minutesIncluded`, how much was granted by hand rather than paid for. */
  minutesGranted: number;
  minutesRemaining: number;
  /** True when the next render would exceed the allowance. */
  exhausted: boolean;
}

export function startOfMonthUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function usageFor(userId: string, plan: PlanKey): Promise<Usage> {
  const [row] = await db
    .select({
      // The charge column first, the measurement as its fallback. A clips
      // render is billed at the source it read rather than the pieces it
      // produced — that lives in billed_seconds — while rows from before that
      // column existed fall back to output_seconds, which is exactly what
      // they were billed at the time. Jobs with neither are skipped rather
      // than counted as zero, because "we did not measure this" and "this
      // was free" are different claims and only one is true.
      seconds: sql<number>`coalesce(sum(coalesce(${jobsTable.billedSeconds}, ${jobsTable.outputSeconds})), 0)`,
    })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.userId, userId),
        eq(jobsTable.status, "done"),
        gte(jobsTable.finishedAt, startOfMonthUtc()),
      ),
    );

  // Minutes handed out by hand this month, read from the audit log — which is
  // where the grant lives, not merely where it is described. The console has
  // no other way to grant one, so a grant that reaches the meter is a grant
  // somebody signed their name to.
  const [granted] = await db
    .select({
      seconds: sql<number>`coalesce(sum((${adminActionsTable.detail} ->> 'seconds')::numeric), 0)`,
    })
    .from(adminActionsTable)
    .where(
      and(
        eq(adminActionsTable.action, "grant_minutes"),
        eq(adminActionsTable.subjectUserId, userId),
        gte(adminActionsTable.createdAt, startOfMonthUtc()),
      ),
    );

  const minutesGranted = minutesFrom(Number(granted?.seconds ?? 0));
  const minutesIncluded = PLAN_LIMITS[plan].minutesPerMonth + minutesGranted;
  const minutesUsed = minutesFrom(Number(row?.seconds ?? 0));

  return {
    minutesUsed,
    minutesIncluded,
    minutesGranted,
    minutesRemaining: Math.max(0, minutesIncluded - minutesUsed),
    exhausted: minutesUsed >= minutesIncluded,
  };
}

/**
 * The wording lives in `plan-limits`, beside the numbers it quotes, so that the
 * policy layer can reach it without importing this module and its database
 * driver. This is the shape the routes already call.
 */
export function exhaustedMessage(plan: PlanKey, usage: Usage): string {
  return messageFor(plan, usage.minutesIncluded);
}
