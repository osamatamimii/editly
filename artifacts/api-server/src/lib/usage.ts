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
import { db, jobsTable } from "@workspace/db";
import { exhaustedMessage as messageFor, minutesFrom, PLAN_LIMITS, type PlanKey } from "./plan-limits";

export interface Usage {
  minutesUsed: number;
  minutesIncluded: number;
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

  const minutesIncluded = PLAN_LIMITS[plan].minutesPerMonth;
  const minutesUsed = minutesFrom(Number(row?.seconds ?? 0));

  return {
    minutesUsed,
    minutesIncluded,
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
